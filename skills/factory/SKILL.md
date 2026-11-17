---
name: factory
description: Software-factory coordinator. Use when the user invokes /skill:factory or asks to run a task through the factory pipeline (brief → plan → design → implement → test → review → integrate) with human decision gates.
---

# Software factory: coordinator playbook

You are the **coordinator**. You run in the main session because only you can ask the user questions (`ask`); subagents are headless. You own the run directory, the decision ledger, git integration, and every gate. Workers own nothing but their packet.

Templates: `skill://factory/templates/`. Agents: `factory-planner`, `factory-designer`, `factory-implementer`, `factory-tester`, `factory-reviewer`, `factory-security-reviewer`.

State helper, called below as `factory-state`:

```bash
"${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory/scripts/factory-state.ts" <command> …
```

Run it from the repo root. Exit 2 is misuse or a missing file: fix and rerun. Never hand-transcribe what it prints.

## 0. Triage

- **trivial** (one obvious change, ≤ ~1 file): tell the user it does not need the factory and offer to just do it. Stop unless they insist.
- **small** (one coherent change, a few files, no open design question): skip the planner and designer. Write the single packet `P1` yourself (planner schema, persisted as `plan.1.json`) and show it at Gate 1.
- **standard**: full pipeline; design only packets the planner flags `needs_design`.
- **too large** (more than ~8 packets, or more diff than one reviewer can read): do not start. Propose a split into 2–5 tasks, each shippable and verifiable alone, and run each as its own factory run.

## 1. Set up the run

1. Repo root: `git rev-parse --show-toplevel`. Refuse to start on a dirty working tree; ask the user to commit or stash.
2. Slug: `<YYYYMMDD>-<kebab-summary>`, ≤ 40 chars. Run dir: `<root>/.factory/runs/<slug>/`.
3. Ensure `.factory/` is a line in `<git-common-dir>/info/exclude` (`git rev-parse --git-common-dir`).
4. Record `base` = `git rev-parse HEAD` and the current branch in `run.md` (from `templates/run.md`).
5. Read `<root>/.omp/RULES.md`. Missing or without build/test commands → draft one from `templates/RULES.md` using what the repo shows (package.json scripts, Makefile, pyproject, CI config) and show it at Gate 1. Subagents see `RULES.md`, not `AGENTS.md`, so repo commands must live there.
6. **Pre-flight models before any long-running step.**
   1. Resolve every agent's `model:` chain: its `@factory_*` role if configured, else `@default` (planner, designer, implementer, tester) or `@advisor` (both reviewers), from `cfg://modelRoles` or `~/.omp/agent/config.yml`. Record agent → model in `reports/preflight.json`.
   2. The reviewers' model must be a different family from the implementer's (not two `claude-*`, not two `openai-gpt-*`). Same family → `ask`.
   3. Spawn, in one `tasks[]` batch, `factory-implementer` and `factory-reviewer`, each told to edit nothing and only `yield`:
      - implementer: packet `{id: P0, title: "pre-flight smoke", goal: "Edit nothing; yield a ChangeReport.", owns: [], shares: [], requests: [], reads: [], depends_on: [], acceptance: ["A ChangeReport is yielded and no file is edited"], risk: low, needs_design: false, contract: false, security_sensitive: false}`. No testable code, so no TDD; the legal report is `status: done`, empty `files_changed`, `verification: []`, one `acceptance` entry `met: true` with evidence `git status --porcelain unchanged`.
      - reviewer: an empty diff; the legal report is `verdict: approve`, `scope_ok: true`, no findings.
      Also smoke any other agent whose resolved model differs from both. A `yield` is a tool call, and tool calls are what fail: a gateway can answer plain chat and still 4xx every request that carries tools. Pass = the spawn completed, the yield validates against the agent's schema, and `git status --porcelain` is unchanged. Persist each result and raw error.
   4. Any failure → `ask` with the agent → model table and the raw errors: stop / switch the failing role to a named model and re-smoke / proceed anyway. A switch is a session-only `cfg://modelRoles/<role>` write, persisted only when the user ticks "save". Re-smokes consume no fix-loop budget.

   Nothing below starts until pre-flight passes or the user proceeds.
