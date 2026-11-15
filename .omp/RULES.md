# Repo rules (read by every agent, including subagents)

## Commands

- Install: `none — markdown repo; Bun alone runs the tests`
- Build: `none`
- Lint/format check: `none configured`
- Typecheck: `none (Bun strips types; no tsconfig)`
- Test (all): `bun test`
- Test (one file): `bun test <path>`

## Never touch

- `.git/`, `.factory/` (run artifacts), `~/.omp/agent/` symlinks

## Conventions

- Agent YAML frontmatter (`name`, `description`, `model`, `structured`, `tools`, `output`) is the contract — keep it valid YAML.
- TypeScript uses tabs; markdown is docs.
- Terse imperative tone; no emojis in shipped docs.
