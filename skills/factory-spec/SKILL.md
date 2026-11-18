---
name: factory-spec
description: Factory spec writer. Use when the user invokes /skill:factory-spec or asks to spec a change too large or vague for one factory run (a new project, a large feature, a migration). Interviews the user, then writes a spec, a decision ledger, and a roadmap of ready-to-run factory Briefs.
---

# Factory spec: playbook

You turn a large or vague request into a spec the factory can execute: one `spec.md`, one decision ledger the factory runs import, and a `roadmap.md` of factory runs, each with a ready-to-paste Brief. You run in the main session; only you can `ask`.

Templates: `skill://factory-spec/templates/` (`spec.md`, `roadmap.md`); the ledger uses `skill://factory/templates/decisions.md`. Check helper:

```bash
"${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory-spec/scripts/factory-spec.ts" check <spec-dir>
```

## 1. Read before asking

Every question a tool could answer is a failure. Before the first question:

1. Find the current state: the files, modules, and services the change touches. Use `scout` for unfamiliar areas.
2. Map every consumer of what changes, including systems the user does not name: callers, config, deploy files, and other services that read or write the same state. Search the organization's other repos for the store's key prefixes, table names, queue or exchange names, and the message shapes you plan to add (`gh search code` or local checkouts). An existing producer of a planned message shape is a contract collision.
3. For each piece of data involved, classify where its truth lives: **a cache of a source**, **the only copy**, or **written by another system**. Each class needs its own migration or cutover rule; sorting by feature or by item hides this.
4. Record facts with `path:line`. Anything you cannot verify is `[INFERENCE]`.

Present the verified inventory at the start of round 1, not guesses.

## 2. Interview

- Batched rounds: one `ask` form per round, 3–6 questions, a recommendation preselected for each. Never ask one question at a time.
- Order: problem, users, and constraints (deploy facts, rollback, data lifetimes) → design options → contracts and interfaces → sequencing.
- **Lead with the simplest safe design.** Before proposing modes, flags, or multi-phase rollouts, check them against the operational facts (how long old and new versions coexist, what a rollback is). If a simpler design is safe, recommend it first.
- **A prefilled form default is not an answer.** A numeric field or text box the user left at its default, or an answer that contradicts another answer, is unresolved: ask again before writing it to the ledger.
- A free-text answer that asks a question gets answered, with evidence, in the next round; do not record it as a decision.
- Cross-repo: when another repo is involved, read its latest default branch (check its tree is clean before pulling) instead of assuming.

Stop interviewing when every human-owned choice (architecture, public_api, dependency, data, security, style) is decided or explicitly marked open with who decides it and when.

## 3. Write

In `<repo>/docs/specs/<YYYYMMDD-slug>/`, committed on the branch the work will land on:

- `spec.md` (template): problem, goals, non-goals, current state with `path:line`, design, rollout, ops prerequisites, risks, open items.
- `decisions.md` (factory ledger format): one entry per decision with `Kind` and `Decision`. A superseded entry says `superseded by D<n>`; an open one says `open`, with a `Recommendation` and who decides it.
- `roadmap.md` (template): one factory run per section `## R<n>: <title>` with `Goal`, `Scope`, `Acceptance`, in dependency order, plus a table with `Depends on`.

Rules for the roadmap:

- **Each run's acceptance is checkable within its own scope.** A criterion that needs something outside the run's scope is untestable: split the scope so each run checks only what it changes.
- **Cross-system contracts are specified to field level and transport**, including headers and which side reads which field, and the acceptance asserts that exact shape.
- A run with "no behavior change" may not touch live code paths.
- Docs describe code; never cite run, packet, or decision IDs in repo docs the runs will edit.
- Every other repo gets a small linked spec in its own docs convention, covering only its runs. It names the open decisions that its run decides and records them in its own file; the main ledger copies them before dependent runs start.

## 4. Check

1. `factory-spec check <spec-dir>` must exit 0. It verifies structure: the three files exist; every ledger entry has `Kind` and `Decision`; open entries have a `Recommendation`; every `D<n>` and `R<n>` cited exists; every run has Goal, Scope, and Acceptance; and no Acceptance contains a backticked value from an open decision's Recommendation (write "the contract D<n> decides" instead). Exit 1 lists defects; fix them and rerun.
2. Judgment checks the script cannot do: re-read each Brief against its scope (rule 1 above), and remove text left over from superseded decisions.
3. Spawn `factory-reviewer` (a different model family) with the spec directory as the "diff", the interview answers, and this instruction: review the spec for contradictions between files, acceptance criteria outside their run's scope, underspecified cross-system contracts, and decisions recorded from defaults. Fix blockers and majors; route its `decisions[]` to the user.

## 5. Hand off

Commit the spec. Give the user the exact `/skill:factory` prompt for the first run: the roadmap path and run id, "read spec.md and decisions.md first; imported decisions are closed", and the branch to work on if it already exists. For other repos, give their prompt separately. After each run, `/skill:factory-retro` on its run directory; fold spec lessons back into the spec before the next run.
