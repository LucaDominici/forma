---
title: 'Control Room — UX pattern inventory'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'ux-inventory'
tags: ['audience/dev', 'kind/audit']
related: ['.agents/context/PRODUCT.md', 'docs/DESIGN.md']
---
# Control Room — UX pattern inventory

Produced with Intent in `extract` mode against the built artifact at 1920×1080 (dark), commit
05b4a49, programme `forma` (8 issues, all closed). Sibling to
[`PRODUCT.md`](PRODUCT.md), which states who this is for and what it must not become. This file
records what the interface *currently does* to that reader, and routes each gap to the discipline
that owns it.

Kept outside `docs/` for the same reason PRODUCT.md is: it is design context, not a governed
document.

---

## Evidence base, stated before the findings

- **Observation:** seven routes, built artifact, real data, 1920×1080 and 3440×1440.
- **No user research exists.** Not one person outside the author has used this. Every claim below
  about what a reader will understand is a **hypothesis**, not a finding. Five participants would
  settle most of them (Nielsen & Landauer 1993); nothing here substitutes for that.
- **n = 1 exemplar.** Every observation is against a programme with 8 issues, all closed. A
  portfolio with three active programmes would surface different defects and hide these.

---

## What is working, and why

| Pattern | Why it serves the reader |
|---|---|
| **Provenance line under every heading** | Answers "why should I believe this" without leaving the panel. Nothing else in this category does it. It is the product's thesis rendered as an interface rule, and it holds on all seven views. |
| **"What this briefing does not know"** | Absence is *counted and named*, not dropped. "Architecture source is 10 commits behind HEAD" is the single most actionable sentence in the artifact. This panel is the differentiator. |
| **Thesis-first reading order** | Each view opens with one sentence in the only large type on the screen. A reader who reads nothing else has an answer. |
| **Every claim drills to evidence** | Row → verdict → evidence ref → source line. Anti-pattern defence by construction: there is no green box that cannot be falsified. |
| **Status as glyph + word + colour** | Never colour alone, and the gate fails if the encoding is removed. Accessibility as a structural property rather than an audit result. |

---

## What is failing, and why

### F1 — The artifact reads as broken because it is shown in its emptiest state. *(Dead Ends, Cat 9, High as shipped)*

On the flagship instance — the one published to Pages as the product's demonstration:

- The first screen says **"0 things need you out of 0 open across 1 programmes."** Three zeros in
  the one sentence that is supposed to carry the answer.
- `#/forma/tech`: five of six tiles are `0`; two of three panels say "No …".
- `#/forma/exec`: "Open work over time" is a flat line at zero; "Priority distribution" says
  **"No data available."**; "Cumulative code landings" exists to say one month is not a series.
- `#/` "Closed and open work" renders as **one unlabelled grey bar**.

Each of these is *honest*. Together they are a first impression of a dead project or a broken tool.
PRODUCT.md promises a stakeholder understands it "cold, in ten seconds" — cold, in ten seconds,
this reads as neither working nor worth reading. **Truthful and unusable are not exclusive.**

An empty state is a design surface, not the absence of one. Right now there are three different
non-answers in use — "No data available.", "No findings supplied.", "Nothing is waiting on you in
this snapshot." — and only the third tells the reader that the emptiness is *good news*.

### F2 — Panels hold their row height whether or not they have content. *(structural)*

The grid was sized against a fixture dense enough to fill it. On the real instance roughly 40% of
every screen is void: on `#/forma/exec` a chart occupies ~150px of a ~430px row. The "fits the
screen" property is currently satisfied *by emptiness*, which is not the same achievement.

### F3 — Four of eight columns in the traceability matrix are constant. *(low signal density)*

On `#/forma/wbs`, `Role` reads "requirement" nine times, and `Satisfies`, `Issues` and `Closed` read
`—` nine times. A table whose columns never vary is a list wearing a table's clothes; it costs the
reader four column-scans to learn nothing.

### F4 — Mechanism names leak into labels. *(Jargon Overload, Cat 9, Medium)*

"Work landed per C4 node" is labelled `lib__gen_mjs`, `test__run_mjs`, `lib__check_mjs`. PRODUCT.md's
voice section forbids exactly this: *"Name things by what they are to a reader, never by the
mechanism."* These are node ids with separators substituted. The reader's name for that thing is
`lib/gen.mjs`.

### F5 — A milestone label is clipped and in the other language. *(Medium)*

"Milestone completion" renders `:onfine — sostituire PowerPoint` — the left edge is cut, and the
string is Italian inside an English UI. The text is user data from GitHub, so the language is not a
bug; **the clipping is**, and a long label has no defined behaviour.

### F6 — The exemplar contradicts the product's central promise. *(strategic)*

The requirements matrix exists so that "GitHub issues represent the complete WBS". On the published
demonstration, requirements landing on issues is **0 of 9** — all nine are accounted for by naming a
verification instead. The claim is true as stated and the gate is honest, but the artifact chosen to
demonstrate the chain is the one instance where the chain's headline case does not appear.

---

## What is manipulative

**Nothing.** The anti-pattern catalog was walked end to end. No urgency, no scarcity, no engagement
mechanics, no consent surfaces, no persuasion — this is a read-only briefing with no conversion goal
and no user data collected. The one structural risk (a single file concentrating issue titles and
architecture for several private repositories) is already named as a deliberate consequence in
DESIGN.md §D5 and PRIVACY.md, and publication is an explicit human decision.

