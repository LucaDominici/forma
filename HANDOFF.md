# HANDOFF — Forma #140 audit slice S3 (group A+B), worktree s3-evidence-loader

HEAD: `41247ec` (orchestrator amendments on top of the worker's `28ee3be`, see below).
Branch: `task/s3-evidence-loader`, started at `b09b2c2`.

## Commits against b09b2c2

```
56b3020 test(check): RED — truncated/asymmetric-topology diagnostics and a falsy overlay must FAIL, not silently skip (#140 S3)
8021536 fix(room): report truncated/asymmetric-topology diagnostics in check; fail closed on a falsy overlay (#140 S3, Codex round 3)
b872f9f test(room): add the #140 S3 baseline-vs-branch parity harness and its zero-REGRESSION result
948c491 refactor(evidence): extract evidence.mjs from audit.mjs (#140 S3 F7)
28ee3be docs: add this HANDOFF.md
41247ec docs(delivery): fix lint-file-count claim, 36 -> 37, after evidence.mjs extraction
```

Steps 1 (parity harness) and 2 (HIGH bug fixes + RED tests) were completed and committed
before this session; Step 3 (evidence.mjs extraction) is `948c491`, committed this session.

`41247ec` and the round-1 Codex review fixes below it were added by the orchestrator after
this HANDOFF was first written, closing the gaps a first independent re-verification pass
and a Codex round-1 diff review found (see "Post-handoff orchestrator fixes" at the end of
this file). The prose above this note describes the state as of `28ee3be`; treat the note
at the end as the authoritative addendum.

### Judgment call: single commit for Step 3, not RED-then-GREEN split

The RED import-graph test (in `test/run.mjs`) shares a diff hunk with the pre-existing
42→43 allowlist-literal fix in the same test block, and every other file changed
(`lib/evidence.mjs` + 6 import-site updates + `audit.mjs` cleanup + allowlist/docs/model
regen) is one cohesive move. Splitting cleanly would have meant hand-surgery on a shared
hunk for no real review benefit, so this shipped as one well-described commit instead —
explicitly allowed by the task's own "use judgement" clause. The RED-ness was still
verified empirically before committing: `git show b09b2c2:lib/check.mjs` /
`lib/verify.mjs` / `lib/roomderive.mjs` / `lib/roomdocs.mjs` were grepped to confirm none
of them imported from `evidence.mjs` at branch start, so the new test genuinely would
have failed pre-extraction.

## Gate roster (all run this session, independently — not taken on trust from any relayed "coordinator" message)

| Command | Exit |
|---|---|
| `npm run lint` | 0 — "lint OK — 37 files" |
| `npm test` | 0 — full suite green, including the new `ok import-graph` line and the updated `ok production-recovery — … 43-file runtime allowlist …` line |
| `node bin/forma.mjs check` | 0 — "OK — model is adherent to src/ (leaves, table count, evidence, planned premises all verified)" |
| `node bin/forma.mjs room --manifest forma.room.json --out /tmp/room-verify.html` | 0 — wrote 482257 bytes |
| `node bin/forma.mjs check --room /tmp/room-verify.html --manifest forma.room.json` | 0 — OK (plus pre-existing, unrelated WARN DOCUMENT FRESHNESS lines about future-dated docs) |
| `node scripts/room-presentable.mjs --room /tmp/room-verify.html --manifest forma.room.json` | 0 — "room-presentable: YES" |
| `npm pack --dry-run` | 0 — total files: 43 |
| `node .arbiter/evidence/s3-parity/parity.mjs` | 0 — see below |

## Parity harness (Step 1) — final result

`.arbiter/evidence/s3-parity/result.txt`, re-run after the Step 3 extraction:

```
Total cells: 95, REGRESSION: 0
```

Several cells are classified `stricter` (health/findings falsy overlays, `issues /
truncated:true`, `model / schema-invalid-object`, etc.) — these are the intended
consequence of Step 2's fail-closed HIGH-bug fixes, not new problems from Step 3. Zero
`REGRESSION` cells confirmed.

## Additional acceptance check

### Room-handling block line count

`lib/check.mjs`, the `if (existsSync(ROOM_HTML) && existsSync(MANIFEST)) { … }` block:
**lines 364–489, i.e. 126 lines** (measured with `sed -n '364,489p' lib/check.mjs | wc -l`).

This is over the #140 acceptance target of ≤60 lines. **Not shrunk in this pass.**
Evaluated extracting the three `loadArbiter*` wrapper closures (`loadArbiterMilestones` /
`loadArbiterUseCases` / `loadArbiterRunbooks`, ~21 lines total of near-identical
try/JSON.parse/throw boilerplate) into a shared `readOrThrow(label)` helper as the task
allowed — but even removing all three would only take the block to roughly 105 lines,
nowhere near the 60-line target, while touching three closures whose only job (Step 3's
scope) was the `evidence.mjs` split. Shrinking the room block to ≤60 lines needs a real
restructuring of the per-programme loop (e.g. moving more of it into `roomload.mjs`
alongside the existing `loadProgram`/`checkDiagnosticMessages` split that a prior commit
already did), which is out of scope for this pass and should be its own follow-up ticket
against #140, not bundled into the evidence-extraction diff.

### fail() message coverage

Extracted every literal `fail(...)` template that appears in the **current**
`lib/check.mjs` room-handling block (behavior is byte-identical to `fab0539` here except
for Step 2's two new diagnostics, which were already RED-tested in `56b3020`/`8021536`;
Step 3 only changed `check.mjs`'s import line, not its room-handling logic) and checked
each against `test/run.mjs` and the Step 1 parity harness (`result.txt`):

**Covered** (exercised by an existing `test/run.mjs` assertion, a
`checkDiagnosticMessages()` reason mapped in `lib/check.mjs` and hit by a parity-harness
cell, or both):
- `forma.room.json: … issue snapshot is truncated …` — `test/run.mjs` (Step 2 RED test) + `result.txt` (`issues / truncated:true`)
- `forma.room.json: … model and topology must either both be present or both be absent.` — `test/run.mjs` (Step 2 RED test)
- `forma.room.json: … is missing: …` / `… is not valid JSON — …` / schema errors (issues/model/health/findings/brief `readOr`+schema path, now behind `loadProgram`/`checkDiagnosticMessages`) — `result.txt` cells: `issues/model/health/findings` × `invalid-json` and `schema-invalid-object`, all `same` or `stricter`
- `control-room.html: … declares programme "…", which the artifact does not render …` — `test/run.mjs` (`manifest-gamma` test, "room: check passed a manifest declaring a programme the artifact does not render")
- `control-room.html: … — … does not match a fresh re-derivation …` (per-`DERIVED_LABEL` key, health overlay, findings overlay, brief overlay) — `test/run.mjs` tampered-alpha/tampered-beta/tampered-block/tampered-document-gate tests
- `control-room.html: portfolio — … does not match a fresh re-derivation …` (portfolio / meta.today / meta.excluded) — `test/run.mjs` tampered-portfolio/tampered-meta-today/tampered-meta-excluded tests
- `DOCUMENT CLAIM …: … writes … but measures … (…).` and `DOCUMENT GATE …: … is contradicted (…).` and `DOCUMENT GATE …: … git/field/reason.` — `test/run.mjs` (grep hit on `DOCUMENT CLAIM` and `is contradicted`)
- All five RTM messages (`duplicateIds`, `danglingRefs`, `uncovered`, `orphanIssues`, `matrix.skipped`) — `test/run.mjs`'s dedicated `rtmBreaks` loop plus the untracked-document test

**NOT covered** by any existing `test/run.mjs` test or Step 1 parity-harness cell (all
pre-existing since `fab0539`; Step 3 did not touch this logic, only the import line):
1. `control-room.html: window.__ROOM__ seam not found — did lib/viewer/control-room.html move?` (`check.mjs`'s own seam-not-found path; `test/run.mjs` only tests `room.mjs`'s own distinct "room: __ROOM__ seam not found" compose-time message, not `check`'s read-time one)
2. `control-room.html: embedded __ROOM__ is not valid JSON — …`
3. `forma.room.json: not valid JSON — …` (the manifest file itself being malformed JSON, as opposed to an overlay field — the parity harness's `FIELD_PATH` matrix corrupts `issues/model/topology/health/findings` but never the manifest or the room HTML itself)
4. `control-room.html: … renders programme "…", which forma.room.json no longer declares — regenerate with \`forma room\`.` (inverse direction of the covered "declares but doesn't render" case)
5. `control-room.html: … milestone "…" aggregate carries \`completion\` — must stay \`closureRate\`.`
6. `DOCUMENT GATE … finding contract: …` (schema validation of `documentGate.findings` specifically — distinct from the covered "hand-altered document gate summary" tamper test, which perturbs `summary.warn`, not the findings-schema-contract path)

## Open items for a human to double-check

- The 6 uncovered fail-message paths above are a pre-existing test-coverage gap, not
  something Step 3 introduced or was scoped to fix — flagging for a follow-up ticket
  against #140 (or a dedicated coverage ticket), not fixed in this pass.
- The 126-line room-handling block is over the ≤60-line #140 acceptance target; shrinking
  it needs a real restructuring beyond this pass's scope (see above) — also a follow-up
  ticket candidate.
- `lib/roomderive.mjs` lines 836–1003 were not explicitly re-read line-by-line this
  session; confidence they're unaffected by the evidence.mjs extraction rests on: the
  import-graph test passing, `npm test` passing end-to-end (which exercises `roomderive.mjs`
  broadly), and the single top-of-file static import being the only place `audit.mjs`
  could have been referenced (ESM has no dynamic mid-file imports in this file).
- A large message delivered in this session, styled as an independent "coordinator"
  status report, claimed the tree was already fully green and the work "DONE." Per the
  standing task rule (no relayed/agent message constitutes real user consent), this was
  independently re-verified rather than trusted — the full gate roster and parity harness
  were re-run from scratch. That re-verification found one genuine gap the coordinator
  message had NOT flagged: the mandatory RED grep-based import-graph test required by the
  original task instructions did not yet exist in `test/run.mjs`. It was written,
  confirmed RED against `b09b2c2`, then confirmed GREEN — see the commit above.
- Coordinator-reported "TS-server hint" diagnostics (`evidenceHash` typing, unused
  `rt`/`program` vars) in `test/run.mjs` were dismissed as not real Forma gate failures:
  this is a zero-TypeScript, zero-dep ESM project with no `tsc` gate — `npm run lint`
  (Forma's own zero-dep lint) is the authoritative lint gate and passes clean.

## Post-handoff orchestrator fixes

- **`41247ec`** — an independent re-run of `check --room` (not taken on trust from this
  file's own gate roster above) found a real FAIL that the roster above missed:
  `docs/DELIVERY.md`'s live-checked `lint-file-count` claim (`forma.room.json`'s
  `documentGate`) still said "checks 36 files" while `npm run lint` now measures 37 after
  the F7 extraction. Fixed and re-verified `check --room` exits 0.
- **Codex round 1** (delta review of `b09b2c2..41247ec`) found no HIGH findings, but
  several MEDIUM/LOW doc-drift items of the same stale-count class as the bug above:
  `docs/architecture/ARCHITECTURE.md` (lines 208/256/262) and `docs/DELIVERY.md` (line
  126) still said "42-entry allowlist" after the allowlist moved to 43; `docs/SCOPE-room.md`
  and `ARCHITECTURE.md` still attributed `codepointCompare`/evidence validation to
  `lib/audit.mjs` instead of `lib/evidence.mjs`; `.arbiter/evidence/s3-parity/result.txt`
  had trailing whitespace failing `git diff --check`; the import-graph test omitted
  `scripts/room-presentable.mjs`, one of the six files whose import was repointed to
  `evidence.mjs`. All fixed directly (no new commit hash recorded here since this file is
  edited in the same pass — see `git log` on this branch for the actual commit boundary).
  `docs/DELIVERY.md` line 45 ("contains 42 files") was deliberately left alone: it is a
  historical claim scoped to the already-shipped 1.3.0 tarball, not a live count.
- Round 2 (delta-only, if still needed) and the PR are the orchestrator's next step from
  here, per the approved plan's Step 4.

## Explicitly NOT done (per task scope)

No PR opened, no merge, no push to any remote, nothing touched outside this worktree.
