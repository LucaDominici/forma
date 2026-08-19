---
name: forma-room-update
description: The "aggiorna control room" ritual — refresh a Forma Control Room end to end. Measure live (never from memory), fill EVERY judgement channel under gate (health verdicts, findings, dependency confirmations, the brief — thesis, risks, decisions, invariants), let Forma refuse what does not anchor, hand the brief to a hostile counter-verifier, recompose, gate. Trigger on "aggiorna control room", "update the control room", "aggiorna dashboard", "ricalcola il briefing", or after any wave of work that changes the state of a programme.
---

# forma-room-update — the ritual

You are the agent that writes the judgement layer. Forma is the machine that refuses it when it is not
anchored, marks it when its anchor moves, and colours it only after a *second* agent with a mandate to
disprove it could not. **The value is trust: a briefing that lies is worse than none.**

Governing rule (paid for twice by the reference dashboards this ritual replaces): **generated parts stay
fresh by themselves; hand-written parts rot in silence.** Every run therefore re-touches ALL judgement
channels, not only the data. Skipping a step is how the artefact starts lying again.

## 0. Fix the day once
`today` is the determinism anchor and Forma never moves it. Set it at the start of the ritual and keep it
for the whole run — every command below reads it from `forma.room.json`:
`npx forma-arch room init --repo . --today YYYY-MM-DD` (or edit the manifest). Both `room update` calls
below share it. Never pass a different `--today` mid-ritual.

## 1. Measure live, never from memory
- `git status -sb`, `git fetch`, and confirm you are on the branch the briefing speaks for.
- `npx forma-arch room update --manifest forma.room.json` — pulls every programme's live `gh` snapshot
  (issues, dependencies, workflow lanes, release) and recomposes. Read its log: `dependencies
  supported/complete`, `signals unknown=N`, `truncated relations`. **If a signal is unknown, it stays
  unknown on screen — never turn an absence into a green.**
- Read the snapshot for what you need: `docs/architecture/c4-issues.json` (issues, `signals.workflows`,
  `signals.release`, `milestones`, `dependencies`).

## 2. Ask Forma what is missing or stale
`npx forma-arch audit --repo . --today YYYY-MM-DD --stale-after-days N --brief docs/architecture/c4-brief.json --plan docs/architecture/audit-plan.json`
(pass `--issues/--health/--findings/--model/--topology` when the manifest paths differ from the defaults).
The plan is the checklist "touch ALL hand-written parts", made mechanical:
- `issues[]` — issues with no fresh health verdict (prompt each);
- `dependencyCandidates[]` — prose "blocked by / dipende da #N" candidates awaiting confirmation;
- `brief.prompts[]` — the kinds still missing (thesis, risks up to 5, decisions up to 5, invariants) and
  `brief.stale[]` — claims whose subject or evidence moved, or that aged out;
- `findingsPrompt` — anything that does not add up and is not yet an issue.

## 3. Write the fill — the rules
Write `docs/architecture/audit-fill.json`:

```json
{"planHash":"<exact plan.planHash>",
 "verdicts":[{"n":12,"verdict":"ok|warn|bad","why":"<one sentence with the proof in it>","evidence":[{"type":"path|commit|issue|signal|milestone","ref":"..."}]}],
 "dependencyConfirmations":[{"fingerprint":"<candidate fingerprint>","evidence":[{"type":"issue","ref":"12"}]}],
 "findings":[{"id":"...","severity":"ok|warn|bad","text":"...","evidence":{"type":"path","ref":"docs/x.md:12"},"trace":"issue|azione"}],
 "brief":{"claims":[
   {"id":"thesis","kind":"thesis","text":"<where the programme stands, one sentence>","about":{"milestone":"v1.4"},"evidence":[{"type":"milestone","ref":"v1.4"},{"type":"signal","ref":"workflows/ci"}]},
   {"id":"risk-nightly","kind":"risk","severity":"bad","text":"<what could sink it, first-hand>","about":{"signal":"workflows/nightly"},"evidence":[{"type":"signal","ref":"workflows/nightly"},{"type":"issue","ref":"4241"}]},
   {"id":"decide-...","kind":"decide","text":"<what only a human can settle now, actionable in one sentence>","about":{"issue":4031},"evidence":[{"type":"issue","ref":"4031"}]},
   {"id":"inv-01","kind":"invariant","severity":"warn","class":"MECCANIZZATO|DOCUMENTATO|SCOPERTO","ifBroken":"<what falls if it falls>","text":"<the invariant, as guarded today>","about":{"path":"docs/GLOBAL_INVARIANTS.md"},"evidence":[{"type":"path","ref":"docs/GLOBAL_INVARIANTS.md:41"},{"type":"path","ref":"test/run.mjs:120"}]},
   {"id":"why-v1.4","kind":"note","text":"<why this batch, in this order — the narrative of a work block>","about":{"milestone":"v1.4"},"evidence":[{"type":"milestone","ref":"v1.4"},{"type":"issue","ref":"4031"}]}
 ]}}
```

