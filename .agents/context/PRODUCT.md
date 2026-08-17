---
title: 'Forma — product context'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'product-context'
tags: ['audience/dev', 'kind/reference']
related: ['docs/PRD.md', 'docs/DESIGN.md']
---
# Forma — product context

Design context for anyone (human or agent) shaping this product's interface. It answers who it is
for and what it must not become. What the product must *do* is [`docs/PRD.md`](../../docs/PRD.md),
and the visual system with its measurements is [`docs/DESIGN.md`](../../docs/DESIGN.md) §D6. This
file repeats neither, and lives outside `docs/` so it stays out of the governed doc set.

A tooling note, since it costs someone an hour otherwise: the impeccable context loader resolves a
single directory, so with this file here it stops finding `docs/DESIGN.md`. Symlinking that file in
was tried and reverted — the link checker then resolves its relative links from the wrong directory
and reports three false breaks. Read §D6 directly.

**register:** product

## What it is

A zero-dependency CLI that turns a codebase into an interactive C4 explorer and a portfolio
briefing, plus a deterministic gate that fails when either stops matching the code.

The product is not the picture. It is **the picture plus the reason to believe it.**

## Users

**The engineer who owns a system.** Reads the explorer. Wants to explain their architecture without
maintaining a diagram, and wants CI to fail when it drifts. Comfortable with a terminal, hostile to
ceremony, will abandon a tool that asks for discipline.

**The person deciding what to do next.** Reads the briefing at the end of a day, across several
programmes. Needs one question answered — *what actually needs me* — and needs to be able to check
the answer without leaving the page.

**A stakeholder who was handed the artifact.** Did not run anything. Gets a file or a link, often
printed. Must understand it cold, in ten seconds, with no vocabulary lesson.

**An agent driving the tool.** Needs a contract, not a UI. Every command is a plain Node script over
documented JSON.

## Voice and tone

Plain, declarative, unhedged. State the number and where it came from. Never enthusiastic, never
apologetic.

Say what is *not* known as readily as what is: `unknown`, `not audited`, `not measured` are
first-class answers and are written as words, not left as blanks. A caveat is information, not an
excuse.

Name things by what they are to a reader, never by the mechanism: "last work 3 days ago", not
"daysSinceLastLanding". Where a word carries a contract, the contract wins over the friendlier
synonym — `closureRate` is never called `completion`, because it measures issue closure and not
work being finished.

Italian and English are peers. Every user-visible string exists in both, and neither is a
translation of the other.

## What the interface must do

- **Fit the screen.** Seven views, each within the viewport at 1920×1080, more generous at
  3440×1440. Panels scroll inside themselves; the page does not.
- **Print whole.** The artifact replaces a status deck, so it has to survive being handed over on
  paper: every view, one per page.
- **Show its provenance.** No panel without a line saying what was counted and what re-checks it.
- **Reserve colour for evidence.** Saturation only where a claim carries a resolvable reference.
  Every status ships as glyph **and** word **and** colour, never colour alone — the palette is
  measured by `scripts/palette.mjs` and the gate fails if the encoding is removed.

## Anti-references

Things this must never be mistaken for:

- **A status dashboard with green boxes.** The whole product exists because those cannot be
  falsified. Any surface that cannot be drilled to its evidence does not ship.
- **The navy-blue developer dashboard**, and **the green-on-black terminal**. Both are the reflex
  answer for this category. The palette is warm-neutral for that reason, and it is measured.
- **A hero metric with a gradient.** A big number over a small label with a coloured glow is the
  SaaS template. The one large thing on any screen is a sentence, not a figure.
- **A wall of identical cards.** Panels are regions delimited by a hairline and a heading, on the
  same ground. No boxes, no shadows, no nesting.
- **A tool that needs a manual.** If a view needs an explanation, the view is wrong.

## Strategic principles

1. **Density is earned by restraint, not by shrinking.** The answer stays large; everything else is
   10–14px so it can afford to be.
2. **Refuse rather than degrade.** A truncated snapshot, an unresolvable reference, a document over
   budget: name it and stop. A warning nobody reads reproduces the failure the product exists to fix.
3. **Absent is not empty.** A rule nobody declared and a rule declared as empty are different facts
   and never render the same.
4. **One thing is bold per screen.** Spend it on the thesis.
