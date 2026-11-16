# Repo rules (read by every agent, including subagents)

## Commands

- Install: `<cmd>`
- Build: `<cmd>`
- Lint/format check: `<cmd>`
- Typecheck: `<cmd>`
- Test (all): `<cmd>`
- Test (one file): `<cmd> <path>`

## Never touch

- <generated files, vendored code, lockfiles unless required>

## Conventions

- <one-line rules that every change must follow>

## Recipes (optional)

Known-good one-liners for recurring verification; add a recipe only after a run has executed it successfully — never spec an untested command.

- <task>: `<cmd>`
