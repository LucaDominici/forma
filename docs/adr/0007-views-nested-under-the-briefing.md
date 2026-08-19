---
title: 'ADR-0007: Views nested under the briefing, not instead of it'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: '0007'
tags: ['audience/dev', 'kind/adr']
related: ['docs/adr/README.md']
---
# ADR-0007: Views nested under the briefing, not instead of it

- **Status:** Accepted (2026-08-10)
- **Refines:** [ADR-0005](0005-portfolio-briefing-over-per-repo-dashboard.md)

## Context
ADR-0005 replaced eight tabs with one briefing in reading order, and it was right about why: tabs
filed one dataset by category and hid the property that distinguishes this artifact from any other
dashboard — that every claim drills to its evidence.

What it could not fix is that a briefing answers one question. "Across everything running, what
needs me" is the right question at the end of a day and the wrong one when the work is a single
programme: showing a stakeholder where a project stands, deciding what to build next, reading the
document that explains why a decision was made. Those are different readings of the same data, and
a single scroll makes each of them a search.

The pull toward re-splitting the artifact per repository was the obvious answer and the wrong one:
it is the shape ADR-0005 measured and rejected, and it puts the cross-programme question back behind
three files.

## Decision
One artifact, two levels. The briefing stays the front door and keeps its reading order. Under it,
each programme has five views addressed by hash route:

```
#/                    the verdict, what waits on you, what moves, what does not add up
#/<prog>/exec         where it stands: coverage of the plan, where we were, the charts
#/<prog>/tech         what needs a human: blocked work, verdicts, findings, and what is not known
#/<prog>/map          the architecture, and checkpoints carrying measured completion
#/<prog>/wbs          the matrix from requirement to work, its holes, then the queue
#/<prog>/docs         the canon in full, everything else listed
#/options             what is in this briefing, and why
```

- **One programme has no portfolio to roll up** (amendment, 2026-08-19). Measured on forma's own
  briefing: with a single programme `#/` read *"0 things need you out of 4 open across one programme"*
  while the brief sat one click away. At `programs.length === 1` the aggregate view is not mounted,
  `#/` and the pre-tab anchors resolve to that programme's `exec`, and the Portfolio link is absent.
  Two or more programmes keep the briefing as front door; nothing above changes for them.
- **Still one file, one composer, one gate.** `--out` remains a single self-contained artifact.
- **Views are mounted on demand.** Printing forces the five official projections to mount, while
  interactive issue archives stay summarized. The whole briefing prints without making page or
  DOM size proportional to lifetime issue count.
- **The pre-tab anchors keep resolving.** `#verdict`, `#now`, `#moving`, `#mismatch` were valid
  addresses for this artifact and still land on their section.
- **Locale tables moved out of the template** into `lib/viewer/strings/{en,it}.json`. At six
  sections they were already the largest thing in the file; at five views nobody could edit around
  them. `npm test` now checks en/it parity *and* that every declared key is actually read — the
  parity half is what I15 always claimed and only the single-lens viewer ever had.

## Consequences
- + Each reading has a place, and a link can point at it: `#/haben/wbs` is an address.
- + Four derivations that were computed and gated but rendered nowhere (`kpis`, `kanban`, `queue`,
  `link`) now have a surface, so the gate is grading something a reader can see.
- + The Options view makes the manifest legible without opening it.
- + Only the selected view is built at load; Queue and Kanban are lazy, paged evidence inside Tech.
- − Five views is more surface to keep honest than one scroll. The `strings` test exists because
  the first thing to rot in a multi-view page is a locale nobody reads.
