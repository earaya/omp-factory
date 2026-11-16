// Regression coverage for the shipped recipes: SKILL.md §6 step-7 freeze record
// (porcelain -z parse, R/C two-field entries, %q escaping, deleted markers)
// and §8 coverage semantics (field-2 membership, escaped-vs-escaped sets).
// Re-implemented here in TypeScript; every fixture lives in a fresh mkdtemp
// tmpdir, never in this repo's tree.
import { afterEach, afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

type Entry = { xy: string; path: string; orig: string | null };
type Fixture = { repo: string; base: string };

const MB16 = 16 * 1024 * 1024;
const dirs: string[] = [];

// One env story for every child process (git and bash alike): a minimal
// allowlist, never a process.env spread — a spread would leak host GIT_*
// variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_DEFAULT_HASH, ...)
// into the fixtures. PATH lets git/bash resolve; TMPDIR matches os.tmpdir();
// every other variable is a deliberate fixture pin added at the call site.
function childEnv(extra: Record<string, string>): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		TMPDIR: process.env.TMPDIR ?? "",
		...extra,
	};
}

// HOME points at the mkdtemp root (parent of the fixture worktree), and the
// GIT_CONFIG_* pins keep host gitconfig from leaking into fixture output;
// GIT_DEFAULT_HASH=sha1 pins the object format for `git init` so the
// blobSha oracle (SHA-1) matches on sha256-default hosts.
function git(cwd: string, args: string[], opts?: { input?: string }): string {
	return execFileSync("git", args, {
		cwd,
		env: childEnv({
			HOME: join(cwd, ".."),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_DEFAULT_HASH: "sha1",
		}),
		encoding: "utf8",
		maxBuffer: MB16,
		input: opts?.input,
	});
}

function writeFile(repo: string, rel: string, content: string): void {
	const slash = rel.lastIndexOf("/");
	if (slash !== -1) mkdirSync(join(repo, rel.slice(0, slash)), { recursive: true });
	writeFileSync(join(repo, rel), content);
}

function initRepo(baseFiles?: Record<string, string>): Fixture {
	const root = mkdtempSync(join(os.tmpdir(), "factory-recipes-"));
	dirs.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.name", "Factory Test"]);
	git(repo, ["config", "user.email", "factory@example.test"]);
	git(repo, ["config", "core.autocrlf", "false"]);
	git(repo, ["config", "commit.gpgsign", "false"]);
	let base = "";
	if (baseFiles) {
		for (const [name, content] of Object.entries(baseFiles)) writeFile(repo, name, content);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", "base"]);
		base = git(repo, ["rev-parse", "HEAD"]).trim();
	}
	return { repo, base };
}

// §6 step-7 recipe: `git status --porcelain=v1 -z --untracked-files=all` —
// each NUL-delimited field is `XY <path>`; an R/C entry consumes a second
// bare NUL-delimited path as part of the same entry.
function parsePorcelainZ(out: string): Entry[] {
	const fields = out.split("\0");
	const entries: Entry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		if (f === "") continue;
		const xy = f.slice(0, 2);
		const path = f.slice(3);
		if (xy[0] === "R" || xy[0] === "C") {
			entries.push({ xy, path, orig: fields[i + 1] });
			i++;
		} else {
			entries.push({ xy, path, orig: null });
		}
	}
	return entries;
}

// The `printf %q` step, via bash resolved on the allowlisted PATH
// (install.sh's `#!/usr/bin/env bash` convention; dash's builtin printf lacks
// %q and shadows coreutils). The raw path travels in the environment, never
// in the command string.
function q(raw: string): string {
	return execFileSync("bash", ["-c", 'printf %q "$FR_PATH"'], {
		env: childEnv({ FR_PATH: raw }),
		encoding: "utf8",
		maxBuffer: MB16,
	});
}

