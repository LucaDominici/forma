# ADR-0006: Traceability is derived from the documents, not curated into a file

- **Status:** Accepted (2026-08-10)
- **Refines:** [ADR-0003](0002-single-source-of-truth-model.md) is unrelated; this extends the
  overlay policy of [ADR-0004](0004-control-room-as-a-forma-rendering.md)

## Context
The briefing could count issues and colour them, but nothing connected the work to the reasons for
it. Milestones were the only structure, and a milestone is a bucket somebody made, not a claim that
the buckets cover the job. So the briefing could say "31 open" and never say whether 31 is all of
it — the question a plan is supposed to answer.

The repository already writes the reasons down. `docs/PRD.md` states what must be true,
`docs/DESIGN.md` states the choices that satisfy it with their rejected alternatives,
`docs/FEASIBILITY.md` separates measured from estimated, `docs/DELIVERY.md` states what is proved
and by which command. That is the GAMP 5 V-model in everything but name, and `lib/docmap.mjs`
already reads tables of this exact shape to derive programme state from a capability matrix.

Three ways to connect requirements to work were available.

## Decision
The matrix is a **derivation** (`lib/rtm.mjs`, called by `deriveAll`), computed from markdown tables
in documents the repository already maintains, joined to the `gh` snapshot by issue number.

- A row traces to another row, or to an issue, **because a cell says so**. Forma measures the
  coverage of those declarations; it never infers the trace.
- The gate reports four holes and fails on each: a duplicate id, a reference that names nothing, a
  requirement that lands on no work and names no verification, and an OPEN issue no requirement
  claims. The last two together are the operational definition of "the GitHub issues are the whole
  of the work" — without both, the claim cannot be falsified in either direction.
- Progress per requirement is issue closure, never code (I5).
- Opt-in by presence of an `rtm` block in the manifest (I11), so no existing repository changes
  behaviour.
- Documents are read from `git ls-files`, sorted. `deriveRtm` touches the disk, and `check`
  re-derives it, so the input set must not depend on the state of a working tree. A document edited
  between `forma room` and `forma check` does fail the gate: that is the drift it exists to find.

**Rejected: an overlay file (`c4-rtm.json`).** It would need a writer, the writer a gate, and the
gate another way to disagree with the documents — a second source of truth for a fact the first one
already states. The same argument ADR-0004 made against widening the model schema.

**Rejected: labelling issues with their requirement (`req:R-01`).** It puts the trace in the tracker,
where the design documents cannot see it, and makes the matrix unreadable offline. It also inverts
the direction that matters: the interesting question is which requirement has no work, and a label
can only answer the reverse.

**Rejected: inferring the trace from prose similarity.** This is the one thing the product may not
do. A requirement nobody wrote, matched to work nobody assigned it to, is exactly the invented
number `docs/PRD.md` §4 forbids.

## Consequences
- + The briefing can state coverage of the plan, not just volume of work, and the number moves down
  when someone opens untraced work — a percentage that can go the wrong way is a measurement.
- + Nothing new to keep in sync: the chain lives in documents that are already reviewed.
- + `check` compares every key `deriveAll` returns, so the matrix was gated the moment it existed.
- − The `issues` column is maintained by hand. It cannot rot silently — the gate fails — but it can
  tire. The escape, when it is earned, is `forma rtm --plan` emitting the rows for untraced open
  work in the plan-then-apply shape `enrich` and `audit` already use.
- − A repository with no id columns gets nothing until someone adds them. Adopting the convention is
  real editing work, not a flag.
