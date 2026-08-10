# Design

The choices that shaped Forma, and the alternatives that were rejected. A decision with no
recorded alternative is indistinguishable from an accident.

Decisions with lasting architectural consequence get an ADR in [`adr/`](adr/). This file holds the
reasoning that is too broad for one ADR, and the roads not taken.

---

## D1. Generate the model, curate the meaning

**Choice.** `gen` derives structure from code, and everything a machine cannot know (what a
container is *for*, which packages form a domain, what state a module is in) comes from curated
JSON that a human or an agent edits.

**Rejected: derive everything.** Tried and measured. On a real 53-package Go repository the fully
derived container level is a 7 by 8 wall in which 85 to 91 percent of the 189 arrows cross boxes
that are not their endpoints, at any grid shape. The layout cannot solve it; only drawing fewer
boxes can, and choosing which boxes is judgement.

**Rejected: curate everything.** Then it is a diagram again, and it rots.

**Cost, stated.** Grouping 53 packages into six domains was about 89 seconds of scripted editing
and 30 to 60 minutes of thinking by someone who knows the repository. That is the real price, and
it is charged once per repository, not once per change.

## D2. The gate re-derives rather than trusts

**Choice.** `check` recomputes the truth from raw inputs and compares. It never accepts a
committed number, and it never reads the artifact it is checking.

**Rejected: checksums.** A hash proves the file did not change. It cannot notice that the file was
always wrong, which is the failure that matters.

**Rejected: parsing the generated HTML.** It works on the day it is written and drifts the first
time the template moves. That is why `lib/roomderive.mjs` exists as one module shared by the
composer and the gate: if they computed differently, the gate would prove nothing.

## D3. Overlays, not a wider schema

**Choice.** New kinds of fact get their own file with their own lifecycle: `c4-status.json`,
`c4-issues.json`, `c4-health.json`, `c4-findings.json`.

**Rejected: adding fields to the node.** The model's root and node objects are
`additionalProperties: false` on purpose. More importantly, these facts have different lifetimes:
structure changes when code changes, issue state changes hourly, an audit verdict is a dated
judgement. One file holding all three would be stale in at least one dimension at all times.

**Consequence accepted.** More files to explain. The reading map in [`README.md`](README.md)
exists because of this decision.

## D4. Issues link to code through git, and only through git

**Choice.** An issue reaches a C4 node because a commit citing it touched a file that node owns.

**Rejected: a curated map.** It would be more precise per entry and would not scale past a few
dozen, and it would be a second authority on the same fact.

**Rejected: labels.** `domain:backend` tells you where somebody said they were working, not where
the work landed.

**Measured.** Coverage is 69 percent on haben, 54 on arbiter, 56 on viafera. The remainder stays
unknown. Partial and honest beat complete and invented.

**Two rules the data forced.** A commit touching more than a threshold of files attributes to
nothing, because a sweep is not a change (1 to 3 percent of commits, p99 64 to 101 files). And a
`#N` preceded by a word character belongs to another repository: `viafera#3807` cited inside a
haben commit does not resolve as a haben issue at all.

## D5. A briefing, not a dashboard

**Choice.** One reading order, thesis first, evidence expanding in place, covering the whole
portfolio.

**Rejected: tabs.** Tabs file content by category, but the Control Room is one dataset in several
projections. Filing it hides the thing that makes it different from any other dashboard: every
claim can be drilled to its proof. Following evidence is the natural movement, so the structure
should be evidence, not cabinets.

**Rejected: one artifact per repository.** Measured across three real programmes: 4141 issues, 53
open, 11 waiting on a human. The question worth answering is which of the 11, and a per-repository
artifact forces the reader to hold the comparison in their head.

**Consequence accepted.** A single file now concentrates issue titles, labels and architecture for
several private repositories. That is a more sensitive artifact than the three separate ones, and
publishing it is a decision its owner has to make deliberately.

## D6. Colour means evidence

**Choice.** Saturation is reserved for claims that carry a resolvable reference. Everything else is
neutral ink on a neutral ground. The reader can scan for colour, and every coloured thing is
checkable.

**Why this and not a house style.** It makes the product's doctrine visible instead of merely
documented. It also rules out the two reflexes a tool like this falls into: the navy-blue developer
dashboard and the green-on-black terminal.

**Verified, not judged by eye.** Both palettes were run through the measurement script. The status
trio sits in the 6 to 8 CVD separation band, which is legal only with secondary encoding, so every
status ships as glyph plus word plus colour, never colour alone. The ordinal ramps pass every
check.

**Consequence.** Most charts are emphasis (one accent against a de-emphasis grey) or a single hue.
There is deliberately no categorical palette, because no view needs to tell many nominal series
apart.

## D7. Determinism over freshness

**Choice.** `today` comes from the manifest. No derivation path reads a clock.

**Rejected: the system clock.** Convenient, and it makes the gate non-reproducible: the same inputs
would produce different verdicts on different days, so a failure could never be trusted.

**Cost, stated.** The manifest must be updated for the dates to be meaningful, and a stale `today`
produces a confidently wrong "days ago". `room-presentable` therefore fails on a snapshot older
than a declared threshold.

## D8. Refuse rather than degrade

**Choice.** `room` refuses to build on a truncated issue snapshot. `applyVerdicts` throws on an
unresolvable reference. `check` fails on a stale registered document.

**Rejected: warn and continue.** The whole product exists because a wrong picture that keeps being
shown is worse than no picture. Building the artifact anyway, with a warning nobody reads in a log
nobody keeps, reproduces exactly that failure.

## D9. Wording is part of the contract

Two examples where a name was chosen to make misuse hard.

- `closureRate`, never `completion`. Closed over total is a measurement of issue closure, not of
  work being finished, and the publication gate enforces the distinction.
- `daysSinceLastLanding`, never `waitingDays`. Git knows when work landed; it does not know when
  someone started waiting. The interface says "last work N days ago" for the same reason.
