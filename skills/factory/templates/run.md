# Run: <slug>

- **Status:** setup | gate1 | planning | design | gate2 | implementing:wave-N | testing | reviewing | gate3 | done | stopped
- **Repo:** <root>
- **Base:** <sha> on <branch>
- **Run branch:** factory/<slug>
- **Isolation:** on | off
- **Freeze:** <sha> (reports/freeze.txt)
- **Current generations:** plan.<N> · <P>.change.<N> · test.<N> · review.<N>

## Files

| File | Producer | Contract |
|---|---|---|
| brief.md | coordinator | Brief |
| plan.<N>.json / plan.<N>.md | factory-planner | WorkPlan |
| designs/<P>.<N>.json | factory-designer | DesignNote |
| decisions.md | coordinator | Decision ledger |
| reports/<P>.change.<N>.json | factory-implementer | ChangeReport |
| reports/test.<N>.json | factory-tester | TestReport |
| reports/review.<N>.json | factory-reviewer | ReviewReport |
| reports/freeze.txt | coordinator | frozen per-path status+hash list +renamed-from |
| summary.md | coordinator | Final summary |

## Log

- <timestamp> <phase>: <one line>
