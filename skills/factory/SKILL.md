---
name: factory
description: Software-factory coordinator. Use when the user invokes /skill:factory or asks to run a task through the factory pipeline (brief → plan → design → implement → test → review → integrate) with human decision gates.
---

# Software factory: coordinator playbook

You are the **coordinator**. You run in the main session because only you can ask the user questions (`ask`); subagents are headless. You own the run directory, the decision ledger, git integration, and every gate. Workers own nothing but their packet.

Templates: `skill://factory/templates/`. Agents: `factory-planner`, `factory-designer`, `factory-implementer`, `factory-tester`, `factory-reviewer`.

State helper, called below as `factory-state`:

```bash
"${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory/scripts/factory-state.ts" <command> …
```

Run it from the repo root. Exit 2 is misuse or a missing file: fix and rerun. Never hand-transcribe what it prints. `factory-state status <run-dir>` prints the live generations, loop counts, and freeze state; use it instead of recording them by hand, and after a resume.

## Spawning and persisting workers

Spawn every worker from eval (Python), one batch per phase, and persist each parsed yield directly:

```python
import json
hs = [agent(prompt, agent="factory-implementer", label="ImplP1"), ...]
rs = wait(hs, raise_errors=False)
write(f"{run}/reports/P1.change.1.json", json.dumps(rs[0], indent=2))
```

- Prompts pass paths, not contents: the run dir, `brief.md`, `plan.<N>.json` and the packet id, its `designs/<P>.<N>.json`, `decisions.md`, `reports/baseline.json`. Workers start blank.
- A slot holding an error, or a result that is not a schema-valid object → log it and re-spawn that worker once; then escalate.
- Generation `<N>` counts revisions per artifact from 1; never overwrite one. Annotations go in `<report>.notes.md` sidecars or the Log, never in a report.

## 0. Triage

- **trivial** (one obvious change, ≤ ~1 file): tell the user it does not need the factory and offer to just do it. Stop unless they insist.
- **small** (one coherent change, a few files, no open design question): skip the planner and designer. Write the single packet `P1` yourself (planner schema, persisted as `plan.1.json`) and show it at Gate 1.
- **standard**: full pipeline; design only packets the planner flags `needs_design`.
- **too large** (more than ~8 packets, or more diff than one reviewer can read): do not start. Offer `/skill:factory-spec`, which splits it into a roadmap of factory runs.

## 1. Set up the run

1. Repo root: `git rev-parse --show-toplevel`. Refuse to start on a dirty working tree; ask the user to commit or stash.
2. Slug: `<YYYYMMDD>-<kebab-summary>`, ≤ 40 chars. Run dir: `<root>/.factory/runs/<slug>/`.
3. Ensure `.factory/` is a line in `<git-common-dir>/info/exclude` (`git rev-parse --git-common-dir`).
4. Record `base` = `git rev-parse HEAD` and the current branch in `run.md` (from `templates/run.md`).
5. `git config user.name` and `git config user.email` must both print a value; otherwise ask for them at Gate 1, since Gate 3 commits.
6. Read `<root>/.omp/RULES.md`. Missing or without build/test commands → draft one from `templates/RULES.md` using what the repo shows (package.json scripts, Makefile, pyproject, CI config) and show it at Gate 1. Subagents see `RULES.md`, not `AGENTS.md`, so repo commands must live there.
7. **Pre-flight models before any long-running step.**
   1. Resolve every agent's `model:` chain: its `@factory_*` role if configured, else `@default` (planner, designer, implementer, tester) or `@advisor` (reviewer), from `cfg://modelRoles` or `~/.omp/agent/config.yml`. Record agent → model in `reports/preflight.json`.
   2. The reviewer's model must be a different family from the implementer's (not two `claude-*`, not two `openai-gpt-*`). Same family → `ask`.
   3. Smoke, in one batch, every agent whose resolved model differs from yours: told to edit nothing and yield the smallest schema-valid report. A `yield` is a tool call, and tool calls are what fail: a gateway can answer plain chat and still 4xx every request that carries tools. Pass = the yield validates and `git status --porcelain` is unchanged. Persist each result and raw error.
   4. Any failure → `ask` with the agent → model table and the raw errors: stop / switch the failing role to a named model and re-smoke / proceed anyway. A switch is a session-only `cfg://modelRoles/<role>` write, persisted only when the user ticks "save". Re-smokes consume no fix-loop budget.

   Nothing below starts until pre-flight passes or the user proceeds.
