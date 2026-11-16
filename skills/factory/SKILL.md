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
6. Run the repo's Test command exactly as `.omp/RULES.md` gives it (e.g. `bun test`) and record the result in the `run.md` Log.
7. Pre-flight smoke: for each of the five `agents/factory-*.md` frontmatters the pipeline will use, resolve its `model:` chain (a configured `@factory_plan` / `@factory_impl` / `@factory_test` / `@factory_review` role first, else the generic fallback), deduplicate identical resolved chains, and spawn one read-only no-op per distinct chain — e.g. a `factory-planner` no-op packet (owns: [], one acceptance `yield done`, output discarded) for a planner chain, a minimal schema-valid ReviewReport for the reviewer chain. With no `factory_*` roles configured this deduplicates to two smokes (the `@default` chains plus the reviewer's `@advisor` chain); with more roles configured it grows accordingly. On any failure, stop and `ask` with the raw outputs; choices stop / fix-and-retry / proceed. Gate 1 (§2) does not open until pre-flight passes or the user explicitly proceeds.

## 2. Intake → Gate 1 (always)

Write `brief.md` from `templates/brief.md`: goal, scope, non-goals, acceptance criteria (observable), constraints, open questions. Investigate the code enough to make acceptance criteria concrete; use `scout` for unfamiliar areas.

**Gate 1**: one `ask` form showing the Brief (in a `<pre>`), any drafted `RULES.md`, and radio choices: approve / approve with edits (textarea) / stop. Apply edits to `brief.md`. Do not plan before approval.

## 3. Plan

Spawn `factory-planner` with the Brief path and contents in `context`. Persist its WorkPlan as a byte-copy of the raw yield (`agent://<id>:raw`) to `plan.<N>.json` plus a readable `plan.<N>.md` (packets table: id, title, owns, depends_on, risk, needs_design).

Validate yourself before continuing:
- no file/glob appears in two packets' `owns`;
- `depends_on` is acyclic and references real ids;
- every Brief acceptance criterion maps to at least one packet's `acceptance`.

Fix violations by re-spawning the planner with the specific defect, at most twice; then escalate.

Record your own amendments to planner output in the `plan.<N>.amendments.json` sidecar — an append-only array (each entry: what/why/who) next to the byte-verbatim plan — plus a `run.md` Log line; a structural amendment triggers a planner re-spawn (next generation) instead.

## 4. Design

For each packet with `needs_design` (or `risk: high` on large tasks), spawn `factory-designer` — all of them in one `tasks[]` batch. Persist each DesignNote as a byte-copy of the raw yield (`agent://<id>:raw`) to `designs/<packet>.<N>.json`. Apply `packet_amendments` only if they keep ownership exclusive; otherwise turn them into decisions.

Verify before continuing:
- every packet with `needs_design` (or `risk: high` on large tasks) has a saved `designs/<packet>.<N>.json` whose approach is concrete;
- `packet_amendments` that would break ownership exclusivity were routed to decisions, not applied.

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
4. Persist each ChangeReport as a byte-copy of the raw yield (`agent://<id>:raw`) to `reports/<packet>.change.<N>.json`.
5. `blocked` → turn its decision into a Gate-2-style `ask`, then re-spawn that packet. `partial` → re-spawn once with the gap named; then escalate.
6. Before each wave, snapshot the dirty set to `reports/status-wave-<N>.before`: run `git status --porcelain=v1 -z --untracked-files=all` (NUL-delimited, so untracked files are individual paths and spaces survive); an entry with an R or C status is followed by a second NUL-delimited path (the original) — consume both fields as one entry. For each path record `git hash-object` of its content — or a `deleted` marker when the status is a deletion. An R/C line records the status, the destination path, `git hash-object` of the destination (the worktree content), and the original path as renamed-from: `<XY>\t<dest>\t<sha>\t<orig>`. Escape each path with `printf %q` before joining it into the record line (both paths of an R/C entry) — porcelain paths may contain tabs/newlines, which would make the record ambiguous to parse. After the wave, re-run the same commands: every path added, hash changed, or marker changed versus the snapshot must fall inside the wave's `owns` (the cumulative status still lists earlier waves' files). Files touched outside ownership are a defect: re-assign or revert them only with the user's approval.
7. Freeze after the last product edit (end of the final wave, and again after any §7/§8 fix edit): re-run the step-6 recipe verbatim (`git status --porcelain=v1 -z --untracked-files=all`, then per-path `git hash-object`, `deleted` marker for deletions) and persist the list to `reports/freeze.txt` as a plain-text record — one line per entry, `<XY>\t<path>\t<sha>` (deletions: `<XY>\t<path>\tdeleted`), `<XY>` being the path's porcelain v1 status from that same status pass. An R/C entry consumes both NUL-delimited fields as one entry and its line records the status, the destination path, the destination's hash (the worktree content), and the original path as renamed-from: `<XY>\t<dest>\t<sha>\t<orig>`. Escape each path with `printf %q` before joining it into the record line (both paths of an R/C entry) — porcelain paths may contain tabs/newlines, which would make the record ambiguous to parse. Record `git hash-object reports/freeze.txt` as the sha on `run.md`'s `Freeze:` line. The installed helper implements this step and its checks — `bash "${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory/scripts/factory-state.sh" <freeze|verify|loops> …` (the installer exposes this skill at that path in every repo): `freeze <run-dir>` writes `reports/freeze.txt` per this recipe and prints its sha (never hand-transcribe it), `verify <run-dir>` checks tree == freeze (exit 1 = stale report), and `loops <run-dir> <test|review>` counts persisted fix loops from the reports' latest verdicts and names the §7/§8 ladder tier the next attempt falls in.

