#!/usr/bin/env -S BUN_BE_BUN=1 omp
// Structural check of a factory spec directory: spec.md, decisions.md, and
// roadmap.md exist; every ledger entry has Kind and Decision, open ones a
// Recommendation, superseded ones a real successor; every D<n>/R<n> cited
// exists; every roadmap run has Goal, Scope, and Acceptance. Judgment checks
// (acceptance within scope, stale text) stay in the playbook.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const USAGE = "usage: factory-spec.ts check <spec-dir>\n";

function die(message: string): never {
	process.stderr.write(`factory-spec: ${message}\n`);
	process.exit(2);
}

interface Section {
	id: string;
	body: string;
}

// `## <prefix><n>...` headings and the text under each, up to the next `## `.
function sections(text: string, prefix: string): Section[] {
	const out: Section[] = [];
	const heading = new RegExp(`^## (${prefix}\\d+)\\b`);
	let current: Section | undefined;
	for (const line of text.split("\n")) {
		const m = heading.exec(line);
		if (m) {
			current = { id: m[1], body: "" };
			out.push(current);
		} else if (line.startsWith("## ")) {
			current = undefined;
		} else if (current) {
			current.body += `${line}\n`;
		}
	}
	return out;
}

const field = (body: string, name: string) => new RegExp(`^- \\*\\*${name}[^*]*:\\*\\*\\s*(.*)$`, "m").exec(body)?.[1];

// R1-R4 style ranges count both ends as cited.
const cited = (text: string, prefix: string) => new Set(text.match(new RegExp(`\\b${prefix}\\d+\\b`, "g")) ?? []);

const [command, dir] = process.argv.slice(2);
if (command !== "check" || dir === undefined) {
	process.stderr.write(USAGE);
	process.exit(2);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`not a directory: ${dir}`);
const files = ["spec.md", "decisions.md", "roadmap.md"].map(f => join(dir, f));
for (const f of files) if (!existsSync(f)) die(`missing ${f}`);
const [spec, ledger, roadmap] = files.map(f => readFileSync(f, "utf8"));

const defects: string[] = [];
const decisions = sections(ledger, "D");
const runs = sections(roadmap, "R");
const decisionIds = new Set(decisions.map(d => d.id));
const runIds = new Set(runs.map(r => r.id));
const open: string[] = [];

if (decisions.length === 0) defects.push("decisions.md: no `## D<n>` entries");
for (const d of decisions) {
	if (field(d.body, "Kind") === undefined) defects.push(`decisions.md ${d.id}: no Kind`);
	const decision = field(d.body, "Decision");
	if (decision === undefined) {
		defects.push(`decisions.md ${d.id}: no Decision`);
		continue;
	}
	if (/^open\b/i.test(decision)) {
		open.push(d.id);
		if (field(d.body, "Recommendation") === undefined) defects.push(`decisions.md ${d.id}: open without a Recommendation`);
	}
	const successor = /superseded by (D\d+)/i.exec(decision)?.[1];
	if (successor && !decisionIds.has(successor)) defects.push(`decisions.md ${d.id}: superseded by unknown ${successor}`);
}

if (runs.length === 0) defects.push("roadmap.md: no `## R<n>:` runs");
for (const r of runs) {
	for (const name of ["Goal", "Scope", "Acceptance"]) {
		if (field(r.body, name) === undefined) defects.push(`roadmap.md ${r.id}: no ${name}`);
	}
}

for (const [name, text] of [["spec.md", spec], ["roadmap.md", roadmap]] as const) {
	for (const id of cited(text, "D")) if (!decisionIds.has(id)) defects.push(`${name}: cites ${id}, not in decisions.md`);
	for (const id of cited(text, "R")) if (!runIds.has(id)) defects.push(`${name}: cites ${id}, not a roadmap run`);
}

if (defects.length > 0) {
	process.stderr.write([...new Set(defects)].map(d => `${d}\n`).join(""));
	process.exit(1);
}
console.log(`spec ok: ${decisions.length} decisions (${open.length} open${open.length ? `: ${open.join(", ")}` : ""}), ${runs.length} runs`);
