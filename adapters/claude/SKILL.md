---
name: forma
description: Set up or refresh the Forma architecture explorer + anti-drift gate for a repo. Runs the stack-agnostic Forma CLI (init/gen/check/doc/serve); any model can drive it.
---

Forma's engine is a plain Node CLI — this skill is a thin adapter, not the product.

1. `npx forma-arch init` — seed `docs/architecture/c4-topology.json` from the repo's top-level source dirs (best-effort; then curate groupings + descriptions).
2. `npx forma-arch gen` — walk `src/` leaves + derive container edges from real code references → `c4-model.json`.
3. `npx forma-arch check` — deterministic anti-drift gate (fails if the model no longer matches code). Wire into the repo gate.
4. `npx forma-arch doc` — project the arc42 scaffold from the model (deterministic sections filled; prose sections stubbed for a human/agent).
5. `npx forma-arch serve` — open the live explorer.

The file contract is `lib/schema/c4-model.schema.json`. Enrichment (curate topology, write the arc42 prose) is model-agnostic: any agent edits the same JSON/Markdown.
