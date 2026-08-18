// roomload.mjs — how a manifest entry becomes a set of concrete inputs. Shared by `room.mjs` (which
// composes) and `check.mjs` (which re-derives and compares), for the same reason roomderive.mjs is
// shared: if the two resolved a programme's paths differently, or merged the manifest differently,
// the gate would be grading a different set of inputs than the composer used and its green would
// mean nothing. Two rules live here and nowhere else:
//
//   1. relative paths resolve against the MANIFEST's own directory, never the working directory,
//      so where the command was invoked from cannot change which repository is read;
//   2. a programme's effective manifest is the portfolio manifest with the programme's own keys
//      layered on top — that is what puts `today`, `linkMaxFiles` and `staleAfterDays` in scope for
//      a per-programme derivation while letting the programme override `taxonomy` and `blockedBy`.
import { isAbsolute, resolve } from 'node:path'

// Which programmes a manifest actually composes. Lives here for the same reason the resolver does:
// the gate iterating a set the composer never rendered fails on the difference, which is how the
// first version of the `enabled` flag broke `check` on an untouched briefing.
export const activePrograms = (manifest) => (manifest.programs || []).filter((program) => program.enabled !== false)
export const excludedPrograms = (manifest) => (manifest.programs || []).filter((program) => program.enabled === false)

export function snapshotManifestErrors(program, snapshot) {
  const errors = []
  if (snapshot.ghRepo !== program.ghRepo) errors.push(`issue snapshot names ${snapshot.ghRepo}, manifest names ${program.ghRepo}`)
  const declared = [...(program.workflows || [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const actual = Object.keys((snapshot.signals || {}).workflows || {}).sort()
  if (declared.map(({ id }) => id).join('\0') !== actual.join('\0')) errors.push(`workflow signals [${actual.join(', ')}] do not match manifest [${declared.map(({ id }) => id).join(', ')}]`)
  for (const workflow of declared) {
    const signal = snapshot.signals && snapshot.signals.workflows && snapshot.signals.workflows[workflow.id]
    if (signal && signal.state === 'present' && signal.path !== workflow.path) errors.push(`workflow ${workflow.id} signal names ${signal.path}, manifest names ${workflow.path}`)
  }
  const release = snapshot.signals && snapshot.signals.release
  if (!program.release && release && release.listState === 'present') errors.push('snapshot carries a release signal that the manifest does not declare')
  if (program.release && release && release.listState === 'unknown' && /not declared/i.test(release.reason || '')) errors.push('manifest declares release collection but the snapshot predates that declaration')
  return errors
}

export function resolveProgramPaths(manifestDir, manifest, program) {
  const at = (p) => (isAbsolute(p) ? p : resolve(manifestDir, p))
  const optional = (p) => (p === undefined ? null : at(p))
  return {
    repo: at(program.repo),
    issues: at(program.issues),
    model: optional(program.model),
    topology: optional(program.topology),
    health: optional(program.health),
    findings: optional(program.findings),
    auditPlan: optional(program.auditPlan),
    counterResults: optional(program.counterResults),
    auditFill: optional(program.auditFill),
    brief: program.brief ? at(program.brief.path) : null,
    programManifest: { ...manifest, ...program },
  }
}

// RTM document paths are the one exception to the rule above, and deliberately so: they are read
// RELATIVE TO THE PROGRAMME'S OWN CHECKOUT, not to the manifest, because `docs/PRD.md` means that
// repository's PRD. They still pass through here rather than being resolved inside lib/rtm.mjs, so
// composer and gate cannot grow two answers to which documents the matrix is built from.
export const rtmFor = (program) => (program.rtm && (program.rtm.docs || []).length ? program.rtm : null)
