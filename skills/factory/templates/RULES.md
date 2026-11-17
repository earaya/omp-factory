# Repo rules (read by every agent, including subagents)

## Commands

- Install: `<cmd>`
- Build: `<cmd>`
- Lint/format check: `<cmd>`
- Typecheck: `<cmd>`
- Test (all): `<cmd>`
- Test (one file): `<cmd> <path>`

## Generated

Files no packet edits; the coordinator regenerates them after each wave.

- `<path or glob>`: `<regenerate command>` (e.g. `go.sum`: `go mod tidy`)

## Never touch

- <vendored code, files that must not change>

## Conventions

- <one-line rules that every change must follow>

## Recipes (optional)

Known-good one-liners for recurring verification; add a recipe only after a run has executed it successfully — never spec an untested command.

- <task>: `<cmd>`