// %q output is shell-safe by construction; embedding it raw IS the semantics.
function unescapeQ(escaped: string): string {
	return execFileSync("bash", ["-c", `printf %s ${escaped}`], {
		env: childEnv({}),
		encoding: "utf8",
		maxBuffer: MB16,
	});
}

// Independent hash oracle: git's blob object format, so freeze shas are not
// checked by re-running git hash-object.
function blobSha(content: string): string {
	return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

function hashStdin(repo: string, content: string): string {
	return git(repo, ["hash-object", "--stdin"], { input: content }).trim();
}

function lineFor(entry: Entry, repo: string): string {
	if (entry.xy.includes("D")) return [entry.xy, q(entry.path), "deleted"].join("\t");
	const sha = git(repo, ["hash-object", entry.path]).trim();
	if (entry.orig !== null) return [entry.xy, q(entry.path), sha, q(entry.orig)].join("\t");
	return [entry.xy, q(entry.path), sha].join("\t");
}

function freezeLines(repo: string): string[] {
	return parsePorcelainZ(git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).map(e =>
		lineFor(e, repo),
	);
}

function splitNul(s: string): string[] {
	return s.split("\0").filter(p => p !== "");
}

// §8 coverage: every field-2 path must appear in the tracked-diff or
// untracked sets, compared escaped-vs-escaped; any non-`??` entry requires a
// non-empty tracked-diff stat. Field 4 (renamed-from) is never consulted.
function coverageCheck(
	repo: string,
	base: string,
	lines: string[],
): { ok: boolean; missing: string[]; emptyStatWithTracked: boolean } {
	const stat = git(repo, ["diff", "--stat", base]);
	const covered = new Set([
		...splitNul(git(repo, ["diff", "--name-only", "-z", base])),
		...splitNul(git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])),
	].map(q));
	const missing: string[] = [];
	let trackedEntry = false;
	for (const line of lines) {
		const [xy, path2] = line.split("\t");
		if (xy !== "??") trackedEntry = true;
		if (!covered.has(path2)) missing.push(path2);
	}
	const emptyStatWithTracked = trackedEntry && stat.trim() === "";
	return { ok: missing.length === 0 && !emptyStatWithTracked, missing, emptyStatWithTracked };
}

afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

describe("freeze record generation", () => {
	test("porcelain XY and content hashes", () => {
		const { repo } = initRepo({ "a.txt": "alpha\n", "b.txt": "beta\n", "c.txt": "gamma\n" });
		writeFile(repo, "a.txt", "alpha2\n");
		writeFile(repo, "d.txt", "delta\n");
		git(repo, ["add", "d.txt"]);
		rmSync(join(repo, "c.txt"));
		writeFile(repo, "u.txt", "un\n");
		expect([...freezeLines(repo)].sort()).toEqual(
			[
				[" M", q("a.txt"), blobSha("alpha2\n")].join("\t"),
				["A ", q("d.txt"), blobSha("delta\n")].join("\t"),
				[" D", q("c.txt"), "deleted"].join("\t"),
				["??", q("u.txt"), blobSha("un\n")].join("\t"),
			].sort(),
		);
	});
});

describe("R and C entries", () => {
	test("staged rename consumes both NUL fields (real R)", () => {
		const { repo } = initRepo({ "old.txt": "renamed\n", "keep.txt": "keep\n" });
		git(repo, ["mv", "old.txt", "new.txt"]);
		writeFile(repo, "u.txt", "u content\n");
		const lines = freezeLines(repo);
		// A one-field parser would emit 3 lines (the bare `old.txt` NUL field
		// misread as a garbage entry); two proves the second field was consumed.
		expect(lines.length).toBe(2);
		expect(lines[0]).toBe(["R ", q("new.txt"), blobSha("renamed\n"), q("old.txt")].join("\t"));
		expect(lines[1]).toBe(["??", q("u.txt"), blobSha("u content\n")].join("\t"));
	});

	test("synthetic C entry flows through the same parse path", () => {
		const { repo } = initRepo({ "copy.txt": "copy\n", "orig.txt": "orig\n" });
		writeFile(repo, "u.txt", "u content\n");
		// The exact byte shape real git emitted for the staged R in the test
		// above: `XY <path>\0<orig>\0` per entry, trailing NUL.
		const buf = Buffer.from("C  copy.txt\0orig.txt\0?? u.txt\0", "utf8");
		const entries = parsePorcelainZ(buf.toString("utf8"));
		expect(entries.length).toBe(2);
		const lines = entries.map(e => lineFor(e, repo));
		expect(lines[0]).toBe(["C ", q("copy.txt"), blobSha("copy\n"), q("orig.txt")].join("\t"));
		expect(lines[1]).toBe(["??", q("u.txt"), blobSha("u content\n")].join("\t"));
	});
});

