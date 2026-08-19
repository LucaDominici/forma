---
title: 'Scope — what "finished" means for the Control Room'
doc_version: '1.1.0'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'scope-room'
tags: ['audience/dev', 'kind/governance']
related: ['docs/SCOPE.md']
---
# Scope — what "finished" means for the Control Room

This document reopened the boundary closed by [`docs/SCOPE.md`](SCOPE.md) (v0.10.0,
*maintained*), which named "no new command" outside its own confine. It exists
because that one's §7 requires it before any such work proceeds. See
[ADR-0004](adr/0004-control-room-as-a-forma-rendering.md) for the shape of the decision.

Instrument: `scripts/room-presentable.mjs`, the same role `scripts/presentable.mjs` plays for
the single-lens viewer — it grades the rendered artifact, `forma check` grades adherence to the
code.

---

## 1. The definition of finished

> `forma room` generates one self-contained HTML briefing from a manifest of programmes — each a
> model + overlays + a `gh` snapshot — with no post-generation hand-editing; `forma check` exits 0
> on the same commit and fails on a deliberately altered aggregate, naming the programme and what
> drifted; `scripts/room-presentable.mjs` exits 0 on the generated artifact and fails on a missing
> evidence ref, an un-piled issue reference, or a non-deterministic re-render.

Two people running those three commands on the same inputs get the same three verdicts.

Both gates are exercised by `npm test` against `test/fixtures/room`, in both directions: they pass
on an untouched briefing and fail on one whose aggregates were altered by hand. That second half is
the part that was missing — each gate had been written against a shape the composer no longer
produced, so neither could run at all, and nothing in the suite would have said so.

### Success metric

A real work wave is reconciled successfully when fresh `verify` snapshots feed `room update
--skip-verify --counter` with no hand-edit to a snapshot or the generated HTML, the external result
covers the regenerated claims 1:1, `room-presentable` and `forma check` both exit 0, and no
contradicted claim remains unresolved. `unsupported` is not failure and never becomes green: it
must remain visible as an anchored warning. The 2026-08-17 five-programme dogfood met this metric
with 233/233 results, 40 held, 193 unsupported, and zero contradicted claims.

## 2. What "mirrors reality" means, operationally

The room's central claim — *deve essere uno specchio della realtà o è completamente inutile* — is
implemented as three separate, falsifiable channels, never one blended trust:

1. **Architecture** — the existing SSOT (`c4-model.json`), unchanged.
2. **Programme facts** — `gh` issues/milestones, fetched by `verify`, timestamped, never invented.
3. **The link between them** — issue → commit citing it → files touched → C4 node, derived from
   `git log`, not curated by hand and not inferred by an LLM. Coverage is partial by
   construction (haben: 69%, arbiter: 54%, viafera: 56%, measured on 2026-08-09) — the
   uncovered remainder reads `unknown`, never zero.

Everything colored, clustered, or prioritized on screen traces to one of those three, or it does
not render.

## 3. Inside the boundary (this round)

- `forma verify` gains a second output, `c4-issues.json`, additive and atomic with the existing
  model write.
- `forma room` composes one briefing in reading order — the verdict, what waits on you, what moves,
  what does not add up — with five views per programme nested under it (`exec`, `tech`, `map`,
  `wbs`, `docs`) and an `options` view, all in one file, addressed by hash route. Eight flat tabs
  (`exec`, `holo`, `c4`, `wbs`, `auto`, `kan`, `seg`, `tec`) were this document's original plan;
  they were built, measured across three programmes and rejected by
  [ADR-0005](adr/0005-portfolio-briefing-over-per-repo-dashboard.md), and
  [ADR-0007](adr/0007-views-nested-under-the-briefing.md) records why views came back one level
  down rather than in place of the briefing. Queue and Kanban remain complete derivations but are
  lazy, bounded evidence inside `tech`; legacy `/auto` and `/kanban` hashes redirect there.
- `forma scan` writes the programme list from a directory of checkouts, merging rather than
  replacing: `enabled: false` and every hand-curated field survive a re-run, and `today` is never
  invented.
- `forma room --serve` is the only path that writes anything: loopback, one field per programme,
  the manifest re-validated before the write (I18).
