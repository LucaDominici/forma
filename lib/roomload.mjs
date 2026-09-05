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

// arbiter's machine outputs take the same exception as RTM docs and for the same reason: the paths
// mean THAT REPOSITORY's files, so `.arbiter/milestones.json` resolves against the programme's own
// checkout rather than the manifest's directory. Resolved here, not inside roomderive, so composer
// and gate cannot grow two answers to which projection was read.
export const arbiterMilestonesPath = (program, repo) =>
  program.arbiter && program.arbiter.milestones ? resolve(repo, program.arbiter.milestones) : null

// Read the projection, checking its DECLARED VERSION and nothing else.
//
// That restraint is deliberate. arbiter owns this shape; re-validating it here would make forma
// hold a second opinion about arbiter's output, which is exactly what the pinned schema contract
// (lib/schema/CONTRACT.json) exists to prevent. A consumer of a versioned machine output checks the
// version it was built against — full shape validation arrives with the vendored pin.
//
// Absent file and MALFORMED file are different claims: absent means the programme declares no
// projection, malformed means one was declared and cannot be trusted. Only the first is silence.
export function loadArbiterMilestones(path, readJson) {
  return loadArbiterProjection(path, readJson, 'arbiter-milestones-v1', 'check-milestones.mjs')
}

// The same two paths arbiter's milestone projection takes, for the same reasons. Extracted rather
// than copied three times: the restraint above is a CONTRACT, and three hand-written copies of it
// is how one of them quietly grows a second opinion about arbiter's shape.
export const arbiterUseCasesPath = (program, repo) =>
  program.arbiter && program.arbiter.useCases ? resolve(repo, program.arbiter.useCases) : null

export const arbiterRunbooksPath = (program, repo) =>
  program.arbiter && program.arbiter.runbooks ? resolve(repo, program.arbiter.runbooks) : null

export function loadArbiterUseCases(path, readJson) {
  return loadArbiterProjection(path, readJson, 'arbiter-use-cases-v1', 'check-use-cases.mjs')
}

export function loadArbiterRunbooks(path, readJson) {
  return loadArbiterProjection(path, readJson, 'arbiter-runbooks-v1', 'check-runbook-coverage.mjs')
}

/**
 * Read a projection, checking its DECLARED VERSION and nothing else — the restraint documented
 * above, in one place so it cannot diverge between the three consumers. Absent means the programme
 * declares none; malformed means one was declared and cannot be trusted. Only the first is silence.
 */
function loadArbiterProjection(path, readJson, schema, emitter) {
  if (path === null) return null
  const doc = readJson(path)
  if (!doc || doc.schema !== schema) {
    throw new Error(
      `arbiter projection at ${path} does not declare schema ${schema} ` +
        `(got ${JSON.stringify(doc && doc.schema)}) — regenerate it with ` +
        `\`node scripts/${emitter} --emit <path>\` in the arbiter checkout`,
    )
  }
  return doc
}
