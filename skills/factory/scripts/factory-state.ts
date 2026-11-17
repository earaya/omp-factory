#!/usr/bin/env -S BUN_BE_BUN=1 omp
// Coordinator state helper: disk-derived factory-run facts, so the playbook
// never hand-runs or hand-transcribes these recipes. Run from the repo root.
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
  loops <run-dir> <test|review|security>  persisted fix-loop count and ladder tier
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

// Fix loops derive from the persisted reports: the phase's Nth fix loop is
// triggered by its Nth failing report, so failing count = pending loop; a
// passing latest report closes the phase. Generations order numerically.
function loops(run: string, phase: string): void {
	const bad = phase === "test" ? "fail" : phase === "review" || phase === "security" ? "changes_requested" : undefined;
	if (bad === undefined) die("phase must be test, review, or security");
	const reports = join(run, "reports");
	const pattern = new RegExp(`^${phase}\\.(\\d+)\\.json$`);
	const gens = existsSync(reports)
		? readdirSync(reports).flatMap(f => {
				const m = pattern.exec(f);
				return m ? [{ gen: Number(m[1]), file: join(reports, f) }] : [];
			})
		: [];
	gens.sort((a, b) => a.gen - b.gen);
	let failing = 0;
	let latestBad: boolean | undefined;
	for (const { file } of gens) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			die(`loops: ${file} is not valid JSON`);
		}
		const verdict = typeof parsed === "object" && parsed !== null && "verdict" in parsed ? parsed.verdict : undefined;
		latestBad = verdict === bad;
		if (latestBad) failing++;
	}
	if (latestBad === undefined) {
		console.log(`${phase} fix loops: 0 completed, no pending attempt — autonomous (loops 1-3)`);
	} else if (!latestBad) {
		console.log(`${phase} fix loops: ${failing} completed, phase closed — next report opens loop ${failing + 1}`);
	} else {
		const tier =
			failing <= 3 ? "autonomous (loops 1-3)" : failing <= 5 ? "coordinator-approved (loops 4-5)" : "user approval (6th attempt)";
		console.log(`${phase} fix loops: ${failing - 1} completed, pending attempt = loop ${failing} — ${tier}`);
	}
}

const commands: Record<string, [string[], (...args: string[]) => void]> = {
	freeze: [["run-dir"], freeze],
	verify: [["run-dir"], verify],
	snapshot: [["run-dir", "wave"], snapshot],
	changed: [["run-dir", "wave"], changed],
	coverage: [["run-dir", "base"], coverage],
	loops: [["run-dir", "phase"], loops],
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