describe("%q escaping", () => {
	test("space and tab names are escaped and round-trip", () => {
		const { repo } = initRepo({ "plain.txt": "p\n" });
		const specials: Array<[string, string]> = [
			["sp ace.txt", "s\n"],
			["ta\tb.txt", "t\n"],
			["uni-é.txt", "u\n"],
		];
		for (const [name, content] of specials) writeFile(repo, name, content);
		const lines = freezeLines(repo);
		expect(lines.length).toBe(specials.length);
		for (const [name, content] of specials) {
			const line = lines.find(l => {
				const fields = l.split("\t");
				return fields[0] === "??" && unescapeQ(fields[1]) === name;
			});
			expect(line).toBeDefined();
			const fields = line!.split("\t");
			// Escaping keeps the tab-delimited record parseable: an unescaped
			// tab in the name would split into 4 fields.
			expect(fields.length).toBe(3);
			expect(fields[1]).toBe(q(name));
			expect(fields[2]).toBe(blobSha(content));
			expect(unescapeQ(fields[1])).toBe(name);
			if (name === "uni-é.txt") continue;
			expect(line).not.toContain(name);
			expect(fields[1]).toContain("\\");
		}
		// The space case pins the stable backslash-space token (bash 3.2/5 alike).
		const spaceLine = lines.find(l => l.split("\t")[1] === q("sp ace.txt"));
		expect(spaceLine).toBeDefined();
		expect(spaceLine!.split("\t")[1]).toContain("\\ ");
	});
});

describe("tree == freeze", () => {
	test("byte-identical re-generation; edit changes the hash", () => {
		const { repo } = initRepo({ "a.txt": "one\n", "b.txt": "two\n" });
		writeFile(repo, "a.txt", "one-v2\n");
		writeFile(repo, "u.txt", "u\n");
		const s1 = freezeLines(repo).join("\n");
		const s2 = freezeLines(repo).join("\n");
		expect(s2).toBe(s1);
		expect(hashStdin(repo, s2)).toBe(hashStdin(repo, s1));
		writeFileSync(join(repo, "u.txt"), "more\n", { flag: "a" });
		const s3 = freezeLines(repo).join("\n");
		expect(s3).not.toBe(s1);
		expect(hashStdin(repo, s3)).not.toBe(hashStdin(repo, s1));
		const uLine = s3.split("\n").find(l => l.split("\t")[0] === "??");
		expect(uLine).toBeDefined();
		expect(uLine!.split("\t")[2]).toBe(blobSha("u\nmore\n"));
	});
});

