#!/usr/bin/env -S BUN_BE_BUN=1 omp
// Retro collector: friction signals from finished factory run directories.
//
// Disk-derived only: counts and verbatim lines, no judgement. run.md Log lines
// are coordinator prose, not a schema, so every pattern-matched line is echoed
// verbatim and the factory-retro skill re-checks the classification.
//
// Generations order numerically (plan.10 > plan.9); only `<prefix>.<N>.json`
// counts, so sidecars (.md, .notes.md) never bump one.
// Any malformed input exits 2 naming the file, before anything is printed.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const USAGE = `usage: factory-retro.ts <command>
  collect <run-dir> [<run-dir>...]  print friction signals as JSON (one run: the run object; several: {runs, totals})
  report <run-dir> [<run-dir>...]   write <run-dir>/report.html (static, self-contained) per run; print each path
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

const phaseGens = (dir: string, prefix: string) => generations(dir, new RegExp(`^${prefix}\\.(\\d+)\\.json$`));
const CHANGE_REPORT = /^(.*?)\.change\.(\d+)\.json$/;

function readLines(file: string): string[] {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
}

// The `- ` lines under run.md's `## Log` heading, up to the next heading.
function logLines(runMd: string): string[] {
	const out: string[] = [];
	let inLog = false;
	for (const line of readLines(runMd)) {
		if (/^## Log\s*$/.test(line)) inLog = true;
		else if (inLog && /^##? /.test(line)) inLog = false;
		else if (inLog && line.startsWith("- ")) out.push(line);
	}
	return out;
}

// run.md `- **Key:** value` bullets before the first `##` heading.
function headerFields(runMd: string): { key: string; value: string }[] {
	const out: { key: string; value: string }[] = [];
	for (const line of readLines(runMd)) {
		if (line.startsWith("##")) break;
		const m = /^- \*\*(.+?):\*\*\s*(.*)$/.exec(line);
		if (m) out.push({ key: m[1], value: m[2] });
	}
	return out;
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

// A ChangeReport: deviations is missing, null, or an array of strings; status
// is missing, null, or a string.
function changeReport(file: string): { deviations: string[]; status: string | null } {
	const r = parseJson(file, "changes");
	if (!isObject(r) || !stringsOrNull(r.deviations) || !stringOrNull(r.status)) {
		die(`changes: ${file} is not a JSON object with string-array deviations and a string status`);
	}
	return { deviations: r.deviations ?? [], status: r.status ?? null };
}

// Each packet's latest ChangeReport deviations.
function deviations(reports: string): { packet: string; text: string }[] {
	const latest = new Map<string, string>();
	for (const { key, file } of generations(reports, CHANGE_REPORT)) latest.set(key, file);
	return [...latest.keys()]
		.sort(packetOrder)
		.flatMap(packet => changeReport(latest.get(packet)!).deviations.map(text => ({ packet, text })));
}

function verdictOf(file: string): string | null {
	const r = parseJson(file, "loops");
	if (!isObject(r)) die(`loops: ${file} is not a JSON object with a string verdict`);
	const { verdict } = r;
	if (!stringOrNull(verdict)) die(`loops: ${file} is not a JSON object with a string verdict`);
	return verdict ?? null;
}

type Loop = { generation: number; verdict: string | null } | null;
const PHASES = ["test", "review"] as const;

function loops(reports: string): Record<(typeof PHASES)[number], Loop> {
	const one = (phase: string): Loop => {
		const last = phaseGens(reports, phase).at(-1);
		return last ? { generation: last.gen, verdict: verdictOf(last.file) } : null;
	};
	return { test: one("test"), review: one("review") };
}

interface Decision {
	id: string;
	question: string;
	kind: string;
	decision: string;
	decided_by: string;
}

// decisions.md entries: `## <ID>: <question>` headings and their `- **Field:**` bullets.
function decisionEntries(lines: string[]): Decision[] {
	const out: Decision[] = [];
	let cur: Decision | null = null;
	for (const line of lines) {
		const h = /^## (\S+?):\s*(.*)$/.exec(line);
		if (h) {
			cur = { id: h[1], question: h[2], kind: "", decision: "", decided_by: "" };
			out.push(cur);
			continue;
		}
		if (line.startsWith("#")) {
			cur = null;
			continue;
		}
		const f = cur && /^- \*\*(Kind|Decision|Decided by):\*\*\s*(.*)$/.exec(line);
		if (cur && f) cur[f[1] === "Kind" ? "kind" : f[1] === "Decision" ? "decision" : "decided_by"] = f[2];
	}
	return out;
}

interface RunSignals {
	run: string;
	plan_generations: number;
	schema_failures: { count: number; lines: string[] };
	advisories: { adopted: number; rejected: number; unclassified: number; lines: { text: string; verdict: string }[]; mentioned: string[] };
	deviations: { packet: string; text: string }[];
	loops: Record<(typeof PHASES)[number], Loop>;
	decisions: { user: number; auto: number; total: number };
}

const runName = (dir: string) => basename(dir.replace(/\/+$/, ""));

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
	const decisionLines = readLines(join(dir, "decisions.md"));
	const decidedBy = decisionLines.flatMap(l => {
		const m = /Decided by:\*\*\s*(.*)/.exec(l);
		return m ? [m[1]] : [];
	});
	return {
		run: runName(dir),
		plan_generations: phaseGens(dir, "plan").at(-1)?.gen ?? 0,
		schema_failures: { count: schema.length, lines: schema },
		advisories: {
			adopted: count("adopted"),
			rejected: count("rejected"),
			unclassified: count("unclassified"),
			lines: advisories,
			mentioned: lines.filter(l => /advisory/i.test(l) && !advisoryEvent(l)),
		},
		deviations: deviations(join(dir, "reports")),
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
		schema_failures: sum(r => r.schema_failures.count),
		advisories: {
			adopted: sum(r => r.advisories.adopted),
			rejected: sum(r => r.advisories.rejected),
			unclassified: sum(r => r.advisories.unclassified),
			mentioned: sum(r => r.advisories.mentioned.length),
		},
		deviations: sum(r => r.deviations.length),
		loops: {
			test: sum(r => r.loops.test?.generation ?? 0),
			review: sum(r => r.loops.review?.generation ?? 0),
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

// ---- report ----

interface Packet {
	id: string;
	title: string;
	owns: string[];
	depends_on: string[];
	needs_design: unknown;
	contract: unknown;
	security_sensitive: unknown;
}

// Packets of the highest plan.<N>.json; null when there is no plan.
function latestPlan(dir: string): { gen: number; packets: Packet[] } | null {
	const last = phaseGens(dir, "plan").at(-1);
	if (!last) return null;
	const plan = parseJson(last.file, "plan");
	const bad = `plan: ${last.file} is not a JSON object with a packets array of objects with string ids`;
	if (!isObject(plan) || !Array.isArray(plan.packets)) die(bad);
	const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
	const packets = plan.packets.map((p: unknown) => {
		if (!isObject(p) || typeof p.id !== "string") die(bad);
		return {
			id: p.id,
			title: typeof p.title === "string" ? p.title : "",
			owns: strs(p.owns),
			depends_on: strs(p.depends_on),
			needs_design: p.needs_design,
			contract: p.contract,
			security_sensitive: p.security_sensitive,
		};
	});
	return { gen: last.gen, packets };
}

const esc = (s: unknown) =>
	String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// Cells: strings verbatim, null/undefined empty, anything else as JSON.
const table = (head: string[], rows: unknown[][]) =>
	`<table><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr>\n${rows
		.map(r => `<tr>${r.map(v => `<td>${esc(typeof v === "string" ? v : v == null ? "" : JSON.stringify(v))}</td>`).join("")}</tr>`)
		.join("\n")}</table>`;

// Depth 0 without depends_on, else 1 + max dep depth; unknown deps and cycles count as depth 0.
function depths(packets: Packet[]): Map<string, number> {
	const byId = new Map(packets.map(p => [p.id, p]));
	const memo = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (id: string): number => {
		if (memo.has(id)) return memo.get(id)!;
		const p = byId.get(id);
		if (!p || visiting.has(id)) return 0;
		visiting.add(id);
		const known = p.depends_on.filter(d => byId.has(d));
		const d = known.length === 0 ? 0 : 1 + Math.max(...known.map(depth));
		visiting.delete(id);
		memo.set(id, d);
		return d;
	};
	for (const p of packets) depth(p.id);
	return memo;
}

function dagSvg(packets: Packet[]): string {
	const W = 200, H = 44, GX = 60, GY = 20, PAD = 10;
	const depth = depths(packets);
	const rows = new Map<number, number>();
	const pos = new Map<string, { x: number; y: number }>();
	for (const p of packets) {
		const col = depth.get(p.id) ?? 0;
		const row = rows.get(col) ?? 0;
		rows.set(col, row + 1);
		pos.set(p.id, { x: PAD + col * (W + GX), y: PAD + row * (H + GY) });
	}
	const cols = Math.max(1, ...[...rows.keys()].map(c => c + 1));
	const maxRows = Math.max(1, ...rows.values());
	const width = PAD * 2 + cols * W + (cols - 1) * GX;
	const height = PAD * 2 + maxRows * H + (maxRows - 1) * GY;
	const edges = packets.flatMap(p =>
		p.depends_on.flatMap(d => {
			const a = pos.get(d), b = pos.get(p.id)!;
			return a ? [`<line x1="${a.x + W}" y1="${a.y + H / 2}" x2="${b.x}" y2="${b.y + H / 2}" marker-end="url(#arrow)"/>`] : [];
		}),
	);
	const boxes = packets.map(p => {
		const { x, y } = pos.get(p.id)!;
		const title = p.title.length > 30 ? `${p.title.slice(0, 29)}…` : p.title;
		return `<g><rect x="${x}" y="${y}" width="${W}" height="${H}" rx="4"/><text x="${x + 8}" y="${y + 18}" class="id">${esc(p.id)}</text><text x="${x + 8}" y="${y + 34}">${esc(title)}</text></g>`;
	});
	return [
		`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>`,
		...edges,
		...boxes,
		"</svg>",
	].join("\n");
}

const STYLE = `body{font:14px/1.4 system-ui,sans-serif;margin:2em;color:#222}
table{border-collapse:collapse;margin:.5em 0}th,td{border:1px solid #ccc;padding:3px 8px;text-align:left;vertical-align:top}
th{background:#f3f3f3}dt{font-weight:bold}dd{margin:0 0 .3em 1.5em}
svg rect{fill:#eef4ff;stroke:#4a6fa5}svg text{font:11px system-ui,sans-serif;fill:#222}svg text.id{font-weight:bold}
svg line{stroke:#888;stroke-width:1.2}svg marker path{fill:#888}`;

function reportHtml(dir: string): string {
	const run = runName(dir);
	const runMd = join(dir, "run.md");
	const reports = join(dir, "reports");
	const header = headerFields(runMd);
	const plan = latestPlan(dir);
	const loopRows = PHASES.flatMap(phase => phaseGens(reports, phase).map(g => [`${phase}.${g.gen}`, verdictOf(g.file)]));
	const changeRows = generations(reports, CHANGE_REPORT)
		.sort((a, b) => packetOrder(a.key, b.key) || a.gen - b.gen)
		.map(g => [g.key, g.gen, changeReport(g.file).status]);
	const decisions = decisionEntries(readLines(join(dir, "decisions.md")));
	const log = logLines(runMd);
	const body = [
		`<h1>${esc(run)}</h1>`,
		header.length ? `<dl>${header.map(f => `<dt>${esc(f.key)}</dt><dd>${esc(f.value)}</dd>`).join("")}</dl>` : "",
		plan ? `<h2>Packets (plan.${plan.gen})</h2>` : "<h2>Packets</h2>",
		plan
			? [
					dagSvg(plan.packets),
					table(
						["id", "title", "owns", "depends_on", "needs_design", "contract", "security_sensitive"],
						plan.packets.map(p => [p.id, p.title, p.owns.join(", "), p.depends_on.join(", "), p.needs_design, p.contract, p.security_sensitive]),
					),
				].join("\n")
			: "<p>no plan</p>",
		"<h2>Loops</h2>",
		loopRows.length ? table(["report", "verdict"], loopRows) : "<p>no test or review reports</p>",
		changeRows.length ? table(["packet", "change generation", "status"], changeRows) : "<p>no change reports</p>",
		"<h2>Decisions</h2>",
		decisions.length
			? table(["id", "question", "Kind", "Decision", "Decided by"], decisions.map(d => [d.id, d.question, d.kind, d.decision, d.decided_by]))
			: "<p>no decisions</p>",
		"<h2>Log</h2>",
		log.length ? `<ul>\n${log.map(l => `<li>${esc(l.slice(2))}</li>`).join("\n")}\n</ul>` : "<p>no log lines</p>",
	];
	return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${esc(run)}</title><style>\n${STYLE}\n</style></head><body>\n${body.filter(Boolean).join("\n")}\n</body></html>\n`;
}

const [command, ...dirs] = process.argv.slice(2);
if ((command !== "collect" && command !== "report") || dirs.length === 0) {
	process.stderr.write(USAGE);
	process.exit(2);
}
for (const d of dirs) if (!isDir(d)) die(`not a directory: ${d}`);
if (command === "collect") {
	const runs = dirs.map(collectOne);
	const out = runs.length === 1 ? runs[0] : { runs, totals: totals(runs) };
	process.stdout.write(`${JSON.stringify(sortKeys(out), null, 2)}\n`);
} else {
	// Render every run before writing any, so malformed input writes nothing.
	const pages = dirs.map(d => ({ file: join(d, "report.html"), html: reportHtml(d) }));
	for (const { file, html } of pages) {
		writeFileSync(file, html);
		process.stdout.write(`${file}\n`);
	}
}
