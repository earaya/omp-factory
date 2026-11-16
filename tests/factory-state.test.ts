import { describe, expect, test, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Covers scripts/factory-state.sh — the coordinator state helper. Disk-derivable
// facts only (freeze/verify/next); the recipe it runs is the §6 step-7 one that
// tests/factory-recipes.test.ts pins from the other side.
const SCRIPT = join(import.meta.dir, "..", "skills", "factory", "scripts", "factory-state.sh");

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
	execFileSync("bash", [SCRIPT, ...args], { cwd: join(root, "repo"), env: fixtureEnv(root), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

function blobSha(content: string): string {
	return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

const unescape = (root: string, escaped: string) =>
	execFileSync("bash", ["-c", `printf %s ${escaped}`], { env: fixtureEnv(root), encoding: "utf8" });

const freezeLines = (run: string) => readFileSync(join(run, "reports", "freeze.txt"), "utf8").split("\n").filter(l => l !== "");

describe("factory-state.sh freeze", () => {
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
		expect(unescape(root, fields[1])).toBe("new.txt"); // field 2: destination
		expect(fields[2]).toBe(blobSha("renamed\n"));      // field 3: worktree content of dest
		expect(unescape(root, fields[3])).toBe("old.txt"); // field 4: renamed-from, metadata
		expect(lines[1].split("\t").slice(0, 2)).toEqual(["??", "u.txt"]); // second entry intact
	});

	test("special-character paths are %q-escaped and round-trip", () => {
		const { root, repo, run } = initRepo({ "plain.txt": "p\n" });
		const names = { "sp ace.txt": "s\n", "ta\tb.txt": "t\n", "uni-é.txt": "u\n" };
		for (const [name, content] of Object.entries(names)) writeFileSync(join(repo, name), content);
		sh(root, "freeze", run);
		const lines = freezeLines(run);
		expect(lines.length).toBe(3);
		for (const [name, content] of Object.entries(names)) {
			const line = lines.find(l => unescape(root, l.split("\t")[1]) === name);
			expect(line).toBeDefined();
			const fields = line!.split("\t");
			expect(fields.length).toBe(3); // tab-in-name stays one field: escaping keeps the record parseable
			expect(fields[2]).toBe(blobSha(content));
			if (name !== "uni-é.txt") {
				expect(line!.includes(name)).toBe(false); // raw name absent; the escaped form is present
				expect(fields[1]).toContain("\\");
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

describe("factory-state.sh verify", () => {
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

describe("factory-state.sh next", () => {
	test("derives the next generation from existing artifacts", () => {
		const { root, run } = initRepo();
		const reports = join(run, "reports");
		mkdirSync(reports, { recursive: true });
		expect(sh(root, "next", reports, "test")).toBe("test.1"); // empty dir
		writeFileSync(join(reports, "test.1.json"), "{}");
		writeFileSync(join(reports, "test.2.json"), "{}");
		expect(sh(root, "next", reports, "test")).toBe("test.3");
		expect(sh(root, "next", reports, "review")).toBe("review.1"); // other prefixes unaffected
		writeFileSync(join(reports, "plan.1.json"), "{}");
		writeFileSync(join(reports, "plan.1.md"), ""); // .md sibling of the same generation does not bump it
		expect(sh(root, "next", reports, "plan")).toBe("plan.2");
	});
});

describe("factory-state.sh loops", () => {
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

	test("invocation from a separate target repo via the canonical installed path", () => {
		// install.sh:26-30 symlinks the skill tree into
		// ${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory — SKILL.md
		// references that path, so a target repo must resolve it there.
		const installed = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".omp", "agent"), "skills", "factory", "scripts", "factory-state.sh");
		const { root, run } = initRepo({ "a.txt": "a\n" });
		const out = execFileSync("bash", [installed, "loops", run, "test"], { cwd: join(root, "repo"), env: fixtureEnv(root), encoding: "utf8" }).trim();
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
		expect(() => sh(root, "loops", run, "plan")).toThrow(/test or review/);
	});
});