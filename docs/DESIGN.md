---
title: 'Design'
doc_version: '1.1.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'design'
tags: ['audience/dev', 'kind/reference']
related: ['docs/PRD.md', 'docs/adr/README.md']
---
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

**Verified, not judged by eye — and for a while that was not true.** This paragraph used to claim
both palettes had been run through "the measurement script". No such script was in the repository,
and `scripts/presentable.mjs` carried no colour predicate, so nobody could reproduce the claim.
Writing [`scripts/palette.mjs`](../scripts/palette.mjs) and running it found what the claim was
hiding: four contrast failures in the briefing, four more in the explorer, a pure `#ffffff`, and a
status trio whose worst pair measured **3.1**, not the 6 to 8 this paragraph asserted.

**What the measurement says now.** Every token is OKLCH, and the numbers below come out of
`node scripts/palette.mjs`, which `npm test` runs.

| Measure | Briefing dark | Briefing light | Explorer holo | Explorer blueprint |
|---|---:|---:|---:|---:|
| lowest text ratio | 4.70:1 | 4.61:1 | 4.61:1 | 4.61:1 |
| lowest chart-mark ratio | 3.25:1 | 3.20:1 | 3.21:1 | 3.21:1 |
| worst status pair under CVD | 7.2 | 8.5 | 7.2 | 8.5 |

The trio is separated by **lightness on purpose**, because lightness is the one channel that
survives colour-blind vision: before, `ok` and `bad` sat within 0.02 of each other in OKLCH L and
collapsed to a separation of 4.2 under simulated deuteranopia. Even so, the worst pair stays inside
the ambiguous band, which is legal *only* with a secondary encoding — so the script also reads
`statusMark()` out of the shipped template and fails if the glyph or the word ever stops rendering.
Two halves of one rule, both enforced.

**The embedded explorer is not a second look.** `blueprint`, the skin the Control Room puts in its
map view, was a cold blue-grey inside a warm briefing and had a recorded defect where its statuses
"read alike". It is now literally the briefing's light palette mapped onto the explorer's token
names. The `holo` skin keeps its own identity: it is the standalone artifact, with its own audience.

**Consequence.** Most charts are emphasis (one accent against a de-emphasis grey) or a single hue.
There is deliberately no categorical palette, because no view needs to tell many nominal series
apart.

**Paper is the third palette, and declaring it was not enough.** Setting only `body{color:#000}` had
left every token at its dark value, so chart numbers printed at 1.23:1 against white. Declaring a
print palette fixed the numbers and not the output: a media query adds no specificity, so
`@media print{:root{…}}` scores (0,1,0) and `html[data-theme="light"]` scores (0,1,1) and wins.
Every reader who had ever pressed the theme button printed the screen palette, and the dark case
passed only by tying the base `:root` on source order. The measurement script was reading the
declaration and reporting a number half the readers never got — the same defect as the missing
script, one layer in. It now derives every rule in a file that declares the ground token and fails
if any of them ties or beats the print rule.

| Measure | Briefing print |
|---|---:|
| lowest text ratio | 4.97:1 |
| chart values (`.svg-value`) | 17.32:1 |
| provenance and axis labels | 7.78:1 |

- **Enforced by:** `node scripts/palette.mjs --check`, inside `npm test`.
- **Red when:** a text token drops below 4.5:1 or a chart mark below 3:1 against either ground; a
  pure `#000`/`#fff` appears; chroma is pushed against the ends of the lightness range; the status
  trio is ambiguous under CVD while the glyph-and-word encoding is gone; or a theme selector reaches
  the specificity of the print palette, so that what is measured is not what applies.

## D10. The screen is the frame, and the floor is declared

**Choice.** The briefing is an application in a fixed shell — `100dvh`, one 52px bar, panels that
scroll inside themselves — and not a document that scrolls. Width earns columns: two below 1500px,
three to 2299, four above. There is no `max-width`.

**Why.** Measured before the redesign, on the smallest possible fixture: the executive view ran
1385px past a 1920×1080 screen, 2.3 screenfuls; and on a 3440px monitor `main` was 1180px wide, so
2260px — 66% of the display — was blank. That is the worst of both, wasting the axis you have and
overflowing the one you do not.

**The floor is 1920×1080 as a viewport, which is ~900px of real `innerHeight`.** Browser and system
chrome take 130–200px off an FHD monitor, so designing against 1080 is designing against a screen
nobody has. The budget is 900 − 52 bar − 32 padding ≈ **815px of content**.

**At the floor the evidence tier scrolls inside its own frame, and that is the design, not a
shortfall.** At 1920×900 the portfolio view holds 476px of evidence in a 376px frame: 100px sit
behind an internal scrollbar rather than lengthening the page. Every view answers its question in
the fixed tier above; the tier that scrolls is the supporting evidence. On a 3440×1440 monitor the
same content fits with nothing hidden, which is how the extra pixels pay: more answer, not more
white.

**Below the floor the shell is released rather than crushed** — the page scrolls, and it is a
deliberate exit. The two arms are separate rules: below 1199px wide the layout also collapses to one
column, because it is narrow; below 761px tall it keeps whatever columns the width earned, because
it is only short. Folding them together turned a half-height ultrawide into a single 3381px column
with a 2096px document.

**Rejected: a height that adapts by hiding.** Dropping panels at small heights would make the
briefing say different things on different screens, and a briefing that omits without saying so is
the artifact this product exists to replace.

- **Enforced by:** measurement in a real browser, in CI, not by a regex over CSS text in `npm test`
  — a pattern match cannot fail for the right reason. See [`docs/technical-debt.md`](technical-debt.md).
- **Red when:** any route overflows the viewport at 3440×1440 or 1920×900.

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
