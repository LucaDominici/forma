---
title: 'Decision registry'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'decision-registry'
tags: ['audience/dev', 'kind/governance']
related: ['docs/GOVERNANCE.md', 'docs/adr/README.md']
---
# Decision registry

Operational decisions that are binding but are not architecture. Architecture goes in an
[ADR](docs/adr/); a rule that must never break goes in
[`GLOBAL_INVARIANTS.md`](docs/GLOBAL_INVARIANTS.md); what "finished" means for a round of work goes
in a scope document. What is left is here.

Every row is followed immediately by an `Enforcement:` line naming the gate, the test, or — when
there is honestly none — the word `documentale`. A row whose enforcement is `documentale` is a
preference wearing a decision's clothes, and is listed as a candidate for either a gate or deletion.

| ID | Decision | Rationale | Decided by | Date |
|---|---|---|---|---|
| D-01 | Squash-merge to `main`; never commit to `main` directly | One logical change, one commit, so `git log` stays a usable record and `link.mjs` can attribute an issue to the files it touched | Luca Dominici | 2026-07-22 |

Enforcement: branch protection requiring the `ci-required` context; `docs/GOVERNANCE.md` states the flow.

| D-02 | Conventional commit subjects, with `(#N)` when the work has an issue | The Control Room's issue-to-code link reads `#N` out of the commit subject; a subject without it attributes to nothing | Luca Dominici | 2026-08-09 |

Enforcement: `lib/link.mjs` derives the link from the subject, so an unlinked commit shows up as missing coverage in the briefing rather than as a lint error. Partial by construction — see `docs/SCOPE-room.md` §2.

| D-03 | Documentation is graded on the **solo** column of the doc-set standard | Forma is a one-committer, dogfood-first tool; the enterprise column (GAMP 5 / Part 11 …) is governance theatre for it and its `arbiter` coupling turned CI red. The reader who matters is the owner running it across a personal portfolio | Luca Dominici | 2026-08-17 (was enterprise, 2026-08-10) |

Enforcement: `tier_floor: solo` in `standards/doc-profile`, read by the doc-set checks in the `docs-gate` CI job. The grading is also being decoupled from the private `arbiter` checkout (debt D-7) so the gate runs standalone.

| D-04 | The document gates run from a checkout of `arbiter`, never vendored into `lib/` | Re-implementing them here would put two engines behind one rule, which is the divergence `roomderive.mjs` and `roomload.mjs` exist to prevent — and a YAML parser in `lib/` would break ADR-0001 | Luca Dominici | 2026-08-10 |

Enforcement: the `docs-gate` job in `.github/workflows/ci.yml`. The coupling is recorded as debt D-7 in `docs/technical-debt.md`.

| D-05 | ADR filenames use four digits (`0001-`), not the standard's three | Seven ADRs already carry four-digit names and are cross-referenced by number from code comments and other documents; renumbering would break every reference to buy nothing that a gate checks | Luca Dominici | 2026-08-10 |

Enforcement: `documentale`. The doc-set presence glob accepts either form, and arbiter's `check-adr-index.mjs` is hardcoded to its own `docs/internal/ADR` path and does not run here. If that gate ever becomes portable, this row is the thing to revisit.

| D-06 | The generated arc42 scaffold is not hand-editable and carries generated frontmatter | `forma doc` rewrites the whole file, so any hand-written frontmatter would die at the next run — the generator must satisfy the standard by construction | Luca Dominici | 2026-08-10 |

Enforcement: `lib/render.mjs` emits the frontmatter block; `scripts/check-doc-style.mjs` grades the result like any other document, so a regression is caught by the same gate.

## Promotion

A row here that stops being an operational preference and becomes structural moves out: to an ADR
if it is a shape, to `GLOBAL_INVARIANTS.md` if it is a rule with an enforcement point. When it
moves, the row is **removed** rather than duplicated — a decision lives in exactly one register.
