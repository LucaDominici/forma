---
title: 'Delivery status'
doc_version: '1.0.0'
status: active
last_review: '2026-08-17'
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
| The shipped JavaScript entry points parse. | `npm run lint` | This passes on the branch and checks 27 files through `node --check`. |
| Forma's own committed model is adherent to Forma's current source. | `node bin/forma.mjs check` | This passes on the branch and independently re-walks source, document facts, evidence, and optional artifacts. |
| The npm selection is clean of editor residue and includes the Control Room runtime files. | `npm pack --dry-run --json` | The prepack guard passes and the dry run lists `room.mjs`, `roomderive.mjs`, the four overlay or manifest schemas, and `control-room.html`. |
| The single-model public demo meets its five publication predicates. | `node scripts/presentable.mjs docs/demo/c4-model.json` | The suite grades the shipped model itself, not a cleaned copy ([`test/run.mjs:1407-1411`](../test/run.mjs#L1407-L1411)). |
| `verify` proves the whole-programme issue and milestone fact base before writing. | `forma verify`, exercised offline by the adaptive `gh` stub inside `npm test` | A full page triggers a doubled fetch until a short page proves completeness; a failed later retry leaves the existing model and snapshot byte-identical. |
| A programme does not need an architecture map to refresh its GitHub fact base. | `forma verify --gh-repo owner/repo` without a model, or `forma room update` on a map-less manifest entry | The offline `gh` stub proves both paths write the snapshot, compose the programme, and never invent a model; the update no longer reports it skipped. |
| A failed refresh cannot publish a stale Control Room. | Make a later adaptive `gh` request fail during `room update` | `verify` leaves its snapshot untouched; `room update` exits non-zero and leaves the prior HTML byte-identical. |
| The embedded C4 drill works without a mouse or microscopic mobile scaling. | Traverse nodes with Enter/Space at 390 px | SVG nodes expose button semantics and accessible names; a 44 px detail action drills on touch; the canvas keeps viewBox scale and pans natively. |
| Issue-to-code linkage uses git history without a second curated map or an LLM. | `forma room`, then inspect the generated linkage coverage; re-run `forma check` | The same `link.mjs` and `roomderive.mjs` path feeds composer and checker, and coverage was measured on three real repositories. |
| The Control Room composer validates inputs, rejects truncated snapshots, and writes one self-contained HTML briefing. | `forma room --manifest <forma.room.json> --out <control-room.html>` | Composition is read-only over its inputs and embeds both the room data and sandboxed explorer ([`lib/room.mjs:36-65`](../lib/room.mjs#L36-L65), [`lib/room.mjs:89-106`](../lib/room.mjs#L89-L106)). |
| Room aggregates are not trusted from rendered markup, and the gate fails when they are altered. | `npm test` (the `room` block) | `check` re-derives every key of `deriveAll` per programme and compares it to the embedded machine-readable block; the test alters one aggregate by hand on both a mapped and a map-less programme and requires `check` to exit 1 naming the programme and the field ([`lib/check.mjs:226-278`](../lib/check.mjs#L226-L278)). |
| The publication instrument runs every predicate and compares a second render byte for byte. | `npm test` (the `room` block), or `node scripts/room-presentable.mjs --room <html> --manifest <json>` | The test runs the instrument against a freshly composed briefing and requires exit 0; determinism is asserted twice, once by the test comparing two renders and once by the instrument re-rendering from the same manifest ([`scripts/room-presentable.mjs:96-110`](../scripts/room-presentable.mjs#L96-L110)). |
| The briefing derives a programme that has no architecture model. | `npm test` (the `room` block) | A programme carrying only issues and git history still yields KPIs, milestones, Kanban buckets and a queue; the two map-dependent answers read `null`, never a measured zero ([`lib/roomderive.mjs:107-131`](../lib/roomderive.mjs#L107-L131)). |
| Audit verdicts and findings cannot be applied without current, resolvable evidence. | `forma audit --today <day> --plan <plan.json>`, return its `planHash`, then `forma audit --today <day> --apply <fill.json> --audit-plan <plan.json>` | Apply rejects a changed plan before either overlay is replaced; within a current plan every verdict, confirmation, finding and counter entry is applied on its own — the ones whose evidence (path, commit, issue, signal, milestone) does not resolve, or that the plan did not request, are refused and named in `lastApply.rejected` ([`lib/audit.mjs`](../lib/audit.mjs)). |
| Counter-verification starts from every truth claim the briefing exposes. | `forma audit --plan <plan.json>` | The deterministic plan names each done node, health verdict, milestone closure rate and open `needs-human` issue, plus the file, commit or GitHub location an independent agent must inspect; `npm test` exercises all four kinds. |
| Counter-verification is independent without putting an agent or network in Forma. | Run the Codex `forma-counterverify` adapter over the plan | The offline stub returns all three verdicts through the same model-agnostic JSON contract; the suite rejects missing claims and any result without an anchored reason, and rejects a `forma audit --run` network seam. D-08 records the delegated CLI-vs-API decision. |
| A counter-verdict reaches the same pill and gate as every other health fact. | `forma audit --today <day> --apply <counter.json> --counter-plan <plan.json>`, then `forma room` and `forma check` | A contradiction becomes `bad`, unsupported becomes a warning, and a held health claim renews its audit date. Apply rejects changed plans and unresolved evidence before either overlay write. |
| Scheduled updates cannot silently skip counter-verification. | Refresh with `room update`, run the external adapter, then `room update --skip-verify --counter` | The counter pass regenerates a plan for every active programme and fails before composition when a configured result is missing; accepted contradictions are embedded in the recomposed briefing. The fixture exercises both success and missing-result failure. |
| The judgement layer expires by itself when the world moves, and the gate refuses to publish a decision nobody re-checked. | Hold a brief under a hostile verifier, refresh a day later with `room update`, then `node scripts/room-presentable.mjs --room <html> --manifest <json>` | Live on `viafera`: eight claims written and held `holds` on 2026-08-18; overnight #4241 (the nightly watchdog) was closed at 03:25Z while the nightly lane stayed `failure` (run 02:57Z). The 2026-08-19 regeneration dropped the colour from four of the eight on its own — thesis, `risk-nightly` and `risk-no-milestone` as `evidence-changed`, `decide-nightly` as `issue-changed` — and the instrument exited NO on a single predicate, `no decision goes out without a fresh hostile hold (viafera decide-nightly (stale))`, with the other fifteen passing including byte-determinism. A hand-written dashboard would have kept yesterday's sentence, or called the incident closed. |
| Room onboarding discovers only safe inputs and preserves operator decisions. | `forma room init` once, then run it again or use `--scan`; refresh with `room update` | Tracked Markdown is seeded as the docs corpus; an RTM candidate enters only when filename, columns and the existing parser agree. Blocker/audit state is never invented. A transient missing `origin` cannot erase `ghRepo`, docs, RTM, `enabled:false` or taxonomy. |
| A cold start is non-vacuous across stacks. | `npm test` (`two-stack` and `cold-start-closure`) | Init seeds every detected production stack, records reasoned test exclusions, and adopts only document tables whose refs resolve. Check prints covered + excluded / recognised per stack and fails when a whole stack is removed. |
| Control Room work is bounded at real programme volume. | Generate the 2,500-issue stress fixture, run browser/mobile/print checks and `room-presentable` | Five official routes mount lazily; Queue, Kanban and portfolio Moving use 40-row pages; interactive archives are summarized in print and legacy `/auto`/`/kanban` links resolve to Tech. |
| The Claude adapter drives onboarding through to a usable artifact. | Follow its `room init`, then `room update --out` recipe | The offline suite runs both commands against a fresh git target and requires the skill to return a Markdown link to the generated Control Room. |
| The personal GitHub portfolio composes as one checked briefing. | `room init --scan --root /home/luca/work/repos --depth 1`, refresh snapshots, then `room update --skip-verify` | The 2026-08-17 run included `arbiter`, `forma`, `haben`, `ripme-main`, and `viafera`: 4,269 issues, 97 open, 1,362,899 output bytes. `room-presentable` passed all seven predicates and `forma check` passed against the same manifest. Repositories without a GitHub origin cannot produce the required fact base and were not silently invented. |
| Independent counter-verification runs across every portfolio programme. | Generate five plans, run the external Codex adapter, then `room update --skip-verify --counter` | The missing-result run first failed naming all five programmes. The completed 2026-08-17 run covered all 233 claims: 40 GitHub milestone/label claims held after an independent live read, 193 node-completion claims were `unsupported`, and none was contradicted. The 193 doubts rendered as anchored warnings; `room-presentable` and `forma check` both passed. |
| The 1.0.0 release candidate is locally installable with its frozen schema contract. | Full suite, `npm pack`, install the tarball into an empty temporary prefix, then `forma --version` | The suite rejects schema major 2 while accepting 1.x; the packaged `forma-arch-1.0.0.tgz` contains 38 files and its installed CLI reports `1.0.0`. Publishing remains the separately authorized remote step. |
| Requirements trace to work, and the gate fails at both ends. | `npm test` (the `rtm` block) | The test edits the fixture's design document four ways — a duplicate id, a reference to nothing, a decision landing on no work, and open work no requirement claims — and requires `forma check` to exit 1 each time, naming the document and the line ([`lib/rtm.mjs`](../lib/rtm.mjs), [`lib/check.mjs`](../lib/check.mjs)). |
| The convention survives a document written by hand for prose reasons. | `npm test` (the `rtm-dogfood` block) | Forma's own `docs/PRD.md` §6 parses as nine traceable requirements, each carrying its verification and its source line, and parsing it twice gives an identical answer. |
| "Where we were" needs no stored history. | `npm test` (the `views` block) | The whole series is a count over `createdAt`/`closedAt` in one snapshot; a snapshot predating those fields derives `null` rather than a flat line ([`lib/roomderive.mjs`](../lib/roomderive.mjs)). |
| A checkpoint carries completion that was measured, not estimated. | `npm test` (the `views` block) | Completion is issue closure on the nodes the checkpoint patches; a checkpoint no issue reaches reads `null`, never 0%. |
| The document budget refuses rather than truncates. | `npm test` (the `views` block) | With a one-byte budget nothing is embedded and every canon document is listed with the budget as its reason. |
| Discovery never overturns a decision. | `npm test` (the `scan+serve` block) | A second `forma scan` over the same root leaves `enabled: false`, hand-curated fields and `today` untouched. |
| The served briefing writes the manifest and nothing else. | `npm test` (the `scan+serve` block), plus `forma room --serve` | It binds loopback only; the handler accepts one boolean per programme and re-validates the whole manifest before writing, so a rejected edit leaves the file byte-identical. |

`npm test` is green, with nothing skipped. It was not, and the reason is recorded under known defects below.

## Parametricity and portfolio proof

On 2026-08-17 a temporary two-programme manifest composed Forma plus the clean `viafera` checkout at
`9482686`. `verify` wrote Viafera's fact base outside both repositories (2,286 issues, 46 open, 11
milestones); no model was added or curated. Changing only the manifest produced a 769,240-byte
briefing, `forma check` stayed green, and all seven `room-presentable` predicates passed, including
byte determinism and coverage of every open issue. This proves parametricity for a real second
map-less repository without turning a private/local checkout into a public CI dependency (#72).

The R5 run then used `room init --scan --depth 1` over the home repository root. Five personal
GitHub checkouts were discovered, including two with curated maps and three map-less programmes.
Snapshots and the generated briefing lived in `/tmp`, so none of the target checkouts was changed.
Directories ending in `.worktrees` are now excluded by a regression test; the depth boundary also
kept the nested work checkout outside the personal portfolio. The three direct local-only checkouts
have no `ghRepo`, so including them would violate the manifest schema and make `verify` impossible.

Counter-verification then ran once per programme from freshly regenerated plans. It refused the
first attempt because all five result files were absent. The external run independently re-read
GitHub milestones and `needs-human` labels; it did not treat a source path as proof of completion.
That left 40 claims holding and 193 explicitly unsupported (seven in Forma, 186 in `ripme-main`),
with zero contradictions. The resulting 193 warning findings all resolved to repository evidence,
and the recomposed 1,421,466-byte briefing passed both publication and drift gates (#75).

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

Every row names its measurement date or its durable source. No value is extrapolated.

| Measurement | Value | Source and meaning |
|---|---:|---|
| Real repositories in the portfolio measurement | 5 | `arbiter`, `forma`, `haben`, `ripme-main`, and `viafera`, live run on 2026-08-17. |
| Issues in that portfolio corpus | 4,269 | Whole-programme issue snapshots from the same run. |
| Open issues in that corpus | 97 | Re-derived from those snapshots. |
| Counter-verification claims | 233 | Five regenerated plans on 2026-08-17: 40 held, 193 unsupported, 0 contradicted. |
| Issues waiting on a human | 11 | Historical 2026-08-09 measurement using a declared rule per programme, never a global inferred label. |
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
| Control Room routes | 2 + kN, k ≤ 6 | The composition contract: the briefing and the options view, plus one route per lens a programme can actually answer. Eight flat tabs were the ADR-0004 shape, replaced by ADR-0005, re-nested by ADR-0007 and partitioned into six justified lenses by ADR-0008 — where k is measured per programme, not reserved (I7, I20). |
| Control Room locale keys | 335 | At en/it parity, and every one read by the template — both halves asserted by `npm test`. |
| Control Room charts | 13 | Each chart has a table twin carrying the same numbers. |
| Generated Control Room artifact size | 1,362,899 bytes for five programmes | Measured on the 2026-08-17 portfolio briefing, architecture viewer embedded once. |

## Known defects, each with its evidence

| Defect | Evidence | Consequence |
|---|---|---|
| The `docmap-cap` check asserted against a repository outside this one. | It read a feature matrix from a sibling checkout of the demo's source repository, silently skipping when absent — so it was green by absence on every CI run and red on one machine. Its expectation had also gone stale: the rows it pinned are now declared not-done upstream, making `planned` the correct answer and the assertion the wrong party. | Resolved: the block is removed. The property it guarded (#43, the prose cap must not silence the verdict) is asserted on the committed `docmap` fixture, where `statusFor` runs the identical path — see the #43 comment at [`test/run.mjs:1199-1210`](../test/run.mjs#L1199-L1210). |
| The engine had no single place stating its rules. | Invariants were scattered across code comments, `CONTRIBUTING.md` and two scope documents; a since-deleted orientation document had drifted (it claimed the viewer was 746 lines when it is 1068, and that the model was never schema-validated when [`lib/check.mjs:28`](../lib/check.mjs) validates it). | Resolved on this branch: `ORIENTATION.md` is removed and replaced by [`GLOBAL_INVARIANTS.md`](GLOBAL_INVARIANTS.md), which pairs every rule with its enforcement point. |
| The documented shipped-file count is unenforced. | `AGENTS.md` records 38 files from the 1.0.0 `npm pack --dry-run --json`; [`scripts/check-clean.mjs:7-10`](../scripts/check-clean.mjs#L7-L10) checks only editor residue. | Still open. The count is deliberately bumped with this release, but nothing fails when a future selection changes. Bump again deliberately or enforce the intended list mechanically. |
