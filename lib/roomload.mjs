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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, basename, dirname } from 'node:path'
import { validateModel } from './validate.mjs'

// Which programmes a manifest actually composes. Lives here for the same reason the resolver does:
// the gate iterating a set the composer never rendered fails on the difference, which is how the
// first version of the `enabled` flag broke `check` on an untouched briefing.
export const activePrograms = (manifest) => (manifest.programs || []).filter((program) => program.enabled !== false)
export const excludedPrograms = (manifest) => (manifest.programs || []).filter((program) => program.enabled === false)
export const duplicateProgramIds = (manifest) => {
  const seen = new Set(), duplicates = new Set()
  for (const program of manifest.programs || []) {
    if (seen.has(program.id)) duplicates.add(program.id)
    seen.add(program.id)
  }
  return [...duplicates].sort()
}

// Canonicalize an output even before it exists by resolving its nearest existing ancestor. This
// lets writers reject two spellings (including symlink aliases) of the same target before work.
export function canonicalPath(path) {
  let base = resolve(path), rest = []
  while (!existsSync(base)) {
    rest.unshift(basename(base))
    const parent = dirname(base)
    if (parent === base) break
    base = parent
  }
  return resolve(realpathSync(base), ...rest)
}

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

export const arbiterUseCasesPath = (program, repo) =>
  program.arbiter && program.arbiter.useCases ? resolve(repo, program.arbiter.useCases) : null

export const arbiterRunbooksPath = (program, repo) =>
  program.arbiter && program.arbiter.runbooks ? resolve(repo, program.arbiter.runbooks) : null

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

export const schemaUrl = (name) => new URL(`./schema/${name}`, import.meta.url)

// Read a file as JSON without ever conflating "could not read/parse it" with "parsed to the JSON
// value null" — a top-level `null` in a model/overlay is a legal (if certainly schema-invalid)
// document, and must still reach `validateModel`, not be treated as a silent no-op the way a
// missing-file sentinel is. `missing` distinguishes ENOENT (ordinary — the composer/gate default
// paths a lot of these) from a file that exists but will not parse.
function readJsonOutcome(path) {
  let text
  try { text = readFileSync(path, 'utf-8') }
  catch (e) { return { failed: true, missing: e && e.code === 'ENOENT', detail: (e && e.message) || String(e) } }
  try { return { failed: false, value: JSON.parse(text) } }
  catch (e) { return { failed: true, missing: false, detail: (e && e.message) || String(e) } }
}

