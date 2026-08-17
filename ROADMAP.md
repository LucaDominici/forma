---
title: 'Roadmap'
doc_version: '2.0.0'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'roadmap'
tags: ['audience/dev', 'kind/governance']
related: ['docs/SCOPE.md', 'docs/SCOPE-room.md', 'docs/technical-debt.md', 'docs/POSTMORTEM-control-room.md', 'docs/ISSUES_TO_OPEN.md']
---
# Roadmap

Forward-looking and deliberately short. Everything here is either already blocking something or has
a named trigger. What "finished" means for a round of work stays in [`SCOPE.md`](docs/SCOPE.md) and
[`SCOPE-room.md`](docs/SCOPE-room.md); the honest account of how the Control Room branch stalled is
in [`POSTMORTEM-control-room.md`](docs/POSTMORTEM-control-room.md), and the concrete backlog is
[`ISSUES_TO_OPEN.md`](docs/ISSUES_TO_OPEN.md). This document says where Forma is going and, more
usefully, what has to be true first.

## The endpoint — what Forma is for

> **One command turns any repository into a living, self-checking Control Room — architecture +
> programme state + audit — that cannot show a false green, regenerated from `gh` and the code,
> model-agnostic and zero-dependency.**

The reference for "rich enough" is the hand-built CEREBRO v2 Control Room: eight dense per-project
lenses (Executive, Coda/auto, Hologram, C4 drill-down, Tavolo tecnico, WBS, Kanban, Segnalazioni)
over one deterministic dataset, every issue wearing a health pill with an anchored reason. Forma's
job is to *generate* that class of artifact from the engine, not to have it cut by hand each time.

**Per-project depth is the richness bar; the portfolio roll-up is how it is consumed.** For this
owner the portfolio is not a demo to justify — it is the **daily dogfood cockpit over every repo on
the home machine**, several of them large and in-progress. So `derivePortfolio`/`scan` are
first-class, and per-project density (R2) is exactly what the complex repos need one level down. The
`feat/control-room` branch's mistake was not building the portfolio; it was building it *before* the
single-repo view was as rich as CEREBRO, and wrapping it in enterprise governance. See the
post-mortem for the full reasoning.

**Validation is dogfood, not a public demo.** "Finished enough" is measured by Forma running across
the owner's real portfolio and the briefing surviving contact with the person who knows those repos
— not by a stranger reading a published page. This retires the empty-demo problem by changing the
question, and makes the counter-verification below the load-bearing quality mechanism.

## Highest ROI — where the leverage is

Ranked by value-over-cost, anchored to what the branch measured about itself:

