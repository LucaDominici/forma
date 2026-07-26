# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