describe("§8 coverage semantics", () => {
	test("field-2 membership; renamed-from excluded", () => {
		const { repo, base } = initRepo({ "old.txt": "renamed\n", "keep.txt": "keep\n" });
		git(repo, ["mv", "old.txt", "new.txt"]);
		writeFile(repo, "keep.txt", "keep2\n");
		writeFile(repo, "copy.txt", "copy\n");
		const real = coverageCheck(repo, base, freezeLines(repo));
		expect(real.ok).toBe(true);
		expect(real.missing.length).toBe(0);
		// Sharp exclusion: ghost-orig.txt is in neither coverage set, yet the
		// line passes — membership checks field 2 only; field 4 is metadata.
		const cLine = ["C ", q("copy.txt"), blobSha("copy\n"), q("ghost-orig.txt")].join("\t");
		const sharp = coverageCheck(repo, base, [cLine]);
		expect(sharp.ok).toBe(true);
		expect(sharp.missing).not.toContain(q("ghost-orig.txt"));
	});

	test("a field-2 path missing from both sets is a defect", () => {
		const { repo, base } = initRepo({ "keep.txt": "keep\n" });
		writeFile(repo, ".gitignore", "ignored.log\n");
		writeFile(repo, "ignored.log", "log\n");
		const ghost = coverageCheck(repo, base, [["??", q("ghost-dest.txt"), blobSha("x\n")].join("\t")]);
		expect(ghost.ok).toBe(false);
		expect(ghost.missing).toContain(q("ghost-dest.txt"));
		// Real gitignore reproduction: the file is on disk but excluded from
		// ls-files --others --exclude-standard, so a freeze line for it is stale.
		const ignored = coverageCheck(repo, base, [["??", q("ignored.log"), blobSha("log\n")].join("\t")]);
		expect(ignored.ok).toBe(false);
		expect(ignored.missing).toContain(q("ignored.log"));
		// Control: .gitignore itself is in the untracked set, so it is covered.
		const control = coverageCheck(repo, base, [["??", q(".gitignore"), blobSha("ignored.log\n")].join("\t")]);
		expect(control.ok).toBe(true);
	});

	test("M entry against empty stat fails; untracked-only passes", () => {
		const { repo, base } = initRepo({ "keep.txt": "keep\n" });
		writeFile(repo, "u.txt", "u\n");
		const untrackedOnly = coverageCheck(repo, base, freezeLines(repo));
		expect(untrackedOnly.ok).toBe(true);
		expect(untrackedOnly.emptyStatWithTracked).toBe(false);
		const withM = [...freezeLines(repo), ["M ", q("keep.txt"), blobSha("keep\n")].join("\t")];
		const res = coverageCheck(repo, base, withM);
		expect(res.ok).toBe(false);
		expect(res.emptyStatWithTracked).toBe(true);
		// Positive control: a real modification makes the stat non-empty.
		writeFile(repo, "keep.txt", "keep2\n");
		const positive = coverageCheck(repo, base, freezeLines(repo));
		expect(positive.ok).toBe(true);
		expect(positive.emptyStatWithTracked).toBe(false);
	});

	test("untracked-only freeze with empty stat is valid", () => {
		const { repo, base } = initRepo({ "base.txt": "b\n" });
		writeFile(repo, "u1.txt", "u1\n");
		writeFile(repo, "u sp.txt", "u2\n");
		const lines = freezeLines(repo);
		expect(lines.length).toBe(2);
		expect(lines.every(l => l.split("\t")[0] === "??")).toBe(true);
		const res = coverageCheck(repo, base, lines);
		expect(res.ok).toBe(true);
		expect(res.emptyStatWithTracked).toBe(false);
	});

	test("escaped-vs-escaped comparison", () => {
		const { repo, base } = initRepo({ "dir sp/file sp.txt": "v1\n", "keep.txt": "keep\n" });
		writeFile(repo, "dir sp/file sp.txt", "v2\n");
		const lines = freezeLines(repo);
		expect(lines.length).toBe(1);
		expect(coverageCheck(repo, base, lines).ok).toBe(true);
		// Both sides go through q: the escaped set holds q(path) and would
		// miss a raw-path comparison.
		const covered = new Set([
			...splitNul(git(repo, ["diff", "--name-only", "-z", base])),
			...splitNul(git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])),
		].map(q));
		expect(covered.has(q("dir sp/file sp.txt"))).toBe(true);
		expect(covered.has("dir sp/file sp.txt")).toBe(false);
	});
});
