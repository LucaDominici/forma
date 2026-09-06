---
title: 'ADR-0008 — the briefing tells a story: ship and plan return as pages'
doc_version: '1.0.0'
status: active
last_review: '2026-08-19'
owner: 'Luca Dominici'
canonical_id: 'adr-0008'
tags: ['audience/dev', 'kind/decision']
related: ['0007-views-nested-under-the-briefing.md', 'SCOPE-room.md']
---
# ADR-0008 — the briefing tells a story: ship and plan return as pages

## Status
Accepted, 2026-08-19. Amends ADR-0007's view set; does not reopen ADR-0005.

## Context
ADR-0007 collapsed the queue and the milestones into `tech` as lazy archives. Measured against the
owner's reading of the real viafera room next to the hand-built reference (wayfinder #100), that
collapse failed the reader: the two questions asked most often — *what do I ship now* and *where is
this going* — had no page, and the reference answered both above the fold. The provenance-first
organisation optimised "can I trust this line" at the cost of "what is this about".

## Decision
Six views per programme, ordered as a narrative a reader can stop at any point:
`exec` (where we stand) → `ship` (what to ship now) → `map` (what the thing is) → `plan` (where it
is going) → `tech` (what is under the hood) → `docs` (the paper it stands on).

- `ship` renders every derived work block **words first**: the block's brief `note` claims — agent
  written, gated, counter-verified — lead the block so the reader decides from a sentence, not from
  issue titles; a block nobody has written words for says so. Blocks group under their milestone;
  the command stays one click from copy; the searchable archive stays at the bottom.
- `plan` opens on the milestones and keeps the traceability matrix and its four holes as the proof
  layer underneath.
- The map's node detail gains the dimensions the reference's hologram carried by hand: `meta.where`
  (where the node runs — space), `meta.notes` (notable details, algorithms), `meta.refs`
  (references — papers, ADRs, external docs). All curated, all optional, all inside the existing
  free-form `meta` object; time is already the checkpoint timeline.
- Legacy `/auto`, `/kanban`, `/wbs` hashes redirect to `ship`, `tech`, `plan`.

## Consequences
`room-presentable` gates the six-view story; the five-view predicate is superseded. The exec page
keeps the judgement layer as its lead. Nothing new is persisted: every page reads the same derived
data and overlays as before.