Two catalog entries land, both in Category 9 (failure by negligence, not by intent): **Dead Ends**
(F1) and **Jargon Overload** (F4).

---

## What is missing

| Missing | Consequence |
|---|---|
| **A designed empty state per view** | F1. There is no inventory of the states each view can be in, so the zero case is whatever falls out. |
| **A stated success metric** | Nobody can say whether the briefing worked. "Replaces a status deck" is a goal, not a signal. |
| **Any user research** | Every usability claim in this repo, including this file, is a hypothesis. |
| **A first-run explanation** | A reader who receives the file cold gets no statement of what a "programme", a "blocking rule" or "accounted for" means. GLOSSARY.md exists but is not reachable from the artifact. |

---

## Routing

| # | Finding | Skill | Order |
|---|---|---|---|
| F1 | Empty and zero states, all seven views | `/fortify` | 1 |
| F2 | Panels hold height with no content | `/wireframe` | 2 |
| F4, F1 | Non-answer copy, mechanism labels, three-zero thesis | `/articulate` | 3 |
| F3 | What belongs in the matrix | `/organize` | 4 |
| F5 | Label clipping and overflow behaviour | `/fortify` (same pass as F1) | 1 |
| F6 | Is forma the right subject for its own demonstration | `/strategize` | human decision |
| — | No success metric | `/measure` | after F1–F4 |
| — | No research | `/investigate` | named as a gap, not scheduled |

**Exit condition for the F1–F4 loop:** every view has a defined and designed state for zero, one,
and many; no panel reserves height it does not use; no label names a mechanism. Then re-run
`/evaluate` against the same seven routes.

---

## Status at 2026-08-10, and what the next session picks up

Three review passes ran against this branch: a hostile code review (nine defects, four of them
written by the previous round of fixes) and a third hostile UX/a11y audit (fourteen, four blocking).
The commits from `902a3e6` to `9cd5e58` close everything below marked **done**. Eleven gates green
at `9cd5e58`; the working tree is clean apart from two untracked scratch files (`PLAN.md`,
`PLAN-REVIEW-LOG.md`).

### Closed, with the measurement

| | before | after |
|---|---|---|
| `renderMarkdown` on a lone CR / U+2028 | **browser hangs, heap death** | renders, ≤1ms |
| specificity gate vs three gate-green print-palette breaks | 3 of 3 passed | 3 of 3 fail; canonical `prefers-color-scheme` stays green |
| unreadable token value under `--check` | silently unmeasured, exit 0 | fails, naming the role it holds |
| landing thesis | "0 things need you out of 0 open across 1 programmes." | "Nothing is open in this programme." + what the panels are showing |
| landing charts | one grey bar, 0 text elements | "8 closed" / "0 open"; the zero case states why |
| map theme | L=97% plate in an L=17% page, both themes | follows the theme; 7 palettes measured |
| map controls reachable by Tab | 7 developer controls | 4 reading controls |
| printed map | 4.9pt body, blank or racing | 8.7pt body, 11.2pt titles, deterministic |
| map staleness | absent, beside a green 63% | "Architecture source is 13 commits behind HEAD." |
| printed identity | 7 of 29 pages | 35 of 35, with page numbers |
| print vs stored theme | all 29 pages differed | 34 of 35 byte-identical; page 6 differs in 417 of 242,604 px (0.17%) at glyph edges, no colour difference |
| reduced motion in the map | 4 infinite animations ran | none (WCAG 2.2.2 Level A) |
| markdown semantics | 9 fake headings, 0 real; `1.` joined into prose | 9 real `h3`–`h4`, 7 lists, ordered lists preserved |

### Open, in the order I would take them

1. **F2 / audit #8 — panels reserve height they do not use.** `/options` is 83% blank at
   3440×1440, `/` is 69%. The content is honest; the layout is not, and a 320px panel holding one
   line reads as content that failed to load. `/wireframe`. This is the largest remaining item and
   the one the client will feel.
2. **Audit #7 — the map is mouse-only and invisible to assistive technology.** 0 focusable elements
   for 6 nodes, no `role`, no `<title>`, and instructions written entirely in mouse vocabulary. The
   product already has the pattern to fix it: every chart ships a table twin. `/include`.
3. **Audit #9 — `#/` at 1920×900 slices its last panel mid-glyph at the fold.** Recoverable through
   a 99px inner scroll, which is the only affordance. Related to (1) and probably fixed by it.
4. **Audit #10 / F4 — client-facing copy carrying internals.** "64074 of 120000 bytes used" is a
   build budget on a client's page; `lib__gen_mjs` names a node id where the reader's name is
   `lib/gen.mjs`; "the only file the served page can write" reads like a half-written security note.
   `/articulate`.
5. **F3 — four of eight columns in the matrix are constant.** `/organize`.
6. **Audit #12, #14 — the tooltip ignores Escape; a single-file deliverable requests
   `/favicon.ico` and logs a 404 in the client's console.** Both small.
7. **Audit #13 — nested markdown lists flatten.** Latent: the current corpus has none, but this
   renderer ingests arbitrary client documents.
8. **F6 — the demo shows 0 of 9 requirements landing on issues**, on the artifact chosen to
   demonstrate that issues are the whole of the work. Decided 2026-08-10: leave forma as the
   subject and let the empty states carry it; revisit if the demo is ever pitched as the proof of
   the chain rather than of the briefing.

Not scheduled, and named rather than owed: no user research exists (`/investigate`), and no success
metric is defined (`/measure`). Every usability claim in this file remains a hypothesis.
