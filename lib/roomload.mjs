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
    programManifest: { ...manifest, ...program },
  }
}

// RTM document paths are the one exception to the rule above, and deliberately so: they are read
// RELATIVE TO THE PROGRAMME'S OWN CHECKOUT, not to the manifest, because `docs/PRD.md` means that
// repository's PRD. They still pass through here rather than being resolved inside lib/rtm.mjs, so
// composer and gate cannot grow two answers to which documents the matrix is built from.
export const rtmFor = (program) => (program.rtm && (program.rtm.docs || []).length ? program.rtm : null)
