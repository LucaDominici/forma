# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-07-24

Closes the QA findings on 0.3.0 (R1-R5).

### Fixed
- **The drift gate now governs every attached doc, not just `docPath` (R1).** `forma doc --attach <file>` records the target in `source.attachedDocs` and `forma gen` carries that registry across regens, so a block injected into any file is checked for staleness and malformed markers. Previously `forma check` read `source.docPath` alone: attaching to any other file produced a generated block no gate ever looked at — a silent false green.
- **`forma init` language detection ignores data/fixture/doc dirs**, the same ones it already refuses to seed as containers. Counting them meant a repo whose fixtures hold another language could be detected as that language and then fail with a confusing "no directory with source files directly in it" — which now also names the detected language and suggests `--include`.
- **Enriched prose survives a failed refill (R5).** When a node's inputs change, the cached LLM sentence is kept (with its now-stale hash) instead of collapsing to the generic fallback, and `--enrich` still refills it on the next successful run. A network outage can no longer make a box worse; `forma check` keeps flagging staleness as advisory.

### Added
- **`forma verify`** — the only networked command, opt-in and separate from the gate. One `gh issue list` call per run: nodes whose referenced issues are closed become `done`/`100` and get their `current` prefixed with dated evidence (`Closed with evidence (#7 CLOSED, gh <ts>).`); open issues are left alone; re-running never stacks prefixes. Structure is never touched, so `forma check` is unaffected. A missing or failing `gh` exits 1 with the model untouched. Stamps `meta.verifiedAt` — the field `gen` no longer writes.
- **Viewer: RE-VERIFY re-reads the model** when it was served, updating the boxes without losing the current level, layout or mode. With an injected `window.__C4_MODEL__` (or a failed re-read) it re-stamps and says so — "(static source)" / "(fonte statica)".
- **Curated programme-status overlay** (`docs/architecture/c4-status.json`, or `--status <path>`): decorates nodes by id with `status2`, `completion`, `statusWord`, `current`, `target`, `verify` and `issues` — the state code cannot know. `func` is refused (documentation owns what a module does). `gen` validates only the form — ids resolve, fields are known, enums and issue numbers are well-shaped — and `check` fails when the overlay decorates a node the model no longer has. The path is recorded in `source.statusPath`.
- **Viewer: arrow labels on the diagram**, not only on hover — automatic while the level stays readable (≤14 arrows), with a `LABELS` toggle to force them either way. They survive SVG/PNG export, so an exported picture no longer loses every relationship.
- **Viewer: three description lines per box** (node height 106 → 118, so the text still clears the `[+] DRILL` control), and the breadcrumb now names the C4 level by number (`C4-L1 · CONTEXT`, `C4-L3 · COMPONENTS`) from the model's own `levels` list.
- `forma gen --cluster-min <n>` / `--group-min <n>` (R3): the §2 clustering thresholds (default 8 and 3) are no longer hardcoded. A non-integer value fails loud rather than silently disabling clustering.
- Synthesized components describe themselves from their children's docs (R4) — first sentence of up to three, ordered by name — instead of falling straight to "Groups related files under X". Deterministic, no LLM.

### Changed
- **`current` is no longer filled with `Exists: <path>`.** That field is for programme facts; restating the evidence path in it left every box saying nothing. Undecorated nodes leave it empty and the viewer shows `func` — which, since 0.3.0, carries the module's real documentation.
- **One volatile field per run (R2):** `gen` no longer writes `meta.verifiedAt`; `generatedAt` is the only field that changes between two runs on an unchanged tree, so a model diff in git is signal. `meta.verifiedAt` is reserved for the (network, opt-in) verify command.
- Schema `1.2.0` → `1.3.0` (additive: `source.attachedDocs`).

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

[Unreleased]: https://github.com/LucaDominici/forma/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/LucaDominici/forma/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LucaDominici/forma/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LucaDominici/forma/releases/tag/v0.1.0
