---
title: 'Global invariants'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'global-invariants'
tags: ['audience/dev', 'kind/invariant']
related: ['AGENTS.md', 'CONTRIBUTING.md']
---
# Global invariants

The rules Forma does not break. Each one names where it is enforced and what turns red when it is
violated. An invariant with no enforcement is a preference, and preferences do not belong here.

Read this before changing anything in `lib/`.

---

## I1. Zero runtime dependencies

`package.json` has no `dependencies` and never will. Everything is Node stdlib: the JSON Schema
walker, the layout, the renderers, the charts.

- **Enforced by:** `scripts/lint.mjs` runs `node --check` over the tree; `npm pack --dry-run`
  ships `bin/`, `lib/`, and three text files. ADR-0001.
- **Red when:** a dependency appears; the package grows a `node_modules` requirement.
- **Why:** an architecture tool that rots because its charting library moved on has proven the
  point it exists to disprove.

## I2. Only `verify` touches the network

`gen`, `check`, `doc`, `serve` and `room` never open a socket. `gen --enrich` is the one opt-in
exception and requires an explicit flag plus a key.

- **Enforced by:** `lib/verify.mjs` is the only module importing a network path; `lib/room.mjs`
  reads a snapshot that must already exist.
- **Red when:** a fetch appears in an offline command; `check` behaves differently with the
  network down.
- **Why:** a gate that can fail because of DNS is not a gate.

## I3. `gen` is the only writer of the model

`verify` writes exactly one model field (`meta.verifiedAt`) plus node state. `room` and `check`
never write the model at all.

- **Enforced by:** `lib/verify.mjs` (the comment at the `meta.verifiedAt` assignment states it);
  `lib/room.mjs` opens the model read-only.
- **Red when:** two commands can produce a different model from the same inputs.
- **Why:** two writers means the file is nobody's.

## I4. Nothing that survives a regeneration may live only in the model

`gen` rebuilds the model from the topology and overlays. Anything else it holds is transient.

- **Enforced by:** the fact base lives in its own file under `docs/architecture/`, written only by `forma verify`, which
  `gen` never touches.
- **Red when:** a fact disappears after a routine `forma gen`.
- **Why:** discovered the hard way: `verify` used to decorate the model, and every decoration died
  at the next generation.

## I5. Code proves existence, never completion

`gen` sets `status2` to `unknown` for anything it merely found. A percentage may only come from a
document or an overlay that a human or an agent wrote, and it carries its citation.

- **Enforced by:** `lib/gen.mjs` at the `status2` default; `scripts/presentable.mjs` predicate 5
  refuses a percentage whose citation does not positively claim a measurement.
- **Red when:** a box turns green because a file exists.

## I6. Unknown renders as a blank, never as a zero

A node nobody ruled on, a program without a curated map, an issue git never saw: all of these
report `null`, and the interface says so in words.

- **Enforced by:** `lib/roomderive.mjs` returns `null` (not `0`) for every aggregate that needs a
  model the program does not have; the viewer's neutral status class.
- **Red when:** a zero appears where nothing was measured. Zero claims "measured and none", which
  is a different and stronger statement.

## I7. Absent is not the same claim as empty

A rule nobody declared and a rule declared as empty are different facts and must stay distinct.

- **Enforced by:** `lib/roomderive.mjs` counts programs with no declared `blockedBy` into
  `totals.unknownRule` rather than into the unblocked count.
- **Red when:** "nobody checked" is rendered as "checked, none".
- **Why:** measured on three repositories: haben declares `needs-human`, arbiter declares
  `needs-human` and `owner-decision`, viafera has no such label at all.

## I8. No colour without a resolvable reason

Every health verdict carries a non-empty `why` and at least one evidence reference. A `path` must
exist on disk; a `commit` must resolve in git.

- **Enforced by:** `applyVerdicts` in `lib/audit.mjs` throws rather than skipping; `lib/check.mjs`
  re-checks every reference; `scripts/room-presentable.mjs` fails on an unresolvable one.
- **Red when:** a verdict is written whose evidence points at nothing.

## I9. Nothing is dropped silently

Every cap, exclusion and truncation is counted and named where a reader can see it.

- **Enforced by:** `lib/link.mjs` records `excludedSweeps` with sha and file count;
  `lib/verify.mjs` sets a required `truncated` flag and warns; `lib/room.mjs` refuses to build on
  a truncated snapshot.
- **Red when:** a number quietly describes a subset.
- **Why:** measured, a fetch returned 1200 of 2246 issues and said nothing. Every proportion built
  on it would have been false.

