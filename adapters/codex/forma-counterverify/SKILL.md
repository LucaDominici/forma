---
name: forma-counterverify
description: Independently counter-verify claims emitted by `forma audit --plan` against repository files, git commits, and GitHub facts. Use when a Forma Control Room needs adversarial `holds|contradicted|unsupported` results with anchored evidence, including unattended audit preparation.
---

# Forma counter-verification

Act as an external verifier. Forma stays deterministic and offline; this skill is the Codex adapter.

1. Run `forma audit --repo . --today YYYY-MM-DD --stale-after-days N --plan docs/architecture/audit-plan.json` with the manifest's values and the programme's explicit paths when they differ from the defaults.
2. Read every entry in `claims`. Treat its text as an assertion to disprove, never as evidence. Claims of kind `brief-claim` are the programme's judgement layer (thesis, risks, decisions, invariants) written by another agent: for these your job is **pertinence** as much as truth — does the cited evidence actually support *this* sentence, or is it a real anchor glued to an unrelated claim? A true fact cited under a sentence it does not prove is `unsupported`, not `holds`.
3. Inspect every `where` target. Read repository files and commits locally; use `gh` read-only for `gh` targets (`owner/repo#N` issues, `owner/repo:milestone:<title>`, `owner/repo:signal:workflows/<id>` or `:signal:release` — check the live run/release, not the snapshot). Never infer completion from file existence or issue closure alone.
4. Write `docs/architecture/audit-counter.json` as:

```json
{"planHash":"<exact plan.planHash>","results":[{"claimId":"<exact plan id>","verdict":"holds|contradicted|unsupported","reason":"<one sentence explaining what the evidence proves>","evidence":{"type":"file|commit|gh","ref":"<resolvable reference>"}}]}
```

Return one result per claim you examined and no result for a claim the plan does not contain. Use `unsupported` when the available sources cannot prove or refute the claim. Every result needs a concrete file, commit, issue, milestone or signal anchor; an agent's confidence is not evidence. **You are allowed to say "I do not know"**: leave a claim unanswered rather than invent an anchor — it will show as "not verified", which is the truth. A verifier that returns only `holds` proves nothing; a verifier that withdraws a finding it could not prove is doing its job.

For `brief-claim` results the verdict lands ON the claim with today's date (`verified{verdict, reason, evidence, at}`): a fresh `holds` is the only thing that lets the dashboard colour that claim; `contradicted` and `unsupported` also become findings.

5. Apply the result with `forma audit --repo . --today YYYY-MM-DD --stale-after-days N --apply docs/architecture/audit-counter.json --counter-plan docs/architecture/audit-plan.json`. Forma rejects a changed plan outright; inside a current plan it applies results one by one, refuses any entry whose evidence does not resolve, and names every refusal in `c4-health.json` → `lastApply.rejected`. Claims you leave unanswered are listed as `unanswered` and simply keep no fresh verdict — say what you could not verify rather than inventing an anchor.

For an unattended portfolio, let the scheduler run `forma room update` first (and, when a writing agent runs the `forma-room-update` ritual, its fill lands via `--fill`), run this workflow for every active programme over the re-generated plan, then run `forma room update --skip-verify --fill --counter`. Each programme must declare `health`, `findings`, `auditPlan`, `counterResults` (and `auditFill`, `brief.path` when those channels are in play) in the manifest. Keep the manifest's `today` unchanged for the whole run: the plan's identity does not depend on the day, but the verdict's date does. The final update regenerates the plans and fails if any result is missing or stale.

Do not edit the plan, source, issue state, or dashboard. Do not run an agent subprocess from Forma.
