---
title: 'Delivery status'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'delivery'
tags: ['audience/dev', 'kind/audit']
related: ['docs/PRD.md', 'docs/technical-debt.md']
---
# Delivery status

This file records realization status for the Control Room branch. A feature is listed as proven only when a named command or recorded measurement can falsify it. Built code without that evidence stays in the next section.

## What is shipped and proven

| Claim | Proof command or recorded check | Why the proof is relevant |
|---|---|---|
| The public CLI dispatches `init`, `gen`, `check`, `doc`, `serve`, `verify`, `scan`, and `room`. | `node bin/forma.mjs --help` | The dispatcher is the package entry point, so this proves the installed command surface ([`bin/forma.mjs:15-38`](../bin/forma.mjs#L15-L38)). |
| The shipped JavaScript entry points parse. | `npm run lint` | This passes on the branch and checks 25 files through `node --check`. |
| Forma's own committed model is adherent to Forma's current source. | `node bin/forma.mjs check` | This passes on the branch and independently re-walks source, document facts, evidence, and optional artifacts. |
| The npm selection is clean of editor residue and includes the Control Room runtime files. | `npm pack --dry-run --json` | The prepack guard passes and the dry run lists `room.mjs`, `roomderive.mjs`, the four overlay or manifest schemas, and `control-room.html`. |
| The single-model public demo meets its five publication predicates. | `node scripts/presentable.mjs docs/demo/c4-model.json` | The suite grades the shipped model itself, not a cleaned copy ([`test/run.mjs:1407-1411`](../test/run.mjs#L1407-L1411)). |
| `verify` fetches a whole-programme issue and milestone fact base, detects likely truncation, and writes only after parsing. | `forma verify`, exercised offline by the `gh` stub inside `npm test` | The test reaches the verify block and reports it green before the later known failure; the write boundary is visible at [`lib/verify.mjs:55-84`](../lib/verify.mjs#L55-L84). |
| Issue-to-code linkage uses git history without a second curated map or an LLM. | `forma room`, then inspect the generated linkage coverage; re-run `forma check` | The same `link.mjs` and `roomderive.mjs` path feeds composer and checker, and coverage was measured on three real repositories. |
| The Control Room composer validates inputs, rejects truncated snapshots, and writes one self-contained HTML briefing. | `forma room --manifest <forma.room.json> --out <control-room.html>` | Composition is read-only over its inputs and embeds both the room data and sandboxed explorer ([`lib/room.mjs:36-65`](../lib/room.mjs#L36-L65), [`lib/room.mjs:89-106`](../lib/room.mjs#L89-L106)). |
| Room aggregates are not trusted from rendered markup, and the gate fails when they are altered. | `npm test` (the `room` block) | `check` re-derives every key of `deriveAll` per programme and compares it to the embedded machine-readable block; the test alters one aggregate by hand on both a mapped and a map-less programme and requires `check` to exit 1 naming the programme and the field ([`lib/check.mjs:226-278`](../lib/check.mjs#L226-L278)). |
| The publication instrument runs every predicate and compares a second render byte for byte. | `npm test` (the `room` block), or `node scripts/room-presentable.mjs --room <html> --manifest <json>` | The test runs the instrument against a freshly composed briefing and requires exit 0; determinism is asserted twice, once by the test comparing two renders and once by the instrument re-rendering from the same manifest ([`scripts/room-presentable.mjs:96-110`](../scripts/room-presentable.mjs#L96-L110)). |
| The briefing derives a programme that has no architecture model. | `npm test` (the `room` block) | A programme carrying only issues and git history still yields KPIs, milestones, Kanban buckets and a queue; the two map-dependent answers read `null`, never a measured zero ([`lib/roomderive.mjs:107-131`](../lib/roomderive.mjs#L107-L131)). |
| Audit verdicts and findings cannot be applied without resolvable evidence. | `forma audit --plan <plan.json>`, fill its contract, then `forma audit --apply <fill.json>` | Both overlays validate before either is replaced; paths must exist inside the repo, commits and issue refs must resolve, and unknown evidence types are rejected ([`lib/audit.mjs`](../lib/audit.mjs)). |
| Counter-verification starts from every truth claim the briefing exposes. | `forma audit --plan <plan.json>` | The deterministic plan names each done node, health verdict, milestone closure rate and open `needs-human` issue, plus the file, commit or GitHub location an independent agent must inspect; `npm test` exercises all four kinds. |
| Requirements trace to work, and the gate fails at both ends. | `npm test` (the `rtm` block) | The test edits the fixture's design document four ways — a duplicate id, a reference to nothing, a decision landing on no work, and open work no requirement claims — and requires `forma check` to exit 1 each time, naming the document and the line ([`lib/rtm.mjs`](../lib/rtm.mjs), [`lib/check.mjs`](../lib/check.mjs)). |
| The convention survives a document written by hand for prose reasons. | `npm test` (the `rtm-dogfood` block) | Forma's own `docs/PRD.md` §6 parses as nine traceable requirements, each carrying its verification and its source line, and parsing it twice gives an identical answer. |
| "Where we were" needs no stored history. | `npm test` (the `views` block) | The whole series is a count over `createdAt`/`closedAt` in one snapshot; a snapshot predating those fields derives `null` rather than a flat line ([`lib/roomderive.mjs`](../lib/roomderive.mjs)). |
| A checkpoint carries completion that was measured, not estimated. | `npm test` (the `views` block) | Completion is issue closure on the nodes the checkpoint patches; a checkpoint no issue reaches reads `null`, never 0%. |
| The document budget refuses rather than truncates. | `npm test` (the `views` block) | With a one-byte budget nothing is embedded and every canon document is listed with the budget as its reason. |
| Discovery never overturns a decision. | `npm test` (the `scan+serve` block) | A second `forma scan` over the same root leaves `enabled: false`, hand-curated fields and `today` untouched. |
| The served briefing writes the manifest and nothing else. | `npm test` (the `scan+serve` block), plus `forma room --serve` | It binds loopback only; the handler accepts one boolean per programme and re-validates the whole manifest before writing, so a rejected edit leaves the file byte-identical. |

`npm test` is green, with nothing skipped. It was not, and the reason is recorded under known defects below.

## What is built but not yet proven on a second repository

- The room manifest can describe multiple programmes and allows a programme to omit its model and topology. This is implemented and validated, but only `haben` has exercised the full mapped pipeline. `arbiter` and `viafera` have measured issue corpora but no curated Forma model, so manifest parametricity across independently curated architectures remains unproved ([`docs/SCOPE-room.md:51-59`](SCOPE-room.md#L51-L59), [`docs/SCOPE-room.md:106-108`](SCOPE-room.md#L106-L108)).
- Portfolio aggregation across programmes is built and was measured over three issue corpora. That proves counting and declared blocking rules, not that a coherent briefing can be produced for a second mapped repository by changing only the manifest.
- Automatic taxonomy detection was measured across three repositories. It remains syntactic pattern matching, so each new repository still needs review of aliases, exclusions, minimum population, and severity order.
- The evidence-gated health audit proves rejection mechanics. It does not prove that every human or agent verdict is substantively correct; the mechanism validates anchors, not judgment.
- Control Room publication is not proven. The generated artifact remains a review artifact, and no Pages or other deployment consumes it.

## What is deliberately not built, and why

- **A curated `c4-blocks.json`.** The automation queue is derived from issue, milestone, and label facts. A second file would duplicate those facts before a real unrepresentable case exists.
- **Automatic curation of a second repository model.** Grouping and naming architecture are human judgments. Treating curation as a code change would turn an unproved interpretation into apparent fact.
- **Semantic label understanding.** Taxonomy recognizes `name:value` and `name/value` families plus declared aliases. It does not guess that differently cased or differently named values are equivalent, because that would hide project-specific meaning.
- **A network path outside explicit fact or prose acquisition.** `verify` owns live GitHub facts. Optional enrichment owns only prose holes. Generation, checking, room composition, linkage, taxonomy, and audit application remain offline so repeated gates are deterministic.
- **Offline proof of snapshot freshness.** A snapshot can be well formed and within a declared age while GitHub has already changed. Only a new `verify` can refresh the fact base.
- **A zero-staleness requirement for `source.commit`.** The architecture layer is regenerated on demand. The room reports how many commits it is behind when resolvable, but does not fail merely because normal development moved HEAD.
- **Control Room publication.** Issue titles, labels, and milestones disclose more than package names. The disclosure decision is still open, so publication is blocked while local composition remains allowed ([`docs/SCOPE-room.md:74-80`](SCOPE-room.md#L74-L80)).
- **New language adapters or graph heuristics.** This scope extends rendering and evidence, not source-language analysis. Existing declared-language and fallback behavior remains unchanged.

## The measured numbers

All numeric entries in this table come from the seven branch commit messages or `docs/SCOPE-room.md`. No value is extrapolated.

| Measurement | Value | Source and meaning |
|---|---:|---|
| Real repositories in the portfolio measurement | 3 | `haben`, `arbiter`, and `viafera`, from the portfolio derivation commit. |
| Issues in that portfolio corpus | 4,141 | Whole-programme issue snapshots across those three repositories. |
| Open issues in that corpus | 53 | Count reported by the portfolio derivation commit. |
| Issues waiting on a human | 11 | Uses a declared rule per programme, never a global inferred label. |
| `haben` issue-to-code coverage | 69% | Issues with at least one linked modeled node, measured 2026-08-09. |
| `arbiter` issue-to-code coverage | 54% | Same definition and date. |
| `viafera` issue-to-code coverage | 56% | Same definition and date. |
| `haben` open issues in the worked audit | 5 | Scope caveat for the worked example. |
| `haben` open issues labeled `needs-human` | 4 of 5 | A judgment boundary, not a code-completeness claim. |
| `arbiter` truncation probe | 1,200 returned of 1,429 | Evidence that `gh --limit` can silently truncate. |
| `viafera` truncation probe | 1,200 returned of 2,246 | Same truncation defect on a larger corpus. |
| `viafera` issue JSON corpus | 1,079,693 bytes | Evidence that Node's former 1 MiB child-process buffer was insufficient. |
| Sweep commits excluded from issue attribution | 1% to 3% | Commits over the file threshold are named and counted but linked to no node. |
| Sweep-size p99 across measured repositories | 64 to 101 files | Supports treating broad sweeps as non-attributable changes. |
| Control Room routes | 2 + 5N | The composition contract: the briefing and the options view, plus five views per programme. Eight flat tabs were the ADR-0004 shape, replaced by ADR-0005 and re-nested by ADR-0007. |
| Control Room locale keys | 179 | At en/it parity, and every one read by the template — both halves asserted by `npm test`. |
| Control Room charts | 13 | Each chart has a table twin carrying the same numbers. |
| Generated Control Room artifact size | 975,986 bytes for three programmes | Measured on the generated portfolio briefing (haben, arbiter, viafera), architecture viewer embedded once. |

## Known defects, each with its evidence

| Defect | Evidence | Consequence |
|---|---|---|
| The `docmap-cap` check asserted against a repository outside this one. | It read a feature matrix from a sibling checkout of the demo's source repository, silently skipping when absent — so it was green by absence on every CI run and red on one machine. Its expectation had also gone stale: the rows it pinned are now declared not-done upstream, making `planned` the correct answer and the assertion the wrong party. | Resolved: the block is removed. The property it guarded (#43, the prose cap must not silence the verdict) is asserted on the committed `docmap` fixture, where `statusFor` runs the identical path — see the #43 comment at [`test/run.mjs:1199-1210`](../test/run.mjs#L1199-L1210). |
| The engine had no single place stating its rules. | Invariants were scattered across code comments, `CONTRIBUTING.md` and two scope documents; a since-deleted orientation document had drifted (it claimed the viewer was 746 lines when it is 1068, and that the model was never schema-validated when [`lib/check.mjs:28`](../lib/check.mjs) validates it). | Resolved on this branch: `ORIENTATION.md` is removed and replaced by [`GLOBAL_INVARIANTS.md`](GLOBAL_INVARIANTS.md), which pairs every rule with its enforcement point. |
| The documented shipped-file count is stale and unenforced. | `AGENTS.md` required 20 files and said the `prepack` guard held that; `npm pack --dry-run --json` reports 36 (30 before this branch added the room modules, the RTM derivation and the locale tables), and [`scripts/check-clean.mjs:7-10`](../scripts/check-clean.mjs#L7-L10) checks residue only. | Still open. The false enforcement claim is removed from `AGENTS.md` and the real number stated, so the gap is visible rather than asserted away — but nothing yet fails when the selection changes. Bump deliberately or enforce the intended list mechanically. |
