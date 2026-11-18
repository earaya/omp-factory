import { describe, expect, test, afterEach } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Covers skills/factory-retro/scripts/factory-retro.ts, the retro collector.
// Fixture run dirs live in mkdtemp, never this tree.
const SCRIPT = join(import.meta.dir, "..", "skills", "factory-retro", "scripts", "factory-retro.ts");

// allowlist, never a process.env spread
function fixtureEnv(root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		TMPDIR: process.env.TMPDIR ?? "",
		HOME: root,
	};
}

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function mkRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "factory-retro-"));
	dirs.push(root);
	return root;
}

function mkRun(root: string, name: string, files: Record<string, string> = {}): string {
	const run = join(root, name);
	mkdirSync(run, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(run, path)), { recursive: true });
		writeFileSync(join(run, path), content);
	}
	return run;
}

const run = (root: string, ...args: string[]) =>
	spawnSync(SCRIPT, args, { cwd: root, env: fixtureEnv(root), encoding: "utf8" });

const collect = (root: string, ...runs: string[]) =>
	JSON.parse(execFileSync(SCRIPT, ["collect", ...runs], { cwd: root, env: fixtureEnv(root), encoding: "utf8" }));

const runMd = (log: string[], tail = "") =>
	["# Run: x", "", "## Files", "", "- not a log line, before the heading", "", "## Log", "", ...log, tail].join("\n") + "\n";

const empty = (name: string) => ({
	run: name,
	plan_generations: 0,
	schema_failures: { count: 0, lines: [] },
	advisories: { adopted: 0, rejected: 0, unclassified: 0, lines: [], mentioned: [] },
	deviations: [],
	loops: { test: null, review: null },
	decisions: { user: 0, auto: 0, total: 0 },
});

describe("factory-retro.ts usage", () => {
	test("no command or no run dir: usage on stderr, exit 2", () => {
		const root = mkRoot();
		for (const args of [[], ["collect"], ["report"], ["bogus"]]) {
			const r = run(root, ...args);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toContain("usage: factory-retro.ts");
		}
	});

	test("missing run dir: exit 2, stderr names it, nothing on stdout", () => {
		for (const command of ["collect", "report"]) {
			const root = mkRoot();
			const good = mkRun(root, "good");
			const missing = join(root, "no-such-run");
			const r = run(root, command, good, missing);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toContain(missing);
			expect(existsSync(join(good, "report.html"))).toBe(false);
		}
	});
});

