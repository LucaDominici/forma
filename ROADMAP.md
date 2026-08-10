---
title: 'Roadmap'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'roadmap'
tags: ['audience/dev', 'kind/governance']
related: ['docs/SCOPE.md', 'docs/SCOPE-room.md', 'docs/technical-debt.md']
---
# Roadmap

Forward-looking, and deliberately short. Everything here is either already blocking something or
has a named trigger; anything else is an idea, and ideas do not belong on a roadmap.

What "finished" means for a round of work is not decided here — that is
[`SCOPE.md`](docs/SCOPE.md) and [`SCOPE-room.md`](docs/SCOPE-room.md). This document says what is
likely to come next and, more usefully, what has to be true first.

## Blocked on a decision, not on work

These are the items where writing code would be premature because the question is not answered.

- **Publishing a Control Room.** A generated briefing carries issue titles, labels and milestones
  for every programme in its manifest, and with a `docs` block it carries prose too. That is
  materially more disclosure than the package names already approved for the public demo. Until
  that is decided, the artifact is generated locally and not deployed anywhere
  ([`SCOPE-room.md`](docs/SCOPE-room.md) §6, [`PRIVACY.md`](PRIVACY.md)).
- **The shipped-file count.** `AGENTS.md` states the size of the `npm pack` selection and nothing
  enforces it. Either the list becomes mechanical or the number leaves the prose; both are cheap,
  and picking one is the actual work (debt D-1).

## Next, with a trigger

Ordered by how likely the trigger is to fire, not by appetite.

| What | Trigger | Why not yet |
|---|---|---|
| A second curated architecture model | Any repository other than the demo target adopting a `c4-topology.json` | Manifest parametricity across independently curated architectures is implemented and validated but **unproved** — one repository has exercised the full mapped pipeline ([`DELIVERY.md`](docs/DELIVERY.md)) |
| `forma rtm --plan` | The RTM `issues` column stops being maintained in practice | The gate already fails on an untraced requirement; a generator is only worth it once the manual path is demonstrably tiring (debt D-4, [ADR-0006](docs/adr/0006-traceability-as-a-derivation-not-an-overlay.md)) |
| Lazy-mounting the architecture view | A real portfolio makes the briefing measurably slow | Every view is in the DOM so printing can un-hide all of it; trading that away before there is a measurement would cost the whole-briefing print guarantee for nothing (debt D-3, [ADR-0007](docs/adr/0007-views-nested-under-the-briefing.md)) |
| Pinning the arbiter checkout in CI | The documentation gate goes red for a reason that is not about Forma | A moving dependency on another repository's default branch is a known, accepted coupling until the standard settles (debt D-7) |
| A public demo target that CI can regenerate | The committed demo snapshot misrepresents its source badly enough to mislead | The current target is private, so Pages publishes a local snapshot and nothing notices staleness. Fixing it means changing the target, not the code (debt D-6) |

## Toward 1.0

`schemaVersion` freezing is the substance of a 1.0, not the version number. Three things have to be
true, and none of them is a feature:

1. **A second repository has driven the whole pipeline**, including a curated model, so the file
   contract has been exercised by something that is not this repository's own shape.
2. **Every mandatory document gate runs in CI and has been seen to fail**, not merely to pass —
   the same standard applied to code in [`GLOBAL_INVARIANTS.md`](docs/GLOBAL_INVARIANTS.md).
3. **The disclosure decision above is made**, because a Control Room that cannot be shared is a
   briefing with one reader.

Until those hold, the version stays pre-1.0 and the schema stays changeable — which is the honest
signal to anyone deciding whether to build on it.

## Not planned

Not a "maybe later" list — these are refusals, recorded so the question is only asked once.

- Runtime dependencies ([ADR-0001](docs/adr/0001-zero-dependency-esm.md)).
- Network access outside `forma verify` and the opt-in `gen --enrich`.
- Inferring architecture, requirements or traceability from prose. Forma measures declarations; a
  model guessing which requirement an issue belongs to is the invented number this product exists
  to refuse ([`PRD.md`](docs/PRD.md) §4).
- Becoming a project-management tool. Forma reads an issue tracker; it does not write to one.
- Becoming a diagram editor. The layout serves reading, not drawing.
