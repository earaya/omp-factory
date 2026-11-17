import { describe, expect, test, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Covers skills/factory/scripts/factory-state.ts, the coordinator state helper. Fixtures are
// mkdtemp repos with the run dir outside the repo, so the record never lists it.
const SCRIPT = join(import.meta.dir, "..", "skills", "factory", "scripts", "factory-state.ts");

// allowlist, never a process.env spread — host GIT_* would leak into fixtures
function fixtureEnv(root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		TMPDIR: process.env.TMPDIR ?? "",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_DEFAULT_HASH: "sha1",
	};
}

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function initRepo(baseFiles?: Record<string, string>): { root: string; repo: string; run: string } {
	const root = mkdtempSync(join(tmpdir(), "factory-state-"));
	dirs.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	const run = join(root, "run");
	mkdirSync(run); // the helper requires an existing run dir
	const env = fixtureEnv(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	git("init", "-q");
	git("config", "user.name", "Factory Test");
	git("config", "user.email", "factory@example.test");
	git("config", "core.autocrlf", "false");
	git("config", "commit.gpgsign", "false");
	if (baseFiles) {
		for (const [name, content] of Object.entries(baseFiles)) {
			mkdirSync(join(repo, name, ".."), { recursive: true });
			writeFileSync(join(repo, name), content);
		}
		git("add", "-A");
		git("commit", "-qm", "base");
	}
	return { root, repo, run };
}

const sh = (root: string, ...args: string[]) =>
	execFileSync(SCRIPT, args, { cwd: join(root, "repo"), env: fixtureEnv(root), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

function blobSha(content: string): string {
	return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

// Inverse of the record's path escaping: \\ \t \n.
const unescape = (escaped: string) => escaped.replace(/\\([\\tn])/g, (_, c) => (c === "t" ? "\t" : c === "n" ? "\n" : "\\"));

const freezeLines = (run: string) => readFileSync(join(run, "reports", "freeze.txt"), "utf8").split("\n").filter(l => l !== "");

describe("factory-state.ts freeze", () => {
	test("writes the §6 step-7 record and prints its sha", () => {
		const { root, repo, run } = initRepo({ "a.txt": "alpha\n", "c.txt": "gamma\n" });
		writeFileSync(join(repo, "a.txt"), "alpha2\n"); // M
		writeFileSync(join(repo, "d.txt"), "delta\n");  // A (staged)
		execFileSync("git", ["add", "d.txt"], { cwd: repo, env: fixtureEnv(root), encoding: "utf8" });
		rmSync(join(repo, "c.txt"));                    // D
		writeFileSync(join(repo, "u.txt"), "un\n");     // ??
		const sha = sh(root, "freeze", run);
		const want = [
			[" M", "a.txt", blobSha("alpha2\n")].join("\t"),
			["A ", "d.txt", blobSha("delta\n")].join("\t"),
			[" D", "c.txt", "deleted"].join("\t"),
			["??", "u.txt", blobSha("un\n")].join("\t"),
		].sort();
		expect(freezeLines(run).sort()).toEqual(want);
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		const onDisk = execFileSync("git", ["hash-object", join(run, "reports", "freeze.txt")], {
			cwd: repo, env: fixtureEnv(root), encoding: "utf8",
		}).trim();
		expect(sha).toBe(onDisk); // the printed sha is the file's sha — derived, never transcribed
	});

	test("R/C entry consumes both NUL fields as one entry", () => {
		const { root, repo, run } = initRepo({ "old.txt": "renamed\n", "keep.txt": "keep\n" });
		execFileSync("git", ["mv", "old.txt", "new.txt"], { cwd: repo, env: fixtureEnv(root), encoding: "utf8" });
		writeFileSync(join(repo, "u.txt"), "u content\n"); // untracked listed last: misalignment canary
		sh(root, "freeze", run);
		const lines = freezeLines(run);
		expect(lines.length).toBe(2); // a one-field parser would emit 3
		const fields = lines[0].split("\t");
		expect(fields.length).toBe(4);
		expect(fields[0]).toBe("R ");
		expect(unescape(fields[1])).toBe("new.txt"); // field 2: destination
		expect(fields[2]).toBe(blobSha("renamed\n"));      // field 3: worktree content of dest
		expect(unescape(fields[3])).toBe("old.txt"); // field 4: renamed-from, metadata
		expect(lines[1].split("\t").slice(0, 2)).toEqual(["??", "u.txt"]); // second entry intact
	});

	test("special-character paths are escaped and round-trip", () => {
		const { root, repo, run } = initRepo({ "plain.txt": "p\n" });
		const names = { "sp ace.txt": "s\n", "ta\tb.txt": "t\n", "new\nline.txt": "n\n", "uni-é.txt": "u\n" };
		for (const [name, content] of Object.entries(names)) writeFileSync(join(repo, name), content);
		sh(root, "freeze", run);
		const lines = freezeLines(run);
		expect(lines.length).toBe(4); // a raw newline in a path would split its entry into two lines
		for (const [name, content] of Object.entries(names)) {
			const line = lines.find(l => unescape(l.split("\t")[1]) === name);
			expect(line).toBeDefined();
			const fields = line!.split("\t");
			expect(fields.length).toBe(3); // tab-in-name stays one field: escaping keeps the record parseable
			expect(fields[2]).toBe(blobSha(content));
			if (name.includes("\t") || name.includes("\n")) {
				expect(line!.includes(name)).toBe(false); // raw tab/newline absent; the escaped form is present
				expect(fields[1]).toContain(name.includes("\t") ? "\\t" : "\\n");
			}
		}
	});

	test("clean tree: empty record, empty-blob sha", () => {
		const { root, run } = initRepo();
		const sha = sh(root, "freeze", run);
		expect(freezeLines(run)).toEqual([]);
		expect(sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"); // git's empty-blob sha
	});
});

describe("factory-state.ts verify", () => {
	test("exit 0 on an untouched tree; exit 1 stale after an edit; re-freeze restores", () => {
		const { root, repo, run } = initRepo({ "a.txt": "alpha\n" });
		writeFileSync(join(repo, "a.txt"), "alpha2\n");
		sh(root, "freeze", run);
		expect(sh(root, "verify", run)).toBe(`tree == freeze: ${execFileSync("git", ["hash-object", join(run, "reports", "freeze.txt")], { cwd: repo, env: fixtureEnv(root), encoding: "utf8" }).trim()}`);
		writeFileSync(join(repo, "a.txt"), "alpha3\n");
		expect(() => sh(root, "verify", run)).toThrow(); // stale: tree differs
		sh(root, "freeze", run);
		expect(() => sh(root, "verify", run)).not.toThrow();
	});
});

const gitIn = (root: string, repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, env: fixtureEnv(root), encoding: "utf8" });

// Runs the helper expecting it may fail; exit status and stderr instead of a throw.
function attempt(root: string, ...args: string[]): { status: number; out: string; err: string } {
	try {
		return { status: 0, out: sh(root, ...args), err: "" };
	} catch (e) {
		// execFileSync throws an Error carrying the child's status and output.
		const err = e as { status: number; stdout?: unknown; stderr?: unknown };
		return { status: err.status, out: String(err.stdout ?? ""), err: String(err.stderr ?? "") };
	}
}

describe("factory-state.ts snapshot / changed", () => {
	test("changed lists only what the wave touched, escaped and sorted", () => {
		const { root, repo, run } = initRepo({ "a.txt": "a\n", "b.txt": "b\n" });
		writeFileSync(join(repo, "a.txt"), "a2\n"); // earlier wave's edit
		sh(root, "snapshot", run, "1");
		expect(readFileSync(join(run, "reports", "status-wave-1.before"), "utf8")).toContain("a.txt");
		writeFileSync(join(repo, "b.txt"), "b2\n");
		writeFileSync(join(repo, "n ew.txt"), "n\n");
		expect(sh(root, "changed", run, "1").split("\n")).toEqual(["b.txt", "n ew.txt"]);
	});

	test("a re-edit of an earlier wave's file counts; a removed entry counts", () => {
		const { root, repo, run } = initRepo({ "a.txt": "a\n" });
		writeFileSync(join(repo, "a.txt"), "a2\n");
		writeFileSync(join(repo, "u.txt"), "u\n");
		sh(root, "snapshot", run, "2");
		writeFileSync(join(repo, "a.txt"), "a3\n");
		rmSync(join(repo, "u.txt"));
		expect(sh(root, "changed", run, "2").split("\n")).toEqual(["a.txt", "u.txt"]);
	});

	test("no change prints nothing; a missing snapshot exits 2", () => {
		const { root, run } = initRepo({ "a.txt": "a\n" });
		sh(root, "snapshot", run, "0");
		expect(sh(root, "changed", run, "0")).toBe("");
		const r = attempt(root, "changed", run, "9");
		expect(r.status).toBe(2);
		expect(r.err).toContain("no snapshot");
	});
});

describe("factory-state.ts coverage", () => {
	const base = (root: string, repo: string) => gitIn(root, repo, "rev-parse", "HEAD").trim();
	const writeFreeze = (run: string, lines: string[]) => {
		mkdirSync(join(run, "reports"), { recursive: true });
		writeFileSync(join(run, "reports", "freeze.txt"), lines.map(l => `${l}\n`).join(""));
	};

	test("rename, modification, and untracked file are covered; renamed-from is metadata", () => {
		const { root, repo, run } = initRepo({ "old.txt": "o\n", "keep.txt": "k\n" });
		gitIn(root, repo, "mv", "old.txt", "new name.txt");
		writeFileSync(join(repo, "keep.txt"), "k2\n");
		writeFileSync(join(repo, "copy.txt"), "c\n");
		sh(root, "freeze", run);
		expect(sh(root, "coverage", run, base(root, repo))).toBe("coverage ok");
		// A C line whose field 4 names a path in neither set still passes: only field 2 counts.
		writeFreeze(run, [["C ", "copy.txt", blobSha("c\n"), "ghost-orig.txt"].join("\t")]);
		expect(attempt(root, "coverage", run, base(root, repo)).status).toBe(0);
	});

	test("a freeze path missing from both sets fails, including a gitignored file", () => {
		const { root, repo, run } = initRepo({ "keep.txt": "k\n" });
		writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
		writeFileSync(join(repo, "ignored.log"), "l\n");
		writeFreeze(run, [
			["??", "ghost.txt", blobSha("x\n")].join("\t"),
			["??", "ignored.log", blobSha("l\n")].join("\t"),
			["??", ".gitignore", blobSha("ignored.log\n")].join("\t"),
		]);
		const r = attempt(root, "coverage", run, base(root, repo));
		expect(r.status).toBe(1);
		expect(r.err).toContain("not covered: ghost.txt");
		expect(r.err).toContain("not covered: ignored.log");
		expect(r.err).not.toContain(".gitignore");
	});

	test("a tracked entry against an empty diff fails; an untracked-only freeze passes", () => {
		const { root, repo, run } = initRepo({ "keep.txt": "k\n" });
		writeFileSync(join(repo, "u sp.txt"), "u\n");
		sh(root, "freeze", run);
		expect(attempt(root, "coverage", run, base(root, repo)).status).toBe(0);
		writeFreeze(run, [["M ", "keep.txt", blobSha("k\n")].join("\t")]);
		const r = attempt(root, "coverage", run, base(root, repo));
		expect(r.status).toBe(1);
		expect(r.err).toContain("is empty");
	});

	test("paths compare escaped on both sides", () => {
		const { root, repo, run } = initRepo({ "dir sp/file sp.txt": "v1\n" });
		writeFileSync(join(repo, "dir sp", "file sp.txt"), "v2\n");
		sh(root, "freeze", run);
		expect(freezeLines(run)[0].split("\t")[1]).toBe("dir sp/file sp.txt");
		expect(sh(root, "coverage", run, base(root, repo))).toBe("coverage ok");
	});
});

describe("factory-state.ts loops", () => {
	const report = (run: string, name: string, verdict: string) => {
		const reports = join(run, "reports");
		mkdirSync(reports, { recursive: true });
		writeFileSync(join(reports, name), `{"verdict": "${verdict}", "summary": "t", "scope_ok": true, "findings": []}`);
	};
	const loops = (phase: string, completed: number, pending: number | null, tier: string) =>
		pending === null
			? `${phase} fix loops: ${completed} completed, phase closed — next report opens loop ${completed + 1}`
			: `${phase} fix loops: ${completed} completed, pending attempt = loop ${pending} — ${tier}`;

	test("no reports: nothing completed, no pending attempt", () => {
		const { root, run } = initRepo();
		expect(sh(root, "loops", run, "test")).toBe("test fix loops: 0 completed, no pending attempt — autonomous (loops 1-3)");
	});

	test("invocation via the canonical installed path (hermetic temp agent dir)", () => {
		// install.sh:26-30 symlinks the skill tree into
		// ${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory — SKILL.md
		// references that path, so a target repo must resolve it there. Build
		// that layout in a temp agent dir instead of relying on a prior
		// install.sh run: a fresh clone must not depend on user-global state.
		const agentDir = join(mkdtempSync(join(tmpdir(), "factory-agent-")), "agent");
		dirs.push(dirname(agentDir));
		mkdirSync(join(agentDir, "skills", "factory", "scripts"), { recursive: true });
		symlinkSync(SCRIPT, join(agentDir, "skills", "factory", "scripts", "factory-state.ts"));
		const { root, run } = initRepo({ "a.txt": "a\n" });
		const env = { ...fixtureEnv(root), PI_CODING_AGENT_DIR: agentDir };
		const installed = join(agentDir, "skills", "factory", "scripts", "factory-state.ts");
		const out = execFileSync(installed, ["loops", run, "test"], { cwd: join(root, "repo"), env, encoding: "utf8" }).trim();
		expect(out).toBe("test fix loops: 0 completed, no pending attempt — autonomous (loops 1-3)");
	});

	test("single fail: fix loop 1 pending, autonomous", () => {
		const { root, run } = initRepo();
		report(run, "test.1.json", "fail");
		expect(sh(root, "loops", run, "test")).toBe(loops("test", 0, 1, "autonomous (loops 1-3)"));
	});

	test("two fails: fix loop 2 pending, autonomous", () => {
		const { root, run } = initRepo();
		report(run, "test.1.json", "fail");
		report(run, "test.2.json", "fail");
		expect(sh(root, "loops", run, "test")).toBe(loops("test", 1, 2, "autonomous (loops 1-3)"));
	});

	test("fail then pass: loop 1 completed, phase closed", () => {
		const { root, run } = initRepo();
		report(run, "test.1.json", "fail");
		report(run, "test.2.json", "pass");
		expect(sh(root, "loops", run, "test")).toBe(loops("test", 1, null, ""));
	});

	test("review: changes_requested then approve = loop 1 closed", () => {
		const { root, run } = initRepo();
		report(run, "review.1.json", "changes_requested");
		report(run, "review.2.json", "approve");
		expect(sh(root, "loops", run, "review")).toBe(loops("review", 1, null, ""));
	});

	test("security counts its own reports, independent of review", () => {
		const { root, run } = initRepo();
		report(run, "review.1.json", "approve");
		report(run, "security.1.json", "changes_requested");
		report(run, "security.2.json", "changes_requested");
		expect(sh(root, "loops", run, "security")).toBe(loops("security", 1, 2, "autonomous (loops 1-3)"));
		expect(sh(root, "loops", run, "review")).toBe(loops("review", 0, null, ""));
	});

	test("three fails: pending loop 3 still autonomous", () => {
		const { root, run } = initRepo();
		for (let n = 1; n <= 3; n++) report(run, `test.${n}.json`, "fail");
		expect(sh(root, "loops", run, "test")).toBe(loops("test", 2, 3, "autonomous (loops 1-3)"));
	});

	test("generations order numerically: test.10 is the latest despite lexical glob order; sidecars ignored", () => {
		const { root, run } = initRepo();
		report(run, "test.9.json", "pass");  // lexically last, numerically older
		report(run, "test.10.json", "fail"); // lexically earlier, numerically latest
		writeFileSync(join(run, "reports", "test.10.notes.md"), "sidecar"); // not .json — never counted
		expect(sh(root, "loops", run, "test")).toBe(loops("test", 0, 1, "autonomous (loops 1-3)"));
	});

	test("four fails: pending loop 4 needs coordinator approval", () => {
		const { root, run } = initRepo();
		for (let n = 1; n <= 4; n++) report(run, `test.${n}.json`, "fail");
		expect(sh(root, "loops", run, "test")).toBe(loops("test", 3, 4, "coordinator-approved (loops 4-5)"));
	});

	test("six fails: pending loop 6 asks the user", () => {
		const { root, run } = initRepo();
		for (let n = 1; n <= 6; n++) report(run, `test.${n}.json`, "fail");
		expect(sh(root, "loops", run, "test")).toBe(loops("test", 5, 6, "user approval (6th attempt)"));
	});

	test("rejects a bad phase", () => {
		const { root, run } = initRepo();
		expect(() => sh(root, "loops", run, "plan")).toThrow(/test, review, or security/);
	});
});