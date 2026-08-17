---
title: 'Issues to open'
doc_version: '1.0.0'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'issues-to-open'
tags: ['audience/dev', 'kind/planning']
related: ['ROADMAP.md', 'docs/POSTMORTEM-control-room.md', 'docs/technical-debt.md']
---
# Issues to open

Ready-to-open backlog, grouped by the [roadmap](ROADMAP.md) releases. Each item is titled as it would
be filed, with **why**, a falsifiable **DoD**, and labels. Anchored to the branch's own technical
debt (D-1…D-8) and the post-mortem findings. Nothing here infers work from a mood — every item names
the file, gate, or measured fact it comes from.

Suggested labels: `release:R1..R5`, `area:room|audit|viewer|ci|docs|cli`, `kind:bug|feat|chore|debt`,
`needs-luca` (a decision only the owner makes).

---

## R1 — Unstall / green baseline

**R1-1 · Decouple the public docs gate from the private `arbiter` checkout**
`area:ci kind:bug release:R1 needs-luca` — Why: CI is red because a *public* repo grades its docs from
a *private* sibling; the workflow's default token cannot check `arbiter` out (debt D-7, commit
`dc285fb`). DoD: `docs-gate` runs green on a fork/clean clone with no private credentials, or is
removed from the required set; decide via `needs-luca` whether to vendor a minimal check (respecting
ADR-0001) or drop enterprise grading (see R1-6).

**R1-2 · Replace "public demo" with a dogfood cockpit over the owner's repos**
`area:room kind:feat release:R1` — Why: the empty-demo problem (forma itself, 8 closed issues → "0 of
0"; F1/F6/D-6) is retired by changing the question — validation is dogfood, not a published page. DoD:
`room init --scan --root ~/Developer` seeds a manifest over the local portfolio; `room update` composes
a briefing that renders rich because the complex in-progress repos carry open work. No public demo
target is chosen; the artifact stays local (SCOPE-room §6 unchanged).

**R1-3 · Wire or quarantine `lib/audit.mjs`**
`area:audit kind:debt release:R1` — Why: `auditPlan`/`applyVerdicts` are dead code; the health/findings
producer does not exist. DoD: either a tracking issue links it to R3 and the module is marked
experimental, or it is removed until R3 — no shipped dead code claiming a channel that has no producer.

**R1-4 · Prune superseded doc/schema archaeology (ponytail)**
`area:docs kind:chore release:R1` — Why: `c4-findings.schema.json` still describes a `seg` field from
superseded ADR-0004; ADR-0004 front-matter (`active`) contradicts its body ("Accepted"); `SCOPE-room.md`
is `status: open` for shipped work. DoD: each superseded reference removed or corrected; a grep for
"superseded"/"seg" in schemas returns nothing stale.

**R1-6 · Right-size governance to the solo tier**
`area:docs kind:chore release:R1` — Why: enterprise grading (D-03) + `arbiter` coupling (D-04/D-07) is
cathedral-building the adopted standard's own "anti-cathedral guardrail" warns against (owner decision:
drop to **solo**). DoD: `tier_floor: solo` in `standards/doc-profile`; D-03 row updated; `GOVERNANCE.md`
no longer claims the enterprise column; CI no longer red for a governance reason.

## R2 — Per-project parity with CEREBRO

**R2-1 · The per-issue pill, everywhere**
`area:viewer kind:feat release:R2` — Why: health became expandable `<details>` rows; there is no
at-a-glance board where every issue wears its verdict + reason. DoD: one `pill()`-equivalent primitive
(glyph+word+colour+why) rendered on every issue reference across views.

**R2-2 · Reinstate a C4 drill-down surface (not only checkpoints)**
`area:viewer kind:feat release:R2 needs-luca` — Why: the C4 L1→L4 drill tab was dropped for a checkpoint
timeline. DoD: the map view exposes level drill-down again, or `needs-luca` ratifies that the embedded
hologram's own drill is sufficient.

## R3 — Audit channel + agentic counter-verification (Codex)

**R3-1 · `forma audit` — an evidence-gated health/findings producer**
`area:audit kind:feat release:R3` — Why: overlays have no producer (post-mortem §4.5). DoD: `forma audit`
emits an offline plan (enrich doctrine), an agent fills verdicts, `--apply` validates and writes
`c4-health.json`/`c4-findings.json`; every verdict carries a resolvable evidence ref.

