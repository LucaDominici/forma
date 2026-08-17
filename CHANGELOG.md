# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-17

The Control Room contract is now exercised across five real GitHub programmes and frozen for 1.0.
The portfolio dogfood covered 4,269 issues and 97 open items; independent counter-verification
covered all 233 emitted claims without turning 193 unsupported completion claims green.

### Added
- `forma room init` / `room update` provide the repeatable portfolio workflow, including map-less
  repositories and externally produced counter-verification results.
- First-class Kanban, execution queue, issue health pills, and embedded C4 drill-down complete the
  dense per-programme Control Room surface.
- `forma audit` emits deterministic offline plans and validates evidence-anchored health/findings;
  the Codex adapter remains outside Forma, so no agent or network path enters the deterministic engine.

### Changed
- The model contract is frozen on schema major 1. Existing 1.x models remain compatible; an
  unsupported future major is rejected explicitly.
- `forma scan` now discovers GitHub-backed map-less repositories and ignores `*.worktrees`
  directories, while preserving curated manifest decisions on repeated runs.

### Fixed
- Public CI no longer depends on the private `arbiter` repository, and governance now matches the
  solo project tier.
- Room aggregates, health overlays, findings, and issue coverage are all re-derived by gates that
  have been observed failing on drift and passing on valid portfolio inputs.

## [0.13.0] - 2026-08-10

Minor, not major: every schema addition is optional, every new gate assertion is opt-in by
presence, and no command or flag changed meaning. A repository that ignores all of it renders and
gates exactly as before.

### Added
- **`forma room`** composes a **Control Room**: one self-contained HTML briefing over N programmes,
  declared in a `forma.room.json` manifest. A briefing in reading order at `#/`, five views per
  programme under it (`exec`, `tech`, `map`, `wbs`, `docs`), and an options view. Every view fits
  the viewport at 1920×1080 and gains columns up to 3440×1440; printing hands over the whole thing,
  one view per page.
- **A requirements traceability matrix, derived not curated.** Declare an `rtm` block and forma
  reads id columns out of the markdown tables a repository already writes, joins them to the issue
  snapshot, and `forma check` fails on five holes: a duplicate id, a reference that resolves to
  nothing, a requirement that lands on no work, open work no requirement claims, and a declared
  document that contributed no rows. The middle pair is what makes "the GitHub issues are the whole
  of the work" falsifiable in both directions ([ADR-0006](docs/adr/0006-traceability-as-a-derivation-not-an-overlay.md)).
- **`forma scan`** writes the programme list from a directory of checkouts. It merges rather than
  replaces: `enabled: false` and every hand-curated field survive a re-run, and `today` is never
  invented.
- **`forma room --serve`** opens the briefing on loopback so the options view can turn programmes on
  and off. It writes one field per programme and re-validates the whole manifest before writing, so
  a rejected edit leaves the file byte-identical. It is the only path in the product that writes
  anything.
- **`scripts/palette.mjs`** — a colour gate: OKLab/OKLCH, WCAG 2.1 contrast, and Machado CVD
  simulation, run by `npm test`. `docs/DESIGN.md` §D6 had claimed a measurement script that did not
  exist; writing it found eight contrast failures, a pure `#ffffff`, and a status trio whose worst
  pair measured 3.1 rather than the asserted 6 to 8.
- **`createdAt` / `closedAt`** on the issue snapshot, so "where we were" is a count over one
  snapshot rather than a stored series. A snapshot written before these fields derives `null`
  history rather than a flat line.
- **Optional manifest fields**: `programs[].enabled`, `programs[].rtm`, `programs[].docs.canon`.

### Changed
- **Every colour token is OKLCH**, and the status trio is separated by lightness on purpose — the
  one channel colour blindness leaves. The worst pair under simulated CVD moves from 3.1 to 8.5 in
  the light theme and 4.2 to 7.2 in the dark one. The `blueprint` skin the briefing embeds is now
  the briefing's own palette rather than a second, colder one.
- **`docs/INVARIANTS.md` is now `docs/GLOBAL_INVARIANTS.md`**, the name the documentation standard
  recognises. Every reference was updated; no content changed.
- **`forma doc` emits frontmatter** into the arc42 scaffold, so the generated file satisfies the
  documentation gates by construction instead of being exempted from them.

### Fixed
- **Both Control Room gates were unrunnable.** `scripts/room-presentable.mjs` threw before its first
  predicate, and `check`'s room block read a shape the composer had stopped producing and was inert
  behind a guard. Both now iterate programmes, and `npm test` requires each to reject a hand-altered
  aggregate.
- **`linkMaxFiles` was ignored on the portfolio path**, so one artifact carried two sweep thresholds
  and only one of them was gated.
- **The landing chart counted pull-request numbers as issues.** GitHub shares one number space, so
  `(#46)` from a squash merge was indistinguishable from an issue; the series is intersected with
  the snapshot now, as coverage always was.
- **A programme without an architecture model derived nothing at all.** It now derives everything
  its issues can answer, with `null` — never a measured zero — for the two answers that need a map.

## [0.12.0] - 2026-07-28

### Changed
- **Derived container edges now read as a relationship, not a count.** `forma gen` labels a
  derived edge with the kind of code reference it found — `imports`, `drives`, `reads`, or
  `references` — instead of a bare `N×`. The reference count moves to a new optional `weight`
  field, which the viewer sums when rolling edges up, so no information is lost: a grouped arrow
  still reads `4×`. An executive reads the verb; an engineer still has the count. Curated edges
  in the topology always win, unchanged. Affects both the name-reference path (`lib/gen.mjs`)
  and the Go import-block path (`lib/lang.mjs`).