// One programme's issue snapshot, model/topology, and overlays — resolved and read the same way
// for `room` (which fails fast, one diagnostic at a time, in this exact order) and `check` (which
// collects every diagnostic and continues past whichever ones its own gate has always continued
// past). F8: the two used to carry separate copies of this load, and only room's schema-validated
// the model — a hand-edited model.json that `room` would refuse to compose passed `check --room`
// silently.
//
// `diagnostics` is total and pure: nothing here calls `process.exit` or throws, so a caller can
// keep going across programmes (`check`, via `fatal`) or stop at the first one (`room`, by using
// `diagnostics[0]` — always the first thing that would have failed in the original inline order).
// Each entry is `{ field, reason, path, detail, errors, fatal }`: `detail` is a single message
// (read/parse failure, or one manifest-mismatch line); `errors` is the raw array from
// `validateModel` for a schema failure, kept unflattened because `room` reports a schema failure as
// ONE message with every violation, and `check` reports each violation as its own line — the two
// formats a single flattened string could not serve. `fatal` is check's own "this programme cannot
// be derived at all" boundary; `room` ignores it; every diagnostic is fatal to `room`, in order.
//
// `docs` and the arbiter projections are deliberately NOT loaded here: neither `room` nor the
// original `check` folded them into this collect-or-fail-fast shape (a malformed arbiter file
// crashes both, uncaught, exactly as before), so moving them would change behaviour no one asked
// this slice to change.
export function loadProgram({ manifestDir, manifest, program, staged }) {
  const diagnostics = []
  const paths = resolveProgramPaths(manifestDir, manifest, program)
  const inputs = { ...paths, ...(staged || {}) }

  const issuesOutcome = readJsonOutcome(inputs.issues)
  let issuesSnapshot = null
  if (issuesOutcome.failed) {
    diagnostics.push({ field: 'issues', reason: issuesOutcome.missing ? 'missing' : 'invalid-json', path: paths.issues, detail: issuesOutcome.detail, fatal: true })
  } else {
    issuesSnapshot = issuesOutcome.value
    const schemaErrs = validateModel(issuesSnapshot, schemaUrl('c4-issues.schema.json'))
    if (schemaErrs.length) diagnostics.push({ field: 'issues', reason: 'schema', path: paths.issues, errors: schemaErrs, fatal: true })
    else {
      // Room-only checks (the original `check --room` never ran either): kept here so a single
      // loader still resolves a programme's issue snapshot only once.
      if (issuesSnapshot.truncated === true) diagnostics.push({ field: 'issues-truncated', path: paths.issues, fatal: true })
      for (const error of snapshotManifestErrors(program, issuesSnapshot)) diagnostics.push({ field: 'manifest-mismatch', detail: error, fatal: false })
    }
  }

  // Room-only: `check --room` never asserted this symmetry either.
  if (Boolean(paths.model) !== Boolean(paths.topology)) diagnostics.push({ field: 'model-topology-symmetry', fatal: true })
  const hasMapDeclared = Boolean(paths.model)
  let model = null, topo = null
  if (hasMapDeclared) {
    const modelOutcome = readJsonOutcome(inputs.model)
    if (modelOutcome.failed) {
      diagnostics.push({ field: 'model', reason: modelOutcome.missing ? 'missing' : 'invalid-json', path: paths.model, detail: modelOutcome.detail, fatal: false })
    } else {
      model = modelOutcome.value
      const schemaErrs = validateModel(model, schemaUrl('c4-model.schema.json'))
      if (schemaErrs.length) diagnostics.push({ field: 'model', reason: 'schema', path: paths.model, errors: schemaErrs, fatal: false })
    }
    const topoOutcome = readJsonOutcome(inputs.topology)
    if (topoOutcome.failed) diagnostics.push({ field: 'topology', reason: topoOutcome.missing ? 'missing' : 'invalid-json', path: paths.topology, detail: topoOutcome.detail, fatal: false })
    else topo = topoOutcome.value
  }

  // A declared overlay that does not exist yet is the state before the first `audit --apply`:
  // empty, not an error. One that exists and will not parse IS fatal (both callers agree); one
  // that parses but fails its schema is reported and used anyway — deriveAll has always been
  // handed a schema-invalid overlay verbatim, only evidence-gating skips it.
  // main's inline boundary (`!pHealth || !pFindings || ...`) skipped a programme, silently, on any
  // FALSY parsed overlay value (`null`, `false`, `0`, `""`) — a truthy non-object (`1`, `"x"`,
  // `[]`) passed that check and was derived from verbatim, schema-invalid or not. `fatal` here
  // reproduces that exact split: falsy stops the programme (check now also reports why, stricter
  // than main's silence); truthy non-object stays `fatal: false`, same as it always has.
  const readOverlay = (path, field, schemaName, empty) => {
    if (path === null || !existsSync(path)) return { value: empty, schemaOk: true }
    const outcome = readJsonOutcome(path)
    if (outcome.failed) { diagnostics.push({ field, reason: 'invalid-json', path, detail: outcome.detail, fatal: true }); return { value: empty, schemaOk: false } }
    const schemaErrs = validateModel(outcome.value, schemaUrl(schemaName))
    if (schemaErrs.length) { diagnostics.push({ field, reason: 'schema', path, errors: schemaErrs, fatal: !outcome.value }); return { value: outcome.value, schemaOk: false } }
    return { value: outcome.value, schemaOk: true }
  }
  const healthLoad = readOverlay(inputs.health, 'health', 'c4-health.schema.json', { verdicts: [], dependencyConfirmations: [] })
  const findingsLoad = readOverlay(inputs.findings, 'findings', 'c4-findings.schema.json', { findings: [] })
  // Opt-in by presence (I11): a programme that declares no brief derives none. `paths.brief`, not
  // `inputs.brief`, decides opt-in: a staged transaction never introduces a brief a programme did
  // not declare (room update stages an existing declared file, never a new key).
  const briefLoad = paths.brief === null ? { value: null, schemaOk: true } : readOverlay(inputs.brief, 'brief', 'c4-brief.schema.json', { claims: [] })

  return {
    inputs: {
      paths, repo: paths.repo, issuesSnapshot, model, topo, hasMapDeclared,
      health: healthLoad.value, findings: findingsLoad.value, brief: briefLoad.value,
      findingsSchemaOk: findingsLoad.schemaOk, briefSchemaOk: briefLoad.schemaOk,
    },
    diagnostics,
  }
}