- The traceability chain (`lib/rtm.mjs`, [ADR-0006](adr/0006-traceability-as-a-derivation-not-an-overlay.md))
  turns the issue tracker into a WBS that can be checked: `forma check` fails on a requirement that
  lands on no work and on open work no requirement claims.
- `forma check` gains four assertions, all opt-in by presence.
- The audit channel (`c4-health.json`/`c4-findings.json`) is populated by the same
  plan-then-apply pattern `--enricher agent` already uses for description holes — never a
  network call, never an unattributed verdict.

## 4. Outside the boundary (this round)

- `c4-blocks.json` as a curated file — the `auto` tab derives its queue from
  issues×milestone×label until something is demonstrably uncoverable that way.
- Publishing the generated Control Room anywhere (Pages, `docs/demo/`, haben) — this round's
  artifact lives in scratch space for review.
- Any new language adapter, any new graph heuristic, any network path outside `verify`.

## 5. Decisions made (grilled with the owner, 2026-08-09)

| # | Decision | Chosen |
|---|---|---|
| 1 | Command shape | `forma room`, dedicated — not `gen --room` |
| 2 | Health overlay key | issue number, not node id — one node can carry several verdicts |
| 3 | Taxonomy detection | automatic (`name<sep>value` label families) + population threshold + manifest-only alias/rename/exclude — never semantic inference |
| 4 | Issue↔code link | git only (`#N` in commit subject → files → node) — no label-based or hand-curated second mapping |
| 5 | `holo` vs `c4` | AS-IS vs TO-BE via the existing `?checkpoint=` mechanism — not drill-depth (would touch the shipped viewer) |
| 6 | Async audit | evidence-gated agent fills (`auditPlan`/`applyVerdicts`), reusing the `enrich.mjs` pattern — no bare LLM prose |
| 7 | Dogfood target | personal GitHub checkouts under the declared scan root; local-only and nested work checkouts stay outside because they cannot produce the required personal `gh` fact base |
| 8 | Dogfood output | scratch space only — snapshots and the composed briefing are not committed to target repositories |

## 6. Open (not this document's to close)

- **Disclosure.** A published Control Room exposes issue titles, labels, and milestones from the
  target repo — richer than the package-name disclosure `docs/SCOPE.md §6.1` already approved for
  `haben`. Not decided; blocks publishing, not building.
- **Shipped-file count.** `AGENTS.md`/`scripts/check-clean.mjs` name a number that grows once
  `room.mjs` and friends are committed for real. Needs a deliberate bump, not a silent one.

## 7. After the boundary

Undecided — this document does not itself define a stage-5 *maintained* state, because it opens
one confine while `docs/SCOPE.md` still governs the rest of the product.

---

## 8. What this does not claim

- **Freshness is not verifiable offline.** `c4-issues.json` carries `fetchedAt`; nothing in
  `check`/`room-presentable` can know whether the live repo has moved since. They can only refuse
  a snapshot that is missing, malformed, or older than the manifest's `staleAfterDays` — never
  confirm it is current.
- **`source.commit` drift is reported, not enforced to zero.** Forma's own dogfood model already
  disagrees with `main` at the moment this document was written (`d9a0694…` vs `d5be89f`) because
  `gen` only runs on demand. The `tec` tab must say how many commits behind the architecture layer
  is; it is not required to be zero.
- **The brief is anchored judgement, not verified truth.** A claim is refused without a subject and
  evidence that resolves, and a risk or a decision must cite something that can move — but whether the
  sentence is *about* the evidence it cites is not decidable by code. That relevance is a second model's
  verdict, which is why a claim carries colour only under a fresh hostile `holds` and reads grey, saying
  so, the moment its anchor moves or the verdict ages. Grey is the honest default, not a failure.
- **Counter-verification validates coverage and anchors, not judgment.** The portfolio run covered
  every emitted claim and refused unresolvable evidence, but an agent result can still be wrong.
  This is why `unsupported` remains a visible warning instead of being coerced into green.
- **The taxonomy detector is pattern matching, not understanding.** It finds `name<sep>value`
  label families and a population threshold; it does not know that `priority:p2` and
  `priority:P2` mean the same thing unless the manifest says so.
