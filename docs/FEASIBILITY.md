---
title: 'Feasibility'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'feasibility'
tags: ['audience/dev', 'kind/audit']
related: ['docs/DESIGN.md']
---
# Feasibility

What is measured, what is estimated, and what is unknown. The three are kept apart on purpose: a
plan that mixes them reads as confident everywhere and is trustworthy nowhere.

Every number below is either sourced or explicitly marked as not measured. If you add one, say
which it is.

---

## 1. Measured

Taken from real runs against real repositories on 2026-08-09 and 2026-08-10. Three private Go,
TypeScript and Java/TypeScript repositories, plus Forma itself.

### The issue corpus

| Programme | Issues | Open | Waiting on a human | Milestones |
|---|---:|---:|---:|---:|
| haben | 466 | 6 | 4 | 7 |
| arbiter | 1429 | 16 | 7 | 11 |
| viafera | 2246 | 31 | 0 | 9 |
| **total** | **4141** | **53** | **11** | |

The decidable surface is 53 items out of 4141, and 11 of those need a person. That ratio is the
reason the Control Room is a briefing and not a wall of gauges.

### The issue-to-code link, from git

| Programme | Coverage | Note |
|---|---:|---|
| haben | 69% raw, 52% against the curated model | the model is 521 commits behind head |
| arbiter | 54% | no curated model |
| viafera | 56% | no curated model |

Noise, measured rather than guessed: median 2 to 4 files per commit; p99 64 to 101; only 1 to 3
percent of commits exceed 50 files. On haben, 16 commit sweeps were excluded and named.

### Label vocabularies

`priority` and `size` recur in all three repositories. Each also grows its own families: arbiter
adds `tier`, `wave`, `release`, `audit`; viafera adds `type`, `domain`, `status`, `invariant`,
`risk`. viafera's `priority` family contains `p2`, `P2` and `high` at once. This is why detection
is automatic with a declared-override, and why nothing in `lib/` hardcodes a label.

### The document corpus

| Programme | Tracked Markdown | Bytes |
|---|---:|---:|
| haben | 370 | 3.9 MB |
| arbiter | 569 | 3.7 MB |
| viafera | 229 | 3.3 MB |
| **total** | **1168** | **11.1 MB** |

A naive walk of haben finds 8899 files and 70 MB, because 8544 of them are agent working copies
under `.claude/worktrees`. Any document feature must select from git-tracked files and carry an
explicit budget.

On haben, three documents carry almost the whole model: its feature matrix supports 27 nodes
through `verify.source` and describes 25 through `descSource: docmap`; its product-boundary document
carries the timeline; `docs/architecture/ARCHITECTURE.md` is the governed document path.

### The artifact

The generated portfolio briefing is 975,986 bytes across three programmes, with the architecture
viewer embedded once. It contains 13 charts, each with a table twin, and 80 keyboard-reachable
marks. Both themes render; the console is clean apart from a favicon request.

### Environment

Codex's local sandbox does not start on this machine: `bwrap: loopback: Failed RTM_NEWADDR`,
reproduced by invoking `bwrap` directly, caused by
`kernel.apparmor_restrict_unprivileged_userns = 1`.

## 2. Estimated

Marked as estimates. None of these has been executed end to end.

| Work | Estimate | Basis |
|---|---|---|
| curating an architecture model for one uncovered repository | 30 to 60 minutes of human judgement per repository | measured once on haben: 89 seconds of scripted editing plus the thinking, which dominates |
| the document browser with a citation graph | not estimated in hours; bounded by the 11.1 MB corpus figure above, which forces an index-always, text-within-budget design | derived from the corpus measurement, not from an implementation |
| a second repository proving the manifest is parametric | one manifest edit plus one curation, so it inherits the row above | the manifest mechanism exists and is exercised by three programmes, two of them without a model |

## 3. Unknown

Stated rather than guessed. These are the questions that would change the plan if answered.

- **Whether the briefing survives contact with a reader who is not its author.** Every judgement in
  this repository about whether the artifact is useful has been made by the two people who built
  it. That is the same stage-3 gap `docs/SCOPE.md` named for the viewer, in a new place.
- **Whether the git link stays useful at low coverage.** At 52 to 69 percent it is informative. It
  is not known where it stops being worth showing, or whether a repository with a different commit
  convention drops below that.
- **Whether the audit channel scales past a handful of issues.** Five verdicts were written by hand
  against haben's open issues. Nothing has exercised it at fifty.
- **Whether the artifact is readable at its full size on a modest machine.** It opens fine here at
  roughly 1 MB with three programmes. Ten programmes with an inlined document corpus is a different
  file and has not been built.
- **The publishing question.** A single artifact concentrating issue titles, labels and
  architecture for several private repositories is more sensitive than the parts. Whether it is
  ever published is an owner decision that has not been taken.

## 4. What would make this infeasible

Named so the answer is not improvised later.

- A repository whose commits do not cite issue numbers: the link layer degrades to zero coverage
  and the architecture view carries the whole product.
- A programme whose "waiting on a human" concept has no label at all and no equivalent: the
  briefing's first section has nothing to rank, and honestly reports an undeclared rule.
- A hard requirement to publish a live, always-fresh board. Forma's determinism comes from
  snapshots; a live board is a different product with a different honesty story.