Verify before continuing:
- each packet has `reports/<packet>.change.<N>.json` with `status: done` (or an escalation under the partial/blocked rules), `files_changed` matching its `owns`, and a `met`/`evidence` entry for every acceptance item;
- after each wave, the re-run of `git status --porcelain=v1 -z --untracked-files=all` + per-path `git hash-object` (or `deleted` marker) shows every added/changed path inside the wave's `owns` — the raw cumulative status cannot be the check.

## 7. Test

Spawn one `factory-tester` with the Brief, packets, and ChangeReports. Persist the TestReport as a byte-copy of the raw yield (`agent://<id>:raw`) to `reports/test.<N>.json`.

On `fail`: route each failure to its packet's implementer (send findings via a fresh spawn with the prior ChangeReport attached). Re-test. Looping is fine as long as you are not thrashing on the same issue — every attempt must address a novel defect and show phase-appropriate progress. Fix ladder, per test ledger:
- loops 1–3: autonomous; log each in the `run.md` Log (defect, fix, generation);
- loops 4–5: coordinator-approved only; record each grant in the decision ledger, with the loop logged in the `run.md` Log, and evidence that (a) the defect is novel (not a recurrence of an earlier finding) and (b) test progress since the last loop — fewer failing commands or unmet criteria per re-test;
- 6th attempt: always `ask` the user with the failures.
Thrash guard, independent of loop count: a recurrence of an earlier finding or absent progress (not fewer failing commands or unmet criteria) escalates immediately at any loop, whatever the tier.

Verify before continuing:
- re-run the §6 step-7 freeze recipe and require tree == freeze: `git hash-object` of the fresh list equals `run.md`'s `Freeze:` sha — mismatch = stale report → do not accept it, re-run the phase on the current tree (re-freezing first if the intervening edit was a sanctioned fix);
- `reports/test.<N>.json` shows `verdict: pass`, every acceptance entry cites evidence, and every `commands[]` entry has a real result;
- on `fail`, the fix ladder above applies.

## 8. Review

Run the diff yourself first: `git diff --stat <base>` plus the coverage sets — `git diff --name-only -z <base>` (tracked paths) and `git ls-files --others --exclude-standard -z` (untracked) — compared as NUL-delimited path sets against the freeze record's paths, each path in both sets escaped with `printf %q` first so the comparison is escaped-vs-escaped. Branch on the recorded `<XY>` statuses: any tracked-modified/deleted entry (an `<XY>` other than untracked `??`) requires a non-empty tracked-diff stat — a freeze of only `??` entries with an empty stat is a valid state. Coverage membership is each entry's current worktree path only — field 2, the destination, for R/C entries and field 2 for plain entries; the renamed-from field is metadata excluded from coverage-set membership (it stays in the record for freeze identity and ownership diagnostics). Every such path must appear in one of the two sets; an empty stat despite a tracked-modified/deleted entry, or a covered path missing from both sets (typically a gitignore/exclude rule hiding it), is a defect to fix before spawning the reviewer, never a clean review.

