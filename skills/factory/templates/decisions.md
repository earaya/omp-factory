# Decision ledger: <slug>

One entry per decision. Never delete entries; supersede them. Every agent receives this file and must not reopen a decided entry.

## D1: <question>

- **Kind:** architecture | public_api | dependency | data | security | style | implementation
- **Raised by:** planner | designer:P2 | implementer:P3 | reviewer:correctness | reviewer:security | coordinator
- **Blocking:** yes | no
- **Options:**
  - `<id>`: <tradeoff>
  - `<id>`: <tradeoff>
- **Recommendation:** `<id>`
- **Evidence:** `path:line`
- **Decision:** `<id>` | open (decided at <gate or run>; keep a Recommendation) | `<id>`, superseded by D<n>
- **Decided by:** user | auto-adopted (implementation kind only) | — while open
- **Notes:** <user's comments, or why it was superseded>
