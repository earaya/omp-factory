# Repo rules (read by every agent, including subagents)

## Commands

- Install: `none` (omp's bundled Bun runs the scripts and tests)
- Build: `none`
- Lint/format check: `none configured`
- Typecheck: `none (Bun strips types; no tsconfig)`
- Test (all): `bun test`, or `BUN_BE_BUN=1 "$(realpath "$(which omp)")" test` without a standalone Bun
- Test (one file): same command plus `<path>`

## Never touch

- `.git/`, `.factory/` (run artifacts), `~/.omp/agent/` symlinks

## Conventions

- Agent YAML frontmatter (`name`, `description`, `model`, `structured`, `tools`, `output`) is the contract — keep it valid YAML.
- TypeScript uses tabs. Scripts start with `#!/usr/bin/env -S BUN_BE_BUN=1 omp` and are executable; markdown is docs.
- Terse imperative tone; no emojis in shipped docs.