8. **Baseline.** Run every check in `RULES.md` (build, lint, typecheck, the Test command exactly as given) on `base`; rerun each failing check once. A failure is preexisting only if it fails both times; one that passes the second time is flaky, named in the `run.md` Log. Persist command, result, and failing test names to `reports/baseline.json`. Every later verdict is relative to it: a failure already present is not the run's failure. Show a non-green baseline at Gate 1.

## 2. Intake → Gate 1 (always)

Write `brief.md` from `templates/brief.md`. Investigate the code enough to make acceptance criteria observable; use `scout` for unfamiliar areas. A run imported from a `factory-spec` roadmap item takes that spec's `decisions.md` entries as closed.

**Gate 1**: one `ask` form with the Brief (`<pre>`), any drafted `RULES.md`, a non-green baseline, missing git identity, the `P1` packet for small tasks, and approve / approve with edits (textarea) / stop. Classify each open question by decision `kind`; every human-owned one (architecture, public_api, dependency, data, security, style) goes in the same form as a radio group with the recommendation preselected. Write each answer into `brief.md` as a Constraint, remove it from Open questions, and record it in `decisions.md` as decided by the user. `implementation` questions wait for the plan. Do not plan before approval.

## 3. Plan

Spawn `factory-planner` with the Brief and `decisions.md` (Gate 1 answers are closed: plan only the chosen option). Persist the WorkPlan to `plan.<N>.json` plus a readable `plan.<N>.md` (packets table: id, title, owns, shares, requests, depends_on, risk, needs_design, contract, security_sensitive).

Run `factory-state validate <run-dir>/plan.<N>.json`. Exit 1 → re-spawn the planner with the printed defects, at most twice; then escalate. Also check by reading that every Brief acceptance criterion maps to some packet's `acceptance`.

A planner decision with `blocking: true` → `ask` it now, before design. Answer differs from the recommendation the planner planned on → re-spawn the planner with the answer recorded in `decisions.md`.

Amending the plan yourself (an adopted designer amendment, an advisory, a Gate 2 answer) → write `plan.<N+1>.json` and `plan.<N+1>.md`, validate it, and log what changed and why. A structural change (packets added, removed, or re-split) is a planner re-spawn instead.

## 4. Design

For each `needs_design` packet, spawn `factory-designer` with the packet, the Brief, and `decisions.md`, all in one batch. Persist each to `designs/<packet>.<N>.json`. `packet_amendments` that pass `validate` once applied become a new plan generation (§3); others become decisions.

## 5. Decisions → Gate 2

The human owns architecture and taste. Collect planner and designer `decisions[]` into `decisions.md` (`templates/decisions.md`) and route by `kind`:

- `implementation`, non-blocking → adopt the recommendation as `auto-adopted`; list it in the form so the user can override.
- any other kind, or `blocking: true` → a question, recommendation preselected so a timeout still proceeds.

Gate 2 fires when any question exists: one `ask` form, each question a radio group with options, tradeoffs, and evidence. With an `architecture` decision or `contract` packets, include the `plan.<N>.md` table. Record who decided. Never re-ask a decided question.

When the run came from a `factory-spec` roadmap, also append every user-decided entry to the spec's `decisions.md` (next free id, citing this run) and list them in `summary.md`, so later runs import them as closed.

## 6. Implement

1. Run branch: if the user names an existing branch to integrate on, stay on it and record it as the Run branch; otherwise `git switch -c factory/<slug>` from `base`.
2. `factory-state waves <run-dir>/plan.<N>.json` prints the waves. Packets share one checkout.
3. Before each wave: `factory-state snapshot <run-dir> <N>`.
4. Spawn one `factory-implementer` per wave packet in one batch, each with its packet, DesignNote, affecting ledger decisions, baseline, and Brief.
5. Persist each ChangeReport to `reports/<packet>.change.<N>.json`. `blocked` → its decision goes to a Gate-2-style `ask`, then re-spawn. `partial` → re-spawn once with the gap named; then escalate.
6. Integrate the wave:
   - route the wave's ChangeReport `decisions[]` by §5 before the next wave starts;
   - `factory-state changed <run-dir> <N>` lists the paths the wave touched; each must be in a wave packet's `owns`/`shares`/`requests`, a reported test file, or a "Generated" entry. Anything else is a defect: re-assign or revert only with the user's approval;
   - run the build/typecheck and the wave's tests. A failure outside the baseline goes to the implementers whose `files_changed` touch it, told which other packets changed those files; none did → fix it as a trivial integration fix or escalate;
   - `deviations` naming a stale doc or comment in a file another packet owns → add the wording to that owner's goal in its wave, or, if its wave already ran, to the Gate 3 round (§9). Every other deviation goes in `summary.md`.