1. **Un-stall the branch (R1).** CI is red because a public repo grades its docs from a *private*
   sibling (`arbiter`, debt D-7); the flagship demo renders empty ("0 things need you out of 0
   open"); four derivations are gated but unrendered. None of this is new features — it is removing
   the reasons the work cannot ship. Highest ROI because everything downstream is blocked on it.
2. **Per-project density (R2).** Restore the three surfaces the pivot dropped — the Kanban board,
   the Coda/auto queue, and the per-issue pill — reusing `deriveKanban`/`deriveQueue`, which are
   *already computed and gated with no surface reading them*. Near-free richness the reader actually
   asked for.
3. **Audit channel + agentic counter-verification (R3).** `lib/audit.mjs` exists but nothing calls
   it, so the anti-false-green health/findings channel — Forma's real differentiator — is half-built.
   Wiring it *and* driving it with an independent agent (Codex) is the highest-leverage feature: it
   is the only thing that checks the dashboard against reality, not just against its own inputs.
4. **`room init` / `room update` + dogfood parametricity (R4).** The two verbs that make the dashboard
   repeatable and cross-repo (delivered as thin orchestrators; harden them and onboard the portfolio).
5. **Dogfood across the whole portfolio (R5).** Run Forma over every home-machine repo, the complex
   in-progress ones included, and let the briefing survive contact with the person who knows them.
   This is the validation that a pre-1.0 tool actually needs.

## Releases — an agile ladder, each rung green and demoable

Semver continues from the branch (`0.13.0`). Every release is a vertical slice that is CI-green,
demoable on a real repo, and closes one named failure. Detailed acceptance lives in the issues doc.

| Release | Theme | Definition of Done |
|---|---|---|
| **R1 · 0.13.x** | **Unstall / green baseline** | CI green on a clean clone with **zero private dependencies** (decouple the doc-gate from `arbiter`, D-7); governance right-sized to the **solo** tier (D-03); docs describing rejected shapes pruned (ponytail); `lib/audit.mjs` either wired or quarantined with a tracking issue; `forma check` + full suite green. |
| **R2 · 0.14** | **Per-project parity with CEREBRO** | Kanban board, Coda/auto queue and the per-issue **pill** restored as first-class per-programme surfaces from the existing `deriveKanban`/`deriveQueue`; AS-IS/TO-BE kept via checkpoints; `room-presentable` passes on the **rich** state, not a cleaned/empty copy. |
| **R3 · 0.15** | **Audit channel + agentic counter-verification (Codex)** | `forma audit` produces `c4-health.json` / `c4-findings.json` via the enrich doctrine (offline plan → **independent agent verifies against the repo/gh** → validated apply); health drives pill colour end-to-end; "no colour without an anchored why" enforced by `check`; the agent step is model-agnostic and defaults to Codex (see §Counter-verification). |
| **R4 · 0.16** | **init/update GA + dogfood onboarding** | `room init` / `room update` hardened; `verify` refreshes a snapshot **without requiring a model** (map-less programmes); one command onboards a tree of repos (`room init --scan`) into one manifest; the Claude skill drives init + update. |
| **R5 · 1.0** | **Dogfood across the portfolio, then freeze** | Forma runs over **every home-machine repo** (complex/in-progress included); the counter-verification runs automatically per programme and its verdicts are recorded; the owner has used the briefing on real work; governance is solo-tier; `schemaVersion` frozen; npm release. |

## Counter-verification — deterministic gate + independent agent

Forma already has two **deterministic** checks, and they are necessary but not sufficient:

- `forma check` re-derives every aggregate from the raw inputs and fails on drift — it proves the
  dashboard is **internally consistent** with its own snapshot.
- `room-presentable` re-composes and byte-compares — it proves the build is **reproducible**.

Neither proves the dashboard is **true**. A snapshot can be internally consistent and still say a
node is `done` that is not, or carry a health verdict whose evidence does not actually support it.
That gap is exactly what the CEREBRO Control Room closed by hand with an "avvocato del diavolo" pass.
The plan makes that pass **automatic and independent**:

1. **Forma emits a counter-verification plan** (extends the audit-plan seam): for each claim the
   briefing makes — a `done` node, a health verdict, a milestone rate, a "waiting on a human" flag —
   a machine-readable entry naming *the claim* and *where to look* (files, commits, gh issue).
2. **An independent agent executes it** — defaulting to **Codex** (OpenAI), deliberately a *different*
   engine than the one that may have produced the work, so the check is adversarial, not a model
   grading itself. The agent reads the real repo and `gh` state and returns, per claim, a verdict
   (`holds` / `contradicted` / `unsupported`) with an **anchored reason** (`file:line`, commit, issue).
3. **Forma validates and gates the result** — the same discipline as every overlay: a verdict with no
   resolvable evidence is an error, and a `contradicted` claim turns the pill red with the agent's
   reason as its "why". Nothing is trusted because an agent said so; it is trusted because the
   evidence it cites resolves.

This stays true to the invariants: the engine is deterministic and offline; the agent step is opt-in,
model-agnostic (Codex by default, any agent by contract, exactly like `--enricher`), and produces a
*plan and verdicts*, never a number Forma then trusts blindly. It is the automatic "contoverifica"
the dogfood strategy leans on — run per programme on `room update`, or unattended in a scheduled job.

## Ponytail — what was pruned, and what is queued to prune

Living docs, tight tail: superseded content is cut, not archived in place. Done in this revision, and
tracked in [`ISSUES_TO_OPEN.md`](docs/ISSUES_TO_OPEN.md) where a code change is needed.

- **Pruned now:** the portfolio-first framing of this roadmap (replaced by the per-project-first
  endpoint above); the pre-1.0 section that made portfolio parametricity the gate to 1.0.
- **Queued (R1):** `lib/schema/c4-findings.schema.json` description still explains a `seg` field
  "back when the room filed its content into tabs (ADR-0004, superseded by ADR-0005)" — schema prose
  carrying dead design. ADR-0004 front-matter says `status: active` while its body says "Accepted".
  `docs/SCOPE-room.md` is still `status: open` for shipped work.
- **Decided (R1):** governance drops from the enterprise tier to **solo** (D-03 updated), and the
  `arbiter` coupling (D-04/D-07) that turned CI red is removed or made self-contained — over-scoped
  for a one-committer, dogfood-first tool. `GOVERNANCE.md` and `standards/doc-profile` follow.

## Not planned

Refusals, recorded so the question is asked once.

- Runtime dependencies ([ADR-0001](docs/adr/0001-zero-dependency-esm.md)).
- Network access outside `forma verify` and the opt-in `gen --enrich`.
- Inferring architecture, requirements or traceability from prose. Forma measures declarations; a
  model guessing which requirement an issue belongs to is the invented number this product refuses
  ([`PRD.md`](docs/PRD.md) §4).
- Becoming a project-management tool. Forma reads an issue tracker; it does not write to one.
- Becoming a diagram editor. The layout serves reading, not drawing.
