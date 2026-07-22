# AGENTS.md — Forma source of truth for humans + AI agents

Forma (`forma-arch`, binary `forma`) is a zero-dependency Node ESM CLI that turns a
codebase into an interactive, stack-agnostic C4 architecture explorer and keeps it
honest with a deterministic drift check. Apache-2.0. See [`README.md`](README.md) and
[`PUBLISH.md`](PUBLISH.md) (release checklist).

## Layout

- `bin/forma.mjs` — CLI entry; dispatches `init | gen | check | doc | serve`.
- `lib/` — the engine: `init.mjs`, `gen.mjs`, `check.mjs`, `doc.mjs`, `serve.mjs`.
- `lib/schema/c4-model.schema.json` — the JSON contract (single source of truth for the model).
- `lib/viewer/c4-hologram.html` — the interactive viewer (swappable skins).
- `scripts/` — `lint.mjs` (zero-dep lint), `check-clean.mjs` (prepack `.fuse_hidden` guard).
- `test/` — `run.mjs` runs `init→gen→check` on `test/fixtures/mini`.

## Working on Forma

- No runtime deps, no build step. Run gates with `npm run lint` and `npm test`.
- `npm pack --dry-run` must stay at the 12 shipped files, zero `.fuse_hidden` (the
  `prepack` guard enforces this).
- Architecture of Forma itself is modeled with Forma: see `docs/architecture/`
  (the dogfood). `forma check` fails if that model drifts from the code.
- Conventional commits; keep history clean (squash merge on `main`).

## GitHub best practices in effect

- Actions pinned to commit SHAs (`ci.yml`, `release.yml`); least-privilege `permissions`.
- `concurrency` + `timeout-minutes` on workflows; `CODEOWNERS` review requests.
- `release.yml` publishes to npm via OIDC trusted publishing + provenance (tag `v*`).
- Branch protection on `main` (require CI green). See [`SECURITY.md`](SECURITY.md),
  [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).