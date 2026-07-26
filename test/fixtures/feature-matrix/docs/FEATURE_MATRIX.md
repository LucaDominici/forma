# Feature Matrix

| Capability | Scope | What it does |
| --- | --- | --- |
| Billing core workflows reconcile recurring invoices and reminders. | `src/billing` | Billing core workflows for invoicing, reconciliation, and billing reminders in a recurring-charge product. |
| Usage reports are exported for operators and support teams. | `src/report/exporter.js` | Generates usage reports for operators and support teams, with CSV and JSON outputs. |
| Usage snapshot builders create daily trend views. | `src/report/snapshot.js` | Builds daily snapshots of billed usage and active feature usage. |
| Legacy migration path describes a deprecated package. | `src/report/missing.js` | Documents a capability from a deprecated path kept only for parser coverage. |
