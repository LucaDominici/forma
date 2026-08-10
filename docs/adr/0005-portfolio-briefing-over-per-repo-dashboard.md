# ADR-0005: A portfolio briefing, not a per-repository dashboard

- **Status:** Accepted (2026-08-10)
- **Refines:** [ADR-0004](0004-control-room-as-a-forma-rendering.md)

## Context
ADR-0004 established the Control Room as a rendering of Forma over one repository, filed into
tabs. Built and measured across three real programmes, that shape answered the wrong question.

Measured on 2026-08-10: 4141 issues, 53 open, 11 waiting on a human (haben 6 open / 4 waiting,
arbiter 16 / 7, viafera 31 / 0). The question worth answering at the end of a day is not "what is
the state of one repository" but "across everything running, what needs me". A per-repository
artifact forces the reader to open three files and hold the comparison in their head.

Two further faults were structural, not cosmetic. Tabs file content by category, but the room is
one dataset in several projections, so filing it hides the property that distinguishes it from any
other dashboard: every claim can be drilled to its evidence. And a dashboard has no thesis, while
the honest reading of this data is a thesis.

## Decision
The Control Room is a **portfolio briefing**: one artifact over N programmes, in reading order
(the verdict, what waits on you, what moves, what does not add up, the map, the programme), with
evidence expanding in place so that verifying a claim never means changing view.

- `forma room` takes one manifest listing programmes; the per-repository flags are gone.
- `deriveAll` stays per programme, unchanged, because `check` re-derives and compares it.
  `derivePortfolio` sits above it.
- A programme without a curated architecture model still participates through its issues, git
  history and documents; only the map is missing, and the briefing says so.
- "Waiting on a human" is declared per programme and never inferred, because the three measured
  repositories use three different conventions and one uses none.

## Consequences
- + The cross-programme question is answered in one screen, which is the reason the artifact exists.
- + Two of three programmes participate today with no curation work at all.
- + One composer, one gate, one template, instead of N artifacts to keep consistent.
- − One file now concentrates issue titles, labels and architecture for several private
  repositories. That is materially more sensitive than the separate artifacts, and publishing it
  becomes a deliberate owner decision rather than a default.
- − The artifact grows with the number of programmes. Measured at 975,986 bytes for three.
- − Reversing this would mean re-splitting the composer; the derivation layer would survive intact.
