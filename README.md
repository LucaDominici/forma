# Forma

**Present your architecture instead of slides.** Forma turns any codebase into an interactive,
stack-agnostic C4 explorer — big-picture → drill-down to the leaf — generated *from the code* and
kept true to it by a deterministic drift check. No more slide decks that lie the day after you draw
them.

Forma is the companion to `arbiter`: arbiter governs the process, Forma shows the system and
guarantees the picture matches reality.

## Why

A hand-drawn architecture diagram is stale the moment code changes. Forma walks your source for the
real structure, infers relationships from cross-references to exported symbol names (heuristic, additive), and **fails a check** when the model
and the code disagree. What you present is what actually exists.

## Install

```sh
npx forma-arch <command>        # or: npm i -D forma-arch
```

## Commands

| Command | What it does |
|---|---|
| `forma init` | Seed `docs/architecture/c4-topology.json` from your source dirs (best-effort; then curate) |
| `forma gen` | Walk `src/` leaves + derive container edges from cross-references to exported symbol names → `c4-model.json` |
| `forma check` | Deterministic drift check — **fails if the model no longer matches the code** |
| `forma doc` | Project the arc42 scaffold (`ARCHITECTURE.scaffold.md`) from the model |
| `forma serve` | Open the live explorer at `http://localhost:4173` |

## How it fits together

```
        code  ──►  forma gen  ──►  c4-model.json  ──┬──►  c4-viewer.html   (present / explore)
                                    (single source)  ├──►  ARCHITECTURE.md  (arc42, via forma doc)
                                                      └──►  forma check     (gate: model == code?)
```

One source of truth (`c4-model.json`); two renderings (the interactive viewer and the arc42 doc);
one deterministic check that keeps them honest. The file contract is
[`lib/schema/c4-model.schema.json`](lib/schema/c4-model.schema.json).

## Model-agnostic by design

The engine is plain Node — no LLM required. Structure is auto-walked, relationships are derived from
code, the check is deterministic. The only human (or agent) step is curating the topology groupings
and writing the arc42 prose — and *any* model can do that against the documented JSON/Markdown
contract. The Claude skill in `adapters/` is a thin wrapper, not the product.

## Skins

The viewer ships with swappable skins (`holo`, `blueprint`) via a dropdown or `?skin=`. Themes are
CSS variables; the engine is decoupled from the look.

## License

Apache-2.0. Not affiliated with C4 or arc42 — see [`NOTICE`](NOTICE).
