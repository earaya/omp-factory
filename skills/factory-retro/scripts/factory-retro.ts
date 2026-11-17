#!/usr/bin/env -S BUN_BE_BUN=1 omp
// Retro collector: friction signals from finished factory run directories.
//
// Disk-derived only: counts and verbatim lines, no judgement. run.md Log lines
// are coordinator prose, not a schema, so every pattern-matched line is echoed
// verbatim and the factory-retro skill re-checks the classification.
//
// Generations order numerically (plan.10 > plan.9); only `<prefix>.<N>.json`
// counts, so sidecars (.md, .notes.md, .amendments.json) never bump one.
// Any malformed input exits 2 naming the file, before anything is printed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const USAGE = `usage: factory-retro.ts <command>
  collect <run-dir> [<run-dir>...]  print friction signals as JSON (one run: the run object; several: {runs, totals})
`;

function die(message: string): never {
	process.stderr.write(`factory-retro: ${message}\n`);
	process.exit(2);
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const list = (dir: string) => (isDir(dir) ? readdirSync(dir) : []);

function parseJson(file: string, what: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		die(`${what}: ${file} is not valid JSON`);
	}
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringsOrNull = (v: unknown): v is string[] | null | undefined =>
	v == null || (Array.isArray(v) && v.every(x => typeof x === "string"));
const stringOrNull = (v: unknown): v is string | null | undefined => v == null || typeof v === "string";

function generations(dir: string, pattern: RegExp): { gen: number; file: string; key: string }[] {
	return list(dir)
		.flatMap(f => {
			const m = pattern.exec(f);
			return m ? [{ gen: Number(m[m.length - 1]), file: join(dir, f), key: m.length > 2 ? m[1] : "" }] : [];
		})
		.sort((a, b) => a.gen - b.gen);
}

const maxGen = (dir: string, prefix: string) => generations(dir, new RegExp(`^${prefix}\\.(\\d+)\\.json$`)).at(-1)?.gen ?? 0;

// The `- ` lines under run.md's `## Log` heading, up to the next heading.
function logLines(runMd: string): string[] {
	if (!existsSync(runMd)) return [];
	const out: string[] = [];
	let inLog = false;
	for (const line of readFileSync(runMd, "utf8").split("\n")) {
		if (/^## Log\s*$/.test(line)) inLog = true;
		else if (inLog && /^##? /.test(line)) inLog = false;
		else if (inLog && line.startsWith("- ")) out.push(line);
	}
	return out;
}

function amendments(dir: string): number {
	let total = 0;
	for (const { file } of generations(dir, /^plan\.(\d+)\.amendments\.json$/)) {
		const v = parseJson(file, "amendments");
		if (!Array.isArray(v)) die(`amendments: ${file} is not a JSON array`);
		total += v.length;
	}
	return total;
}

// P2 before P10: compare the non-digit prefix, then the digit runs as numbers.
function packetOrder(a: string, b: string): number {
	const key = (p: string) => [p.match(/^\D*/)![0], (p.match(/\d+/g) ?? []).map(Number)] as const;
	const [pa, na] = key(a);
	const [pb, nb] = key(b);
	if (pa !== pb) return pa < pb ? -1 : 1;
	for (let i = 0; i < Math.max(na.length, nb.length); i++) {
		if ((na[i] ?? -1) !== (nb[i] ?? -1)) return (na[i] ?? -1) - (nb[i] ?? -1);
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

// Each packet's latest ChangeReport: files_changed and deviations are missing,
// null, or arrays of strings.
function changes(reports: string): { packet: string; files_changed: string[]; deviations: string[] }[] {
	const latest = new Map<string, string>();
	for (const { key, file } of generations(reports, /^(.*?)\.change\.(\d+)\.json$/)) latest.set(key, file);
	return [...latest.keys()].sort(packetOrder).map(packet => {
		const file = latest.get(packet)!;
		const r = parseJson(file, "changes");
		if (!isObject(r)) die(`changes: ${file} is not a JSON object with string-array files_changed and deviations`);
		const { files_changed, deviations } = r;
		if (!stringsOrNull(files_changed) || !stringsOrNull(deviations)) {
			die(`changes: ${file} is not a JSON object with string-array files_changed and deviations`);
		}
		return { packet, files_changed: files_changed ?? [], deviations: deviations ?? [] };
	});
}

type Loop = { generation: number; verdict: string | null } | null;

function loops(reports: string): Record<"test" | "review" | "security", Loop> {
	const one = (phase: string): Loop => {
		const gen = maxGen(reports, phase);
		if (gen === 0) return null;
		const file = join(reports, `${phase}.${gen}.json`);
		const r = parseJson(file, "loops");
		if (!isObject(r)) die(`loops: ${file} is not a JSON object with a string verdict`);
		const { verdict } = r;
		if (!stringOrNull(verdict)) die(`loops: ${file} is not a JSON object with a string verdict`);
		return { generation: gen, verdict: verdict ?? null };
	};
	return { test: one("test"), review: one("review"), security: one("security") };
}

interface RunSignals {
	run: string;
	plan_generations: number;
	amendments: number;
	schema_failures: { count: number; lines: string[] };
	advisories: { adopted: number; rejected: number; unclassified: number; lines: { text: string; verdict: string }[]; mentioned: string[] };
	applied_requests: { packet: string; file: string }[];
	deviations: { packet: string; text: string }[];
	loops: Record<"test" | "review" | "security", Loop>;
	decisions: { user: number; auto: number; total: number };
}

function collectOne(dir: string): RunSignals {
	const lines = logLines(join(dir, "run.md"));
	// An advisory event: the event word of the Log line, after `- <date> `, is advisory.
	const advisoryEvent = (l: string) => /^- \S+\s+advisory\b/i.test(l);
	const advisories = lines.filter(advisoryEvent).map(text => ({
		text,
		verdict: (text.match(/\b(adopted|rejected)\b/i)?.[1].toLowerCase() ?? "unclassified") as string,
	}));
	const count = (verdict: string) => advisories.filter(a => a.verdict === verdict).length;
	const schema = lines.filter(l => /schema/i.test(l) && /\b(fail|invalid)/i.test(l));
	const decisionLines = existsSync(join(dir, "decisions.md")) ? readFileSync(join(dir, "decisions.md"), "utf8").split("\n") : [];
	const decidedBy = decisionLines.flatMap(l => {
		const m = /Decided by:\*\*\s*(.*)/.exec(l);
		return m ? [m[1]] : [];
	});
	const ch = changes(join(dir, "reports"));
	return {
		run: basename(dir.replace(/\/+$/, "")),
		plan_generations: maxGen(dir, "plan"),
		amendments: amendments(dir),
		schema_failures: { count: schema.length, lines: schema },
		advisories: {
			adopted: count("adopted"),
			rejected: count("rejected"),
			unclassified: count("unclassified"),
			lines: advisories,
			mentioned: lines.filter(l => /advisory/i.test(l) && !advisoryEvent(l)),
		},
		applied_requests: ch.flatMap(c =>
			c.files_changed
				.filter(f => f.includes("(applied request)"))
				.map(f => ({ packet: c.packet, file: f.replace(" (applied request)", "") })),
		),
		deviations: ch.flatMap(c => c.deviations.map(text => ({ packet: c.packet, text }))),
		loops: loops(join(dir, "reports")),
		decisions: {
			user: decidedBy.filter(b => b.startsWith("user")).length,
			auto: decidedBy.filter(b => b.startsWith("auto-adopted")).length,
			total: decisionLines.filter(l => l.startsWith("## D")).length,
		},
	};
}

function totals(runs: RunSignals[]) {
	const sum = (f: (r: RunSignals) => number) => runs.reduce((n, r) => n + f(r), 0);
	return {
		plan_generations: sum(r => r.plan_generations),
		amendments: sum(r => r.amendments),
		schema_failures: sum(r => r.schema_failures.count),
		advisories: {
			adopted: sum(r => r.advisories.adopted),
			rejected: sum(r => r.advisories.rejected),
			unclassified: sum(r => r.advisories.unclassified),
			mentioned: sum(r => r.advisories.mentioned.length),
		},
		applied_requests: sum(r => r.applied_requests.length),
		deviations: sum(r => r.deviations.length),
		loops: {
			test: sum(r => r.loops.test?.generation ?? 0),
			review: sum(r => r.loops.review?.generation ?? 0),
			security: sum(r => r.loops.security?.generation ?? 0),
		},
		decisions: {
			user: sum(r => r.decisions.user),
			auto: sum(r => r.decisions.auto),
			total: sum(r => r.decisions.total),
		},
	};
}

// Stable output: object keys sorted at every depth.
function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
	return v;
}

const [command, ...dirs] = process.argv.slice(2);
if (command !== "collect" || dirs.length === 0) {
	process.stderr.write(USAGE);
	process.exit(2);
}
for (const d of dirs) if (!isDir(d)) die(`not a directory: ${d}`);
const runs = dirs.map(collectOne);
const out = runs.length === 1 ? runs[0] : { runs, totals: totals(runs) };
process.stdout.write(`${JSON.stringify(sortKeys(out), null, 2)}\n`);
