#!/usr/bin/env bash
# Coordinator state helper: disk-derived factory-run facts, so the playbook
# never hand-runs or hand-transcribes these recipes.
#
# A record line is one `git status --porcelain=v1 -z --untracked-files=all`
# entry: `<XY>\t<path>\t<sha>` (`deleted` for deletions), plus `\t<orig>` for
# R/C entries, whose second NUL field is consumed as part of the same entry.
# Paths are `printf %q`-escaped so tabs/newlines keep the record parseable.
#
# No `log` subcommand: a script cannot see tool-call results, so
# spawn/persist/log ordering stays a coordinator rule.
set -euo pipefail

die() { echo "factory-state: $*" >&2; exit 2; }

record() {
	# One record line per porcelain entry (see header); run from the repo root.
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

cmd_snapshot() {
	local run_dir=${1:?run-dir} wave=${2:?wave}
	[[ -d $run_dir ]] || die "not a directory: $run_dir"
	mkdir -p "$run_dir/reports"
	record > "$run_dir/reports/status-wave-$wave.before"
}

# Escaped paths whose record line was added, removed, or changed since the
# wave's snapshot: what the wave touched, earlier waves' edits excluded.
cmd_changed() {
	local run_dir=${1:?run-dir} wave=${2:?wave}
	local before=$run_dir/reports/status-wave-$wave.before
	[[ -f $before ]] || die "no snapshot: $before"
	local a b
	a=$(mktemp); b=$(mktemp)
	trap "rm -f '$a' '$b'" EXIT
	LC_ALL=C sort "$before" > "$a"
	record | LC_ALL=C sort > "$b"
	# comm prefixes second-column lines with a tab, shifting the path to field 3.
	LC_ALL=C comm -3 "$a" "$b" | awk -F'\t' '{ print ($1 == "" ? $3 : $2) }' | LC_ALL=C sort -u
}

# Pre-review check: every freeze path (field 2; renamed-from is metadata) is
# in `git diff --name-only <base>` or the untracked set, compared escaped;
# a tracked entry needs a non-empty diff. Exit 1 lists each defect.
cmd_coverage() {
	local run_dir=${1:?run-dir} base=${2:?base}
	local freeze=$run_dir/reports/freeze.txt
	[[ -f $freeze ]] || die "no freeze record: $freeze"
	local covered xy path rest ok=1 tracked=0
	covered=$(mktemp)
	trap "rm -f '$covered'" EXIT
	{ git diff --name-only -z "$base"; git ls-files --others --exclude-standard -z; } |
		while IFS= read -r -d '' path; do printf '%q\n' "$path"; done > "$covered"
	while IFS=$'\t' read -r xy path rest; do
		[[ -n $xy ]] || continue
		[[ $xy == '??' ]] || tracked=1
		if ! grep -Fxq -- "$path" "$covered"; then
			echo "not covered: $path" >&2
			ok=0
		fi
	done < "$freeze"
	if (( tracked )) && [[ -z $(git diff --stat "$base") ]]; then
		echo "tracked entries in freeze but git diff --stat $base is empty" >&2
		ok=0
	fi
	(( ok )) || exit 1
	echo "coverage ok"
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
snapshot) shift; cmd_snapshot "$@" ;;
changed) shift; cmd_changed "$@" ;;
coverage) shift; cmd_coverage "$@" ;;
loops) shift; cmd_loops "$@" ;;
*)
	cat >&2 <<'EOF'
usage: factory-state.sh <command>
  freeze <run-dir>             write reports/freeze.txt, print its sha
  verify <run-dir>             tree == freeze? exit 0, or exit 1 (stale)
  snapshot <run-dir> <wave>    write reports/status-wave-<wave>.before
  changed <run-dir> <wave>     print escaped paths the wave changed since its snapshot
  coverage <run-dir> <base>    every freeze path is in the diff vs base? exit 0, or exit 1 listing defects
  loops <run-dir> <test|review|security>  persisted fix-loop count and ladder tier
EOF
	exit 2
	;;
esac