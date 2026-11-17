---
name: factory-retro
description: Factory retrospective. Use after a factory run, or when the user invokes /skill:factory-retro <run-dir>..., to turn one or more .factory/runs/<slug>/ directories into proposed changes to the factory (omp-factory) or to the target repo's .omp/RULES.md.
---

# Factory retro: playbook

You turn finished runs into proposals. You propose; the user decides. Edit nothing before the user accepts a proposal.

Inputs: one or more run directories (`.factory/runs/<slug>/`). No directory given → ask for one; never guess.

## 1. Collect

```bash
"${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/skills/factory-retro/scripts/factory-retro.ts" collect <run-dir> [<run-dir>...]
```

Exit 2 → report the stderr message and stop. One directory prints the run object; several print `{runs, totals}`.

Signals, per run:

| Field | Friction it points at |
|---|---|
| `plan_generations` > 1 | a re-plan |
| `amendments` | plan entries superseded after persistence |
| `schema_failures` | a yield that failed its output schema |
| `advisories` | advisor interventions: Log lines whose event word is `advisory`, counted `adopted` / `rejected` / `unclassified` in `lines`; `mentioned` holds uncounted Log lines that cite an advisory inside another event |
| `applied_requests` | an implementer applied a `requests` entry itself |
| `deviations` | an implementer departed from packet or DesignNote |
| `loops.<phase>.generation` > 1 | a fix loop in test, review, or security |
| `decisions` | `user` vs `auto` (auto-adopted) vs `total` |

The collector matches run.md Log prose by pattern. Re-read every echoed `lines` entry and correct its classification before using it; a misclassified line is not evidence. Read every `advisories.mentioned` line too: it may record an advisory verdict the counts miss.

## 2. Root-cause

1. Read `skill://factory` and every agent the signals implicate (`factory-planner`, `factory-designer`, `factory-implementer`, `factory-tester`, `factory-reviewer`, `factory-security-reviewer`). Read the target repo's `.omp/RULES.md`.
2. For each nonzero signal, read the run artifacts behind it (`run.md`, `plan.<N>.json`, `plan.<N>.amendments.json`, `reports/*.json`, `decisions.md`) and find why it happened. A count is not a cause.
3. Cite evidence on both sides: `path:line` in the run directory, and the `skill://factory`, agent, or `.omp/RULES.md` line the proposal would change. No citation on either side → no proposal.
4. Decide the fix target:
   - `factory`: the playbook or an agent in omp-factory was missing, wrong, or vague.
   - `repo`: the target repo's `.omp/RULES.md` lacked a command, generated file, or convention.
   - neither: the run behaved as designed; drop the signal.
5. Consider deletions on every pass. Propose deleting a playbook or agent rule when:
   - it did not fire in any given run and no signal needs it;
   - a signal shows it caused the friction or is wrong.
   When deleting a rule and adding one both fix the friction, propose the deletion.
6. A signal seen in only one run → label the proposal `single-run evidence`.

## 3. Propose

One batched `ask` form. Never ask per proposal. Each proposal:

- title: `[factory]` or `[repo]` tag, `add` / `change` / `delete`, one-line summary;
- body: the signal, the root cause, both citations, the exact text to add, change, or delete, and `single-run evidence` when it applies;
- radio group: accept / reject (no preselection);
- textarea: edits to the proposed text.

No proposals → say so with the signals checked and stop.

## 4. Apply

1. Accepted proposals only, with the user's textarea edits applied. Rejected proposals are dropped; record them nowhere else.
2. `factory` proposals: edit omp-factory, then run `bun test` there (no standalone Bun: `BUN_BE_BUN=1 "$(realpath "$(which omp)")" test`). Failure → fix the edit, never the test, and rerun.
3. `repo` proposals: edit the target repo's `.omp/RULES.md`.
4. Commit each changed repo with the `commit` eval namespace: conventional summary line, body listing each accepted proposal and its run-dir evidence. Never push.
5. Report what changed, per repo, with the commit sha.
