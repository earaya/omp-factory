#!/usr/bin/env -S BUN_BE_BUN=1 omp
// Coordinator state helper: disk-derived factory-run facts and WorkPlan checks,
// so the playbook never hand-runs or hand-transcribes these recipes. Run from
// the repo root.
//
// A record line is one `git status --porcelain=v1 -z --untracked-files=all`
// entry: `<XY>\t<path>\t<sha>` (`deleted` for deletions), plus `\t<orig>` for
// R/C entries, whose second NUL field belongs to the same entry. Paths escape
// `\`, tab, and newline so the record stays one entry per line.
//
// No `log` command: a script cannot see tool-call results, so
// spawn/persist/log ordering stays a coordinator rule.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = `usage: factory-state.ts <command>
  freeze <run-dir>             write reports/freeze.txt, print its sha
  verify <run-dir>             tree == freeze? exit 0, or exit 1 (stale)
  snapshot <run-dir> <wave>    write reports/status-wave-<wave>.before
  changed <run-dir> <wave>     print escaped paths the wave changed since its snapshot
  coverage <run-dir> <base>    every freeze path is in the diff vs base? exit 0, or exit 1 listing defects
  loops <run-dir> <test|review>  persisted fix-loop count and ladder tier
  validate <plan.json>         plan structure ok? exit 0, or exit 1 listing defects
  waves <plan.json>            print the plan's waves, one line each
  status <run-dir>             print derived run state, one key: value line each