## I10. The gate re-derives, it never trusts

`check` recomputes from raw inputs and compares. It never parses the generated HTML, and never
takes a committed number at face value.

- **Enforced by:** `lib/check.mjs` imports the same `lib/roomderive.mjs` the composer uses and
  compares against a machine-readable block, not against markup.
- **Red when:** a check reads the artifact it is supposed to be checking.

## I11. New gating is opt-in by presence

A repository that never adopted a feature sees no new failure mode from it.

- **Enforced by:** the pattern of `topo.countChecks || []` and `existsSync(statusPath)`, followed
  by every Control Room assertion in `lib/check.mjs`.
- **Red when:** adding a capability turns an unrelated repository's gate red.

## I12. Determinism: the only clock is the manifest

Nothing in the derivation path calls `Date.now()` or `new Date()` with no argument. `today` comes
from `forma.room.json`. `gen` has exactly one volatile field, `generatedAt`.

- **Enforced by:** `test/run.mjs` compares two consecutive `gen` runs and allows exactly one field
  to differ; `room-presentable` re-renders and compares bytes.
- **Red when:** two runs on unchanged inputs differ.

## I13. Nothing in `lib/` knows any project's names

No node id, directory, label or stack of any specific repository appears in the engine. Anything
project-specific is declared in a manifest or a topology.

- **Enforced by:** `CONTRIBUTING.md`; the per-program `blockedBy` and `taxonomy` fields exist
  precisely so `needs-human` is not hardcoded.
- **Red when:** a grep for a project's vocabulary hits `lib/` or `bin/`.

## I14. Repository-controlled text never becomes markup

Model prose, issue titles, finding text and document bodies are all attacker-adjacent input.

- **Enforced by:** `lib/room.mjs` escapes `<` as `<` in injected JSON and `</script` in the
  inlined viewer; the embedded frame runs `sandbox="allow-scripts"` without `allow-same-origin`.
- **Red when:** a `</script>` in a description closes the script element. There is a test that
  plants exactly that.

## I15. Every UI string exists in both locales, and every declared string is used

The single-lens viewer keeps its `STRINGS` literal; the Control Room's tables are
`lib/viewer/strings/{en,it}.json`. Both stay at parity, and the Control Room's are additionally
checked for keys nothing reads — dead weight a translator still has to carry.

- **Enforced by:** `test/run.mjs` compares the viewer's key counts, and compares the two JSON files
  key by key plus greps the template for every one of them.
- **Red when:** a string is added to one locale only, or a key survives the view that used it.
- **Note:** this rule claimed to cover the Control Room long before it did. The parity half was only
  ever true of the viewer until the tables became files.

## I16. Traceability is measured, never inferred

A requirement traces to a decision, a verification or an issue because a cell in a document says
so. Forma measures how much of that is covered and names what is not, at both ends: a requirement
that lands on nothing, and open work no requirement claims.

- **Enforced by:** `lib/rtm.mjs` reads only declared references; `lib/check.mjs` fails on a
  duplicate id, a reference that resolves to nothing, an uncovered requirement, an orphan open
  issue, and a declared document that contributed no rows.
- **Red when:** a matrix is missing a link at either end — or a document quietly stops contributing,
  which is how a matrix empties while still looking full.

## I17. History is derived, never stored

"Where we were" comes out of the same snapshot as "where we are": an issue was open on a day when
it existed and was not yet closed. No register, no second fetch, and the only clock is
`manifest.today`.

- **Enforced by:** `deriveHistory` in `lib/roomderive.mjs` reads `createdAt`/`closedAt` and returns
  `null` — not an empty series — when the snapshot predates those fields; `check` re-derives it.
- **Red when:** a briefing shows a flat line where it should say the snapshot cannot answer, or a
  series that changes without its inputs changing.

## I18. The only file a briefing writes is the manifest

`forma room --serve` exists because a page of checkboxes cannot write a file. It binds loopback,
accepts one field per programme (`enabled`), and re-validates the whole manifest against its schema
before writing, so a rejected edit leaves the file exactly as it was.

- **Enforced by:** the `PUT /programs` handler in `lib/room.mjs`; `npm test` asserts the bind is
  loopback.
- **Red when:** anything else becomes writable through the page, or a rejected edit lands half-applied.

---

## How to add an invariant

Do not add one here until it has an enforcement point. Write the check first, watch it fail on
purpose, then write the row. A rule that has never been seen to go red is a rule nobody knows
works.
