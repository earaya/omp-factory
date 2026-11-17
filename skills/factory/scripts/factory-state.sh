#!/usr/bin/env bash
# Coordinator state helper — disk-derivable factory-run facts only.
#
# freeze/verify implement the skills/factory/SKILL.md §6 step-7 recipe verbatim
# (porcelain v1 -z; an R/C entry consumes both NUL-delimited fields as one
# entry; per-path `git hash-object`, `deleted` markers, `printf %q` path
# escaping), so the Freeze sha is derived from the tree — never hand-
# transcribed — and tree == freeze is one command.
#
# Deliberately no `log` subcommand: a script cannot see tool-call results, so
# spawn/persist/log ordering stays a coordinator rule ("Be transactional").
set -euo pipefail

die() { echo "factory-state: $*" >&2; exit 2; }

record() {
	# The §6 step-7 recipe, run from the repo root.
	while IFS= read -r -d '' entry; do
		local xy=${entry:0:2}
		local path=${entry:3}
		local orig=""
		if [[ $xy == [RC]* ]]; then
			IFS= read -r -d '' orig || true
		fi
		if [[ $xy == *D* ]]; then
			printf '%s\t%s\tdeleted\n' "$xy" "$(printf '%q' "$path")"
		elif [[ $xy == [RC]* ]]; then
			printf '%s\t%s\t%s\t%s\n' "$xy" "$(printf '%q' "$path")" \
				"$(git hash-object -- "$path")" "$(printf '%q' "$orig")"
		elif [[ -f $path ]]; then
			printf '%s\t%s\t%s\n' "$xy" "$(printf '%q' "$path")" "$(git hash-object -- "$path")"
		fi
	done < <(git status --porcelain=v1 -z --untracked-files=all)
}

cmd_freeze() {
	local run_dir=${1:?run-dir}
	[[ -d $run_dir ]] || die "not a directory: $run_dir"
	mkdir -p "$run_dir/reports"
	record > "$run_dir/reports/freeze.txt"
	git hash-object "$run_dir/reports/freeze.txt"
}

cmd_verify() {
	local run_dir=${1:?run-dir}
	local freeze=$run_dir/reports/freeze.txt
	[[ -f $freeze ]] || die "no freeze record: $freeze"
	local fresh sha
	fresh=$(mktemp)
	trap 'rm -f "$fresh"' EXIT
	record > "$fresh"
	sha=$(git hash-object "$fresh")
	if diff -q "$fresh" "$freeze" >/dev/null; then
		echo "tree == freeze: $sha"
		exit 0
	fi
	echo "stale: tree differs from $freeze (fresh sha: $sha)" >&2
	exit 1
}

cmd_next() {
	local dir=${1:?dir} prefix=${2:?prefix}
	[[ -d $dir ]] || die "not a directory: $dir"
	local max=0 n f
	for f in "$dir/$prefix."*; do
		if [[ ! -e $f ]]; then
			continue
		fi
		n=${f#"$dir/$prefix".}
		n=${n%%.*}
		if [[ $n =~ ^[0-9]+$ ]] && (( n > max )); then
			max=$n
		fi
	done
	echo "$prefix.$(( max + 1 ))"
}

# Fix loops derive from the persisted reports' latest verdict: the phase's Nth
# fix loop is triggered BY its Nth failing report (test = "fail", review =
# "changes_requested"), so failing count = pending loop; a passing latest
# report closes the phase. Disk-derived, never hand-counted.
cmd_loops() {
	local run_dir=${1:?run-dir} phase=${2:?test|review|security}
	local reports=$run_dir/reports
	local bad
	case $phase in
		test) bad='fail' ;;
		review|security) bad='changes_requested' ;;
		*) die "phase must be test, review, or security" ;;
	esac
	if [[ ! -d $reports ]]; then
		echo "$phase fix loops: 0 completed, no pending attempt — autonomous (loops 1-3)"
		return
	fi
	# Generations order numerically: the glob is lexical, so test.10.json
	# sorts before test.9.json — "latest" must track the highest
	# generation, not the last glob hit. Sidecars (.notes.md) are not
	# .json and never match.
	local n=0 latest="" gen v f line
	for line in $(for f in "$reports/$phase."*.json; do
		if [[ ! -e $f ]]; then
			continue
		fi
		gen=${f#"$reports/$phase".}
		gen=${gen%%.*}
		if ! [[ $gen =~ ^[0-9]+$ ]]; then
			continue
		fi
		if grep -qE '"verdict"[[:space:]]*:[[:space:]]*"'"$bad"'"' "$f"; then
			v=bad
		else
			v=good
		fi
		printf '%s %s\n' "$gen" "$v"
	done | sort -n); do
		gen=${line%% *}
		v=${line#* }
		if [[ $v == bad ]]; then
			n=$(( n + 1 ))
		fi
		latest=$v
	done
	if [[ -z $latest ]]; then
		echo "$phase fix loops: 0 completed, no pending attempt — autonomous (loops 1-3)"
		return
	fi
	if [[ $latest == good ]]; then
		echo "$phase fix loops: $n completed, phase closed — next report opens loop $(( n + 1 ))"
		return
	fi
	local tier
	case $n in
		1|2|3) tier='autonomous (loops 1-3)' ;;
		4|5) tier='coordinator-approved (loops 4-5)' ;;
		*) tier='user approval (6th attempt)' ;;
	esac
	echo "$phase fix loops: $(( n - 1 )) completed, pending attempt = loop $n — $tier"
}

case ${1:-} in
freeze) shift; cmd_freeze "$@" ;;
verify) shift; cmd_verify "$@" ;;
next) shift; cmd_next "$@" ;;
loops) shift; cmd_loops "$@" ;;
*)
	cat >&2 <<'EOF'
usage: factory-state.sh <command>
  freeze <run-dir>     write reports/freeze.txt per the §6 step-7 recipe, print its sha
  verify <run-dir>     tree == freeze? exit 0 and print the sha, or exit 1 (stale)
  next <dir> <prefix>  next generation name (e.g. next reports test -> test.3)
  loops <run-dir> <test|review|security>  count persisted fix loops and report the §7/§8 ladder tier
EOF
	exit 2
	;;
esac