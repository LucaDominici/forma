---
title: 'Post-mortem — the Control Room branch'
doc_version: '1.0.0'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'postmortem-control-room'
tags: ['audience/dev', 'kind/analysis']
related: ['ROADMAP.md', 'docs/SCOPE-room.md', 'docs/technical-debt.md', 'docs/ISSUES_TO_OPEN.md']
---
# Post-mortem — the Control Room branch

Reverse-engineering of three things and an honest account of why `feat/control-room` stalled: what
Forma is today, what the hand-built CEREBRO v2 Control Room is, and what the branch built on the way
from one to the other. Written from the code and the branch's own docs, not from memory.

## 1. Forma today (main) — a single-view C4 explorer

Zero-dependency Node ESM CLI (`forma-arch`). One source of truth, two renderings, one gate:
`code → forma gen → c4-model.json → { c4 viewer | arc42 doc | forma check }`. Commands
`init/gen/check/doc/serve/verify`. The viewer (`lib/viewer/c4-hologram.html`) is **one** SVG C4
diagram you navigate by drilling — context → container → component → leaf — with a status overlay
(`c4-status.json`), an AS-IS→TO-BE timeline of typed checkpoint patches, and `verify` refreshing
issue state from live `gh`. `check` is deterministic, offline, and fails on drift, never SKIP. This
is excellent at *architecture* and has nothing to say about *programme state*.

## 2. The target — CEREBRO v2 Control Room

A hand-authored, self-contained HTML dashboard: **eight per-project tabs** (Executive, Coda/auto,
Hologram, C4 drill-down, Tavolo tecnico, WBS, Kanban, Segnalazioni) over **one deterministic dataset**
(`ISSUES`, `HEALTH{verdict,why}`, `MS_META`, `BLOCKS`). Its two cross-cutting encodings are AS-IS/TO-BE
(solid vs dashed) and health (a semaphore). Its unifying primitive is `pill(n)`: every issue reference
anywhere flows through one function, so colour = health and hover = the anchored reason, uniformly. Its
doctrine: *"every line comes from `gh`, from the code, or from an anchored audit — never from an agent's
mood"* and *"never a colour without a reason"*. It is the density and the honesty Forma should generate.

## 3. What the branch built (and it is real, tested work)

`feat/control-room` (34 commits, ~8,600 lines, `0.10.0 → 0.13.0`, still zero-dep) added a genuine
engine:

- **Commands** `forma scan` (discover programmes → manifest) and `forma room` (compose a self-contained
  HTML briefing). `verify` extended to always write a `c4-issues.json` snapshot.
- **A derivation core** (`roomderive.mjs`) — the only place aggregates are computed, pure, no clock:
  KPIs, milestones (closure rate, never "completion"), history reconstructed from one snapshot,
  kanban buckets, queue, commit drift, issue→code link, RTM.
- **Three overlays** (`c4-health` / `c4-findings` / `c4-issues` schemas) and a manifest
  (`forma.room.json`) that is explicitly multi-repo ("portfolio").
- **A real anti-false-green gate**: `check` re-runs every derivation from the raw inputs and fails on
  drift; `room-presentable.mjs` re-composes and byte-compares; RTM reports four falsifiable holes; an
  audit verdict without resolvable evidence is an error.

The core pipeline is coherent and end-to-end tested (`test/run.mjs` grew a full room block with
two-way tamper tests). **This is worth keeping.**

## 4. Why it didn't go great

1. **It solved a different problem than the one asked for.** ADR-0004 opens: *"A Control Room
   (multi-tab programme dashboard) was requested."* The branch built it, measured it against three
   real repos, judged it "answered the wrong question," and pivoted (ADR-0005) to a **portfolio
   briefing** — then ADR-0007 walked half of it back, re-nesting five per-programme views. **Three
   shapes in one unmerged branch** (8 tabs → 1 briefing → 1 briefing + 5N views), and the actually
   requested per-project control room never shipped.
2. **The pivot dropped the density.** Mapping the eight CEREBRO tabs onto what shipped: Executive →
   `exec`; Hologram → the `map` iframe; **C4 drill-down → dropped** (reduced to a checkpoint
   timeline); Tavolo tecnico → `tech`; WBS → `wbs`; **Kanban → watered to a six-number strip** (the
   board derivation computed but unrendered); **Coda/auto → folded away**; Segnalazioni → demoted to a
   panel. The **per-issue pill** became expandable `<details>` rows — no at-a-glance board where every
   issue wears its health.
3. **The flagship demo renders broken.** The published demo is forma's own repo — 8 issues, all
   closed — so the first screen reads *"0 things need you out of 0 open across 1 programmes"* and the
   RTM headline case shows **0 of 9** (UX-INVENTORY F1/F6). *"Truthful and unusable are not
   exclusive."*
4. **Governance overreach turned CI red.** The branch enrolled a one-committer, pre-1.0 tool in an
   enterprise "Gold Doc-Set" standard (GAMP 5 / 21 CFR Part 11 / ISO 27001 …), graded from a
   **private** sibling repo (`arbiter`). Because a public repo's CI cannot check out a private repo,
   **the docs gate is red** (debt D-7, commit `dc285fb`) — the governance apparatus is blocking the
   branch it governs. The standard it adopted literally carries an "anti-cathedral guardrail" the
   branch then ignored.
5. **The audit channel is half-built.** `lib/audit.mjs` (`auditPlan`/`applyVerdicts`) is never called
   by any command, script, or test — there is no `forma audit`. So `c4-health.json`/`c4-findings.json`,
   on which the whole anti-false-green narrative rests, have **no producer**. The USP is unwired.
6. **Most commits fix self-inflicted defects.** The trail is dominated by "N defects, M of them
   written by the previous round of fixes," a browser heap-death hang from a stray control character
   in foreign repo text, and repeated gate-green breaks — consistent with a design litigated against
   real repos several times, and with both gates having rotted silently ("green by absence") because
   each had been written against a shape the composer no longer produced.
7. **No external validation.** FEASIBILITY §3 / UX-INVENTORY: *"Not one person outside the author has
   used this. Every claim … is a hypothesis."*

The branch's docs are refreshingly honest about all of this — which is exactly why the failure is
recoverable rather than mysterious.

## 5. The call — salvage, re-center, right-size

Do **not** restart: the derivation-and-gate core is solid and tested, and restarting throws it away.
**Build on the branch**, and:

- **Re-center** on the per-project Control Room (CEREBRO parity) as the product; keep the portfolio
  engine as an optional roll-up, not the headline (ROADMAP endpoint).
- **Restore** the three dropped surfaces from derivations that already exist (Kanban, Coda/auto, the
  pill).
- **Wire** the audit channel (`forma audit`) so health/findings have a producer.
- **Right-size** governance and **decouple** the public repo from the private `arbiter` gate to get
  CI green.
- **Fix the demo** so it renders rich, and get **one external reader**.

This is R1→R5 in the roadmap; the concrete backlog is [`ISSUES_TO_OPEN.md`](docs/ISSUES_TO_OPEN.md).
