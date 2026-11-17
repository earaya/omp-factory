# Run: <slug>

- **Status:** setup | gate1 | planning | design | gate2 | implementing:wave-N | testing | reviewing | milestone-gate:M | gate3 | done | stopped
- **Repo:** <root>
- **Base:** <sha> on <branch>
- **Run branch:** factory/<slug>
- **Isolation:** on (patch, apply) | off
- **Baseline:** <green | N failing> (reports/baseline.json)
- **Freeze:** <sha> (reports/freeze.txt)
- **Current generations:** plan.<N> · <P>.change.<N> · test.<N> · review.<N> · security.<N>
- **Milestone:** <M> of <N>, base <sha> | n/a

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
| reports/<P>.integration.<N>.json | factory-integrator | IntegrationReport |
| reports/test.<N>.json | factory-tester | TestReport |
| reports/review.<N>.json | factory-reviewer | ReviewReport |
| reports/security.<N>.json | factory-security-reviewer | ReviewReport |
| reports/freeze.txt | coordinator | frozen per-path status+hash list +renamed-from |
| milestones/<M>.md, milestones/<M>/ | coordinator | Milestone summary and run-dir |
| summary.md | coordinator | Final summary |

## Log

- <timestamp> <phase>: <one line>