A `note` anchored to a milestone or to an issue is shown on the work block that carries that milestone or
issue ("why this batch"): that is where the narrative of the queue lives — not in a curated blocks file — with
the same anchor, staleness and refusal path as every other claim.

Rules Forma enforces — write to them, do not test them:
1. **Every claim names its subject** (`about`: exactly one of `issue | signal | milestone | path`) and cites
   evidence that resolves in this repository or snapshot. `path` may carry `:line`.
2. **A risk or a decision must rest on something that can move**: an OPEN issue, a `signal`
   (`workflows/<id>` or `release`), a `milestone`, or a commit from the last 30 days. A closed issue or a
   README path alone is refused — an anchor that never expires is no anchor.
3. **Caps**: one thesis, at most five risks, at most five decisions (ordered by how much each unblocks).
   Replace by id; do not add a sixth. Invariants and notes are uncapped and carry no colour.
4. **Never stamp provenance yourself** (`writtenAt`, `evidenceHash`, `auditedAt`, `verified`): Forma stamps
   it and refuses a fill that tries.
5. **The proof lives in the sentence AND in the evidence**: "verified on the live run", "curl 200",
   `path:line` — never "should". Deduce state from the live resource, not from the code or the docs
   (a diff that looks right and a `curl` that says otherwise disagree in favour of the `curl`).
6. **Declare the gap instead of filling it**: if you cannot anchor a claim, do not write it. An issue you
   cannot judge gets no verdict (it stays "not audited"), never an `ok` by default.
7. **No number from a sub-agent without re-verifying it** — if a report says it and you did not run it,
   either run it or attribute it in the sentence.
8. **The false "all done"**: a decisions list that is empty because you did not look is a lie the first
   screen tells. If nothing waits for a human, say so as a `note` anchored to what you checked.
9. Rewrite a claim when the world moved; **omit** it to drop it. A rewritten claim loses its previous
   hostile verdict — the verifier held a different sentence.

## 4. Apply — and read what Forma refused
`npx forma-arch audit --repo . --today YYYY-MM-DD --stale-after-days N --brief docs/architecture/c4-brief.json --apply docs/architecture/audit-fill.json --audit-plan docs/architecture/audit-plan.json`
Forma applies item by item and names every refusal in `docs/architecture/c4-health.json` →
`lastApply.rejected` (and on stderr). **Read them.** Fix the fill and re-apply, or accept the refusal:
the number of refused claims is shown on the dashboard, and that is fine — it is the honest number.
`--apply` refuses the whole fill only if the plan is stale (model, issues or health changed since
`--plan`): re-plan, re-fill.

## 5. Hand the brief to the hostile verifier
Every brief claim is now a counter-claim in the plan (`kind: brief-claim`). Run the counter-verifier —
by default the **Codex** adapter (`adapters/codex/forma-counterverify`), deliberately a *different* engine
than the one that wrote the brief — over `audit-plan.json` (re-plan first so it names the brief you just
wrote). It returns `holds | contradicted | unsupported` per claim with an anchor; Forma lands the verdict
ON the claim with its date. **A claim gets a colour only on a fresh `holds`.** Contradicted or unsupported
claims are grey and become findings. Claims the verifier does not answer stay "not verified" — say so,
never colour them yourself.

## 6. Recompose and gate
`npx forma-arch room update --manifest forma.room.json --skip-verify --fill --counter`
then `npx forma-arch check --room <the html>` and `node scripts/room-presentable.mjs --room <the html> --manifest forma.room.json`.
`room-presentable` refuses to publish a brief with a decision nobody held. If it refuses, do not publish:
fix the fill or get the verifier to answer.

Report to the human the facts, not "updated": how many claims were written, how many refused and why,
how many held / contradicted / unsupported, and what you could NOT verify.

Do not edit `c4-issues.json`, `c4-health.json`, `c4-findings.json` or `c4-brief.json` by hand: they are
written only by `verify` and `audit --apply`. Do not run an agent subprocess from Forma.
