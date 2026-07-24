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
- `forma gen --cluster-min <n>` / `--group-min <n>` (R3): the §2 clustering thresholds (default 8 and 3) are no longer hardcoded. A non-integer value fails loud rather than silently disabling clustering.
- Synthesized components describe themselves from their children's docs (R4) — first sentence of up to three, ordered by name — instead of falling straight to "Groups related files under X". Deterministic, no LLM.

### Changed
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
