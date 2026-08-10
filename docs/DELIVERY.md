# Delivery status

This file records realization status for the Control Room branch. A feature is listed as proven only when a named command or recorded measurement can falsify it. Built code without that evidence stays in the next section.

## What is shipped and proven

| Claim | Proof command or recorded check | Why the proof is relevant |
|---|---|---|
| The public CLI dispatches `init`, `gen`, `check`, `doc`, `serve`, `verify`, and `room`. | `node bin/forma.mjs --help` | The dispatcher is the package entry point, so this proves the installed command surface ([`bin/forma.mjs:15-38`](../bin/forma.mjs#L15-L38)). |
| The shipped JavaScript entry points parse. | `npm run lint` | This passes on the branch and checks 21 files through `node --check`. |
| Forma's own committed model is adherent to Forma's current source. | `node bin/forma.mjs check` | This passes on the branch and independently re-walks source, document facts, evidence, and optional artifacts. |
| The npm selection is clean of editor residue and includes the Control Room runtime files. | `npm pack --dry-run --json` | The prepack guard passes and the dry run lists `room.mjs`, `roomderive.mjs`, the four overlay or manifest schemas, and `control-room.html`. |
| The single-model public demo meets its five publication predicates. | `node scripts/presentable.mjs docs/demo/c4-model.json` | The suite grades the shipped model itself, not a cleaned copy ([`test/run.mjs:1407-1411`](../test/run.mjs#L1407-L1411)). |
| `verify` fetches a whole-programme issue and milestone fact base, detects likely truncation, and writes only after parsing. | `forma verify`, exercised offline by the `gh` stub inside `npm test` | The test reaches the verify block and reports it green before the later known failure; the write boundary is visible at [`lib/verify.mjs:55-84`](../lib/verify.mjs#L55-L84). |
| Issue-to-code linkage uses git history without a second curated map or an LLM. | `forma room`, then inspect the generated linkage coverage; re-run `forma check` | The same `link.mjs` and `roomderive.mjs` path feeds composer and checker, and coverage was measured on three real repositories. |
| The Control Room composer validates inputs, rejects truncated snapshots, and writes one self-contained HTML briefing. | `forma room --manifest <forma.room.json> --out <control-room.html>` | Composition is read-only over its inputs and embeds both the room data and sandboxed explorer ([`lib/room.mjs:36-65`](../lib/room.mjs#L36-L65), [`lib/room.mjs:89-106`](../lib/room.mjs#L89-L106)). |
| Room aggregates are not trusted from rendered markup. | `forma check` with room artifacts present | `check` re-derives Executive, milestone, Kanban, and commit-drift values through the same `deriveAll` function and compares the embedded machine-readable values ([`lib/check.mjs:220-249`](../lib/check.mjs#L220-L249)). |
| The publication instrument tests all predicates and compares a second render byte for byte. | `node scripts/room-presentable.mjs ...` | The branch commit records the deterministic double render and tri-state exit behavior; the script prints every predicate before exiting ([`scripts/room-presentable.mjs:93-109`](../scripts/room-presentable.mjs#L93-L109)). |
| Audit verdicts cannot be applied without resolvable evidence. | Call `auditPlan`, apply fills with `applyVerdicts`, then run `forma check` | Paths must exist, commits must resolve, and unknown evidence types are rejected before merge ([`lib/audit.mjs:32-58`](../lib/audit.mjs#L32-L58)). |

`npm test` is not claimed as globally green. It proves the preceding fixture blocks as they execute, then exits 1 at the known external-corpus defect documented below.

## What is built but not yet proven on a second repository

- The room manifest can describe multiple programmes and allows a programme to omit its model and topology. This is implemented and validated, but only `haben` has exercised the full mapped pipeline. `arbiter` and `viafera` have measured issue corpora but no curated Forma model, so manifest parametricity across independently curated architectures remains unproved ([`docs/SCOPE-room.md:51-59`](SCOPE-room.md#L51-L59), [`docs/SCOPE-room.md:106-108`](SCOPE-room.md#L106-L108)).
- Portfolio aggregation across programmes is built and was measured over three issue corpora. That proves counting and declared blocking rules, not that a coherent eight-tab room can be produced for a second mapped repository by changing only the manifest.
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
| Control Room tabs | 8 | The room composition contract. |
| Control Room charts | 13 | Each chart has a table twin carrying the same numbers. |
| Generated Control Room artifact size | 975,986 bytes for three programmes | Measured on the generated portfolio briefing (haben, arbiter, viafera), architecture viewer embedded once. |

## Known defects, each with its evidence

| Defect | Evidence | Consequence |
|---|---|---|
| The pre-existing real-corpus `docmap-cap` check fails. | `npm test` exits 1 with `docmap-cap: 4 rows all done produced status2=planned`; the assertion is [`test/run.mjs:1421-1434`](../test/run.mjs#L1421-L1434). | The full suite is not green even though every preceding fixture block passes. A release workflow that requires `npm test` will fail until the status derivation or corpus interpretation is corrected. |
| The engine had no single place stating its rules. | Invariants were scattered across code comments, `CONTRIBUTING.md` and two scope documents; `docs/ORIENTATION.md` had drifted (it claimed the viewer was 746 lines when it is 1068, and that the model was never schema-validated when [`lib/check.mjs:28`](../lib/check.mjs) validates it). | Resolved on this branch: `ORIENTATION.md` is removed and replaced by [`INVARIANTS.md`](INVARIANTS.md), which pairs every rule with its enforcement point. |
| The documented shipped-file count is stale and unenforced. | [`AGENTS.md:38-39`](../AGENTS.md#L38-L39) requires 20 files; `npm pack --dry-run --json` currently reports 30. [`scripts/check-clean.mjs:7-10`](../scripts/check-clean.mjs#L7-L10) checks residue only. | A package-content change can violate the written invariant while prepack stays green. Update the number deliberately or enforce the intended list mechanically. |