Spawn one `factory-reviewer` with the Brief, WorkPlan, reports, and the diff instruction: `git diff <base>` (the working tree against the base commit — nothing is committed until Gate 3) plus `git ls-files --others --exclude-standard` and `git diff --no-index /dev/null -- <file>` per untracked path (files the run creates stay untracked until Gate 3). Persist the ReviewReport as a byte-copy of the raw yield (`agent://<id>:raw`) to `reports/review.<N>.json`.

On `changes_requested`: route blocker/major findings to implementers, re-test, re-review. Never dismiss a blocker on your own; disagreeing with the reviewer is a user decision. Looping is fine as long as you are not thrashing on the same issue — every attempt must address a novel defect and show phase-appropriate progress. Fix ladder, per review ledger:
- loops 1–3: autonomous; log each in the `run.md` Log (defect, fix, generation);
- loops 4–5: coordinator-approved only; record each grant in the decision ledger, with the loop logged in the `run.md` Log, and evidence that (a) the defect is novel (not a recurrence of an earlier finding) and (b) review progress since the last loop — fewer blocker/major findings, or strictly reduced severity, with no finding re-occurring after being marked fixed;
- 6th attempt: always `ask` the user with the findings.
Thrash guard, independent of loop count: a recurrence of an earlier finding (including one re-occurring after being marked fixed) or absent progress (not fewer blocker/major findings or reduced severity) escalates immediately at any loop, whatever the tier.

Verify before continuing:
- re-run the §6 step-7 freeze recipe and require tree == freeze: `git hash-object` of the fresh list equals `run.md`'s `Freeze:` sha — mismatch = stale report → do not accept it, re-run the phase on the current tree (re-freezing first if the intervening edit was a sanctioned fix);
- `reports/review.<N>.json` shows `verdict: approve` with `scope_ok: true`;
- every `findings[]` entry has a `location` (`path:line`);
- on `changes_requested`, the fix ladder above applies.

## 9. Integrate → Gate 3 (always)

1. Write `summary.md`: what changed, acceptance status, test and review results, every decision and who made it, and remaining risks.

Verify before Gate 3:
- `summary.md` states acceptance status, test and review results, and every decision with who made it.

2. **Gate 3** `ask`: show the summary, `git diff --stat <base>`, and the untracked-file list (`git ls-files --others --exclude-standard`). Choices:
   - commit on `factory/<slug>` (preselected);
   - commit and push the branch;
   - commit, push, and open a PR;
   - leave uncommitted for manual review.
3. Do exactly what was chosen. Commit message: conventional summary line plus body from `summary.md`. Use the repo's existing remote; never force-push, never merge to the default branch.

## Rules for the coordinator

- Every gate and escalation goes through `ask`. Batch questions; never ask one at a time.
- Persist every handoff in the run dir before using it; the run dir is the source of truth if the session compacts or is resumed.
- Update `run.md`'s status line after each phase so a resumed session knows where it is.
- Persist every worker yield as a byte-copy of the raw payload (`read agent://<id>:raw`, write those exact bytes — never retype or re-render); coordinator annotations go to `<report>.notes.md` sidecars or the `run.md` Log, never inside a persisted report. Generation `<N>` counts persisted yield revisions from 1 per artifact (a fresh spawn or a steered re-run of an idle agent each produce the next generation); earlier generations are never deleted or overwritten, and `run.md`'s Current-generations line points at the live one.
- A spawn that dies from model/config routing is coordinator-fixed and re-spawned; it consumes no §7/§8 fix-loop budget.
- Treat every advisory/steering message as a finding: verify it against the tree, then adopt or reject with the reason logged in `run.md` — never adopt silently. During §7/§8 verification, adopted advisory fixes batch into one wave — packet owners apply them at the next verification boundary (or fold them into an open fix loop) and the tree re-freezes once per wave, never once per advisory: each mid-verification edit invalidates every report gathered against the prior freeze.
- Plan amendments per §3: recorded in the `plan.<N>.amendments.json` sidecar plus `run.md`, or a planner re-spawn when structural.
- You coordinate; workers implement. Do not write production code yourself except trivial integration fixes, which you record in `summary.md`.
- Report only what tools showed. Unverified claims are marked `[INFERENCE]`.
- Be transactional: write each spawn/persist/log claim only after the tool result confirms it, never before (run-2 slips: approval-less gate, pre-approval spawn, snapshot into a missing directory, phantom "spawned" log line).
- Run meta-validation on each new playbook check: execute it once against a real tree (including a scratch R/C entry) before shipping it.
