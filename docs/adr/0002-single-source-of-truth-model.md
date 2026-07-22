# ADR-0002: Single source of truth — `c4-model.json`

- **Status:** Accepted (2026-07-22)

## Context
An architecture picture rots the day code changes, and two renderings (a viewer and a doc) must
not diverge from each other or from the code.

## Decision
`docs/architecture/c4-model.json` is the single source of truth, validated by
`lib/schema/c4-model.schema.json`. `forma gen` emits it from the code plus a curated topology;
the viewer and `forma doc` are pure projections of it; `forma check` fails if it drifts from code.

## Consequences
- + One artifact to trust; renderings are cheap and cannot lie independently.
- + Drift is falsifiable (`forma check` exits non-zero).
- − The topology is human-curated (names, descriptions, externals) — the one required human step.