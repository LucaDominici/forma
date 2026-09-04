---
title: "Global invariants"
doc_version: "1.0.0"
status: active
last_review: "2026-08-10"
owner: "Luca Dominici"
canonical_id: "global-invariants"
tags: ["audience/dev", "kind/invariant"]
related: ["AGENTS.md", "CONTRIBUTING.md"]
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

When a model exists, `verify` writes exactly one model field (`meta.verifiedAt`) plus node state; a
map-less run writes only the issue snapshot. `room` and `check` never write the model at all.

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
exist on disk, a `commit` must resolve in git, and an `issue` must exist in the snapshot.

- **Enforced by:** `applyVerdicts`/`applyCounterResults` in `lib/audit.mjs` throw rather than
  skipping; `lib/check.mjs` re-checks every health and finding reference;
  `scripts/room-presentable.mjs` fails on an unresolvable one.
- **Red when:** a verdict is written whose evidence points at nothing.

## I9. Nothing is dropped silently

Every cap, exclusion and truncation is counted and named where a reader can see it.

- **Enforced by:** `lib/link.mjs` records `excludedSweeps` with sha and file count;
  `lib/verify.mjs` retries full result pages and writes only after a short page proves completeness;
  `lib/room.mjs` still refuses any legacy snapshot marked truncated.
- **Red when:** a number quietly describes a subset.
- **Why:** measured, a fetch returned 1200 of 2246 issues and said nothing. Every proportion built
  on it would have been false.

## I10. The gate re-derives, it never trusts

`check` recomputes from raw inputs and compares. It never parses the generated HTML, and never
takes a committed number at face value.

- **Enforced by:** `lib/check.mjs` imports the same `lib/roomderive.mjs` the composer uses and
  compares against a machine-readable block, not against markup. Source coverage is a mandatory
  topology contract: every recognised source is modelled or excluded with a reason.
- **Red when:** a check reads the artifact it is supposed to be checking.

## I11. New gating is opt-in by presence

A repository that never adopted an optional feature sees no new failure mode from it. Core source
coverage is not optional: without it `check` cannot prove that a topology did not omit a stack.

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
so. Forma measures how much of that is covered. When `requireIssuesFrom` explicitly declares the
matrix to be the complete WBS, it names holes at both ends: a requirement that lands on nothing,
and open work no requirement claims. An auto-discovered matrix remains informational.

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

## I19. A shape shared with arbiter cannot change on one side

arbiter owns the governance ontology; Forma owns the C4 model shape and renders what arbiter
defines. Two repositories that share schemas by agreement drift the first time either ships alone,
and the drift surfaces as a briefing rendering a model it half-understands. `lib/schema/CONTRACT.json`
pins every shared schema — owner, path, sha256, which repos vendor a copy — and both repositories
hold a byte-identical copy and gate their own half.

- **Enforced by:** `scripts/check-arbiter-contract.mjs`, run by `npm test` and as its own CI step;
  arbiter runs the mirror `scripts/check-forma-contract.mjs`. When an arbiter checkout sits beside
  this one the cross-checkout half also runs; when it does not, it **skips out loud** — a
  cross-repo check that quietly does nothing is the failure the contract exists to prevent.
- **Red when:** a shared schema is edited without re-pinning in BOTH copies, a vendored copy drifts
  from the shape its owner defines, or the two copies of the manifest stop being identical.

## I20. Every derived surface has exactly one home lens

The Control Room answers seven questions — a portfolio and six lenses (ADR-0008) — and a question
answered in two places is answered twice differently the first time either half changes. The
five-view IA it replaces proved that: `commitDrift` was rendered on `map` and again on `tech`,
`kpis` on `exec` and again on `tech`, requirement coverage on `exec` and again on `wbs`; the code
even said so, in a comment reading *"the same fact `tech` reports, on the surface that shows it"*.
A comment is not a mechanism. The failure runs the other way too: `criticalPath`, `milestonePath`
and `milestoneReconciliation` were derived, gated and rendered **nowhere**, and nothing noticed.

`lib/lenses.mjs` declares the partition — each lens, its one question, the derived surfaces it owns
and the artifacts that publish it — and the viewer is partitioned by `/*lens:<id>*/` markers. The
table is the routing too: the composer injects it as `window.__LENSES__` and the viewer mounts what
it finds there, so a route cannot exist in one place and not the other. Publication is per
programme and rests on backing artifacts — a lens with nothing behind it is **absent**, not an empty
panel (I7).

