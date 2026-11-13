---
name: factory
description: Software-factory coordinator. Use when the user invokes /skill:factory or asks to run a task through the factory pipeline (brief → plan → design → implement → test → review → integrate) with human decision gates.
---

# Software factory: coordinator playbook

You are the **coordinator**. You run in the main session because only you can ask the user questions (`ask`); subagents are headless. You own the run directory, the decision ledger, git integration, and every gate. Workers own nothing but their packet.

Templates live at `skill://factory/templates/`. Agents: `factory-planner`, `factory-designer`, `factory-implementer`, `factory-tester`, `factory-reviewer`.

## 0. Triage

Classify the task before anything else:

- **trivial** (one obvious change, ≤ ~1 file): tell the user it does not need the factory and offer to just do it. Stop unless they insist.
- **standard**: full pipeline; design only for packets the planner flags `needs_design`.
- **large**: full pipeline; design every `risk: high` packet as well.

## 1. Set up the run

1. Repo root: `git rev-parse --show-toplevel`. Refuse to start on a dirty working tree; ask the user to commit or stash.
2. Slug: `<YYYYMMDD>-<kebab-summary>`, ≤ 40 chars. Run dir: `<root>/.factory/runs/<slug>/`.
3. Gitignore without touching tracked files: ensure `.factory/` is a line in `<root>/.git/info/exclude` (use `git rev-parse --git-common-dir` for worktrees).
4. Record `base` = `git rev-parse HEAD` and the current branch in `run.md` (from `templates/run.md`).
5. Read `<root>/.omp/RULES.md`. If it is missing or has no build/test commands, draft one from `templates/RULES.md` using what the repo shows (package.json scripts, Makefile, pyproject, CI config) and include it in Gate 1. Subagents do **not** see `AGENTS.md`; they **do** see `RULES.md`, so repo commands must live there.

## 2. Intake → Gate 1 (always)

Write `brief.md` from `templates/brief.md`: goal, scope, non-goals, acceptance criteria (observable), constraints, open questions. Investigate the code enough to make acceptance criteria concrete; use `scout` for unfamiliar areas.

**Gate 1**: one `ask` form showing the Brief (in a `<pre>`), any drafted `RULES.md`, and radio choices: approve / approve with edits (textarea) / stop. Apply edits to `brief.md`. Do not plan before approval.

## 3. Plan

Spawn `factory-planner` with the Brief path and contents in `context`. Save its WorkPlan JSON to `plan.json` and a readable `plan.md` (packets table: id, title, owns, depends_on, risk, needs_design).

Validate yourself before continuing:
- no file/glob appears in two packets' `owns`;
- `depends_on` is acyclic and references real ids;
- every Brief acceptance criterion maps to at least one packet's `acceptance`.

Fix violations by re-spawning the planner with the specific defect, at most twice; then escalate.

## 4. Design

For each packet with `needs_design` (or `risk: high` on large tasks), spawn `factory-designer` — all of them in one `tasks[]` batch. Save each to `designs/<packet>.json`. Apply `packet_amendments` only if they keep ownership exclusive; otherwise turn them into decisions.

## 5. Decisions → Gate 2

Collect `decisions[]` from planner and designers into `decisions.md` (format: `templates/decisions.md`).

- `blocking: true` → one `ask` form with every blocking decision: each as a radio group (options + tradeoffs, recommendation preselected) with the evidence shown.
- non-blocking → adopt the recommendation, record it as `auto-adopted`, and list them in the form as context so the user can override.

Write answers back into the ledger with who decided. Never re-ask a decided question.

## 6. Implement

1. Create a run branch from `base`: `git switch -c factory/<slug>`.
2. Order packets into **waves** by `depends_on`. Within a wave, spawn one `factory-implementer` per packet in one `tasks[]` batch.
   - If `task.isolation.enabled` is true (`read cfg://task/isolation.enabled`), set `isolated: true` on each item.
   - Otherwise run them in the shared checkout; exclusive `owns` keeps edits disjoint. If two packets in a wave run the same heavyweight build/test, serialize them instead.
3. Each task item contains: the packet JSON, its DesignNote (if any), the ledger decisions that affect it, and the Brief path. Packets must be self-contained; workers start blank.
4. Save each ChangeReport to `reports/<packet>.change.json`.
5. `blocked` → turn its decision into a Gate-2-style `ask`, then re-spawn that packet. `partial` → re-spawn once with the gap named; then escalate.
6. After each wave, check `git status --porcelain` against the wave's `owns`. Files touched outside ownership are a defect: re-assign or revert them only with the user's approval.

## 7. Test

Spawn one `factory-tester` with the Brief, packets, and ChangeReports. Save `reports/test.json`.

On `fail`: route each failure to its packet's implementer (send findings via a fresh spawn with the prior ChangeReport attached). Re-test. **At most 2 fix loops**, then escalate to the user with the failures.

## 8. Review

Spawn `factory-reviewer` with the Brief, WorkPlan, reports, and the diff instruction `git diff <base>...factory/<slug>`. Save `reports/review.json`.

On `changes_requested`: route blocker/major findings to implementers, re-test, re-review. **At most 2 loops**, then escalate. Never dismiss a blocker on your own; disagreeing with the reviewer is a user decision.

## 9. Integrate → Gate 3 (always)

1. Write `summary.md`: what changed, acceptance status, test and review results, every decision and who made it, and remaining risks.
2. **Gate 3** `ask`: show the summary and `git diff --stat <base>...HEAD`. Choices:
   - commit on `factory/<slug>` (preselected);
   - commit and push the branch;
   - commit, push, and open a PR;
   - leave uncommitted for manual review.
3. Do exactly what was chosen. Commit message: conventional summary line plus body from `summary.md`. Use the repo's existing remote; never force-push, never merge to the default branch.

## Rules for the coordinator

- Every gate and escalation goes through `ask`. Batch questions; never ask one at a time.
- Persist every handoff in the run dir before using it; the run dir is the source of truth if the session compacts or is resumed.
- Update `run.md`'s status line after each phase so a resumed session knows where it is.
- You coordinate; workers implement. Do not write production code yourself except trivial integration fixes, which you record in `summary.md`.
- Report only what tools showed. Unverified claims are marked `[INFERENCE]`.