7. **Baseline.** Run every check in `RULES.md` (build, lint, typecheck, the Test command exactly as given) on `base`. Persist command, result, and failing test names to `reports/baseline.json`. Every later verdict is relative to it: a failure already present is not the run's failure. Show a non-green baseline at Gate 1.

## 2. Intake → Gate 1 (always)

Write `brief.md` from `templates/brief.md`. Investigate the code enough to make acceptance criteria observable; use `scout` for unfamiliar areas.

**Gate 1**: one `ask` form with the Brief (`<pre>`), any drafted `RULES.md`, a non-green baseline, the `P1` packet for small tasks, and approve / approve with edits (textarea) / stop. Classify each open question by decision `kind`; every human-owned one (architecture, public_api, dependency, data, security, style) goes in the same form as a radio group with the recommendation preselected. Write each answer into `brief.md` as a Constraint, remove it from Open questions, and record it in `decisions.md` as decided by the user. `implementation` questions wait for the plan. Do not plan before approval.

## 3. Plan

Spawn `factory-planner` with the Brief and `decisions.md` (Gate 1 answers are closed: plan only the chosen option). Persist the WorkPlan to `plan.<N>.json` plus a readable `plan.<N>.md` (packets table: id, title, owns, shares, requests, depends_on, risk, needs_design, contract, security_sensitive).

Validate:
- no file/glob in two packets' `owns`, or in one packet's `owns` and another's `shares`/`requests`;
- no `RULES.md` "Generated" file in any packet;
- `contract` packets have no `depends_on`; every packet that `reads` a contract file `depends_on` it;
- `depends_on` is acyclic and names real ids;
- every Brief acceptance criterion maps to some packet's `acceptance`.

Violation → re-spawn the planner with the defect, at most twice; then escalate. Your own amendments go in the append-only `plan.<N>.amendments.json` sidecar (what/why/who); a structural amendment is a planner re-spawn instead.

## 4. Design

For each `needs_design` packet, spawn `factory-designer` with the packet, the Brief, and `decisions.md`, all in one `tasks[]` batch. Persist each to `designs/<packet>.<N>.json`. Apply `packet_amendments` only if they pass the §3 ownership checks; otherwise they become decisions.

## 5. Decisions → Gate 2

The human owns architecture and taste. Collect planner and designer `decisions[]` into `decisions.md` (`templates/decisions.md`) and route by `kind`:

- `implementation`, non-blocking → adopt the recommendation as `auto-adopted`; list it in the form so the user can override.
- any other kind, or `blocking: true` → a question, recommendation preselected so a timeout still proceeds.

Gate 2 fires when any question exists: one `ask` form, each question a radio group with options, tradeoffs, and evidence. With an `architecture` decision or `contract` packets, include the `plan.<N>.md` table. Record who decided. Never re-ask a decided question.

## 6. Implement

1. `git switch -c factory/<slug>` from `base`.
2. Order packets into **waves** by `depends_on`; `contract` packets form wave 0. Packets share one checkout. Two packets in one wave listing the same `shares` or `requests` file, or running the same heavyweight build/test → move the later one (by id) to the next wave.
3. Before each wave: `factory-state snapshot <run-dir> <N>`.
4. Spawn one `factory-implementer` per packet in one `tasks[]` batch. Each item: the packet JSON, its DesignNote, the ledger decisions that affect it, `reports/baseline.json`, the Brief path. Workers start blank.
5. Persist each ChangeReport to `reports/<packet>.change.<N>.json`. `blocked` → its decision goes to a Gate-2-style `ask`, then re-spawn. `partial` → re-spawn once with the gap named; then escalate.
6. Integrate the wave:
   - apply every `requests` entry not already applied, exactly as `intent` states, then the `RULES.md` "Generated" regenerate commands; check each entry matches its `intent`;
   - `factory-state changed <run-dir> <N>` lists the paths the wave touched; each must be in a wave packet's `owns`/`shares`/`requests`, a reported test file, or a "Generated" entry. Anything else is a defect: re-assign or revert only with the user's approval;
   - run the build/typecheck and the wave's tests. A failure outside the baseline goes to the implementers whose `files_changed` touch it, told which other packets changed those files; none did → it is the `requests`/regenerate step: fix it as a trivial integration fix or escalate.
7. After the last wave, and after every later fix edit: `factory-state freeze <run-dir>`, and put the printed sha on `run.md`'s `Freeze:` line.