- **Derived edges are now `inferred`, not `active`.** Name-reference derivation is a heuristic
  (undirected in principle), so stamping it `active` overstated it. The viewer draws `inferred`
  edges with a softer dotted style, distinct from curated `active` flow and `to-build` dashed.
  The legend names all three. Curated edges stay `active`.

### Added
- **`weight`** (optional integer) on edges in `c4-model.schema.json`; **`inferred`** added to the
  `estatus` enum. Both are additive — existing models render unchanged.

## [0.11.3] - 2026-07-27

### Fixed
- **Unchanged timeline nodes no longer repeat their function as checkpoint state.** `What it does`
  remains visible once; `At this checkpoint` now appears only when the model carries an explicit
  `current` value. Projected nodes keep their checkpoint state and change detail, while legacy
  models retain their existing fallback behavior.

## [0.11.2] - 2026-07-27

### Changed
- **The public haben demo now exercises the governed architecture timeline instead of only
  describing it.** The reproducible curation maps haben's current delivery boundary to five typed,
  cumulative checkpoints over the code-verified AS-IS graph. The final custody-only checkpoint
  deliberately carries no C4 patch and therefore renders `no architecture changes`. The snapshot
  was regenerated from `haben@4c9b6880`: 63 nodes and 193 edges at AS-IS, 66 nodes and 196 edges at
  the final projection, with `presentable` and `forma check` both green.

## [0.11.1] - 2026-07-27

### Changed
- **The timeline is navigation, not a persistent change register.** The duplicated list above the
  graph is gone; the local patch remains visible through graph accents and contextual node detail.
  A future checkpoint with an empty patch now says `no architecture changes`, while board badges
  stay verbatim display-only annotations. The cumulative graph, typed-patch contract and legacy
  CURRENT/TARGET behavior are unchanged.

## [0.11.0] - 2026-07-27

### Fixed
- **The public demo asserted a completion nobody measured, and drew "not ruled" as "not built".**
  The board read `100%` on every box that carried a number and `avanzamento 100% 25/56` on the one
  line a stakeholder reads first, while 36 boxes — modules the measured repository plainly has —
  wore the dash the legend teaches as *to build*. Four causes, one class:
  - **A status column that never says "not done" is an inventory, not a measure.**
    `done / rows.length` is pinned to 1 by arithmetic when no row can say no — the source matrix is
    39 rows, 39 `DONE`, so all 27 nodes it reached came out at exactly 100. The verdict survives
    (the document *is* declaring those capabilities finished); the percentage does not. Measured per
    source, which is the unit that either discriminates or does not.
  - **Rows that reach a box only through its children did not rule on that box.** Two curated
    groupings with no evidence of their own read `done/100` with `coverage {named:0}` — a verdict
    borrowed from below and printed as their own. Reporting what is underneath is `rollStatus`'s
    job, not something `gen` may invent.
  - **`unknown` wore the grammar of `planned`.** `.s-unk` was dashed and `legHint` says a dashed box
    is *da costruire*; the dash now belongs to `.s-plan` alone. And the hollow green the legend has
    promised since 0.9.0 — `DONE (declared)` as against `DONE (proven)` — is finally drawn, so a
    verdict derived from a document stops being painted as proof.
  - **`rollStatus` counted percentages, not verdicts,** so a domain holding nine packages a document
    calls finished went silent again the moment those packages stopped carrying a number. It now
    counts verdicts and reports `9/14` with no mean when there is none to report. The badge became a
    function (`badgeOf`) and stops printing `?` over a box its own colour calls finished.

### Added
- **A governed architecture timeline can replace the binary CURRENT/TARGET projection.** Models
  may carry an optional sequence of cumulative checkpoints over the code-derived AS-IS baseline.
  Each checkpoint contains typed node/edge add, update, rewire and remove operations; `gen`
  materializes and validates every cumulative graph before writing, while `check` fails if the
  compact programme drifts from the topology. In the viewer the timeline is the only temporal
  control, the local patch is accented, board counts remain display-only, and legacy models retain
  CURRENT/TARGET unchanged. Schema `1.6.0`.
- **`scripts/presentable.mjs` grades the claim, not just the scene.** Its four predicates measured
  geometry — box counts, actors, prose, arrows — and not one read `completion`, so the model above
  passed at full marks and went to Pages. A fifth predicate refuses to publish a board where a
  percentage's only provenance is a document declaring itself finished (`verify.derived`). Driven
  at the published model it names the offending boxes with their citations and exits 1.

## [0.10.1] - 2026-07-26

### Fixed
- **A box that groups others read `?` while its children carried verdicts.** Four of six domains on
  the public demo showed the unknown badge, so the one screen a stakeholder is shown looked less
  finished than the repository was. The viewer now rolls the children up: the badge reads the mean
  of the descendants somebody ruled on **together with how many that was** — `100% 9/14` — and the
  colour follows worst-of, where `unknown` still outranks `done` (a domain holding one package
  nobody ruled on is not a green domain, however green the rest of it is). The mean alone would be
  the invented green this tool exists to kill: 9 of 9 ruled done says nothing about the other 5.
  `gen` still refuses to derive a verdict — the model keeps saying `unknown` for that box; this is
  the viewer reporting what is underneath, and the detail panel names it as a roll-up.

## [0.10.0] - 2026-07-26

Closes the boundary in `docs/SCOPE.md`: four issues, three of them measured on a real foreign
repository rather than on this one.

