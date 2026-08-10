---
title: 'ADR-0004: Control Room as a Forma rendering, not a second product'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: '0004'
tags: ['audience/dev', 'kind/adr']
related: ['docs/adr/README.md']
---
# ADR-0004: Control Room as a Forma rendering, not a second product

- **Status:** Accepted (2026-08-09)

## Context
A Control Room (multi-tab programme dashboard: architecture, WBS, Kanban, Executive, findings)
was requested. `docs/SCOPE.md` closed Forma at v0.10.0, stage *maintained*, and named "no new
command" outside the boundary — so this needs its own decision, not a silent reopening.

## Decision
The Control Room is **one more deterministic rendering of the existing SSOT**, not a competing
source of truth. Concretely:
- A new command, `forma room` (not `gen --room`) — `gen` stays the only model writer; `room` is
  read-only over model + overlays + a gh snapshot, and writes one self-contained HTML file.
- New facts get new overlays with their own lifecycle (`c4-issues.json` from `verify`,
  `c4-health.json`/`c4-findings.json` from an evidence-gated audit channel), never new required
  fields on the closed node/edge schema.
- The issue↔code link is derived once (`#N` in a commit subject → files touched → node, via the
  same `evidence`/`leafSources` contract `check` already walks) and shared between the composer
  and the gate, so they cannot disagree.
- `forma check` gains assertions that are **opt-in by presence** — a repo with no room overlays
  sees no new failure mode. `scripts/room-presentable.mjs` grades the rendered artifact, mirroring
  the `check`/`presentable.mjs` split that already exists.
- `docs/SCOPE.md` is superseded by `docs/SCOPE-room.md` per its own §7 ("nothing else without a
  new scope document replacing this one").

## Consequences
- + One SSOT, N renderings — the invariant from ADR-0002 extends instead of breaking.
- + No new validation engine: schemas are validated by the existing `validateModel(obj, schemaPath)`.
- + A repo that never runs `forma room` is byte-for-byte unaffected.
- − The shipped-file count (`AGENTS.md`, `scripts/check-clean.mjs`) grows past today's number —
  the invariant's *value* needs bumping when this lands, not just re-asserted.
- − `check` cannot verify the freshness of a gh snapshot offline; it can only refuse a stale or
  malformed one. Declared in `docs/SCOPE-room.md` §8, not hidden.
