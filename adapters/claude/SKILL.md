---
name: forma
description: Set up or refresh the Forma architecture explorer + anti-drift gate for a repo, and compose/update its Control Room dashboard. Runs the stack-agnostic Forma CLI (init/gen/check/doc/serve/verify + room init/update); any model can drive it.
---

Forma's engine is a plain Node CLI — this skill is a thin adapter, not the product.

1. `npx forma-arch init` — seed `docs/architecture/c4-topology.json` from the repo's top-level source dirs (best-effort; then curate groupings + descriptions).
2. `npx forma-arch gen` — walk `src/` leaves + derive container edges from real code references → `c4-model.json`.
3. `npx forma-arch check` — deterministic anti-drift gate (fails if the model no longer matches code). Wire into the repo gate.
4. `npx forma-arch doc` — project the arc42 scaffold from the model (deterministic sections filled; prose sections stubbed for a human/agent).
5. `npx forma-arch serve` — open the live explorer.

**If boxes are still empty after `gen`** (nodes with `descSource: "fallback"`), you are the LLM — write the prose yourself, do not call one:

1. `npx forma-arch gen --enrich --enricher agent` — writes `docs/architecture/enrich-plan.json` with one entry per hole. No network, no API key.
2. Read the plan. For each entry write ONE sentence (max 18 words) saying what the module does — open the source file the prompt names when you are not sure. Save them as `docs/architecture/enrich-fill.json`: `{"fills":[{"id":"<entry id>","func":"<your sentence>"}]}`.
3. `npx forma-arch gen --enrich-apply docs/architecture/enrich-fill.json` — applied with provenance (`descSource: "llm"` + hash), preserved across later regens.

Do **not** use `--enricher anthropic|openai|ollama` from inside an agent session: those exist for headless/CI runs, need an API key or a local model, and cannot read the repo the way you can.

The file contract is `lib/schema/c4-model.schema.json`. Enrichment (curate topology, write the arc42 prose) is model-agnostic: any agent edits the same JSON/Markdown.

## Control Room (the project dashboard)

Forma also composes a **Control Room** — one self-contained HTML dashboard over one or more programmes, generated from the same model plus a live `gh` issue snapshot and optional audit overlays. Two verbs drive it; both are thin orchestrators over the engine, zero-dep, any model can run them.

1. `npx forma-arch room init --repo . --today <YYYY-MM-DD>` — seed/refresh `forma.room.json` for this repo (derives `ghRepo` from the git remote, wires the model if present, sets the `today` determinism anchor). For several repos under one root: `room init --scan --root <dir> --today <YYYY-MM-DD>`. It never invents `today` and never clobbers a decision (`enabled`, taxonomy, blockedBy) already in the manifest. Follow the printed NEXT steps.
2. `npx forma-arch room update --manifest forma.room.json` — the **"aggiorna dashboard"** verb: re-pulls each programme's live GitHub snapshot via `verify` (the only networked step), then recomposes the HTML. `--skip-verify` recomposes from the snapshots already on disk (offline); `--gh-cmd`/`--limit` pass through to `verify`.

`check` re-derives every Control Room aggregate (KPIs, milestone rates, kanban buckets, RTM holes) from the raw inputs and **fails on drift** — a hand-edited number in the dashboard is a red gate, not a silent lie. Audit overlays follow the same rule: a health verdict with no anchored evidence is an error, never a colour without a reason. Manifest contract: `lib/schema/forma.room.schema.json`; overlays: `c4-health.schema.json`, `c4-findings.schema.json`, `c4-issues.schema.json`.
