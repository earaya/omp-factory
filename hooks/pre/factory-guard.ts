import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Subagents must never change git history or remote state: the coordinator
// (main session) integrates at Gate 3. This is an approval guard, not a
// sandbox: it does not parse shell syntax and does not see eval subprocesses.
const BLOCKED: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bgit\s+(?:-C\s+\S+\s+)?(commit|push|merge|rebase|cherry-pick|revert|tag|am)\b/, "git history/remote change"],
	[/\bgit\s+(?:-C\s+\S+\s+)?reset\s+--hard\b/, "git reset --hard"],
	[/\bgit\s+(?:-C\s+\S+\s+)?(switch|checkout)\s+(-[bBcC]\b|--orphan\b)/, "branch creation"],
	[/\bgit\s+(?:-C\s+\S+\s+)?branch\s+(-[dDmMfc]\b|--delete\b|--force\b)/, "branch rewrite"],
	[/\bgit\s+(?:-C\s+\S+\s+)?(clean\s+-\w*f|stash\b)/, "discarding working-tree state"],
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
