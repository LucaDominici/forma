---
name: forma-counterverify
description: Independently counter-verify claims emitted by `forma audit --plan` against repository files, git commits, and GitHub facts. Use when a Forma Control Room needs adversarial `holds|contradicted|unsupported` results with anchored evidence, including unattended audit preparation.
---

# Forma counter-verification

Act as an external verifier. Forma stays deterministic and offline; this skill is the Codex adapter.

1. Run `forma audit --repo . --today YYYY-MM-DD --stale-after-days N --plan docs/architecture/audit-plan.json` with the manifest's values and the programme's explicit paths when they differ from the defaults.
2. Read every entry in `claims`. Treat its text as an assertion to disprove, never as evidence.
3. Inspect every `where` target. Read repository files and commits locally; use `gh` read-only for `gh` targets. Never infer completion from file existence or issue closure alone.
4. Write `docs/architecture/audit-counter.json` as:

```json
{"planHash":"<exact plan.planHash>","results":[{"claimId":"<exact plan id>","verdict":"holds|contradicted|unsupported","reason":"<one sentence explaining what the evidence proves>","evidence":{"type":"file|commit|gh","ref":"<resolvable reference>"}}]}
```

Return exactly one result for every claim and no others. Use `unsupported` when the available sources cannot prove or refute the claim. Every result needs a concrete file, commit, issue, or milestone anchor; an agent's confidence is not evidence.

5. Apply the result with `forma audit --repo . --today YYYY-MM-DD --stale-after-days N --apply docs/architecture/audit-counter.json --counter-plan docs/architecture/audit-plan.json`. Forma rejects a changed plan outright; inside a current plan it applies results one by one, refuses any entry whose evidence does not resolve, and names every refusal in `c4-health.json` → `lastApply.rejected`. Claims you leave unanswered are listed as `unanswered` and simply keep no fresh verdict — say what you could not verify rather than inventing an anchor.

For an unattended portfolio, let the scheduler run `forma room update` first, run this workflow for every active programme, then run `forma room update --skip-verify --counter`. Each programme must declare `health`, `findings`, `auditPlan`, and `counterResults` in the manifest. The final update regenerates the plans and fails if any result is missing or stale.

Do not edit the plan, source, issue state, or dashboard. Do not run an agent subprocess from Forma.
