---
title: 'ADR-0001: Zero-dependency Node ESM CLI'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: '0001'
tags: ['audience/dev', 'kind/adr']
related: ['docs/adr/README.md']
---
# ADR-0001: Zero-dependency Node ESM CLI

- **Status:** Accepted (2026-07-22)
- **Decider:** Luca Dominici

## Context
Forma walks a codebase and emits/verifies a C4 model. Adopters run it via `npx` or `npm i -D`.
Every runtime dependency is supply-chain surface and review burden for a tool that reads source.

## Decision
Ship Forma as a zero-runtime-dependency Node ESM package. Use only Node builtins. No build step.

## Consequences
- + Trivial adoption, tiny review surface, no network in the core commands.
- + No drift between bundled and source behaviour.
- − We hand-roll what a dep would give (schema validation is minimal; the engine walks source
  with regex, not a parser) — acceptable for a C4 explorer, not a compiler.