7. After the last wave, and after every later fix edit: `factory-state freeze <run-dir>`.

## 7. Test (once)

Spawn `factory-tester` once, after the last wave, with the Brief, packets, ChangeReports, and baseline. Persist to `reports/test.1.json`. Accept it only if `factory-state verify <run-dir>` exits 0 (tree == freeze; the tester may add tests, then re-freeze) and the report shows `verdict: pass` with evidence on every acceptance entry.

`fail` → route each failure to its packet's implementer (fresh spawn, prior ChangeReport attached), re-freeze, then rerun the `RULES.md` Test command and the checks that failed yourself. Persist that rerun as the next `test.<N>.json` in TestReport shape: your commands and results, the failed `acceptance` entries re-checked, the rest carried over, `tests_added: []`. Re-spawn the tester only when a fix adds behavior no existing test covers. All of this runs under the fix ladder.

## 8. Review

Before spawning: `factory-state coverage <run-dir> <base>` must exit 0 (every changed path is visible to the reviewer's diff). Exit 1 is a defect to fix first, usually an exclude rule hiding a file.

One **round** spawns `factory-reviewer` → `reports/review.<N>.json`, given the Brief, WorkPlan, DesignNotes, `decisions.md`, the run dir path, and `base`. Do not paste ChangeReports or TestReports into its prompt; it reads them from the run dir after forming its own view.

Then:
- `taste` findings and reviewer `decisions[]` never enter the fix loop: non-blocking ones go to Gate 3, blocking ones to an `ask` routed by §5.
- other `blocker`/`major` findings → implementers, re-freeze, rerun the checks (§7), new round, under the fix ladder.

Never dismiss a blocker or major yourself. If the tree contradicts one, spawn `factory-reviewer` once with only that finding and your `path:line` evidence, persisted as `reports/review.<N>.dispute.json`. Withdrawn → drop it; upheld → `ask` the user. Accept the round only when `factory-state verify` exits 0 and the review approves with `scope_ok: true`.

## Fix ladder (test and review)

`factory-state loops <run-dir> <test|review>` prints the pending loop and its tier: loops 1–3 run autonomously; loop 4 or later → `ask` the user.

Thrash guard, at any loop: a recurrence of an earlier finding, or no progress (test: not fewer failing commands or unmet criteria; review: not fewer blocker/major findings or lower severity) → `ask` the user now. A spawn that dies from model routing is re-spawned without using budget.

## 9. Integrate → Gate 3 (always)

1. Write `summary.md`: what changed, acceptance status, test results against the baseline, review results, every decision and who made it, unrouted deviations, remaining risks.
2. Generate the run report: `"${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory-retro/scripts/factory-retro.ts" report <run-dir>` writes `<run-dir>/report.html`; give its path in the form.
3. **Gate 3** `ask`: the summary, `git diff --stat <base>`, untracked files, open `taste` findings and stale-doc deviations (checkboxes: which to apply), pending reviewer decisions (radio groups), and: commit on the Run branch (preselected) / commit and push it / commit, push, and open a PR / leave uncommitted.
4. Selected items that change code → one implementer round, rerun the checks, re-freeze; no new review unless the change exceeds what was named.
5. Do exactly what was chosen. Message: conventional summary line plus body from `summary.md`. Use the existing remote; never force-push, never merge to the default branch.

## Rules for the coordinator

- Every gate and escalation goes through `ask`, batched.
- The run dir is the source of truth if the session compacts or resumes: persist every handoff before using it, and update `run.md`'s Status after each phase.
- `run.md` Log: one event per line, `- <date> <event>: <text>`.
- An **advisory** is an `<advisory>` note from the omp advisor (see README). Treat each as a finding: verify it against the tree, then log it on its own line whose event word is `advisory`, with `adopted` or `rejected` and the reason. During test/review, batch adopted fixes into one wave and re-freeze once, not per advisory.
- Log a spawn, persist, or check only after the tool result confirms it.
- You coordinate; workers implement. Write production code only for trivial integration fixes, each listed in `summary.md`.
- Report only what tools showed; mark the rest `[INFERENCE]`.
