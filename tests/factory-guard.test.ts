import { describe, expect, test } from "bun:test";
import { blockedReason } from "../hooks/pre/factory-guard";

describe("blockedReason", () => {
	test.each([
		"git commit -m wip",
		"cd repo && git push origin HEAD",
		"git -C ../other merge main",
		"git reset --hard HEAD~1",
		"git checkout -b feature",
		"git switch -c feature",
		"git branch -D old",
		"git clean -fd",
		"git stash",
		"gh pr create --fill",
		"gh pr merge 12",
	])("blocks %p", cmd => {
		expect(blockedReason(cmd)).toBeDefined();
	});

	test.each([
		"git status --porcelain",
		"git diff main...HEAD",
		"git log --oneline -5",
		"git show HEAD:src/a.ts",
		"git switch main",
		"git branch --list",
		"gh pr view 12",
		"bun test",
	])("allows %p", cmd => {
		expect(blockedReason(cmd)).toBeUndefined();
	});
});
