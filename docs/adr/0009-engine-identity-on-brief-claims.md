---
title: 'ADR-0009: Engine identity on brief claims, so cross-engine holds are enforceable'
doc_version: '1.0.0'
status: active
last_review: '2026-09-14'
owner: 'Luca Dominici'
canonical_id: '0009'
tags: ['audience/dev', 'kind/adr']
related: ['docs/adr/README.md']
---
# ADR-0009: Engine identity on brief claims, so cross-engine holds are enforceable

- **Status:** Accepted (2026-09-14)
- **Amends:** the colour rule stated by `lib/schema/c4-brief.schema.json` and `lib/audit.mjs`
  (`classifyVerification`) since the brief shipped; no prior ADR recorded that rule, so this one is
  the first to state it explicitly.

## Context
The brief's whole claim is: a claim is coloured only while an independent counter-verifier holds
it. "Independent" was never a different *engine* in the code, only a different *date* — nothing in
`c4-brief.schema.json` recorded which engine (Claude, Codex, a human) wrote a claim's text, or
which engine wrote its `verified` verdict. A same-day, same-engine `holds` coloured a claim exactly
like a genuinely hostile, cross-engine one.

Issue #99's counter-verification run against the viafera room made this concrete: before a real
Codex counter-verify, 7 of 15 brief claims were `holds`, all stamped the same day by whichever
agent had written the brief — never adversarially re-checked. After Codex ran, only 1 survived. The
schema could not have caught the other 6 on its own: it had no field to check.

## Decision
`claim.author.engine` and `claim.verified.engine` — free-form model-id strings, both optional.

- **Author.** `forma audit --apply ... --audit-plan ...` stamps `author.engine` from a new
  `--engine <id>` flag on every claim it creates or rewrites, the same way it already stamps
  `writtenAt`/`evidenceHash` — never from the fill's own JSON (a fill claiming its own engine would
  defeat the whole point). An unchanged resubmission keeps the original `author`, like it already
  keeps the original `verified`.
- **Verifier.** The counter-verify apply (`--apply ... --counter-plan ...`) stamps
  `verified.engine` from the same `--engine <id>` flag onto every verdict it writes that apply.
- **The gate.** `classifyVerification` colours a `holds` only when `author.engine` and
  `verified.engine` are both present and different. Same engine, or either side missing (every
  brief written before this ADR, and any claim applied without `--engine`), yields a new derived
  state, `self-held`: the raw verdict stays on the claim (nothing is thrown away or silently
  rewritten), the room renders it grey with the word, and the header count for held claims no
  longer includes it (`counts.selfHeld` is now separate from `counts.holds`).
- **Compatibility.** Both fields are optional and `additionalProperties: false` scoped to their
  own objects. A legacy brief with neither field validates unchanged and renders every prior
  `holds` as `self-held` from now on — the honest read, not a crash: nothing on file records who
  verified those claims, so nothing can call it independent.
- `lib/roomupdate.mjs` gained `--author-engine` (for `room update --fill`) and `--verifier-engine`
  (for `room update --counter`), each forwarded to the `audit.mjs --apply` subprocess that flag
  spawns. `--fill` and `--counter` are refused together (#123 follow-up: `--fill` always re-plans
  from the current state before applying, so a counter result from any earlier plan is stale the
  moment a combined call re-plans again) — every invocation therefore carries exactly one of the
  two engine flags, never both on the same apply.
- `adapters/codex/forma-counterverify` and the `forma-room-update` rituals (Claude and Codex) were
  updated to always pass their own engine flag on their respective `room update` call, one writing
  `--author-engine` and the other `--verifier-engine`, so the two identities never collide.

**Rejected: infer the engine from `writtenAt`/process environment.** Forma runs offline with no
network and no model call (ADR-0001); it has no channel to observe which model is driving the CLI
beyond what the invocation declares. The `--engine` flag is the same trust boundary `--today`
already crosses: an external fact, named at the command line, never invented by `audit.mjs` itself.

**Rejected: require `--engine` and refuse `--apply` without it.** That would break every existing
manifest overnight for a flag most operators have not started passing yet. Missing engine already
has a defined, honest meaning (`self-held`, `unknown`) — refusing outright would trade a silent bug
for a hard outage on the same day this ships.

**Rejected: a boolean `verified.independent` set by the fill.** Delegates the exact judgement this
ADR exists to make unforgeable back to the fill — a same-engine verifier could just assert
`independent: true`, and forma would have no way to check it, the same hole #99 found in the first
place.

## Consequences
- + The colour rule ("a claim gets colour only on a fresh `holds` from a different engine") is now
  something `check` and the schema can actually enforce, not just something the SKILL prose asks
  for.
- + `self-held` is additive: nothing that already read `state === 'holds'`/`coloured` needed to
  change; the new state only subtracts from what used to render as held.
- − Every brief that predates this ADR loses its coloured claims the next time `room update` runs,
  until it is re-verified with `--engine` recorded on both sides. That is the correct outcome (the
  colour was never actually earned), but it is a visible, one-time regression on every existing
  Control Room's held count.
- − `--engine` is a free-form string forma does not validate against a known list — a typo
  (`"calude"`) silently looks like a different engine from `"claude"` and grants colour. Left as a
  known gap: a closed enum would need forma to maintain a registry of engines it has never itself
  needed to know about.
