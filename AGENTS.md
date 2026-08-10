# AGENTS.md — Forma source of truth for humans + AI agents

Forma (`forma-arch`, binary `forma`) is a zero-dependency Node ESM CLI that turns a
codebase into an interactive, stack-agnostic C4 architecture explorer and keeps it
honest with a deterministic drift check. Apache-2.0. See [`README.md`](README.md) and
[`PUBLISH.md`](PUBLISH.md) (release checklist).

## Layout

- `bin/forma.mjs` — CLI entry; dispatches `init | gen | check | doc | serve | verify | scan | room`.
- `lib/` — the engine: `init.mjs`, `gen.mjs`, `check.mjs`, `doc.mjs`, `serve.mjs`, `verify.mjs`,
  `room.mjs`, plus the shared pieces `cluster.mjs` (component synthesis), `describe.mjs` (§1a
  description resolution), `docmap.mjs` (capability tables → box text + derived progress),
  `enrich.mjs` (opt-in LLM prose), `lang.mjs` (per-language topology + edge adapters; Go reads
  packages and `import` blocks), `render.mjs` (arc42 renderers shared by doc+check), `validate.mjs`
  (zero-dep JSON-schema walker used by `gen`, `check` and `room`), `link.mjs` (issue↔code linkage
  via git log, no LLM), `taxonomy.mjs` (auto-detected label families), `audit.mjs` (evidence-gated
  Control Room verdicts, same doctrine as `enrich.mjs`), `roomderive.mjs` (Control Room aggregates
  — the ONE module both `room` and `check` import, so they can't disagree), `roomload.mjs` (how a
  manifest entry becomes concrete paths, and which programmes are active — shared for the same
  reason), `rtm.mjs` (requirements traceability derived from document tables, ADR-0006),
  `roomdocs.mjs` (the document corpus a briefing carries, git-tracked and byte-budgeted),
  `scan.mjs` (programme discovery that merges instead of replacing). The `lib` leaf count is a
  gated number: `forma check` re-walks the directory and fails if the model disagrees.
- `lib/schema/c4-model.schema.json` — the JSON contract (single source of truth for the model).
  `c4-issues.schema.json`, `c4-health.schema.json`, `c4-findings.schema.json`,
  `forma.room.schema.json` — the Control Room overlays (docs/SCOPE-room.md), each its own file
  with its own lifecycle, validated by the same `validateModel(obj, schemaPath)`.
- `lib/viewer/c4-hologram.html` — the interactive viewer (swappable skins).
- `lib/viewer/control-room.html` — the Control Room shell `forma room` composes into: a briefing in
  reading order at `#/`, with five views per programme nested under it (`exec`, `tech`, `map`,
  `wbs`, `docs`) and an `options` view, all in one file. Flat tabs were built, measured and
  rejected (ADR-0005); ADR-0007 records why views returned one level down instead. Three seams get
  filled at compose time: the room JSON, the locale tables and the inlined explorer.
- `lib/viewer/strings/{en,it}.json` — the Control Room's locale tables. Out of the template because
  at seven views they were the largest thing in it. `npm test` checks parity AND that the template
  actually reads every declared key.
- `scripts/` — `lint.mjs` (zero-dep lint), `check-clean.mjs` (prepack `.fuse_hidden` guard),
  `presentable.mjs` (viewer publication gate), `room-presentable.mjs` (briefing publication gate).
- `test/` — `run.mjs` runs `init→gen→check` across the fixtures; `stub-gh.mjs` stands in for the
  `gh` CLI so `verify` is tested offline.

## Working on Forma

- No runtime deps, no build step. Run gates with `npm run lint` and `npm test`.
- `gen` and `check` never touch the network. `verify` (gh) and `gen --enrich` (LLM) are the only
  networked paths, both opt-in — keep it that way.
- The viewer is one HTML file in ES5 style (var/function); every new UI string goes in BOTH
  locales of `STRINGS`.
- `npm pack --dry-run` must stay clean of editor residue — zero `.fuse_hidden`. That much the
  `prepack` guard does enforce; it does **not** check the file count. This line used to claim a
  count of 20 and claim the guard held it: the selection is 36 today, and the number has moved
  several times unnoticed. Bump it deliberately or enforce the intended list mechanically — see
  the open item in [`docs/SCOPE-room.md`](docs/SCOPE-room.md) §6 and the defect row in
  [`docs/DELIVERY.md`](docs/DELIVERY.md).
- Architecture of Forma itself is modeled with Forma: see `docs/architecture/`
  (the dogfood). `forma check` fails if that model drifts from the code.
- Conventional commits; keep history clean (squash merge on `main`).

## GitHub best practices in effect

- Actions pinned to commit SHAs (`ci.yml`, `release.yml`); least-privilege `permissions`.
- `concurrency` + `timeout-minutes` on workflows; `CODEOWNERS` review requests.
- `release.yml` publishes to npm via OIDC trusted publishing + provenance (tag `v*`).
- Branch protection on `main` (require CI green). See [`SECURITY.md`](SECURITY.md),
  [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).