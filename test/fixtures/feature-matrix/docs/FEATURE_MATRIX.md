# Feature Matrix

Shaped like a real one: an id column, a capability sentence, a status word, the code that
implements it, and a longer note. The resolver must take the capability — not the id, not the
status word, and not the note just because it is longer.

| feature_id | capability | status | code_ref | note |
| --- | --- | --- | --- | --- |
| FX-001 | Billing core workflows reconcile recurring invoices and reminders. | DONE | `src/billing` | Shipped in the first release; the superseded reconciliation ledger is kept for audit history only. |
| FX-002 | Usage reports are exported for operators and support teams. | DONE | `src/report/exporter.js` | CSV and JSON outputs, both streamed straight to the caller without a temporary file. |
| FX-003 | Usage snapshot builders create daily trend views. | BACKLOG | `src/report/snapshot.js` | Daily rollups of billed usage and active feature usage, retained for ninety days. |
| FX-004 | Legacy migration path describes a deprecated package. | DONE | `src/report/missing.js` | The path does not exist on disk: the parser must still read the row, only `init` checks disk. |
