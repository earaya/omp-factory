import { describe, expect, test } from "bun:test";
import { blockedReason } from "../hooks/pre/factory-guard";

describe("blockedReason", () => {
	test.each([
		"git commit -m wip",
		"cd repo && git push origin HEAD",
		"git -C ../other merge main",
		"git -c user.name=x commit -m wip",
		"git --no-pager commit -m wip",
		"git --git-dir=.git -C . push",
		"git pull --rebase",
		"git reset --hard HEAD~1",
		"git reset HEAD src/a.ts",
		"git checkout -b feature",
		"git checkout -- src/a.ts",
		"git checkout .",
		"git checkout main -- src/a.ts",
		"git switch -c feature",
		"git switch main",
		"git restore .",
		"git restore --staged src/a.ts",
		"git branch -D old",
		"git branch --move old new",
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
		"git --no-pager diff abc123",
		"git log --oneline -5",
		"git show HEAD:src/a.ts",
		"git branch --list",
		"git rev-parse HEAD",
		"gh pr view 12",
		"bun test",
		"grep -r checkout src",
	])("allows %p", cmd => {
		expect(blockedReason(cmd)).toBeUndefined();
	});
});
