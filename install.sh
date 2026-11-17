#!/usr/bin/env bash
# Symlink the factory into omp's user agent directory so every repo sees it.
# Idempotent. Never overwrites a real file; reports conflicts instead.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
status=0

link() {
	local src="$1" dst="$2"
	mkdir -p "$(dirname "$dst")"
	if [[ -L "$dst" ]]; then
		ln -sfn "$src" "$dst"
	elif [[ -e "$dst" ]]; then
		echo "conflict: $dst exists and is not a symlink; skipped" >&2
		status=1
		return
	else
		ln -s "$src" "$dst"
	fi
	echo "linked $dst -> $src"
}

for f in "$repo"/agents/*.md; do
	link "$f" "$agent_dir/agents/$(basename "$f")"
done
link "$repo/skills/factory" "$agent_dir/skills/factory"
link "$repo/skills/factory-retro" "$agent_dir/skills/factory-retro"
link "$repo/skills/factory-spec" "$agent_dir/skills/factory-spec"
for f in "$repo"/hooks/pre/*.ts; do
	link "$f" "$agent_dir/hooks/pre/$(basename "$f")"
done

cat <<EOF

Optional: merge config/config.example.yml into $agent_dir/config.yml
(model roles). Agents fall back to @default/@advisor without it.
EOF
exit "$status"
