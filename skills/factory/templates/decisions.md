# Decision ledger: <slug>

One entry per decision. Never delete entries; supersede them. Every agent receives this file and must not reopen a decided entry.

## D1: <question, technical>

- **Plain question:** <the same question about behavior, in plain words, as asked at the gate>
- **Kind:** architecture | public_api | dependency | data | security | style | implementation
- **Raised by:** planner | designer:P2 | implementer:P3 | reviewer | coordinator
- **Blocking:** yes | no
- **Options:**
  - `<id>`: <summary>. Pros: <consequence>. Cons: <consequence>.
  - `<id>`: <summary>. Pros: <consequence>. Cons: <consequence>.
- **Revisits:** D<n> or Brief line, and the evidence that reopened it (omit when not reopening)
- **Recommendation:** `<id>`
- **Evidence:** `path:line`
- **Decision:** `<id>` | open (decided at <gate or run>; keep a Recommendation) | `<id>`, superseded by D<n>
- **Decided by:** user | auto-adopted (implementation kind, or a Small decision with what settled it in Notes) | — while open
- **Notes:** <user's comments, or why it was superseded>
