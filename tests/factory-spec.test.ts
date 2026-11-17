import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Covers skills/factory-spec/scripts/factory-spec.ts check. Fixture spec dirs live in mkdtemp.
const SCRIPT = join(import.meta.dir, "..", "skills", "factory-spec", "scripts", "factory-spec.ts");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

const ledger = (...entries: string[]) => `# Decision ledger: x\n\n${entries.join("\n")}`;
const entry = (id: string, decision: string, extra = "") =>
	`## ${id}: q\n\n- **Kind:** architecture\n- **Decision:** ${decision}\n${extra}`;
const run = (id: string, body = "- **Goal:** g\n- **Scope:** s\n- **Acceptance:**\n  1. a\n") => `## ${id}: t\n\n${body}\n`;

const good = {
	"spec.md": "# Spec\n\nDesign follows D1; rollout runs R1 then R2 (D2 open).\n",
	"decisions.md": ledger(
		entry("D1", "`a`, **superseded by D3**"),
		entry("D2", "open; asked at R2's Gate 1", "- **Recommendation:** `x`\n"),
		entry("D3", "`b`"),
	),
	"roadmap.md": `# Roadmap\n\n| Run | Depends on |\n|---|---|\n| R1 | — |\n| R2 | R1 |\n\n${run("R1")}${run("R2")}`,
};

function check(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "factory-spec-"));
	dirs.push(dir);
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return spawnSync(SCRIPT, ["check", dir], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir } });
}

describe("factory-spec.ts check", () => {
	test("a well-formed spec passes and lists open decisions", () => {
		const r = check(good);
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe("spec ok: 3 decisions (1 open: D2), 2 runs");
	});

	test("missing directory or file exits 2; bad usage exits 2", () => {
		const r = check({ "spec.md": "", "decisions.md": "" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("roadmap.md");
		expect(spawnSync(SCRIPT, ["check", "/no/such/dir"], { encoding: "utf8" }).status).toBe(2);
		expect(spawnSync(SCRIPT, [], { encoding: "utf8" }).stderr).toContain("usage: factory-spec.ts");
	});

	test("an Acceptance asserting a value an open decision still owns fails", () => {
		const files = {
			...good,
			"decisions.md": ledger(
				entry("D1", "`a`"),
				entry("D2", "open", "- **Recommendation:** header `tenant`; `{type: ORDER_UPDATED}`\n"),
				entry("D3", "`b`"),
			),
			"roadmap.md": `${run("R1")}${run("R2", "- **Goal:** g\n- **Scope:** s, per `ORDER_UPDATED`\n- **Acceptance:** header `tenant` set, type ORDER_UPDATED, tenant id present\n")}`,
		};
		const r = check(files);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("R2: Acceptance asserts `tenant`, which open D2 still decides"); // backticked
		expect(r.stderr).toContain("R2: Acceptance asserts `ORDER_UPDATED`, which open D2 still decides"); // bare ALL_CAPS inside a long span
		files["roadmap.md"] = `${run("R1")}${run("R2", "- **Goal:** g\n- **Scope:** per `ORDER_UPDATED`\n- **Acceptance:** the shape D2 decides; tenant id present\n")}`;
		expect(check(files).status).toBe(0); // Scope may name it; a plain word is not a hit
		files["roadmap.md"] = `${run("R1")}${run("R2", "- **Goal:** g\n- **Scope:** s\n- **Acceptance:** header `tenant` set\n")}`;
		files["decisions.md"] = ledger(entry("D1", "`a`"), entry("D2", "`header`", "- **Recommendation:** header `tenant`\n"), entry("D3", "`b`"));
		expect(check(files).status).toBe(0); // decided: asserting it is fine
	});

	test("ledger defects: no Kind, no Decision, open without Recommendation, unknown successor", () => {
		const r = check({
			...good,
			"decisions.md": ledger(
				"## D1: q\n\n- **Decision:** `a`\n",
				"## D2: q\n\n- **Kind:** data\n",
				entry("D3", "open"),
				entry("D4", "`a`, superseded by D9"),
			),
			"spec.md": "D1 D2 D3 D4 R1 R2\n",
		});
		expect(r.status).toBe(1);
		for (const msg of ["D1: no Kind", "D2: no Decision", "D3: open without a Recommendation", "D4: superseded by unknown D9"]) {
			expect(r.stderr).toContain(msg);
		}
	});

	test("a run missing Goal, Scope, or Acceptance fails", () => {
		const r = check({ ...good, "roadmap.md": `${run("R1")}${run("R2", "- **Goal:** g\n")}` });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("R2: no Scope");
		expect(r.stderr).toContain("R2: no Acceptance");
		expect(r.stderr).not.toContain("R1:");
	});

	test("citing an unknown decision or run fails, in spec or roadmap", () => {
		const r = check({ ...good, "spec.md": "Uses D7 and R5.\n" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("spec.md: cites D7, not in decisions.md");
		expect(r.stderr).toContain("spec.md: cites R5, not a roadmap run");
	});

	test("a heading that is not D<n>/R<n> ends the previous section", () => {
		const r = check({ ...good, "roadmap.md": `${run("R1", "- **Goal:** g\n")}## Notes\n\n- **Scope:** s\n- **Acceptance:** a\n${run("R2")}` });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("R1: no Scope");
	});
});