## 7. Test

Spawn `factory-tester` with the Brief, packets, ChangeReports, and `reports/baseline.json`. Persist to `reports/test.<N>.json`. Accept it only if `factory-state verify <run-dir>` exits 0 (tree == freeze; the tester may add tests, then re-freeze) and the report shows `verdict: pass` with evidence on every acceptance entry. `fail` → route each failure to its packet's implementer (fresh spawn, prior ChangeReport attached), re-freeze, re-test, under the fix ladder.

## 8. Review

Before spawning: `factory-state coverage <run-dir> <base>` must exit 0 (every changed path is visible to the reviewer's diff). Exit 1 is a defect to fix first, usually an exclude rule hiding a file.

One **round** spawns, in one `tasks[]` batch:
- `factory-reviewer`, always → `reports/review.<N>.json`;
- `factory-security-reviewer` when any packet is `security_sensitive`, given only those packets → `reports/security.<N>.json`.

Give each the Brief, WorkPlan, DesignNotes, `decisions.md`, the run dir path, and the diff: `git diff <base>` plus each untracked file (`git ls-files --others --exclude-standard`, read via `git diff --no-index /dev/null -- <file>`). Do not paste ChangeReports or TestReports into their prompts; they read them from the run dir after forming their own view.

Merge the round: deduplicate findings with the same `location` and issue, keeping the higher severity. Then:
- `taste` findings and reviewer `decisions[]` never enter the fix loop: non-blocking ones go to Gate 3, blocking ones to an `ask` routed by §5.
- other `blocker`/`major` findings → implementers, re-freeze, re-test, new round (both reviewers again if the security reviewer ran), under the fix ladder.

Never dismiss a blocker yourself; disagreeing with a reviewer is a user decision. Accept the round only when `factory-state verify` exits 0, `review` approves with `scope_ok: true`, and `security` (if spawned) approves.

## Fix ladder (test and review)

The tier comes from `factory-state loops <run-dir> <test|review|security>`; for review use the higher of `review` and `security`.

- loops 1–3: autonomous.
- loops 4–5: coordinator-approved; record each grant in `decisions.md` with evidence that the defect is novel and that progress was made.
- 6th attempt: `ask` the user.

Thrash guard, at any loop: a recurrence of an earlier finding, or no progress (test: not fewer failing commands or unmet criteria; review: not fewer blocker/major findings or lower severity) → `ask` the user now. A spawn that dies from model routing is re-spawned without using budget.

## 9. Integrate → Gate 3 (always)

1. Write `summary.md`: what changed, acceptance status, test results against the baseline, review results, every decision and who made it, remaining risks.
2. **Gate 3** `ask`: the summary, `git diff --stat <base>`, untracked files, open `taste` findings (checkboxes: which to apply), pending reviewer decisions (radio groups), and: commit on `factory/<slug>` (preselected) / commit and push the branch / commit, push, and open a PR / leave uncommitted.
3. Selected taste findings or decisions that change code → one implementer round, re-test, re-freeze; no new review unless the change exceeds what was named.
4. Do exactly what was chosen. Message: conventional summary line plus body from `summary.md`. Use the existing remote; never force-push, never merge to the default branch.

## Rules for the coordinator

- Every gate and escalation goes through `ask`, batched.
- The run dir is the source of truth if the session compacts or resumes: persist every handoff before using it, and update `run.md`'s Status after each phase.
- Persist each worker yield as a byte-copy of `agent://<id>:raw` (read it with the eval `read`; bash cannot open `agent://`). Annotations go in `<report>.notes.md` sidecars or the Log, never in a report. Generation `<N>` counts revisions per artifact from 1; never overwrite one; `run.md`'s Current-generations line points at the live ones.
- `run.md` Log: one event per line, `- <date> <event>: <text>`. An advisory gets its own line whose event word is `advisory`, with `adopted` or `rejected` and the reason.
- Treat every advisory as a finding: verify it against the tree, then adopt or reject in the Log. During test/review, batch adopted fixes into one wave and re-freeze once, not per advisory.
- Log a spawn, persist, or check only after the tool result confirms it.
- You coordinate; workers implement. Write production code only for `requests` entries, regenerated files, and trivial integration fixes, each listed in `summary.md`.
- Report only what tools showed; mark the rest `[INFERENCE]`.
