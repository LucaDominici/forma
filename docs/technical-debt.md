---
title: 'Technical debt register'
doc_version: '1.0.1'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'technical-debt'
tags: ['audience/dev', 'kind/audit']
related: ['docs/DELIVERY.md', 'docs/FEASIBILITY.md']
---
# Technical debt register

Known shortcuts, what each one costs, and what would pay it back. A shortcut is listed here only
when it is *deliberate* and has a stated ceiling; an unknown defect belongs in
[`DELIVERY.md`](DELIVERY.md)'s defects table instead, and a thing simply not built belongs in
[`SCOPE.md`](SCOPE.md).

Two conventions carried from the code: a deliberate simplification in `lib/` is marked with a
`ponytail:` comment naming its ceiling and upgrade path, and nothing here is owed a fix until its
trigger fires. A debt with no trigger is a design decision, not debt.

| # | Debt | Cost today | Trigger to pay it | Payback |
|---|---|---|---|---|
| D-2 | **`docmap.mjs` matches a dead code ref by prefix.** `alive()` accepts a truncated ref so glob stems like `internal/imports/statement*.go` keep resolving. | A genuinely renamed path can read as alive if it shares a prefix with a surviving sibling, so a row keeps counting when it should have failed. | A false-alive measured on a real repository. | Keep the raw cell and relax the prefix rule only for refs that actually carried a `*`. The `ponytail:` comment at `lib/docmap.mjs` records this. |
| D-4 | **The RTM `issues` column is maintained by hand.** A design row names the issues that implement it. | It cannot rot silently — `forma check` fails on a dangling or missing reference — but it can tire, and tiring is how a discipline gets abandoned. | The column stops being updated in practice, i.e. the gate starts being worked around rather than satisfied. | `forma rtm --plan`, emitting rows for untraced open work in the same plan-then-apply shape `enrich` and `audit` already use. Named as a consequence in [ADR-0006](adr/0006-traceability-as-a-derivation-not-an-overlay.md). |
| D-5 | **`coverageOf` reports 0% for an empty population.** `linked/total` with `total === 0` yields `0`, not `null`. | A repository with no issues at all reads "0% linked", which claims a measurement over an empty set — the exact shape I6 forbids elsewhere. | Any programme legitimately reaching the briefing with zero issues. | One line in `lib/link.mjs`, plus updating whatever compares the value. Left alone so far because it is pre-existing and no measured programme hits it. |
| D-6 | **The demo model cannot regenerate itself.** `docs/demo/c4-model.json` is a snapshot committed from a local run against a private repository. | Nothing automated notices if it goes stale; the README says so out loud. | The demo misrepresents `haben` badly enough to mislead. | Either make the source repository reachable from CI, or replace the demo target with a public one. Both are real work, not a code change. |

## What is *not* debt

Resolved on 2026-08-17: the 38-file npm allowlist is enforced by `prepack`; Control Room views are
lazy and bounded; and the layout/accessibility/print floor runs in required browser CI with retained
evidence. These were D-1, D-3 and D-8 respectively.

- **Zero runtime dependencies.** A constraint, not a shortcut ([ADR-0001](adr/0001-zero-dependency-esm.md)).
- **The hand-rolled JSON Schema walker.** It supports the subset the schemas use and refuses to
  pretend otherwise; the alternative is a dependency, which is forbidden.
- **Partial issue-to-code coverage.** Partial by construction — git only knows what a commit cited.
  It is reported as a measurement with its denominator, never rounded up to a claim.
