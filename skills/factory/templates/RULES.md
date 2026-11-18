# Repo rules (read by every agent, including subagents)

## Commands

- Install: `<cmd>`
- Build: `<cmd>`
- Lint/format check: `<cmd>`
- Typecheck: `<cmd>`
- Test (all): `<cmd>`
- Test (one file): `<cmd> <path>`

## Generated

Files no packet owns or shares. A packet that needs one changed lists its manifest in `requests` and runs the regenerate command.

- `<path or glob>`: `<regenerate command>` (e.g. `go.sum`: `go mod tidy`; `package-lock.json`: `npm install`; `poetry.lock`: `poetry lock`)

## Never touch

- <vendored code, files that must not change>

## Conventions

- <one-line rules that every change must follow>