### Exactly what is enforced

The analyzer is lexical, and the rule is stated as narrowly as the mechanism actually holds:

1. **One home.** No derived surface is read in two lens regions of the viewer's partitioned script.
2. **Both directions.** Each lens's measured reads equal its declared `owns` — a declaration nobody
   honours is the same lie seen from the other side.
3. **One spelling.** A `derived` token must be followed by `.<key>`, or by the `&&` of the guard
   idiom that precedes one. An alias (`var d = p.derived`), a destructure, an optional chain, a
   computed key and `p["derived"]` are each refused **by name** rather than silently missed.
4. **Code, not commentary.** Comments are stripped before measuring, so a comment can neither
   satisfy a declaration nor invent a duplicate.
5. **Nothing above the partition.** The first region begins exactly where the script does — an
   anchored check, not an existence test — and the head is held to the SAME spelling rule as every
   region, or a script wedged in ahead of the partition could read a surface through an alias while
   leaving the anchor pair intact. Template-only: a composed briefing's head carries the room JSON,
   both locale tables and the whole C4 hologram viewer, any of which may quote a surface while
   explaining this rule. For the same reason the marker scan starts at the script body, so a
   document that quotes a concrete marker cannot become the first region.
6. **The pin is pinned.** `DERIVED_KEYS` is compared against a live `deriveAll` call, so a new
   derivation cannot land with no home by being forgotten in two places at once.
7. **A comment is not a read, and a string is.** Comments are stripped before measuring — the
   fail-closed direction. String literals deliberately are not, so `p["derived"]` stays visible to
   the spelling rule. The stripper is regex-based, which is a known limit: a `//` or `/*` inside a
   string literal would truncate the rest of that line, and the failure would be silent. The viewer
   contains none, and the behaviour is pinned in both directions by test.
8. **Shared primitives read nothing derived.** The issue pill wears a health verdict on every lens,
   so the verdict lens *interprets* the overlay once — staleness beats the verdict, an unaudited
   issue is not a green one — and publishes the finished mark and reason. The pill draws them and
   could not re-interpret the overlay if it wanted to.

### What it does not cover, said plainly

- **`ROOM.portfolio` is a second surface.** It is cross-programme, the portfolio lens owns it, and
  it is outside this rule: it recomputes three aggregates the programme already derived, and copies
  health verdicts, reasons and evidence into its blocked rows. Nothing stops a future surface being
  given a second home by that route. Tracked as **L-3** in `docs/ISSUES_TO_OPEN.md`, not covered
  here. What the viewer no longer does is RENDER those copies: the blocked row reads the verdict
  index the verdict lens publishes, the same one the pill draws, so the two cannot disagree on
  screen — which they did, one line apart, because the portfolio drops stale verdicts and the index
  keeps them.
- **Markers are lexical, not structural.** Nothing ties a region to the view its code appends to, so
  a foreign panel wrapped in the owning lens's marker would be attributed correctly and rendered in
  the wrong lens. The rule catches drift, not deliberate misdirection.

- **Enforced by:** `ownershipViolations()` and `unpartitionedReads()` in `lib/lenses.mjs`, run by
  `npm test` against the shipped viewer with the tamper cases above, and `ownershipViolations()`
  again in `scripts/room-presentable.mjs` against the composed artifact. `derived.lenses` is
  computed in `roomderive.mjs`, so `forma check` re-derives publication like every other aggregate
  and refuses a briefing whose routing was edited by hand.
- **Red when:** two lens regions read the same derived surface; a lens declares a surface it does
  not read, or reads one it does not declare; a derived surface is spelled any way but
  `derived.<key>`; a shared primitive reads any derived surface; code sits above the first region;
  `DERIVED_KEYS` drifts from `deriveAll`; a new derivation lands with no home and no reasoned entry
  in `UNRENDERED`; or the artifact publishes a lens whose backing artifacts do not exist.

---

## How to add an invariant

Do not add one here until it has an enforcement point. Write the check first, watch it fail on
purpose, then write the row. A rule that has never been seen to go red is a rule nobody knows
works.
