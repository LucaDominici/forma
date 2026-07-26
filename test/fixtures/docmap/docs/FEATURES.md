---
title: 'Feature inventory'
---

# What the product does

| id | capability | status | code_ref |
|---|---|---|---|
| F1 | Bill a customer and collect what they owe | DONE | `src/billing/invoice.js`, `src/core/db.js` |
| F2 | Chase an invoice nobody paid | BACKLOG | `src/billing/dunning.js`, `src/core/db.js` |
| F3 | Hand the accountant the month as a spreadsheet | DONE | `src/reporting/export.js`, `src/core/db.js` |
| F4 | Keep an audit trail of every change | DONE | `src/core/db.js` |
