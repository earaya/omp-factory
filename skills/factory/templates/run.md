# Run: <slug>

- **Status:** setup | gate1 | planning | design | gate2 | implementing:wave-N | testing | reviewing | gate3 | done | stopped
- **Repo:** <root>
- **Base:** <sha> on <branch>
- **Run branch:** factory/<slug>
- **Isolation:** on | off

## Files

| File | Producer | Contract |
|---|---|---|
| brief.md | coordinator | Brief |
| plan.json / plan.md | factory-planner | WorkPlan |
| designs/<P>.json | factory-designer | DesignNote |
| decisions.md | coordinator | Decision ledger |
| reports/<P>.change.json | factory-implementer | ChangeReport |
| reports/test.json | factory-tester | TestReport |
| reports/review.json | factory-reviewer | ReviewReport |
| summary.md | coordinator | Final summary |

## Log

- <timestamp> <phase>: <one line>
