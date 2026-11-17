# Run: <slug>

- **Status:** setup | gate1 | planning | design | gate2 | implementing:wave-N | testing | reviewing | gate3 | done | stopped
- **Repo:** <root>
- **Base:** <sha> on <branch>
- **Run branch:** factory/<slug>
- **Baseline:** <green | N failing> (reports/baseline.json)
- **Freeze:** <sha> (reports/freeze.txt)
- **Current generations:** plan.<N> · <P>.change.<N> · test.<N> · review.<N> · security.<N>

## Files

| File | Producer | Contract |
|---|---|---|
| brief.md | coordinator | Brief |
| reports/baseline.json | coordinator | Baseline check results on base |
| reports/preflight.json | coordinator | Agent → resolved model, smoke result and raw error per model |
| plan.<N>.json / plan.<N>.md | factory-planner | WorkPlan |
| designs/<P>.<N>.json | factory-designer | DesignNote |
| decisions.md | coordinator | Decision ledger |
| reports/<P>.change.<N>.json | factory-implementer | ChangeReport |
| reports/test.<N>.json | factory-tester | TestReport |
| reports/review.<N>.json | factory-reviewer | ReviewReport |
| reports/security.<N>.json | factory-security-reviewer | ReviewReport |
| reports/status-wave-<N>.before | coordinator (`factory-state snapshot`) | Pre-wave record |
| reports/freeze.txt | coordinator (`factory-state freeze`) | Frozen per-path status + hash record |
| summary.md | coordinator | Final summary |

## Log

- <date> <event>: <one event per line; advisories use the event word `advisory`>
