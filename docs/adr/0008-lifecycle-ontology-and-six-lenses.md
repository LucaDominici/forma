---
title: "ADR-0008: The lifecycle ontology arbiter owns, rendered as six justified lenses"
doc_version: "1.0.0"
status: active
last_review: "2026-09-02"
owner: "Luca Dominici"
canonical_id: "0008"
tags: ["audience/dev", "kind/adr"]
related:
  [
    "docs/adr/0007-views-nested-under-the-briefing.md",
    "docs/adr/0002-single-source-of-truth-model.md",
    "docs/GLOBAL_INVARIANTS.md",
  ]
---

# ADR-0008: The lifecycle ontology arbiter owns, rendered as six justified lenses

- **Status:** Accepted (2026-09-02)
- **Refines:** [ADR-0007](0007-views-nested-under-the-briefing.md)
- **Depends on:** [ADR-0002](0002-single-source-of-truth-model.md)

## Context

Forma measures what exists — code, issues, documents — and what is claimed — the brief, the
overlays. It has nothing that models **what is intended and in what order**. There is no milestone
definition, so `deriveMilestones` can only group the issues a snapshot happens to carry and compute
a closure rate. There is no dependency traversal, so `deriveDependencies` builds the blocking edges
and no one walks them: no critical path, no slack, no schedule. Traceability is graded on one axis,
coverage, while the second axis — whether a requirement was actually _verified_, and on what
evidence — exists in the golden fixture's vocabulary (`PROVEN`, `FAILING`, `STALE`, `UNRESOLVED`,
`UNCOVERED`) and nowhere in the engine. Use cases, runbooks, tabletop definitions, feasibility and
external sources have no shape at all.

The raw material is already here. That is what makes the gap worth closing rather than tolerating.

Three shapes of this product now coexist in the tree: eight flat tabs (ADR-0004), one briefing
(ADR-0005), one briefing with five nested views (ADR-0007). `scripts/room-presentable.mjs`
hard-codes the five-view IA as a publication predicate while `ROADMAP.md` names an eight-lens bar
as the target. The gate and the roadmap disagree about what Forma is supposed to become, and that
disagreement is why every attempt to add a surface turns into a debate about the shape.

## Decision

**1. arbiter owns the ontology; Forma derives and renders it.** Every lifecycle artifact type —
milestone, source, use case, tabletop scenario, runbook, feasibility study, epic — gets its schema,
its identifier scheme, its gate and its edit-time hook in arbiter. Forma never defines one and never
writes an instance: it reads, derives, and refuses to publish what does not re-derive. I18 stands
unchanged — the only file a briefing writes is the manifest.

**2. The C4 model shape stays Forma's, and arbiter adopts it.** Forma defined the stack-agnostic C4
graph first and generates it. Rather than let arbiter invent a second C4 standard, arbiter vendors a
hash-pinned copy of `lib/schema/c4-model.schema.json`, and the pin is gated in both repositories
(I19). Ownership follows competence, in both directions.

**3. Seven surfaces, each answering one question, each the only home for its data.** The portfolio
plus six per-programme lenses:

| Lens         | The one question it answers                                |
| ------------ | ---------------------------------------------------------- |
| portfolio    | Which programme needs me now?                              |
| verdict      | Can I trust this programme's claims today?                 |
| plan         | What happens when, and what blocks the date?               |
| architecture | What is the system, and how complete is our picture of it? |
| traceability | Is what we promised built and proven?                      |
| operations   | Can we run it, and survive failure?                        |
| provenance   | Why is it this way, on whose authority?                    |

This supersedes the five-view predicate in `scripts/room-presentable.mjs`, which becomes per-lens:
a lens publishes when its backing artifacts exist and is honestly absent when they do not — never a
reserved empty panel, per I7.

**4. One home per surface.** Today milestones render twice, blocked work three times, snapshot age
three times, and the exec/tech boundary asks the same question twice in different clothes. The
partition above is only real if it is enforced, so the one-home rule becomes an invariant with a
tamper test when the lenses land, not a convention in this document.

## Rejected alternatives

**Re-splitting per repository.** The shape ADR-0005 measured and rejected; it puts the
cross-programme question back behind three files.

**Keeping five views and growing them.** The duplication is not cosmetic — it is what happens when
two surfaces have no distinct question. Adding data to `exec` and `tech` deepens the overlap.

**Reaching the eight-lens bar literally.** Two of the eight (Kanban, Coda) are filters over one
dataset, not questions; they belong inside `plan` as controls, not as lenses.

**Letting Forma define the milestone schema, since Forma renders it.** It would make Forma a
project-management tool, which `ROADMAP.md` explicitly refuses, and would split ownership of the
lifecycle vocabulary across two repositories with no arbiter of disputes.

## Consequences

Good: every surface has a defensible reason to exist; the plan layer becomes derivable; the golden
fixture stops being dead weight and becomes the acceptance target for the derived shapes; the two
repositories become mechanically coupled instead of conventionally aligned.

Bad: the IA changes for the third time, and `room-presentable.mjs` — a publication gate — must be
rewritten rather than extended. Six lenses is more surface to keep honest than five; the one-home
invariant is what keeps that cost bounded.

Cost accepted deliberately: three lenses (`plan`, `operations`, most of `provenance`) render nothing
until arbiter ships the artifacts behind them. They are absent, not empty — which is the honest
state and, per I7, a visible one.