**R3-2 · Counter-verification plan — the claims a briefing makes, machine-readable**
`area:audit kind:feat release:R3` — Why: the deterministic gate proves internal consistency, not truth
(ROADMAP §Counter-verification). DoD: `forma audit --plan` emits, per claim (`done` node, health verdict,
milestone rate, "waiting on a human" flag), an entry naming the claim and where to look (files/commits/gh);
the plan is deterministic and offline.

**R3-3 · Independent agent runner, default Codex**
`area:audit kind:feat release:R3 needs-luca` — Why: the check must be adversarial and independent — a
different engine than may have produced the work. DoD: the plan is executed by an agent that returns, per
claim, `holds|contradicted|unsupported` + an anchored reason; the runner is model-agnostic with **Codex**
(OpenAI) the default, wired like `--enricher`; a contract test uses an offline stub. Decide the exact Codex
entry point (CLI vs API) — `needs-luca`.

**R3-4 · Ingest verdicts, gate, and colour the pill**
`area:audit kind:feat release:R3` — Why: close the loop reality → pill. DoD: `--apply` validates agent
verdicts (evidence must resolve), a `contradicted` claim turns the pill red with the agent's reason as its
"why", `check` fails on an unresolved verdict, and re-derivation equality still holds.

**R3-5 · Automatic contoverifica on update / unattended**
`area:audit kind:feat release:R3` — Why: it must run without being asked (dogfood leans on it). DoD:
`room update` optionally runs the counter-verification per active programme; a documented recipe runs it
unattended (scheduled) and surfaces contradictions in the briefing.

## R4 — init/update GA + parametricity

**R4-1 · `verify` refreshes a snapshot without requiring a model**
`area:cli kind:feat release:R4` — Why: `verify` fails if `c4-model.json` is absent, so map-less programmes
cannot refresh via `room update` (found while building `room update`). DoD: `verify --no-model` (or auto)
writes `c4-issues.json` with no model present; `room update` refreshes every active programme.

**R4-2 · Harden `room init` / `room update`**
`area:cli kind:feat release:R4` — Why: delivered as thin orchestrators; need tests + edge cases. DoD: unit
coverage for seed/merge/`--scan`/`--today` and verify-then-compose; `--skip-verify` path tested; a
map-less programme handled cleanly.

**R4-3 · Prove parametricity on a second repository**
`area:room kind:feat release:R4` — Why: one repo has driven the pipeline; parametricity is unproved
(DELIVERY). DoD: a second real repo produces a coherent Control Room by changing only the manifest, with
`check` green.

**R4-4 · Skill drives init + update**
`area:docs kind:chore release:R4` — Why: the adapter now documents both verbs; a run should exercise them.
DoD: the Claude skill runs `room init` then `room update` on a target and links the output.

## R5 — Dogfood across the portfolio, then freeze

**R5-1 · Onboard the whole home-machine portfolio**
`area:room kind:feat release:R5` — Why: validation is dogfood across real repos, the complex in-progress
ones included. DoD: every intended repo is in one manifest (`room init --scan`), each with a snapshot and,
where curated, a model; `room update` composes one briefing over all of them and `check` is green.

**R5-2 · Counter-verification runs green (or honestly red) across the portfolio**
`area:audit kind:feat release:R5` — Why: the contoverifica is the load-bearing quality gate now. DoD: R3
runs per programme over the portfolio; contradictions surface as red pills with anchored reasons; a run is
recorded as the dogfood evidence that replaces "one external reader".

**R5-3 · A success metric**
`area:docs kind:chore release:R5 needs-luca` — Why: named as owed, never defined (UX-INVENTORY). DoD: one
measurable dogfood success condition written into `SCOPE-room.md` and checkable (e.g. "a wave of work is
reconciled by `room update` with zero hand-edits and zero counter-verification contradictions").

**R5-4 · Freeze `schemaVersion` and cut 1.0**
`area:cli kind:chore release:R5` — Why: pre-1.0 is the honest signal until the contract is exercised. DoD:
R5-1 done (a second+ repo has driven the pipeline), all mandatory gates seen to fail and pass → freeze
schema, tag, npm.

## Carried debt (open regardless of release)

D-1 shipped-file count unenforced · D-2 `docmap` prefix false-alive · D-3 every view in the DOM at load
(unmeasured at portfolio scale) · D-4 RTM `issues` column maintained by hand · D-5 `coverageOf` returns
0% on an empty population · D-8 layout floor measured, not gated. File each as `kind:debt` when its
trigger fires; do not pre-emptively build.
