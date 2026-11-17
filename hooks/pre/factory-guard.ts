import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Subagents must never change git history, branches, remote state, or discard
// working-tree changes: the coordinator (main session) integrates. This is an
// approval guard, not a sandbox: it does not parse shell syntax and does not
// see eval subprocesses.

// `git` followed by any global options: -C <dir>, -c <k=v>, --no-pager, --git-dir=...
const GIT = String.raw`\bgit\s+(?:(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*`;

const BLOCKED: ReadonlyArray<readonly [RegExp, string]> = [
	[new RegExp(`${GIT}(commit|push|merge|rebase|cherry-pick|revert|tag|am|pull)\\b`), "git history/remote change"],
	[new RegExp(`${GIT}reset\\b`), "git reset"],
	[new RegExp(`${GIT}(checkout|switch)\\b`), "branch or working-tree checkout"],
	[new RegExp(`${GIT}restore\\b`), "discarding working-tree state"],
	[new RegExp(`${GIT}branch\\s+(-[dDmMfcC]\\b|--delete\\b|--force\\b|--move\\b|--copy\\b)`), "branch rewrite"],
	[new RegExp(`${GIT}(clean\\s+-\\w*f|stash\\b)`), "discarding working-tree state"],
	[/\bgh\s+(pr|release|repo)\s+(create|merge|close|edit|delete)\b/, "GitHub mutation"],
];

export function blockedReason(command: string): string | undefined {
	for (const [pattern, what] of BLOCKED) {
		if (pattern.test(command)) return what;
	}
	return undefined;
}

export default function factoryGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent?.kind !== "sub" || event.toolName !== "bash") return;
		const what = blockedReason(String(event.input.command ?? ""));
		if (!what) return;
		return {
			block: true,
			reason: `factory-guard: subagents may not perform ${what}. Leave the working tree changed and report in your ChangeReport; the coordinator integrates.`,
		};
	});
}