`;

function die(message: string): never {
	process.stderr.write(`factory-state: ${message}\n`);
	process.exit(2);
}

function git(args: string[]): string {
	const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
	if (r.status !== 0) die(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
	return r.stdout;
}

const escapePath = (p: string) => p.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");

const blobSha = (text: string) =>
	createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function record(): string {
	const fields = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
	const hash = (path: string) => git(["hash-object", "--", path]).trim();
	let out = "";
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i];
		if (entry === "") continue;
		const xy = entry.slice(0, 2);
		const path = entry.slice(3);
		const renamed = xy[0] === "R" || xy[0] === "C";
		const orig = renamed ? (fields[++i] ?? "") : "";
		if (xy.includes("D")) out += `${xy}\t${escapePath(path)}\tdeleted\n`;
		else if (renamed) out += `${xy}\t${escapePath(path)}\t${hash(path)}\t${escapePath(orig)}\n`;
		else if (isFile(path)) out += `${xy}\t${escapePath(path)}\t${hash(path)}\n`;
	}
	return out;
}

const lines = (text: string) => text.split("\n").filter(l => l !== "");
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function requireDir(dir: string): void {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`not a directory: ${dir}`);
}

function readRequired(path: string, what: string): string {
	if (!existsSync(path)) die(`no ${what}: ${path}`);
	return readFileSync(path, "utf8");
}

function freeze(run: string): void {
	requireDir(run);
	mkdirSync(join(run, "reports"), { recursive: true });
	const text = record();
	writeFileSync(join(run, "reports", "freeze.txt"), text);
	console.log(blobSha(text));
}

function verify(run: string): void {
	const frozen = readRequired(join(run, "reports", "freeze.txt"), "freeze record");
	const fresh = record();
	if (fresh === frozen) {
		console.log(`tree == freeze: ${blobSha(fresh)}`);
		return;
	}
	process.stderr.write(`stale: tree differs from ${join(run, "reports", "freeze.txt")} (fresh sha: ${blobSha(fresh)})\n`);
	process.exit(1);
}

function snapshot(run: string, wave: string): void {
	requireDir(run);
	mkdirSync(join(run, "reports"), { recursive: true });
	writeFileSync(join(run, "reports", `status-wave-${wave}.before`), record());
}

// Escaped paths whose record line was added, removed, or changed since the
// wave's snapshot: what the wave touched, earlier waves' edits excluded.
function changed(run: string, wave: string): void {
	const before = new Set(lines(readRequired(join(run, "reports", `status-wave-${wave}.before`), "snapshot")));
	const after = new Set(lines(record()));
	const paths = new Set<string>();
	for (const l of before) if (!after.has(l)) paths.add(l.split("\t")[1]);
	for (const l of after) if (!before.has(l)) paths.add(l.split("\t")[1]);
	for (const p of [...paths].sort(byCodeUnit)) console.log(p);
}

// Pre-review check: every freeze path (field 2; renamed-from is metadata) is in
// `git diff --name-only <base>` or the untracked set, compared escaped; a
// tracked entry needs a non-empty diff. Exit 1 lists each defect.
function coverage(run: string, base: string): void {
	const frozen = lines(readRequired(join(run, "reports", "freeze.txt"), "freeze record"));
	const covered = new Set(
		[
			...git(["diff", "--name-only", "-z", base]).split("\0"),
			...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
		]
			.filter(p => p !== "")
			.map(escapePath),
	);
	const defects: string[] = [];
	let tracked = false;
	for (const line of frozen) {
		const [xy, path] = line.split("\t");
		if (xy !== "??") tracked = true;
		if (!covered.has(path)) defects.push(`not covered: ${path}`);
	}
	if (tracked && git(["diff", "--stat", base]).trim() === "") {
		defects.push(`tracked entries in freeze but git diff --stat ${base} is empty`);
	}
	if (defects.length > 0) {
		process.stderr.write(defects.map(d => `${d}\n`).join(""));
		process.exit(1);
	}
	console.log("coverage ok");
}

type Report = { gen: number; file: string };

// Generation files in dir matching `<prefix>.<N>.json`, numeric order.
function generations(dir: string, prefix: string): Report[] {
	const pattern = new RegExp(`^${prefix}\\.(\\d+)\\.json$`);
	const gens = existsSync(dir)
		? readdirSync(dir).flatMap(f => {
				const m = pattern.exec(f);
				return m ? [{ gen: Number(m[1]), file: join(dir, f) }] : [];
			})
		: [];
	return gens.sort((a, b) => a.gen - b.gen);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		die(`${file} is not valid JSON`);
	}
}

const failVerdict: Record<string, string> = { test: "fail", review: "changes_requested" };

// Fix loops derive from the persisted reports: the phase's Nth fix loop is
// triggered by its Nth failing report, so failing count = pending loop; a
// passing latest report closes the phase. Generations order numerically.
function phaseState(run: string, phase: string): { failing: number; latest?: { gen: number; verdict: unknown; bad: boolean } } {
	let failing = 0;
	let latest: { gen: number; verdict: unknown; bad: boolean } | undefined;
	for (const { gen, file } of generations(join(run, "reports"), phase)) {
		const parsed = readJson(file);
		const verdict = typeof parsed === "object" && parsed !== null && "verdict" in parsed ? parsed.verdict : undefined;
		latest = { gen, verdict, bad: verdict === failVerdict[phase] };
		if (latest.bad) failing++;
	}
	return { failing, latest };
}

function loops(run: string, phase: string): void {
	if (!Object.hasOwn(failVerdict, phase)) die("phase must be test or review");
	const { failing, latest } = phaseState(run, phase);
	if (latest === undefined) {
		console.log(`${phase} fix loops: 0 completed, no pending attempt — autonomous (loops 1-3)`);
	} else if (!latest.bad) {
		console.log(`${phase} fix loops: ${failing} completed, phase closed — next report opens loop ${failing + 1}`);
	} else {
		const tier = failing <= 3 ? "autonomous (loops 1-3)" : `ask the user (loop ${failing} > 3)`;
		console.log(`${phase} fix loops: ${failing - 1} completed, pending attempt = loop ${failing} — ${tier}`);
	}
}

type Packet = {
	id: string;
	owns: string[];
	shares: string[];
	requests: string[];
	reads: string[];
	depends_on: string[];
	contract: boolean;
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

// P10 after P9: numeric suffix first, then code-unit order.
const byId = (a: string, b: string) => {
	const num = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
	return num(a) - num(b) || byCodeUnit(a, b);
};

function loadPlan(path: string): Packet[] {
	if (!isFile(path)) die(`no plan: ${path}`);
	const parsed = readJson(path);
	const packets = typeof parsed === "object" && parsed !== null && "packets" in parsed ? parsed.packets : undefined;
	if (!Array.isArray(packets)) die(`${path} has no packets array`);
	return packets.map((p: Record<string, unknown>) => ({
		id: String(p?.id),
		owns: strings(p?.owns),
		shares: strings(p?.shares),
		requests: Array.isArray(p?.requests)
			? p.requests.flatMap((r: unknown) =>
					typeof r === "object" && r !== null && "file" in r && typeof r.file === "string" ? [r.file] : [],
				)
			: [],
		reads: strings(p?.reads),
		depends_on: strings(p?.depends_on),
		contract: p?.contract === true,
	}));
}

// Unknown/self depends_on and cycles. Cycles name their ids, deduplicated by rotation.
function dependencyDefects(packets: Packet[]): string[] {
	const byKey = new Map(packets.map(p => [p.id, p]));
	const defects: string[] = [];
	for (const p of packets) {
		for (const d of p.depends_on) {
			if (d === p.id) defects.push(`${p.id} depends_on itself`);
			else if (!byKey.has(d)) defects.push(`${p.id} depends_on unknown id ${d}`);
		}
	}
	const state = new Map<string, "open" | "done">();
	const stack: string[] = [];
	const seen = new Set<string>();
	const visit = (id: string) => {
		state.set(id, "open");
		stack.push(id);
		for (const d of byKey.get(id)?.depends_on ?? []) {
			if (d === id || !byKey.has(d)) continue;
			if (state.get(d) === "open") {
				const cycle = stack.slice(stack.indexOf(d));
				const start = cycle.indexOf([...cycle].sort(byId)[0]);
				const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
				const key = rotated.join(" ");
				if (!seen.has(key)) {
					seen.add(key);
					defects.push(`dependency cycle: ${[...rotated, rotated[0]].join(" -> ")}`);
				}
			} else if (!state.has(d)) visit(d);
		}
		stack.pop();
		state.set(id, "done");
	};
	for (const id of [...byKey.keys()].sort(byId)) if (!state.has(id)) visit(id);
	return defects;
}

// `- <paths>: <cmd>` lines under `## Generated` in .omp/RULES.md; paths are the
// backtick-quoted tokens before the first `: `.
function generatedEntries(): string[] {
	const rules = join(".omp", "RULES.md");
	if (!isFile(rules)) return [];
	const entries: string[] = [];
	let inside = false;
	for (const line of readFileSync(rules, "utf8").split("\n")) {
		if (/^#/.test(line)) {
			inside = /^##\s+Generated\s*$/.test(line);
			continue;
		}
		if (!inside || !line.startsWith("- ")) continue;
		const colon = line.indexOf(": ");
		if (colon < 0) continue;
		for (const m of line.slice(2, colon).matchAll(/`([^`]+)`/g)) entries.push(m[1]);
	}
	return entries;
}

function validate(path: string): void {
	const packets = loadPlan(path);
	const generated = generatedEntries().map(e => ({ entry: e, glob: new Bun.Glob(e) }));
	const defects: string[] = [];

	const counts = new Map<string, number>();
	for (const p of packets) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
	for (const [id, n] of counts) if (n > 1) defects.push(`duplicate packet id: ${id}`);

	const owner = new Map<string, string>();
	for (const p of packets) {
		for (const f of new Set(p.owns)) {
			const prev = owner.get(f);
			if (prev === undefined) owner.set(f, p.id);
			else if (prev !== p.id) defects.push(`${f}: owned by ${prev} and ${p.id}`);
		}
	}
	for (const p of packets) {
		for (const [list, verb] of [[p.shares, "shared"], [p.requests, "requested"]] as const) {
			for (const f of new Set(list)) {
				const o = owner.get(f);
				if (o !== undefined && o !== p.id) defects.push(`${f}: owned by ${o} and ${verb} by ${p.id}`);
			}
		}
		for (const [list, verb] of [[p.owns, "owns"], [p.shares, "shares"]] as const) {
			for (const f of new Set(list)) {
				const g = generated.find(g => g.entry === f || g.glob.match(f));
				if (g !== undefined) defects.push(`${f}: ${p.id} ${verb} a Generated path (${g.entry}); list it in requests`);
			}
		}
	}

	defects.push(...dependencyDefects(packets));

	const byKey = new Map(packets.map(p => [p.id, p]));
	const ancestors = new Map<string, Set<string>>();
	const ancestorsOf = (id: string): Set<string> => {
		const memo = ancestors.get(id);
		if (memo) return memo;
		const out = new Set<string>();
		ancestors.set(id, out); // set before recursing: cycles terminate
		for (const d of byKey.get(id)?.depends_on ?? []) {
			if (!byKey.has(d)) continue;
			out.add(d);
			for (const a of ancestorsOf(d)) out.add(a);
		}
		return out;
	};
	const contracts = packets.filter(p => p.contract);
	for (const c of contracts) {
		if (c.depends_on.length > 0) defects.push(`contract packet ${c.id} has depends_on: ${c.depends_on.join(" ")}`);
	}
	for (const p of packets) {
		for (const c of contracts) {
			if (c.id === p.id || ancestorsOf(p.id).has(c.id)) continue;
			for (const f of new Set(p.reads)) {
				if (c.owns.includes(f)) defects.push(`${p.id} reads ${f} owned by contract packet ${c.id} without depending on it`);
			}
		}
	}

	if (defects.length > 0) {
		process.stderr.write(defects.map(d => `${d}\n`).join(""));
		process.exit(1);
	}
	console.log(`plan ok: ${packets.length} packets`);
}

// Wave = 1 + max dependency wave; then, per wave, a packet sharing or
// requesting a file with a lower-id packet in the same wave moves down one,
// dependents follow, until stable.
function waves(path: string): void {
	const packets = loadPlan(path);
	const deps = dependencyDefects(packets);
	if (deps.length > 0) {
		process.stderr.write(deps.map(d => `${d}\n`).join(""));
		process.exit(1);
	}
	const ids = [...new Set(packets.map(p => p.id))].sort(byId);
	const byKey = new Map(packets.map(p => [p.id, p]));
	const touched = new Map(ids.map(id => [id, new Set([...byKey.get(id)!.shares, ...byKey.get(id)!.requests])]));
	const floor = new Map(ids.map(id => [id, 0]));
	const wave = new Map<string, number>();
	for (;;) {
		wave.clear();
		const waveOf = (id: string): number => {
			const known = wave.get(id);
			if (known !== undefined) return known;
			const w = Math.max(floor.get(id)!, ...byKey.get(id)!.depends_on.map(d => waveOf(d) + 1));
			wave.set(id, w);
			return w;
		};
		for (const id of ids) waveOf(id);
		let moved = false;
		const kept = new Map<number, string[]>();
		for (const id of ids) {
			const w = wave.get(id)!;
			const peers = kept.get(w) ?? [];
			if (peers.some(o => [...touched.get(id)!].some(f => touched.get(o)!.has(f)))) {
				floor.set(id, w + 1);
				moved = true;
			} else kept.set(w, [...peers, id]);
		}
		if (!moved) break;
	}
	const rows = new Map<number, string[]>();
	for (const id of ids) rows.set(wave.get(id)!, [...(rows.get(wave.get(id)!) ?? []), id]);
	for (const w of [...rows.keys()].sort((a, b) => a - b)) console.log(`wave ${w}: ${rows.get(w)!.join(" ")}`);
}

// Highest generation per packet among `<P>.<infix><N>.json` files in dir.
function latestPerPacket(dir: string, infix: string): string {
	const pattern = new RegExp(`^([^.]+)\\.${infix}(\\d+)\\.json$`);
	const best = new Map<string, number>();
	if (existsSync(dir)) {
		for (const f of readdirSync(dir)) {
			const m = pattern.exec(f);
			if (m) best.set(m[1], Math.max(best.get(m[1]) ?? 0, Number(m[2])));
		}
	}
	const out = [...best.keys()].sort(byId).map(p => `${p}.${best.get(p)}`);
	return out.length > 0 ? out.join(" ") : "none";
}

function status(run: string): void {
	requireDir(run);
	const reports = join(run, "reports");
	const plan = generations(run, "plan").at(-1);
	console.log(`plan: ${plan ? `plan.${plan.gen}` : "none"}`);
	console.log(`designs: ${latestPerPacket(join(run, "designs"), "")}`);
	console.log(`changes: ${latestPerPacket(reports, "change\\.")}`);
	const phases = ["test", "review"].map(phase => ({ phase, ...phaseState(run, phase) }));
	for (const { phase, latest } of phases) {
		console.log(`${phase}: ${latest ? `${phase}.${latest.gen} ${String(latest.verdict ?? "no verdict")}` : "none"}`);
	}
	console.log(`loops: ${phases.map(p => `${p.phase} ${p.failing}`).join(" · ")}`);
	const freezeFile = join(reports, "freeze.txt");
	const frozen = isFile(freezeFile) ? readFileSync(freezeFile, "utf8") : undefined;
	console.log(`freeze: ${frozen === undefined ? "none" : blobSha(frozen)}`);
	console.log(`tree: ${frozen === undefined ? "no freeze" : record() === frozen ? "matches freeze" : "stale"}`);
}

const commands: Record<string, [string[], (...args: string[]) => void]> = {
	freeze: [["run-dir"], freeze],
	verify: [["run-dir"], verify],
	snapshot: [["run-dir", "wave"], snapshot],
	changed: [["run-dir", "wave"], changed],
	coverage: [["run-dir", "base"], coverage],
	loops: [["run-dir", "phase"], loops],
	validate: [["plan.json"], validate],
	waves: [["plan.json"], waves],
	status: [["run-dir"], status],
};

const [name, ...args] = process.argv.slice(2);
const command = name === undefined ? undefined : commands[name];
if (command === undefined) {
	process.stderr.write(USAGE);
	process.exit(2);
}
const [params, run] = command;
if (args.length < params.length) die(`${name}: missing ${params.slice(args.length).join(", ")}`);
run(...args);