describe("factory-retro.ts collect", () => {
	test("empty run dir: all counts 0, loops null, exit 0", () => {
		const root = mkRoot();
		const r = run(root, "collect", mkRun(root, "empty-run"));
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(empty("empty-run"));
	});

	test("output is stable: sorted keys", () => {
		const root = mkRoot();
		const out = run(root, "collect", mkRun(root, "r")).stdout;
		expect(Object.keys(JSON.parse(out))).toEqual([
			"advisories", "decisions", "deviations", "loops", "plan_generations", "run", "schema_failures",
		]);
		expect(run(root, "collect", join(root, "r") + "/").stdout).toBe(out); // trailing slash: same run name
	});

	test("plan_generations orders numerically; sidecars do not count", () => {
		const root = mkRoot();
		const r = mkRun(root, "r", {
			"plan.9.json": "{}",
			"plan.10.json": "{}",
			"plan.11.md": "",
			"plan.12.amendments.json": "[]",
			"plan.x.json": "{}",
		});
		expect(collect(root, r).plan_generations).toBe(10);
	});

	test("changes: a non-JSON, non-object, or mistyped ChangeReport fails the collect with exit 2, naming the file", () => {
		const valid = JSON.stringify({ files_changed: ["a.go"], deviations: [], status: "done" });
		const bad = [
			"not json",
			JSON.stringify([{ deviations: [] }]),
			JSON.stringify({ deviations: "used X" }),
			JSON.stringify({ deviations: ["ok", 3] }),
			JSON.stringify({ deviations: [], status: 1 }),
		];
		for (const content of bad) {
			const root = mkRoot();
			const ok = mkRun(root, "ok");
			const r = mkRun(root, "r", { "reports/P1.change.1.json": content, "reports/P2.change.1.json": valid });
			for (const runs of [[r], [ok, r], [r, ok]]) {
				const res = run(root, "collect", ...runs);
				expect(res.status).toBe(2);
				expect(res.stdout).toBe("");
				expect(res.stderr).toContain("P1.change.1.json");
			}
		}
	});

	test("changes: a missing or null deviations counts as empty", () => {
		const root = mkRoot();
		const r = mkRun(root, "r", {
			"reports/P1.change.1.json": JSON.stringify({ deviations: null }),
			"reports/P2.change.1.json": JSON.stringify({}),
		});
		expect(collect(root, r).deviations).toEqual([]);
	});

	test("loops: a non-JSON, non-object, or non-string-verdict phase report fails the collect with exit 2, naming the file", () => {
		const bad = ["not json", JSON.stringify(["approve"]), JSON.stringify({ verdict: 1 }), JSON.stringify({ verdict: ["approve"] })];
		for (const content of bad) {
			const root = mkRoot();
			const ok = mkRun(root, "ok");
			const r = mkRun(root, "r", { "reports/review.1.json": content });
			for (const runs of [[r], [ok, r], [r, ok]]) {
				const res = run(root, "collect", ...runs);
				expect(res.status).toBe(2);
				expect(res.stdout).toBe("");
				expect(res.stderr).toContain("review.1.json");
			}
		}
	});

	test("loops: a missing or null verdict is null", () => {
		const root = mkRoot();
		const r = mkRun(root, "r", { "reports/test.1.json": JSON.stringify({}), "reports/review.2.json": JSON.stringify({ verdict: null }) });
		const out = collect(root, r);
		expect(out.loops.test).toEqual({ generation: 1, verdict: null });
		expect(out.loops.review).toEqual({ generation: 2, verdict: null });
	});

	test("only `- ` lines after the ## Log heading are read", () => {
		const root = mkRoot();
		const r = mkRun(root, "r", {
			"run.md": [
				"# Run: x",
				"- advisory (blocker) adopted, before the Log heading",
				"## Log",
				"- 2026-11-16 advisory (blocker) adopted: counted",
				"  - advisory (blocker) adopted: indented, not a log line",
				"advisory adopted: no bullet",
			].join("\n") + "\n",
		});
		expect(collect(root, r).advisories.lines).toEqual([
			{ verdict: "adopted", text: "- 2026-11-16 advisory (blocker) adopted: counted" },
		]);
	});

	test("the Log section ends at the next heading", () => {
		const root = mkRoot();
		const r = mkRun(root, "r", {
			"run.md": runMd(
				["- 2026-11-16 advisory (blocker) adopted: in the Log"],
				"## Notes\n\n- 2026-11-16 advisory (blocker) rejected: after the Log\n- 2026-11-16 plan.2: yield failed schema, after the Log\n",
			),
		});
		const out = collect(root, r);
		expect(out.advisories.lines).toEqual([
			{ verdict: "adopted", text: "- 2026-11-16 advisory (blocker) adopted: in the Log" },
		]);
		expect(out.schema_failures.count).toBe(0);
	});

	test("schema_failures: schema plus a fail*/invalid* word; schema-valid alone does not count", () => {
		const root = mkRoot();
		const hits = [
			"- 2026-11-16 plan.2: first gen-2 yield failed schema (decisions missing); planner re-yielded, schema valid.",
			"- 2026-11-16 test.1: SCHEMA check Failed on yield",
			"- 2026-11-16 review.1: report invalid against the output schema",
		];
		const misses = [
			"- 2026-11-16 preflight: reviewer returned a schema-valid yield",
			"- 2026-11-16 preflight: reviewer failed 4 times: no yield tool call",
			"- 2026-11-16 wave 1: schema unfailing", // fail not at a word start
		];
		const r = mkRun(root, "r", { "run.md": runMd([...hits, ...misses]) });
		expect(collect(root, r).schema_failures).toEqual({ count: 3, lines: hits });
	});

	test("advisories: count only advisory events; first of adopted/rejected wins; neither is unclassified", () => {
		const root = mkRoot();
		const lines = [
			"- 2026-11-16 advisory (concern): point 1 adopted. Point 2 rejected: reasons.",
			"- 2026-11-16 advisory (blocker) rejected: D9 stays auto-adopted",
			"- 2026-11-16 advisory (blocker), Adopted after verification",
			"- 2026-11-16 advisory (nit): noted, no action",
			"- 2026-11-16 Advisory (blocker) adopted: capitalized event word still counts",
			"- 2026-11-16 plan.2: schema valid. Advisory rejected: embedded in another event, mentioned only",
			"- 2026-11-16 wave 0: P1 done, D9 auto-adopted. advisory (interceptor field) rejected",
			"- 2026-11-16 wave 1: P2 done, D9 auto-adopted",
		];
		const r = mkRun(root, "r", { "run.md": runMd(lines) });
		expect(collect(root, r).advisories).toEqual({
			adopted: 3,
			rejected: 1,
			unclassified: 1,
			lines: [
				{ verdict: "adopted", text: lines[0] },
				{ verdict: "rejected", text: lines[1] },
				{ verdict: "adopted", text: lines[2] },
				{ verdict: "unclassified", text: lines[3] },
				{ verdict: "adopted", text: lines[4] },
			],
			mentioned: [lines[5], lines[6]],
		});
	});

	test("deviations come from each packet's latest ChangeReport only", () => {
		const root = mkRoot();
		const change = (deviations: string[]) => JSON.stringify({ files_changed: [], deviations });
		const r = mkRun(root, "r", {
			"reports/P1.change.1.json": change(["stale P1 deviation"]),
			"reports/P1.change.2.json": change(["P1 first", "P1 second"]),
			"reports/P2.change.9.json": change(["stale P2 deviation"]),
			"reports/P2.change.10.json": change(["P2 only"]),
			"reports/P10.change.1.json": change([]),
			"reports/P3.change.1.notes.md": "not a report",
		});
		const out = collect(root, r);
		expect(out.deviations).toEqual([
			{ packet: "P1", text: "P1 first" },
			{ packet: "P1", text: "P1 second" },
			{ packet: "P2", text: "P2 only" },
		]);
	});

	test("deviations order packets numerically (P2 before P10)", () => {
		const root = mkRoot();
		const r = mkRun(root, "r", {
			"reports/P10.change.1.json": JSON.stringify({ files_changed: [], deviations: ["ten"] }),
			"reports/P2.change.1.json": JSON.stringify({ files_changed: [], deviations: ["two"] }),
		});
		expect(collect(root, r).deviations.map((d: { packet: string }) => d.packet)).toEqual(["P2", "P10"]);
	});

	test("loops: highest-N report per phase; sidecars and security reports ignored", () => {
		const root = mkRoot();
		const verdict = (v: string) => JSON.stringify({ verdict: v });
		const r = mkRun(root, "r", {
			"reports/test.1.json": verdict("fail"),
			"reports/test.9.json": verdict("fail"),
			"reports/test.10.json": verdict("pass"),
			"reports/test.11.notes.md": "sidecar",
			"reports/review.1.json": verdict("changes_requested"),
			"reports/review.1.notes.md": "sidecar",
			"reports/security.2.json": "not even json",
		});
		expect(collect(root, r).loops).toEqual({
			test: { generation: 10, verdict: "pass" },
			review: { generation: 1, verdict: "changes_requested" },
		});
	});

	test("decisions: user / auto-adopted Decided by lines; total = ## D headings", () => {
		const root = mkRoot();
		const r = mkRun(root, "r", {
			"decisions.md": [
				"# Decision ledger",
				"## D1: a",
				"- **Decided by:** user (Gate 2)",
				"## D2: b",
				"- **Decided by:** auto-adopted (implementation kind only)",
				"## D3: c",
				"- **Decided by:** user",
				"## D4: open",
				"- **Decided by:** user | auto-adopted (implementation kind only)", // template placeholder still counts as user
				"## Notes",
			].join("\n") + "\n",
		});
		expect(collect(root, r).decisions).toEqual({ user: 3, auto: 1, total: 4 });
	});

	test("several run dirs: runs in argument order plus summed totals", () => {
		const root = mkRoot();
		const a = mkRun(root, "a", {
			"plan.2.json": "{}",
			"run.md": runMd([
				"- 2026-11-16 plan.2: yield failed schema",
				"- 2026-11-16 advisory (blocker) adopted",
			]),
			"reports/P1.change.1.json": JSON.stringify({ files_changed: ["go.mod"], deviations: ["d1"] }),
			"reports/test.2.json": JSON.stringify({ verdict: "pass" }),
			"decisions.md": "## D1: x\n- **Decided by:** user (Gate 1)\n",
		});
		const b = mkRun(root, "b", {
			"plan.1.json": "{}",
			"run.md": runMd([
				"- 2026-11-16 advisory (concern) rejected",
				"- 2026-11-16 advisory (nit) noted",
				"- 2026-11-16 plan.2: persisted. Advisory rejected: mentioned",
			]),
			"reports/P1.change.1.json": JSON.stringify({ files_changed: [], deviations: ["d2", "d3"] }),
			"reports/test.1.json": JSON.stringify({ verdict: "pass" }),
			"reports/review.3.json": JSON.stringify({ verdict: "approve" }),
			"decisions.md": "## D1: x\n- **Decided by:** auto-adopted (implementation kind only)\n## D2: y\n- **Decided by:** user\n",
		});
		const c = mkRun(root, "c");
		const out = collect(root, a, b, c);
		expect(out.runs.map((x: { run: string }) => x.run)).toEqual(["a", "b", "c"]);
		expect(out.runs[0]).toEqual(collect(root, a));
		expect(out.runs[2]).toEqual(empty("c"));
		expect(out.totals).toEqual({
			plan_generations: 3,
			schema_failures: 1,
			advisories: { adopted: 1, rejected: 1, unclassified: 1, mentioned: 1 },
			deviations: 3,
			loops: { test: 3, review: 3 },
			decisions: { user: 2, auto: 1, total: 3 },
		});
	});

	test("invocation via the canonical installed path (hermetic temp agent dir)", () => {
		// SKILL.md runs ${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory-retro/scripts/factory-retro.ts,
		// which install.sh symlinks; build that layout in a temp agent dir.
		const root = mkRoot();
		const agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		execFileSync("ln", ["-s", join(import.meta.dir, "..", "skills", "factory-retro"), join(agentDir, "skills", "factory-retro")]);
		const installed = join(agentDir, "skills", "factory-retro", "scripts", "factory-retro.ts");
		const out = execFileSync(installed, ["collect", mkRun(root, "r")], {
			cwd: root, env: { ...fixtureEnv(root), PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8",
		});
		expect(JSON.parse(out)).toEqual(empty("r"));
	});
});

describe("factory-retro.ts report", () => {
	const report = (root: string, ...runs: string[]) => run(root, "report", ...runs);

	test("renders packets DAG, loops, decisions and escaped log; prints the written path", () => {
		const root = mkRoot();
		const packet = (id: string, depends_on: string[]) => ({
			id, title: `title ${id}`, owns: [`${id}.go`], depends_on, needs_design: false, contract: id === "P1", security_sensitive: false,
		});
		const r = mkRun(root, "r", {
			"run.md": [
				"# Run: r",
				"",
				"- **Status:** done",
				"- **Base:** abc123",
				"",
				"## Log",
				"",
				"- 2026-11-18 wave 0: <script>alert(1)</script>",
			].join("\n") + "\n",
			"plan.1.json": JSON.stringify({ packets: [packet("P1", [])] }),
			"plan.2.json": JSON.stringify({ packets: [packet("P1", []), packet("P2", []), packet("P3", ["P1", "P2"])] }),
			"reports/review.1.json": JSON.stringify({ verdict: "changes_requested" }),
			"reports/review.2.json": JSON.stringify({ verdict: "approve" }),
			"reports/security.1.json": "ignored",
			"reports/P1.change.1.json": JSON.stringify({ status: "done", deviations: [] }),
			"decisions.md": [
				"# Decision ledger",
				"## D1: Cutover mechanism",
				"- **Kind:** architecture",
				"- **Decision:** mode-flag",
				"- **Decided by:** user (Gate 1)",
				"## D2: Retry count",
				"- **Kind:** implementation",
				"- **Decision:** three",
				"- **Decided by:** auto-adopted (implementation kind only)",
			].join("\n") + "\n",
		});
		const res = report(root, r);
		expect(res.status).toBe(0);
		const file = join(r, "report.html");
		expect(res.stdout).toBe(`${file}\n`);
		const html = readFileSync(file, "utf8");
		const svg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
		for (const id of ["P1", "P2", "P3"]) expect(svg).toContain(`>${id}<`);
		expect((svg.match(/<line /g) ?? []).length).toBe(2);
		for (const s of ["D1", "D2", "Cutover mechanism", "mode-flag", "auto-adopted", "review.1", "review.2", "changes_requested", "approve", "Status", "abc123"]) {
			expect(html).toContain(s);
		}
		expect(html).not.toContain("security.1");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script");
		expect(html).not.toMatch(/https?:/);
	});

	test("no plan: report carries the 'no plan' note", () => {
		const root = mkRoot();
		const r = mkRun(root, "empty");
		const res = report(root, r);
		expect(res.status).toBe(0);
		const html = readFileSync(join(r, "report.html"), "utf8");
		expect(html).toContain("no plan");
		expect(html).not.toContain("<svg");
	});

	test("several run dirs: one report per dir, paths in argument order", () => {
		const root = mkRoot();
		const a = mkRun(root, "a");
		const b = mkRun(root, "b");
		expect(report(root, a, b).stdout).toBe(`${join(a, "report.html")}\n${join(b, "report.html")}\n`);
	});
});
