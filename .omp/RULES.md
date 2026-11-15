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

## Recipes

- Parse agent YAML frontmatter: `bun -e 'const {parse}=await import("yaml");const t=await Bun.file(process.argv[2]||process.argv[1]).text();const m=t.match(/^---\n([\s\S]*?)\n---/);console.log(parse(m[1]));' <agent>.md` (dynamic import — CJS `require("yaml")` fails; the trailing argument is the agent file).
