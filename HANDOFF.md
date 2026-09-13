# HANDOFF — forma #123 (engine identity on brief claims)

Worker: Claude Sonnet 5. Worktree: `/home/luca/work/repos/forma.worktrees/123-engine-identity`
(branch `task/123-engine-identity`, based on origin/main `28074cd`).

## HEAD
`f4e95ef` feat(audit): record author/verifier engine so cross-engine holds are enforceable (#123)

## Commits (this branch, in order)
1. `3eaf577` test(audit): RED — same-engine holds must not colour a brief claim (#123)
2. `f4e95ef` feat(audit): record author/verifier engine so cross-engine holds are enforceable (#123) — GREEN

## Commands + exits
- `node test/run.mjs` → 0 (RED commit: confirmed 1 failure — `engine: a same-engine hold was
  coloured` — before the GREEN commit; not re-verified standalone after, superseded by `npm test`)
- `npm test` (palette check + arbiter-contract check + test/run.mjs) → **0**
- `node scripts/lint.mjs` → 0 (35 files)
- `node lib/check.mjs` (forma's own `docs/architecture` C4 self-check, dogfooding) → **0**
- Legacy-brief validation smoke: forma's own pre-existing `docs/architecture/c4-brief.json` (8
  claims, written before this change, no `author`/engine fields) validates against the updated
  `c4-brief.schema.json` and composes — confirms backward compatibility, not just the test fixture.

## AC status (issue #123)
- [x] Schema records authoring engine (`claim.author.engine`) and verifying engine
      (`claim.verified.engine`), both optional, backward compatible (missing = unknown).
- [x] `audit apply` (`classifyVerification` in `lib/audit.mjs`) refuses to colour a `holds` when
      `verdict.engine === author.engine` or either is unknown; the verdict is still recorded
      (nothing dropped/rewritten), rendered as a new derived state `self-held`, distinct from
      `holds`/`unverified`/`contradicted`/`unsupported`.
- [x] The counter-verify adapter writes its engine id: `adapters/codex/forma-counterverify/SKILL.md`
      now always passes `--engine codex` on the counter apply; `lib/audit.mjs --apply ...
      --counter-plan ...` stamps `verified.engine` from that flag onto every verdict it writes.
      Authoring side: `--engine` on `--apply ... --audit-plan ...` stamps `author.engine`; a fill
      cannot self-declare `author` (guarded next to `writtenAt`/`evidenceHash`/`verified`).
      `lib/roomupdate.mjs` (`room update --fill --counter`) gained `--author-engine`/
      `--verifier-engine` threaded to its two `audit.mjs` subprocess spawns; both
      `forma-room-update` SKILL.md copies (claude/codex) updated identically (their own test
      requires byte-identical text) to always pass `--engine`.
- [x] Tests (`test/run.mjs`): same-engine hold → not coloured (`self-held`, real round trip through
      `--apply`/`--counter-plan`); different-engine hold → coloured (`holds`, existing
      thesis/decide-1 scenario re-used with `--engine claude` then `--engine codex`); legacy brief
      with no engine data anywhere → not coloured, no crash (pure `classifyVerification` unit
      coverage + forma's own pre-existing brief re-validated above); adapter/CLI writes engine
      (author-stamp and verifier-stamp assertions on the real apply output).
- [x] Room header counts distinguish independently held vs self-held: `roomderive.mjs`
      `counts.selfHeld` separate from `counts.holds`; `control-room.html` renders a
      `self-held · {date}` chip and includes `{selfHeld}` in the header strip
      (`briefCounts`/`briefSelfHeld` keys added to `lib/viewer/strings/{en,it}.json`).
- [x] ADR: no prior ADR governed the brief schema/colour rule, so added
      `docs/adr/0009-engine-identity-on-brief-claims.md` (Context/Decision/Rejected
      alternatives/Consequences, including the one-time visible regression: pre-existing coloured
      claims lose colour until re-verified with engine recorded on both sides) and indexed it in
      `docs/adr/README.md`.

## Design notes for the parent
- Provenance is a single `--engine <id>` CLI flag per `audit.mjs --apply` invocation (mirrors how
  `--today` is already an external, forma-trusted fact) — not a per-JSON-entry field the fill
  writes itself, to keep engine identity unforgeable by the same content it colours.
- `room update` needed **two** flags (`--author-engine`, `--verifier-engine`) because one
  `--fill --counter` invocation can run both the authoring apply and the counter apply in the same
  process with two different identities.
- `--engine` is free-form/unvalidated (no enum) — noted as a known gap in ADR-0009 consequences,
  not fixed (would need forma to maintain an engine registry it has never needed before).

## Owned paths touched
`lib/schema/c4-brief.schema.json`, `lib/audit.mjs`, `lib/roomderive.mjs`, `lib/roomupdate.mjs`,
`lib/viewer/control-room.html`, `lib/viewer/strings/{en,it}.json`, `test/run.mjs`,
`adapters/codex/forma-counterverify/SKILL.md`, `adapters/{claude,codex}/forma-room-update/SKILL.md`,
`docs/adr/0009-engine-identity-on-brief-claims.md`, `docs/adr/README.md`.

Not touched (read-only, per instructions): `~/work/forma-rooms/**`.

## Open items for the parent
- None blocking. `npm test` and `node lib/check.mjs` are both green on HEAD `f4e95ef`.
- The one deliberate behavioural consequence to flag upstream: any real Control Room composed from
  a brief written before this change will show its previously-"held" claims as "self-held" (not
  coloured) the next `room update --counter` run, until re-verified with `--author-engine`/
  `--verifier-engine` (or `--engine`) actually passed. This is correct per the AC, but is a visible
  diff on existing rooms (e.g. viafera) the first time this ships there.
