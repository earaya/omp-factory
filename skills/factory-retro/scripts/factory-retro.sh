#!/usr/bin/env bash
# Retro collector — friction signals from finished factory run directories.
#
# Disk-derived only: counts and verbatim lines, no judgement. run.md Log lines
# are coordinator prose, not a schema, so every pattern-matched line is echoed
# verbatim and the factory-retro skill re-checks the classification.
#
# Generations order numerically (plan.10 > plan.9); only `<prefix>.<N>.json`
# counts, so sidecars (.md, .notes.md, .amendments.json) never bump one.
set -euo pipefail

die() { echo "factory-retro: $*" >&2; exit 2; }

usage() {
	cat >&2 <<'EOF'
usage: factory-retro.sh <command>
  collect <run-dir> [<run-dir>...]  print friction signals as JSON (one run: the run object; several: {runs, totals})
EOF
	exit 2
}

# Highest N over <dir>/<prefix>.<N>.json; 0 if none.
max_gen() {
	local dir=$1 prefix=$2 max=0 n f
	for f in "$dir/$prefix."*.json; do
		if [[ ! -e $f ]]; then
			continue
		fi
		n=${f#"$dir/$prefix".}
		n=${n%.json}
		if [[ $n =~ ^[0-9]+$ ]] && (( 10#$n > max )); then
			max=$(( 10#$n ))
		fi
	done
	echo "$max"
}

# The `- ` lines under run.md's `## Log` heading, up to the next heading.
log_lines() {
	local run_md=$1
	if [[ ! -f $run_md ]]; then
		return
	fi
	awk '
		/^## Log[[:space:]]*$/ { inlog = 1; next }
		inlog && /^##? / { inlog = 0 }
		inlog && /^- / { print }
	' "$run_md"
}

amendments() {
	local dir=$1 total=0 n f
	for f in "$dir"/plan.*.amendments.json; do
		if [[ ! -e $f ]]; then
			continue
		fi
		n=${f#"$dir"/plan.}
		n=${n%.amendments.json}
		if [[ $n =~ ^[0-9]+$ ]]; then
			n=$(jq 'if type == "array" then length else error("not an array: " + input_filename) end' "$f") ||
				die "amendments: $f is not a JSON array"
			total=$(( total + n ))
		fi
	done
	echo "$total"
}

# Each packet's latest ChangeReport as {packet, files_changed, deviations}.
# Reports are read in this shell, never inside a pipeline, so a bad one dies.
# files_changed and deviations: missing or null is [], else an array of strings.
changes() {
	local reports=$1 f base p n latest out='' obj
	if [[ ! -d $reports ]]; then
		echo '[]'
		return
	fi
	latest=$(
		for f in "$reports"/*.change.*.json; do
			if [[ ! -e $f ]]; then
				continue
			fi
			base=${f##*/}
			p=${base%%.change.*}
			n=${base#"$p".change.}
			n=${n%.json}
			if [[ $n =~ ^[0-9]+$ ]]; then
				printf '%s\t%s\n' "$p" "$(( 10#$n ))"
			fi
		done | sort -t $'\t' -k1,1 -k2,2n | awk -F '\t' '
			{ latest[$1] = $2 }
			END { for (p in latest) printf "%s\t%s\n", p, latest[p] }
		'
	) || die "changes: cannot list $reports"
	while IFS=$'\t' read -r p n; do
		if [[ -z $p ]]; then
			continue
		fi
		f=$reports/$p.change.$n.json
		obj=$(jq -c --arg p "$p" '
			def strings_or_null: type == "null" or (type == "array" and all(.[]; type == "string"));
			if type == "object" and (.files_changed | strings_or_null) and (.deviations | strings_or_null)
			then {packet: $p, files_changed: (.files_changed // []), deviations: (.deviations // [])}
			else error("not a ChangeReport: " + input_filename) end' "$f") ||
			die "changes: $f is not a JSON object with string-array files_changed and deviations"
		out+=$obj$'\n'
	done <<<"$latest"
	jq -s '.' <<<"$out" || die "changes: cannot combine reports in $reports"
}

# {test, review, security}: {generation, verdict} of the highest-N report, or null.
# The report must be an object whose verdict is a string, missing, or null.
loops() {
	local reports=$1 phase gen out='{}'
	for phase in test review security; do
		gen=0
		if [[ -d $reports ]]; then
			gen=$(max_gen "$reports" "$phase")
		fi
		if (( gen == 0 )); then
			out=$(jq -c --arg k "$phase" '.[$k] = null' <<<"$out") || die "loops: jq failed on $phase"
		else
			out=$(jq -c --arg k "$phase" --argjson g "$gen" --slurpfile r "$reports/$phase.$gen.json" '
				if ($r[0] | type == "object" and (.verdict | type == "string" or type == "null"))
				then .[$k] = {generation: $g, verdict: ($r[0].verdict // null)}
				else error("not a phase report") end' <<<"$out") ||
				die "loops: $reports/$phase.$gen.json is not a JSON object with a string verdict"
		fi
	done
	echo "$out"
}

collect_one() {
	local dir=${1%/} amendments changes loops
	local decisions=/dev/null
	# Computed here, not inside jq arguments: a failure there would not stop the
	# collect. `|| exit` because errexit is off inside command substitution.
	amendments=$(amendments "$dir") || exit
	changes=$(changes "$dir/reports") || exit
	loops=$(loops "$dir/reports") || exit
	if [[ -f $dir/decisions.md ]]; then
		decisions=$dir/decisions.md
	fi
	jq -n -S \
		--arg run "$(basename "$dir")" \
		--argjson plan_generations "$(max_gen "$dir" plan)" \
		--argjson amendments "$amendments" \
		--rawfile log <(log_lines "$dir/run.md") \
		--argjson changes "$changes" \
		--argjson loops "$loops" \
		--rawfile decisions "$decisions" '
		def packet_key: [(match("^\\D*").string), [scan("\\d+") | tonumber], .];
		# An advisory event: the event word of the Log line, after `- <date> `, is advisory.
		def advisory_event: test("^- \\S+\\s+advisory\\b"; "i");
		($log | split("\n") | map(select(. != ""))) as $lines
		| ($lines | map(select(test("schema"; "i") and test("\\b(fail|invalid)"; "i")))) as $schema
		| ($lines | map(select(advisory_event) | {
			verdict: ((first(match("\\b(adopted|rejected)\\b"; "gi").string | ascii_downcase)) // "unclassified"),
			text: .
		})) as $adv
		| ($lines | map(select(test("advisory"; "i") and (advisory_event | not)))) as $mentioned
		| ($decisions | split("\n")) as $dl
		| ($dl | map(capture("Decided by:\\*\\*\\s*(?<by>.*)")? | .by)) as $by
		| ($changes | sort_by(.packet | packet_key)) as $ch
		| {
			run: $run,
			plan_generations: $plan_generations,
			amendments: $amendments,
			schema_failures: {count: ($schema | length), lines: $schema},
			advisories: {
				adopted: ($adv | map(select(.verdict == "adopted")) | length),
				rejected: ($adv | map(select(.verdict == "rejected")) | length),
				unclassified: ($adv | map(select(.verdict == "unclassified")) | length),
				lines: $adv,
				mentioned: $mentioned
			},
			applied_requests: [$ch[] | .packet as $p | .files_changed[]
				| select(contains("(applied request)"))
				| {packet: $p, file: sub(" \\(applied request\\)"; "")}],
			deviations: [$ch[] | .packet as $p | .deviations[] | {packet: $p, text: .}],
			loops: $loops,
			decisions: {
				user: ($by | map(select(startswith("user"))) | length),
				auto: ($by | map(select(startswith("auto-adopted"))) | length),
				total: ($dl | map(select(startswith("## D"))) | length)
			}
		}'
}

cmd_collect() {
	(( $# > 0 )) || usage
	local d out='' one
	for d in "$@"; do
		[[ -d $d ]] || die "not a directory: $d"
	done
	if (( $# == 1 )); then
		collect_one "$1"
		return
	fi
	# Each run collected in this shell, not a pipeline, so a failing run dies.
	for d in "$@"; do
		one=$(collect_one "$d") || exit
		out+=$one$'\n'
	done
	jq -s -S '{
		runs: .,
		totals: {
			plan_generations: (map(.plan_generations) | add),
			amendments: (map(.amendments) | add),
			schema_failures: (map(.schema_failures.count) | add),
			advisories: {
				adopted: (map(.advisories.adopted) | add),
				rejected: (map(.advisories.rejected) | add),
				unclassified: (map(.advisories.unclassified) | add),
				mentioned: (map(.advisories.mentioned | length) | add)
			},
			applied_requests: (map(.applied_requests | length) | add),
			deviations: (map(.deviations | length) | add),
			loops: {
				test: (map(.loops.test.generation // 0) | add),
				review: (map(.loops.review.generation // 0) | add),
				security: (map(.loops.security.generation // 0) | add)
			},
			decisions: {
				user: (map(.decisions.user) | add),
				auto: (map(.decisions.auto) | add),
				total: (map(.decisions.total) | add)
			}
		}
	}' <<<"$out"
}

case ${1:-} in
collect) shift; cmd_collect "$@" ;;
*) usage ;;
esac
