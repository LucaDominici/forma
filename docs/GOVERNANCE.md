---
title: 'Governance'
doc_version: '1.0.1'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'governance'
tags: ['audience/dev', 'kind/governance']
related: ['docs/adr/README.md', 'DECISION_REGISTRY.md', 'docs/GLOBAL_INVARIANTS.md']
---
# Governance

How a decision is made in this repository, where it is written down, and what stops it from being
quietly reversed.

## Who decides

One maintainer, Luca Dominici, named in [`CODEOWNERS`](../.github/CODEOWNERS). Every file has that
owner; there is no area with ambiguous ownership, and pretending otherwise would be governance
theatre for a repository with one committer.

That fact selects the solo column of the doc-set standard. Publication to npm does not manufacture
a review team; [`standards/doc-profile`](../standards/doc-profile) records the floor explicitly.

## Where a decision lives

Four registers, deliberately not merged, because they answer different questions.

| Register | Question it answers | Lifecycle |
|---|---|---|
| [ADRs](adr/) | Why is the architecture shaped this way, and what was rejected | Immutable once Accepted; superseded by a new ADR that links back |
| [`GLOBAL_INVARIANTS.md`](GLOBAL_INVARIANTS.md) | What must never break, and which file enforces it | Amended only with its enforcement point |
| [`DECISION_REGISTRY.md`](../DECISION_REGISTRY.md) | Operational decisions that are not architecture | Rows carry an `Enforcement:` line; a matured row becomes an invariant or an ADR |
| [`SCOPE.md`](SCOPE.md) / [`SCOPE-room.md`](SCOPE-room.md) | What "finished" means for a round of work | Closed when the round closes; a new confine needs a new document |

The rule that keeps these honest is the one Forma applies to itself: **a rule with no enforcement
is a preference.** `GLOBAL_INVARIANTS.md` says so in its own closing section, and every row in it
names the file that turns red.

## How a change lands

1. Branch from `main`. Never commit to `main` directly.
2. Make the change, with the check that would fail if it broke. For non-trivial logic that is a
   block in `test/run.mjs`; for a claim about the model it is an assertion in `forma check`.
3. Run the gate locally: `npm run lint`, `npm test`, `node bin/forma.mjs check`.
4. Open a PR. CI runs the source gate on Node 18/20/22 and the browser publication gate once on
   dogfood plus the deterministic 2,500-issue fixture.
5. Squash-merge. One logical change, one commit.

The PR template asks for the blast radius and for the four boxes; those are the questions that have
actually caught things.

## What blocks a merge

Everything in `ci-required`. It is a fail-closed aggregate job so that branch protection has a
single context to require, and so a newly added check cannot be forgotten in the branch-protection
settings.

| Gate | What it refuses |
|---|---|
| `npm run lint` | a shipped file that does not parse |
| `npm test` | a fixture regression, and every Control Room and traceability assertion |
| `node bin/forma.mjs check` | the committed model disagreeing with the code, the documents, or a generated artifact |
| `scripts/browser-gate.mjs` | runtime overflow, unbounded issue DOM, false rendered claim state, Axe A/AA findings, keyboard-inoperable maps, sub-44 targets or an unbounded/static-incomplete PDF |

## Amending an invariant

An invariant is not amended by editing prose. Write the check first, watch it fail on purpose, then
write the row — the procedure is stated at the end of `GLOBAL_INVARIANTS.md`. Removing one requires
saying what now prevents the failure it was there to prevent.

## Superseding an ADR

ADRs are immutable once Accepted. To change a decision, write a new ADR that links back and states
what changed and why the earlier reasoning no longer holds. ADR-0005 superseding the tab layout and
ADR-0007 re-nesting it are the worked example: the record shows the shape was built, measured and
rejected, which is information the current layout alone does not carry.

## Documentation governance

The canonical document set, the solo tier, and the overlays that apply are declared in
[`standards/gold-doc-set.yml`](../standards/gold-doc-set.yml) and
[`standards/doc-profile`](../standards/doc-profile). The external `arbiter` engines are an optional
local audit; required public CI does not depend on them. Commands are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

Two conventions follow from that standard and apply to every hand-authored document here:

- **Frontmatter is mandatory** — eight keys, with `last_review` as an ISO date and `doc_version` as
  semver. `doc_version` is per-document content versioning and is independent of the product
  version; the split is explained in [`SEMVER.md`](SEMVER.md).
- **`tags` is a closed vocabulary.** Adding a tag that the standard does not define is a violation:
  extend the taxonomy first.

## The AI question

Forma is built with AI assistance, and [`AGENTS.md`](../AGENTS.md) is the contract an agent works
under. The governance position is one sentence: **no model's output is trusted, only its work is
reviewed.** Every claim an agent adds must arrive with the check that falsifies it, which is the
same bar a human contribution meets. `gen --enrich` is the one place a model writes into an
artifact, it is opt-in behind an explicit flag, it fills prose holes only, and nothing it produces
reaches a gate.
