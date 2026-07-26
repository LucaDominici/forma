# Refactor plan

| Feature | File | Change |
|---|---|---|
| C1 move the helper | `src/core/db.js` | extract openPool |
| C2 rename the flag | `src/plumbing/queue.js` | drain -> flush |
| C3 drop the shim | `src/reporting/export.js` | delete legacy branch |
