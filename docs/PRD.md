---
title: 'Forma — product requirements'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'prd'
tags: ['audience/dev', 'kind/ssot']
related: ['docs/DESIGN.md', 'docs/DELIVERY.md']
---
# Forma — product requirements

Status: living document. Supersedes nothing; it states what the other documents assume.

## 1. The problem

An architecture diagram is wrong the day after it is drawn, and nobody finds out. The slide keeps
being shown, the wiki page keeps being linked, and the gap between the picture and the code grows
until the picture is worse than nothing, because people still act on it.

Every existing cure asks for discipline: update the diagram when you change the code. Discipline
does not scale past the second sprint.

The same failure has a second, worse form. A programme status board (percent complete, green
boxes, burn-up) is assembled by hand from what people believe. Nobody can re-derive it, so nobody
can falsify it. A number that cannot go red is not a measurement, it is an inventory.

## 2. What Forma is

A zero-dependency Node CLI that reads a codebase and produces two things:

1. an interactive C4 architecture explorer, generated from the code rather than drawn;
2. a Control Room: a portfolio briefing over one or more programmes, built only from facts that
   can be re-derived offline.

And, holding both honest, a deterministic gate (`forma check`) that fails loudly when any of it
stops matching the code.

The product is not the picture. The product is **the picture plus the reason to believe it.**

## 3. Who it is for

| User | What they need | What they get |
|---|---|---|
| The engineer who owns a system | to explain it without maintaining a diagram | an explorer generated from the code, and a gate that fails in CI when it drifts |
| The person deciding what to do next | to know what actually needs them, across everything they run | a briefing that ranks the few open items and cites the evidence for each |
| An AI agent driving the tool | a contract it can hold, not a UI it must guess | documented JSON and Markdown files; every command is a plain Node script |
| A reviewer or stakeholder | to trust a claim without reading the code | every claim on screen carries a citation that resolves |

Forma is model-agnostic on purpose: no agent, model or vendor is required. A human with no AI can
drive every command, and an agent drives the same contract.

## 4. The one requirement everything else serves

> Every number, verdict, cluster and colour on screen must be re-derivable from raw inputs by an
> offline command, and that command must fail when the artifact disagrees.

Consequences, all of them binding:

- **Code proves existence, never completion.** Walking `src/` tells you a file is there. It does
  not tell you the feature works. Forma refuses to derive a completion percentage from structure.
- **Unknown is a value.** A node nobody ruled on stays `unknown` and renders as a blank, never as
  a zero and never as a green.
- **A declaration is not a measurement.** A document saying "done", or a closed issue, is a claim
  someone made. Forma may show it, labelled as what it is, but the publication gate refuses a
  percentage whose only provenance is a declaration.
- **No colour without a reason.** A verdict carries a `why` and at least one evidence reference
  that resolves, or it is rejected at write time.
- **Silence is a defect.** A cap, a truncation, an excluded commit or a dropped document is
  counted and named. Anything the tool leaves out, it says out loud.

## 5. Scope

**In scope.** Generating the model from code; curating it through documented JSON; deriving state
from the repository's own capability tables; refreshing issue state from GitHub; linking issues to
code through git; composing a portfolio briefing; and gating all of it.

**Out of scope, deliberately.**

- Runtime dependencies. Ever. This is a hard constraint, not a preference (ADR-0001).
- Any network access outside `forma verify` and the opt-in `gen --enrich`.
- Inventing programme state. What no document, issue or commit names stays unknown.
- Project management. Forma reads issues, it does not manage them.
- Being a diagram editor. The layout serves reading, not drawing.

## 6. How each requirement is verified

A requirement with no command behind it is a wish. Each of these is runnable.

The `id` column is not decoration. It is the first link of the traceability chain `lib/rtm.mjs`
reads: a requirement here is satisfied by a decision in [`DESIGN.md`](DESIGN.md), proved by a row in
[`DELIVERY.md`](DELIVERY.md), and worked by GitHub issues. Where a programme's manifest declares an
`rtm` block, `forma check` fails on a requirement that lands on nothing and on open work no
requirement claims — which is the only way "the issues are the whole of the work" can be checked
rather than asserted.

| id | requirement | verified by |
|---|---|---|
| R-1 | the model matches the code | `forma check` re-walks `src/` and compares |
| R-2 | the model matches its own contract | `validateModel` against `lib/schema/c4-model.schema.json`, run inside `gen` and `check` |
| R-3 | a generated document does not drift | `check` re-renders the governed block and compares |
| R-4 | a derived state still derives | `check` recomputes from the source document and fails if the row is gone |
| R-5 | the artifact is worth projecting | `scripts/presentable.mjs`, five predicates |
| R-6 | the briefing keeps its promises | `scripts/room-presentable.mjs`, including a byte-identical re-render |
| R-7 | a verdict is anchored | `applyVerdicts` refuses an unresolvable reference; `check` re-checks on disk |
| R-8 | the whole thing still works | `npm test`, fixtures driven through the real CLI |
| R-9 | a requirement lands on work, and no work is unclaimed | `forma check` with an `rtm` block declared; `npm test`, the `rtm` block |

## 7. What success looks like

Forma is succeeding when a stranger can clone a repository, run three commands, and get a picture
they can defend in a meeting; and when the person who runs it every day opens the briefing and
learns something they did not already know, in the first ten seconds.

It is failing, regardless of how it looks, the moment a number on screen cannot be traced back to
something a machine can check.

## 8. Related documents

Read [`docs/README.md`](README.md) for the reading order.