### Added
- **A grouping box inherits its children.** Grouping 53 packages into domains is the only cure for
  a level no projector can show, and it used to cost two things in silence: the domain level drew
  **zero** arrows, and the tally counted domains instead of packages — the same repo read `25/53`
  flat and `2/6` once curated, so drawing fewer boxes deleted 23 verdicts from the number a reader
  sees first. `rollEdges` now projects each endpoint onto the visible ancestor, sums the counts and
  drops self-loops (0 → 14 arrows); `tallyOf` counts units, not boxes (25/53). And a curation that
  would lose edges — `kind: "component"` on a grouped package takes 189 edges to 13 — now warns on
  stderr with the count. (#32)
- **`init` seeds the first screen.** It used to emit one context node with a generated sentence in
  it. It now seeds a `person` and an `external` placeholder with edges, and `gen` names them on
  stderr, once, until they are renamed. (#33)
- **`init` names the stack it did not model.** A Go + React monorepo was seeded as 53 Go packages
  with the React application silently absent. Every skipped stack is now named with its file and
  directory count, and the topology carries `_unseeded` with ready-made `nodes`+`leafSources` that
  `gen` and `check` accept verbatim. Seeding every stack automatically was measured and rejected:
  it regresses the edge predicate and doubles the box count. (#34)
- **The public demo is no longer forma demoing on forma** — it is a private 53-package Go
  application, published as a committed snapshot with its source commit recorded. At that commit
  `scripts/presentable.mjs` and `forma check` both exit 0, and the Pages job refuses to publish a
  model that fails the first. (#35)

### Fixed
- **`init` matched by file extension, not by language.** A React repo with more `.tsx` than `.ts`
  modelled half its files, silently, and the skipped-stack report handed back directories that were
  already seeded — pasting them would have stacked a second container on the same place.

## [0.9.0] - 2026-07-26

### Fixed — the first five minutes of a stranger

- **The first screen is no longer one empty box (#33).** `init` seeded a single context node with a
  generated sentence in it, and the README's "best-effort; then curate" never said that for *this*
  screen the curation is not optional — without it there is no big picture at all. `init` now seeds
  the two roles every system has, `kind: "person"` and `kind: "external"`, with an arrow each to the
  system and names that cannot be mistaken for curation: `TODO: who uses it`,
  `TODO: what it depends on`. Inventing plausible ones ("End user") was rejected for exactly that
  reason. While a `TODO:` name survives, `gen` prints the names back on stderr in one line and
  carries on — the model is valid, only its first screen is unfinished. The closing line of `init`
  now leads with the context instead of listing it as one chore of three. Measured on a foreign
  53-package repo: `scripts/presentable.mjs` predicate 1 goes FAIL (1 box) → PASS (3 boxes) and
  predicate 4 stays PASS (`2,189`) on a bare `init`, with no hand curation anywhere.
- **A two-stack repo says so instead of showing one stack (#34).** `init` models ONE language per
  run — the container pass keys on a single `match` — and it used to walk past everything else in
  silence: on a Go + React monorepo it seeded 53 Go packages and left out the application the users
  actually open, with no line admitting it. Every stack it saw and did not seed is now named with
  its file and directory counts, and the topology carries `_unseeded`: ready-made `nodes` +
  `leafSources` pairs, one per directory, ids already de-duplicated against the seeded ones.
  Pasting them is a cut, not a rewrite: the fixture proves `gen` and `check` both accept the entries
  verbatim. Seeding them automatically was measured on that repo and
  rejected: it takes the container level from 53 boxes to 92, prose-less boxes from 28 to 55, and
  flips predicate 4 from PASS to FAIL — and the shallowest-directory rule would model the frontend
  as its two build config files, because `frontend/` holds `knip.config.ts` and `vite.config.ts`
  while the 302-file application lives one level down under `frontend/src`.
- **One `match` per language, not per extension.** A React repo where `*.tsx` outnumbered `*.ts` was
  modelled from the `.tsx` half alone and the `.ts` half was neither seeded nor mentioned; `init`
  now seeds `\.(ts|tsx)$`. The same rule governs what gets reported: the report keys on the
  directories the container pass did not reach — per language, so `scripts/` can be a Go package and
  still be named for the 160 `*.mjs` nothing models — and counts each candidate the way `gen` walks
  it, match and exclusion included. Without that last part six directories of a real Go repo, holding
  nothing but `_test.go`, came back as entries that would have seeded twenty boxes of test files.
- **`--include` stopped promising what it cannot do.** The flag un-skips a data/doc directory **by
  name** (`docs`, `fixtures`, `testdata`, …); it never took a path, so the `--include <dir,...>` in
  `init`'s error message read as "point me at the sources" and did nothing on a Go repo. The message
  now names the directories the flag actually accepts, and that error is no longer fatal: `init` is
  best-effort, and since #33 it always has something true to write. A repo with no recognised source
  at all is now a warning and a valid context-only topology, not exit 1.

### Changed

- **A number derived from a repo document now discloses what it rests on.** Two things were true at
  once and rendered identically: a green from a closed GitHub issue is a fact, a green from a
  capability table is the repo declaring itself finished. The detail panel now reads **Declared in**
  rather than *Verification source* for a derived state, the citation says `(3/3 declared done)`,
  and the legend carries both marks — filled for **DONE (proven)**, hollow for **DONE (declared)**.
  `check` keys off the `verify.derived` boolean and never the wording, so the words stay free to be
  honest.
- **Coverage rides with the percentage.** `done / rows.length` answers *of the capabilities somebody
  wrote down, how many are finished* — never *how much of this module is finished*. A container of
  22 files that a matrix names 3 of, all done, read `100%` while the other 19 were not counted as
  unfinished: they were not counted at all. Every derived state now carries `verify.coverage`, and
  the box says **3 of 22 units named by the document**, or **the document names this module itself**
  when a row addresses the whole unit. Measured on a real Go repo: 22 of 25 derived boxes are
  whole-module and honest; 3 were quietly reporting a corner (`internal/worker` 3 of 22,
  `internal/insight` 3 of 8, `internal/export` 1 of 2). Averaging over every unit instead was
  rejected as the mirror lie — a module the document never names is not 0% done, which is exactly
  why `gen` refuses to write a completion nobody curated.

## [0.8.0] - 2026-07-26

Pointed at a real 53-package Go repo, the board was unreadable and the numbers were wrong. Three
independent reviews, one per failure. Every count below is measured on that repo.

### Fixed — the board was unreadable

- **A title rendered at 3.24 px.** `autoLayout` capped the grid at 4 columns, so 53 containers
  became a 1328×2834 ribbon inside a stage twice as wide as tall; the fit-to-content viewBox then
  did its job and scaled everything to 0.28. Columns now follow the stage's shape, and past 20
  siblings the card goes compact — a title is **10.9 px**. A new legibility floor asserts ≥ 9 px for
  every sibling count up to 60; the shipped code failed it for 44 of them.
- **189 arrows over 53 boxes.** 172 crossed a box that was not one of their endpoints, and that
  stayed 85–91% at every grid shape tried — layout cannot fix it, only drawing less can. Past the
  threshold that already hides edge labels, arrows drop to background texture; hover still brings
  one back to full strength.
- **26 of 53 boxes printed `1 file: advisor.` under a box titled `internal/advisor`.** A description
  that only restates the title is now dropped.

### Fixed — the numbers were wrong

- **A renamed `code_ref` turned a box green.** A row whose refs resolve to nothing was silently
  dropped, so the capability it described left the completion denominator: one edited cell took a
  container from `in-progress`/50 to `done`/100 with a fresh "(1/1 done)" citation, and `check`
  re-derived and confirmed the new number. `gen` and `check` now refuse a row whose `code_ref`
  resolves to nothing. Glob stems (`internal/imports/statement*.go`) still count as live.
- **The whole-product box read `done`/100 on the first screen anyone opens.** Every row in a
  capability table touches the system node — its subtree is the whole repo — so its denominator was
  "the rows somebody wrote", never "the repo", while containers the document never mentions sat
  underneath at `unknown`. The system node no longer derives state from a document; the
  whole-product verdict is what the curated overlay is for.
- **`check` read silence as "no drift".** Delete the cited document, rewrite a row's sentence, or
  let the document grow past the row cap, and the derivation fell silent while the committed green
  box and its citation kept shipping. A listed source that is gone now fails; a state that used to
  derive and no longer does fails; and the quoted box text is re-derived just like the numbers.
- **Two unrelated Go packages both claimed to be the whole product**, quoting the repo's root
  README, because a package at the module root globbed `"."`.

### Changed — BREAKING for Go repos

- **A Go package is ONE node.** It used to be a container *and* a leaf pointing at that very same
  directory, so drilling into a package showed the package again — 53 of 53. The files inside stay
  internal detail (issue #17): they are a count on the container, not boxes. The model goes from
  107 nodes to 54, with **187 of 187 import edges still agreeing with `go list`, 0 missing** —
  nothing was traded away.
- **This also un-breaks the drift gate on Go, which was vacuous.** The old leafSource matched one
  fixed directory name, so adding or deleting a `.go` file passed `forma check`. The gate that is
  the product did not fire on Go at all. It now re-walks the package's real files and compares the
  count.
- Go leaf node ids disappear. A `c4-status.json`, `descriptions` or `layout` keyed to one fails loud
  at `gen` — the correct behaviour, not a regression.

## [0.7.2] - 2026-07-26

### Fixed
- **The headline percentage claimed coverage it did not have.** The per-level tally averaged
  `completion` over the nodes that carry one and printed the result as the progress of the level.
  On a real Go repo that rendered **`progress 100%`** beside a board where 25 containers were
  `done` and **28 had no verdict at all** — the invented green this tool exists to kill, in the one
  number a stakeholder reads first, while every box below it was honestly `unknown`. The mean now
  reports its own denominator: `progress 100% 25/53`. Averaging over *every* child instead was
  rejected as the mirror lie — a node nobody ruled on is not 0% done, which is exactly why `gen`
  refuses to write a completion nobody curated. Found by looking at the screen; no data-level
  check could see it, so the tally is now a lifted, tested function (`tallyOf`).

## [0.7.1] - 2026-07-26

Three holes 0.7.0 left around the curated overlay — the channel it declares to be the authority.

### Added
- **`forma gen --status-apply <file>` — the writer `c4-status.json` never had.** The overlay outranks
  every derived number, `gen` validates it and `check` governs it, and no command in the repo had
  ever written one: on a fresh repo the authority channel was reachable only by hand-editing JSON.
  The apply merges `{"nodes":{"<id>":{…}}}` into the curated file through the **same** validator the
  read path uses — one function now, because a writer that validated differently from the reader
  would commit a file the very next `gen` rejects. It validates **everything before touching disk**,
  so any rejected fill leaves the committed overlay byte-identical, and it creates
  `docs/architecture/` when the first apply on a repo is also the one that creates the overlay.
- **`forma init` seeds `meta.ghRepo` from the `origin` remote.** `forma verify` is the one command
  that derives progress from a fact rather than a claim in a document, and it needs that field to
  know where to look; `init` never wrote it, so on every freshly seeded repo verify had nowhere to
  point. A directory with no git remote still gets no `ghRepo` — a fabricated one would send
  `verify` at the wrong repository.

### Fixed
- **A leaf's `category` was its parent's `category`, not its container.** Every leaf in a model
  therefore carried the literal string `"container"` — 53 of 53 on a real Go repo — and the viewer's
  catalogue collapse groups childless siblings *by category*, so drilling into a container showed
  one box labelled `container` instead of the leaves. Leaves now carry their container's name.

## [0.7.0] - 2026-07-26

Two things a diagram generator should have been doing all along, and was not: reading the
**language's own declaration** of its architecture instead of guessing at it, and reading the
sentence your **capability table** already wrote about a container instead of showing a stakeholder
the first docstring inside it. Plus the gate finally applied to the product: the model is validated
against the schema forma claims to validate it against, and CI runs `forma check`.

**If you use forma on a Go repo, read the BREAKING note first — your node ids change.**

### Changed

- **BREAKING (Go repos only) — the leaf is now the package, not the file, so every Go node id
  changes.** 0.6.0 made each `.go` *file* a leaf, `_test.go` included; 0.7.0 makes each *package*
  the leaf and drops test files from the architecture entirely. Ids go from
  `internal_store__store_go` to `internal_store__store`, `cmd_app__main_go` to `cmd_app__app`, and
  a leaf like `internal_server__server_test_go` **disappears**. Anything you keyed to the old ids
  is affected, in three different ways:

  | What you curated | What 0.7.0 does |
  |---|---|
  | `c4-status.json` overlay on an old leaf id | **`forma gen` exits 1** — `[gen-c4] FAIL: status overlay: unknown node id "internal_store__store_go" — it is not in the model (stale overlay?)` |
  | a `c4-topology.json` seeded by ≤0.6.0, left as-is | **every Go import edge silently vanishes** — the old `leafSources` are file-shaped and no longer map to import paths (measured on a 4-package repo: `edges=3` → `edges=0`, exit 0, no warning) |
  | `descriptions` / `layout` keyed to old ids | **silently ignored** — the box drops to the generic `"Component of module …"` fallback, and a layout pin is copied into `meta.layout` verbatim where it matches nothing |

  **Migration**, in this order:

  1. `forma init --force` — re-seeds `leafSources` package-shaped. This is the step that brings the
     import edges back; upgrading without it is the silent-empty-graph row above. Re-apply any
     hand-curation of the topology afterwards (`init` overwrites the file).
  2. Re-key `c4-status.json`: `<container>__<file>_go` → `<container>__<package-dir>`, and delete
     the entries for `_test.go` leaves — those nodes no longer exist. Run `forma gen`; it fails on
     the first stale id and names it, so repeat until it exits 0.
  3. Re-key `descriptions` and `layout` the same way. These fail quietly, so check them by eye:
     `descriptions` is keyed by node *name*, which survives where the package directory and the
     file share a name (`store.go` in `store/`) and breaks where they do not (`main.go` in `app/`
     was `main`, is now `app`).

  Non-Go repos are unaffected — ids, edges and the description chain are unchanged, and the five
  non-Go fixtures (`mini`, `flat-python`, `data-noise`, `virgin-kebab`, `docmap`) stay green
  through `init→gen→check`. Minor bump, not patch: 0.x may break, but it is declared here, not
  buried.
- `schemaVersion` 1.4.0 → **1.5.0**: `descSource` gains `docmap` (additive enum value).

### Added
- **The feature matrix now outranks the code above the leaf (`lib/docmap.mjs`), and it can generate
  the progress bar (issue #17, first slice).** The description chain was code-first at every level:
  right for a file, wrong for a container, where a stakeholder asks what that part of the product
  does for the user — a sentence a governed repo has already written in a capability table.
  `forma init` now detects those tables and lists them under `docSources`; `gen` joins each row to
  the nodes its code references name and quotes the row **verbatim** (`descSource: "docmap"`).
  Where the rows carry a status, `status2` and `completion` are **derived** from them (one of two
  capabilities shipped ⇒ `in-progress`, 50%) with `verify.source` naming the document and the
  tally — the first producer of programme state that is not a hand-written overlay. Because it is
  derived it is never trusted: `forma check` re-reads the document and **fails** if the committed
  model claims a number the document no longer supports, per field, skipping fields the curated
  overlay owns. Three guards keep the "invents nothing" rule intact: a node named by **more than
  three rows** is only *touched* by the matrix, not described by it, so it yields nothing and the
  code chain runs (on haben `internal/store` is named by 12 rows, `internal/server` by 20);
  auto-detection additionally **requires a status column**, because "feature + file" is also the
  shape of a refactor plan and a task line does not belong in a stakeholder's box; and a node no
  document names stays `unknown` rather than getting a made-up zero.
  Measured on haben (107 nodes): `descSource` went from `{curated 1, fallback 104, readme 2}` with
  every node `unknown`, to `{curated 1, docmap 50, fallback 54, readme 2}` with **50 nodes carrying
  derived progress** and **25 of 53 containers** reading their own capability sentence.
- **Per-language adapters for topology and edges (`lib/lang.mjs`), with Go as the first case.**
  `forma init` already detected the language and then applied a heuristic designed for JS anyway.
  On a real Go repo (~38 sources) that produced `nodes=44 leaves=38 edges=0`: `internal/` was one
  container hiding thirty packages, the leaves were files, the `_test.go` files were architecture,
  and the graph was empty. Four defects, one root cause — the language declares all of this and
  forma was guessing. Go now seeds one container per **package** (any directory holding a non-test
  `.go`, recursing past the first level), makes the **package** the leaf, drops `_test.go`
  everywhere, and derives edges from the **`import` blocks** instead of from name collisions, so
  the direction is right by construction. Same repo: `nodes=107 leaves=53 edges=189`.
  Verified against an independent oracle — `go list -f '{{.ImportPath}} {{join .Imports " "}}'` —
  **187 of 187 intra-module edges agree, 0 missing.** The 2 extra come from a `//go:build ignore`
  file whose imports are real source that `go list` excludes from the build; the 5 packages
  `go list` reports and forma does not are test-only directories, which is the point of the fix.
  Every other stack keeps the name-matching heuristic unchanged (`mini`, `flat-python`,
  `data-noise`, `virgin-kebab` are all green), and a curated topology opts in with `meta.stack: "Go"`.
- `test/fixtures/go-nested` — nested packages under a common directory, a `_test.go` sitting
  directly in that directory (the exact trap that stopped the seeder at `internal`), a per-package
  test file, and both `import` spellings.
- **The model is validated against the schema it declares (`lib/validate.mjs`).** The architecture
  doc had been claiming this since 0.1; no code path had ever loaded
  `lib/schema/c4-model.schema.json`. `gen` now validates after writing and fails loud — curated
  topology nodes are copied verbatim into the model, so a `kind` outside the enum used to sail
  straight through — and `check` reports schema errors alongside its drift errors, prefixed
  `SCHEMA:`. Zero dependencies (ADR-0001): a hand-written walker over the keyword subset the schema
  uses (`type`, `required`, `properties`, `additionalProperties` where literally `false`, `items`,
  `enum`, `minItems`, `minimum`/`maximum`, `pattern`). `format` remains an annotation, as ajv treats
  it in draft-07 without `ajv-formats`; `oneOf`/`allOf`/`$ref`/`patternProperties`/tuple `items` are
  unsupported and the module says so. Verified against an independent oracle — ajv 8.20 over the
  committed model, the 5 fixture models and 47 mutations: **53 of 53 verdicts agree**.
- **CI runs `forma check`.** The drift gate that is the product had never been applied to the
  product: `ci.yml` ran lint and tests only, while `pages.yml` deployed the committed model to
  GitHub Pages on every push to `main`. `pages.yml`'s comment claimed the check was "a local
  responsibility"; it no longer is, and the comment no longer says so.

### Fixed
- **A README opening with YAML front matter put `--- title: '…' docversion: '2.1.0'` in a box.**
  `firstPara` stripped markdown headings but not front matter, so on any repo whose docs carry it
  the first "paragraph" was the metadata block. Two of haben's containers rendered exactly that.
- **`dir: "."` leaked a `./` prefix into leaf evidence.** A package at the module root was recorded
  as `./migrations`, which the Go adapter could not map back to the import path
  `<module>/migrations` — one real edge silently missing. Found by the `go list` comparison, not by
  a test. Evidence refs are now plain repo-relative keys for every stack.
- **A directory leaf took its parent's README.** `describe` called `dirname()` unconditionally, so a
  Go package leaf would be described by the README one level up. It now reads the README *inside* a
  directory-evidence node.
- `npm pack` ships **20** files (was 17) — `lib/lang.mjs`, `lib/validate.mjs`, `lib/docmap.mjs`.
- **Documentation that this release made false, corrected.** `AGENTS.md` listed 11 of the 13 engine
  modules (no `lang.mjs`, no `validate.mjs`) beside a file count of 20; `ARCHITECTURE.md` §5 counted
  12 leaves under `lib` when the model has 13, credited `lint.mjs` with 8 files when it lints 16,
  and described the `mini` fixture as 3 leaves when it has 5; §6 still described edge derivation as
  name-matching only, with no mention of the Go adapter that overrides it; `docs/ORIENTATION.md`
  (audited at `8af203c`, before this release) asserted in three places that nothing validates the
  schema and that CI never runs `forma check` — both closed here — and `c4-status.json` still
  announced `v0.6.0` and `schema 1.4.0` on the boxes the live demo renders.

## [0.6.0] - 2026-07-26

Pointed at a **virgin repo** — kebab-case, no docstrings, no directory READMEs, no curated overlay
— forma produced an empty graph and a board claiming the project was finished. Six fixes, one
missing test.

### Fixed
- **Auto-edges on kebab/dotted names.** The matcher built its regex by *deleting* every non-word
  character instead of escaping it, so `session-store` became `/\bsessionstore\b/` and matched
  nothing: every kebab-case repo (i.e. most JS/TS ones) rendered `edges=0`. Metacharacters are now
  escaped and the boundary is `(^|[^\w-])…([^\w-]|$)`, since `\b` sits *inside* a hyphenated name.
  Side effect, deliberate: a name matched inside a longer hyphenated token (`cluster` in
  `--cluster-min`) no longer counts, which is what the label meant all along.
- **Component synthesis for kebab/camel/dot repos.** Grouping split on `_` only, so a container of
  12 kebab files produced zero components and the C4 component level did not exist. Splits on
  `/[-_.]/`.
- **Boxes described by their programming language.** The viewer's description chain ended in
  `|| n.tech`, printing "TypeScript" wherever a description was missing; removed at all three
  sites. And a container's own directory README now actually reaches it (`describe` only followed
  `path` evidence, while containers carry a `glob`), with a **measured** last resort — what the
  node holds, counted — instead of nothing.
- **Every node reported done at 100%.** `gen` stamped `status2:'done'` + `completion:100` on every
  non-planned node, so an unmeasured repo showed a fully complete programme. Without a
  `c4-status.json` overlay the state is now **`unknown`** with no completion at all, and the viewer
  gained a sixth neutral state to render it: `.s-unk`, a `?` badge, a legend entry (en/it), tally
  counting, catalogue aggregation and SVG export.
- **Containers excluded from enrichment.** `holesIn` admitted only leaves and components — exactly
  not the boxes that stay empty. Their prompt also had to stop being self-referential (a container
  *is* its own container: it claimed to belong to itself and called its children siblings) and now
  offers `Read the sources under <dir>/`.

### Added
- `test/fixtures/virgin-kebab` + assertions: the test whose absence let all of the above ship.
  kebab-case, 9 leaves in one container, zero docstrings, zero READMEs, zero overlay.

### Changed
- **BREAKING — `--enrich` now requires an explicit `--enricher`.** The flag used to default to
  `anthropic`, so a user without `ANTHROPIC_API_KEY` got a skip line, exit 0 and the same empty
  boxes: a silent no-op dressed as success. `gen --enrich` without `--enricher` now **fails**, and
  the error names all four providers (`anthropic|openai|ollama|agent`). Any script or CI job
  calling `gen --enrich` on the implicit default breaks — pass `--enricher anthropic` to keep the
  old behaviour. Minor bump, not patch: 0.x may break, but it is declared here, not buried.
- `schemaVersion` 1.3.0 → **1.4.0**: `status2` gains `unknown` (additive enum value). A model
  generated by 0.6.0 on a repo with no `c4-status.json` overlay carries `status2: "unknown"` and
  **no** `completion` field, where 0.5.0 wrote `done`/`100` on every node.

## [0.5.0] - 2026-07-25

The self-model stops being a lonely box in an empty canvas: the viewer shrink-wraps the level it
draws, and forma is finally pointed at forma with every channel the engine grew in 0.4.0.

### Added
- Viewer: **fit-to-content viewBox** — a sparse level renders zoomed and dense instead of lost in a
  fixed 1020px canvas (minimums keep a single box from becoming comically large; extra room is
  split evenly so content stays centred). Exported SVG/PNG backgrounds honour the fitted origin.
- Viewer: **per-level programme tally** in the breadcrumb — status dots with counts plus mean
  completion ("progress 63%"), computed on the level's real children (catalogue members included).
- **Self-model dogfood:** curated context level (developer/agent, target codebase, npm registry,
  GitHub CI + Pages, planned status boards), programme overlay `docs/architecture/c4-status.json`,
  curated `layout` hints for L1/L2, and `meta.title` — the Pages demo now shows what the tool can do.

### Changed
- Viewer: description lines cap raised 3 → 4 when the box height allows (still geometry-driven, so
  short boxes cannot print through `[+] DRILL`).

### Fixed
- Viewer: edge endpoints trim at the **true rectangle border** instead of a radial guess — on wide
  boxes with shallow angles the old trim landed inside the box and dragged the arrow label under
  the node (falls back to the radial trim when boxes touch).
- Viewer: edge labels get a stage-coloured paint-order halo, so they stay legible over grid lines,
  arrows and box borders in both skins.
- Viewer: the fitted viewBox is **held still while a box is dragged** (`draw()` runs on every
  mousemove, so a live refit rescaled the whole canvas under the pointer); the drop refits.
- Test: the attach fixture drops the repo's real programme overlay before regenerating a synthetic
  topology over the self-repo copy (the overlay refers to the curated topology's ids; gen failing
  loud on the mismatch is correct behaviour).

## [0.4.0] - 2026-07-24

Closes the QA findings on 0.3.0 (R1-R5).

### Fixed
- **The drift gate now governs every attached doc, not just `docPath` (R1).** `forma doc --attach <file>` records the target in `source.attachedDocs` and `forma gen` carries that registry across regens, so a block injected into any file is checked for staleness and malformed markers. Previously `forma check` read `source.docPath` alone: attaching to any other file produced a generated block no gate ever looked at — a silent false green.
- **`forma init` language detection ignores data/fixture/doc dirs**, the same ones it already refuses to seed as containers. Counting them meant a repo whose fixtures hold another language could be detected as that language and then fail with a confusing "no directory with source files directly in it" — which now also names the detected language and suggests `--include`.
- **A registered doc cannot quietly stop being governed.** Deleting both forma markers — or the file itself — from a doc listed in `source.attachedDocs` now fails the check: registry membership proves a block was injected, so silence there is the same false green the registry was added to close. `docPath` keeps its lenient behaviour (it may simply never have been attached), and `gen` warns instead of dropping the registry when a prior model exists but cannot be read.
- **A component's cached prose goes stale when its children gain documentation.** `descInputHash` now folds in the children's descriptions for `component` nodes — they are what the box is composed from. Without it a child gaining a docstring left the hash unchanged, so the old LLM sentence was restored over the fresh documentation, `--enrich` saw no hole and `check` never warned: the box was frozen with no way back.
- **Viewer: a description line can no longer paint outside its box.** Every wrapped line is clamped to the box width, so an unbreakable token (a long class name, a URL) is truncated instead of spilling over the rounded rect and its neighbours.
- **Enriched prose survives a failed refill (R5).** When a node's inputs change, the cached LLM sentence is kept (with its now-stale hash) instead of collapsing to the generic fallback, and `--enrich` still refills it on the next successful run. A network outage can no longer make a box worse; `forma check` keeps flagging staleness as advisory.

### Added
- **`--enricher agent`** — enrichment without a network call or an API key, for the case forma is built for: an agent is already driving it. `gen --enrich --enricher agent` writes `enrich-plan.json` (one entry per hole, with the source path to read for certainty), the agent writes the sentences, and `gen --enrich-apply <file>` applies them with the same cache, provenance and stickiness as any other enricher. A fill aimed at a node described by its docstring/README/arc42 is refused, not silently applied.
- **Curated layout hints.** An optional `"layout"` section in the topology (keyed by parent id, `"root"` at the top) rides into `meta.layout`; the viewer pins those boxes at their exact `x/y/w/h` — variable heights included — and auto-arranges unhinted nodes *below* the pinned block, so a partial hint set can never produce an overlap. **Export layout JSON** in the PRINT/EXPORT menu dumps every level you have arranged in exactly that shape, ready to paste back. No browser storage: the repo is the memory.
- **Viewer: `meta.title`** names the board (and the browser tab) when the model is not "repo X" — an embedded, curated model usually has its own name.
- **`window.__C4_API__`** (`model()`, `redraw()`, `stamp()`) for embedders that re-verify through their own bridge and need to push results back without forking the viewer.
- **`forma verify`** — the only networked command, opt-in and separate from the gate. One `gh issue list` call per run: nodes whose referenced issues are closed become `done`/`100` and get their `current` prefixed with dated evidence (`Closed with evidence (#7 CLOSED, gh <ts>).`); open issues are left alone; re-running never stacks prefixes. Structure is never touched, so `forma check` is unaffected. A missing or failing `gh` exits 1 with the model untouched. Stamps `meta.verifiedAt` — the field `gen` no longer writes. A node marked done also gives up a curated `statusWord`, which otherwise wins over `completion` in the badge and would leave a green box still labelled "NEXT".
- **Viewer: RE-VERIFY re-reads the model** when it was served, updating the boxes without losing the current level, layout or mode. With an injected `window.__C4_MODEL__` (or a failed re-read) it re-stamps and says so — "(static source)" / "(fonte statica)".
- **Curated programme-status overlay** (`docs/architecture/c4-status.json`, or `--status <path>`): decorates nodes by id with `status2`, `completion`, `statusWord`, `current`, `target`, `verify` and `issues` — the state code cannot know. `func` is refused (documentation owns what a module does). `gen` validates only the form — ids resolve, fields are known, enums and issue numbers are well-shaped — and `check` fails when the overlay decorates a node the model no longer has. The path is recorded in `source.statusPath`.
- **Viewer: arrow labels on the diagram**, not only on hover — automatic while the level stays readable (≤14 arrows), with a `LABELS` toggle to force them either way. They survive SVG/PNG export, so an exported picture no longer loses every relationship.
- **Viewer: description lines are laid out from the box geometry** — up to three, as many as clear the footer control, so a curated layout hint with short boxes can never print its text through `[+] DRILL`. Default node height 106 → 118 (three lines). Truncation now marks the last visible line instead of spending a whole line on a lone `…`, and a node title is measured against the actual badge width rather than a flat reserve, so names stop being clipped when there was room for them.
- **Viewer: the breadcrumb names the C4 level by number** (`C4-L1 · CONTEXT`, `C4-L3 · COMPONENTS`) from the model's own `levels` list.
- `forma gen --cluster-min <n>` / `--group-min <n>` (R3): the §2 clustering thresholds (default 8 and 3) are no longer hardcoded. A non-integer value fails loud rather than silently disabling clustering.
- Synthesized components describe themselves from their children's docs (R4) — first sentence of up to three, ordered by name — instead of falling straight to "Groups related files under X". Deterministic, no LLM.

### Changed
- **`current` is no longer filled with `Exists: <path>`.** That field is for programme facts; restating the evidence path in it left every box saying nothing. Undecorated nodes leave it empty and the viewer shows `func` — which, since 0.3.0, carries the module's real documentation.
- **One volatile field per run (R2):** `gen` no longer writes `meta.verifiedAt`; `generatedAt` is the only field that changes between two runs on an unchanged tree, so a model diff in git is signal. `meta.verifiedAt` is reserved for the (network, opt-in) verify command.
- Schema `1.2.0` → `1.3.0` (additive: `source.attachedDocs`, `source.statusPath`).

## [0.3.0] - 2026-07-24

### Added
- **Description ingest (§1a):** box text resolves from existing docs — curated → module docstring → dir `README.md` → mapped arc42 section — before the generic fallback. `descSource` records provenance. No LLM; pure parsing.
- **Component layer on flat containers (§2):** `forma gen` auto-groups a large flat container's leaves by common `foo_*` prefix into `component` nodes (`--no-cluster` to disable). Deterministic.
- **Attach-mode (§1b):** `forma doc --attach <file>` injects the generated diagrams/tables between `<!-- forma:begin -->` / `<!-- forma:end -->` markers in an existing doc (default: the model's `docPath`), leaving human prose untouched; `forma check` fails if that block goes stale.
- **Optional LLM enrichment (§7):** `forma gen --enrich` fills only description holes via a pluggable enricher (`--enricher anthropic|openai|ollama`, default off, opt-in). Cached in `c4-model.json` with `descInputHash`; `forma check` never calls the network — it recomputes the hash and warns softly if the prose is stale.
- **Smarter `init` (§3):** skips data/fixture/doc dirs (`docs`, `fixtures`, `testdata`, `demo`, `corpus`, `assets`, `examples`) instead of seeding them as containers; records each in `_skipped`. `--skip-tests` / `--include <csv>` to adjust.

### Changed
- Schema `1.1.0` → `1.2.0` (additive: `descSource`, `descInputHash` node fields).

## [0.2.0] - 2026-07-24

### Added
- Viewer: **drag** nodes to lay out the view, **export** to SVG/PNG, PRINT, and hover-to-label on edges.
- Viewer: **click any box to read its explanation at every level** (context / container / leaf), not just leaves.

### Changed
- Viewer: drilling is now an explicit action — double-click a box or its `[+]` control — so a plain click always inspects and no longer competes with drag.

## [0.1.0] - 2026-07-22

### Added
- CLI (`forma`) with `init`, `gen`, `check`, `doc`, `serve`.
- `init`: seed a `c4-topology.json` from real source directories (language-detected, Java-package aware).
- `gen`: walk `src/` leaves + derive container edges from real code references → `c4-model.json`.
- `check`: deterministic anti-drift gate (fails when the model diverges from the code).
- `doc`: project an arc42 scaffold from the model (deterministic C4 diagrams + ADR index; prose stubbed).
- `serve`: local static server for the interactive viewer.
- Stack-agnostic viewer with swappable skins (`holo`, `blueprint`).
- JSON schema contract (`lib/schema/c4-model.schema.json`).

[Unreleased]: https://github.com/LucaDominici/forma/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/LucaDominici/forma/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/LucaDominici/forma/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/LucaDominici/forma/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/LucaDominici/forma/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LucaDominici/forma/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LucaDominici/forma/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LucaDominici/forma/releases/tag/v0.1.0
