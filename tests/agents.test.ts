import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// omp passes agent `output` schemas through opaquely (no $ref), so shared
// contracts are copied between agents. These tests keep the copies identical.

const dir = join(import.meta.dir, "..", "agents");
const agents = Object.fromEntries(
	readdirSync(dir)
		.filter(f => f.endsWith(".md"))
		.map(f => {
			const text = readFileSync(join(dir, f), "utf8");
			const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
			if (!match) throw new Error(`${f}: missing frontmatter`);
			return [f.replace(/\.md$/, ""), Bun.YAML.parse(match[1]) as Record<string, any>];
		}),
);

describe("agent definitions", () => {
	test.each(Object.keys(agents))("%s: name matches file and output is an object schema", name => {
		const fm = agents[name];
		expect(fm.name).toBe(name);
		expect(fm.structured).toBe(true);
		expect(fm.output.type).toBe("object");
		for (const key of fm.output.required) expect(fm.output.properties).toHaveProperty(key);
	});

	test("every decisions[] schema is identical apart from its description", () => {
		const schemas = Object.entries(agents)
			.filter(([, fm]) => fm.output.properties.decisions)
			.map(([name, fm]) => {
				const { description: _, ...rest } = fm.output.properties.decisions;
				return [name, rest] as const;
			});
		expect(schemas.length).toBeGreaterThanOrEqual(4);
		for (const [, schema] of schemas) expect(schema).toEqual(schemas[0][1]);
	});
});
