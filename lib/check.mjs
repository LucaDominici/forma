#!/usr/bin/env node
// check-c4-model.mjs — NON-VACUOUS anti-drift gate for the C4 model.
// Fails LOUD (never SKIP). Asserts the committed model against INDEPENDENT ground truth in src/,
// and flags architecture-doc numbers that disagree with code (the "14 vs 25 tables" trap).
// Usage: node check-c4-model.mjs [--repo <path>] [--model <path>] [--topology <path>]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containerOf } from './cluster.mjs'
import { renderBlock, extractBetween, norm } from './render.mjs'
import { descInputHash } from './enrich.mjs'
import { loadDocRows, indexByNode, describingRows, statusFor } from './docmap.mjs'
import { materializeTimeline, validateModel } from './validate.mjs'
import { deriveAll } from './roomderive.mjs'
import { resolveProgramPaths, activePrograms, snapshotManifestErrors, arbiterMilestonesPath, loadArbiterMilestones } from './roomload.mjs'
import { validateEvidence as validateAuditEvidence } from './audit.mjs'
import { loadDocs, stripGateInputs } from './roomdocs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const MODEL = arg('--model', join(REPO, 'docs/architecture/c4-model.json'))
const TOPO = arg('--topology', join(REPO, 'docs/architecture/c4-topology.json'))
const rp = (p) => join(REPO, p)
const errs = []
const fail = (m) => errs.push(m)
const evidenceGate = (repo, evidence, label, known) => {
  try { validateAuditEvidence(repo, evidence, label, known) } catch (e) { fail(`${label}: ${String((e && e.message) || e).replace(/^audit apply:\s*/, '')}`) }
}

if (!existsSync(MODEL)) { console.error('[check-c4] FAIL: model missing (no SKIP): ' + MODEL); process.exit(1) }
if (!existsSync(TOPO)) { console.error('[check-c4] FAIL: topology missing: ' + TOPO); process.exit(1) }
const model = JSON.parse(readFileSync(MODEL, 'utf-8'))
const topo = JSON.parse(readFileSync(TOPO, 'utf-8'))
for (const err of validateModel(model)) errs.push('SCHEMA: ' + err)
// The topology is the curated architecture authority. The generated model carries the same compact
// patch programme for the browser; editing either side alone is drift even when both JSON values
// remain individually valid.
if (JSON.stringify(model.timeline || null) !== JSON.stringify(topo.timeline || null)) {
  fail('TIMELINE DRIFT: model.timeline does not match c4-topology.json — regenerate c4-model.json.')
}
for (const err of materializeTimeline(model, { sourceExists: (rel) => existsSync(rp(rel)) }).errors) fail('TIMELINE: ' + err)
const byId = new Map((model.nodes || []).map((n) => [n.id, n]))

// 1) schemaVersion present + basic shape
if (!/^\d+\.\d+\.\d+$/.test(model.schemaVersion || '')) fail('missing/invalid schemaVersion')
if (!Array.isArray(model.nodes) || model.nodes.length === 0) fail('no nodes')

// 2) re-derive leaf counts from src/ INDEPENDENTLY and compare to the model
function walk(spec) {
  const dir = rp(spec.dir); if (!existsSync(dir)) { fail('leafSource dir missing: ' + spec.dir); return [] }
  const re = new RegExp(spec.match), ex = spec.exclude ? new RegExp(spec.exclude) : null
  const skipped = new Set(spec.excludeDirs || [])
  const out = []
  ;(function visit(abs, rel, depth) {
    if (depth > 16) return
    for (const f of readdirSync(abs).sort()) {
      if (f.startsWith('.')) continue
      const child = join(abs, f), key = rel ? rel + '/' + f : f
      if (statSync(child).isDirectory()) {
        if (spec.recursive && !skipped.has(f.toLowerCase())) visit(child, key, depth + 1)
        else if (!spec.recursive && spec.filesOnly === false && re.test(f) && !(ex && ex.test(f))) out.push(key)
      } else if (re.test(f) && !(ex && ex.test(f))) out.push(key)
    }
  })(dir, '', 0)
  return out
}
for (const spec of topo.leafSources) {
  const live = walk(spec).length
  // An `evidenceOnly` source produces no leaves — the count IS the assertion, carried on the
  // container's glob evidence. Comparing leaves for those would compare 0 to 0 forever: that is
  // exactly how the Go gate went vacuous, passing while a .go file was added or deleted.
  // A model with no glob evidence predates the count; report 0 so it drifts loud, not `undefined`.
  const inModel = spec.evidenceOnly
    ? (((byId.get(spec.parent) || {}).evidence || []).find((e) => e.type === 'glob') || {}).count ?? 0
    : model.nodes.filter((n) => n.kind === 'leaf' && n.status === 'current' && containerOf(n, byId) === spec.parent).length
  if (live === 0) fail(`phantom parent "${spec.parent}": src glob ${spec.dir} matches 0 files`)
  if (live !== inModel) fail(`DRIFT: ${spec.parent} — src has ${live} files, model has ${inModel}. Regenerate c4-model.json.`)
}

// 2b) An init-generated topology must cover the recognised source universe, not merely recount the
// globs it chose. Otherwise deleting 99% of leafSources makes this gate easier to pass. Exclusions
// are data with a reason, so tests/fixtures can stay out without becoming invisible.
if (!topo.sourceCoverage) fail('SOURCE COVERAGE: topology is missing sourceCoverage; regenerate or declare reasoned exclusions instead of deleting the coverage contract.')
if (topo.sourceCoverage) {
  const ext = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', mts: 'TypeScript', cts: 'TypeScript', py: 'Python', go: 'Go', java: 'Java', rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', kt: 'Kotlin', swift: 'Swift', cpp: 'C++', c: 'C' }
  const invisible = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out', 'vendor', 'coverage', '.next', '.gradle', 'bin', 'obj'])
  const exclusions = topo.sourceCoverage.exclusions || []
  const exclusionRules = []
  for (const x of exclusions) {
    if (!x.reason || (!x.dir && !x.match)) { fail('SOURCE COVERAGE: every exclusion needs a dir or match and a non-empty reason.'); continue }
    let re = null
    try { re = x.match ? new RegExp(x.match) : null } catch (e) { fail(`SOURCE COVERAGE: invalid exclusion /${x.match}/: ${(e && e.message) || e}`) }
    exclusionRules.push({ ...x, re })
  }
  const excluded = (rel) => exclusionRules.some((x) =>
    (x.dir && (rel === x.dir || rel.startsWith(x.dir + '/'))) || (x.re && x.re.test(rel)))
  const covered = (rel) => (topo.leafSources || []).some((spec) => {
    const base = String(spec.dir || '.').replace(/\\/g, '/').replace(/^\.\/?$/, '')
    const under = !base || rel.startsWith(base + '/')
    if (!under) return false
    const local = base ? rel.slice(base.length + 1) : rel
    if (!spec.recursive && local.includes('/')) return false
    if ((spec.excludeDirs || []).some((d) => local.toLowerCase().split('/').slice(0, -1).includes(String(d).toLowerCase()))) return false
    const name = local.split('/').pop()
    return new RegExp(spec.match).test(name) && !(spec.exclude && new RegExp(spec.exclude).test(name))
  })
  const totals = new Map()
  ;(function scan(dir, rel, depth) {
    if (depth > 16) return
    let entries; try { entries = readdirSync(dir).sort() } catch { return }
    for (const name of entries) {
      if (invisible.has(name) || name.startsWith('.')) continue
      const abs = join(dir, name), key = rel ? rel + '/' + name : name
      let st; try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) scan(abs, key, depth + 1)
      else {
        const m = /\.([a-z0-9]+)$/i.exec(name), stack = m && ext[m[1].toLowerCase()]
        if (!stack) continue
        const row = totals.get(stack) || { recognised: 0, covered: 0, excluded: 0, missing: [] }
        row.recognised++
        if (covered(key)) row.covered++
        else if (excluded(key)) row.excluded++
        else row.missing.push(key)
        totals.set(stack, row)
      }
    }
  })(REPO, '', 0)
  for (const [stack, row] of [...totals].sort()) {
    console.log(`[check-c4] coverage ${stack}: ${row.covered} covered + ${row.excluded} excluded / ${row.recognised} recognised`)
    if (row.missing.length) fail(`SOURCE COVERAGE ${stack}: ${row.missing.length} recognised file(s) are neither modelled nor explicitly excluded: ${row.missing.slice(0, 8).join(', ')}${row.missing.length > 8 ? ', …' : ''}`)
  }
}

// 3) OPTIONAL count checks — generic, config-driven (the "14-vs-25 tables" trap, for ANY stack).
// A repo opts in by adding `countChecks` to its topology, e.g.:
//   "countChecks": [{ "file": "src/db/schema.ts", "pattern": "sqliteTable\\(", "nodeId": "l_db_1",
//                     "doc": { "file": "docs/architecture/ARCHITECTURE.md", "pattern": "(\\d+)\\s+tables?" } }]
// No project-specific constants live here. Absent → nothing runs.
for (const c of topo.countChecks || []) {
  const f = rp(c.file)
  if (!existsSync(f)) { fail(`countCheck: file missing: ${c.file}`); continue }
  const actual = (readFileSync(f, 'utf-8').match(new RegExp(c.pattern, 'g')) || []).length
  const node = model.nodes.find((n) => n.id === c.nodeId)
  if (!node) { fail(`countCheck: model node "${c.nodeId}" not found`); continue }
  const modelN = parseInt(node.tech, 10)
  if (actual !== modelN) fail(`DRIFT: ${c.file} has ${actual} match(es) of /${c.pattern}/, model node ${c.nodeId} says ${modelN}`)
  if (c.doc && existsSync(rp(c.doc.file))) {
    const claims = [...readFileSync(rp(c.doc.file), 'utf-8').matchAll(new RegExp(c.doc.pattern, 'gi'))].map((m) => parseInt(m[1], 10)).filter((n) => !Number.isNaN(n))
    for (const cl of claims) if (cl !== actual) fail(`DOC DRIFT: ${c.doc.file} claims "${cl}" but ${c.file} has ${actual}.`)
  }
}

// 4) every node evidence path of type "path" must exist (no phantom evidence)
for (const n of model.nodes) for (const e of n.evidence || []) if (e.type === 'path' && !existsSync(rp(e.ref))) fail(`node ${n.id}: evidence path missing: ${e.ref}`)

// 5) planned premises still hold
for (const p of topo.plannedLeaves || []) if (p.sourceMustContain) {
  const f = rp(p.sourceRef)
  if (!existsSync(f) || !readFileSync(f, 'utf-8').includes(p.sourceMustContain)) fail(`planned "${p.name}" premise broken in ${p.sourceRef}`)
}

// 6) attach-mode doc-block freshness — if docPath carries forma markers, the region between them
// must equal a freshly rendered block. Opt-in: no markers → nothing runs. No LLM, no network.
// Governs docPath AND every doc registered by `forma doc --attach` (source.attachedDocs): a block
// injected into a file no gate looks at is the false-green this whole command exists to kill.
const src = model.source || {}
const registered = new Set(src.attachedDocs || []) // registry membership PROVES a block was injected
const governed = [...new Set([src.docPath, ...registered].filter(Boolean))]
const deregister = 'remove it from source.attachedDocs if the block is gone for good'
for (const docRel of governed) {
  if (!existsSync(rp(docRel))) {
    // docPath may simply never have been attached; a REGISTERED doc that vanished is drift.
    if (registered.has(docRel)) fail(`DOC BLOCK: ${docRel} is registered in source.attachedDocs but the file is gone — ${deregister}.`)
    continue
  }
  const text = readFileSync(rp(docRel), 'utf-8')
  const inner = extractBetween(text)
  if (inner != null) {
    if (norm(inner) !== norm(renderBlock(model, { repo: REPO }))) fail(`DOC BLOCK DRIFT: ${docRel} forma block is stale — run \`forma doc --attach\`.`)
  } else if (text.includes('<!-- forma:begin') || text.includes('<!-- forma:end')) {
    fail(`DOC BLOCK: malformed forma markers in ${docRel} (begin/end mismatch).`)
  } else if (registered.has(docRel)) {
    // Both markers deleted: the generated block stopped being governed while its (now frozen)
    // text keeps shipping to readers. Exactly the false green attachedDocs exists to prevent.
    fail(`DOC BLOCK: ${docRel} is registered in source.attachedDocs but has no forma markers — re-run \`forma doc --attach\`, or ${deregister}.`)
  }
}

// 7) the status overlay decorates nodes by id: an id that no longer resolves is drift (the node was
// renamed or deleted and the curated state was left behind). Form only — never the prose itself.
let overlay = {}
if (src.statusPath && existsSync(rp(src.statusPath))) {
  let ov = null
  try { ov = JSON.parse(readFileSync(rp(src.statusPath), 'utf-8')) } catch (e) { fail(`status overlay: ${src.statusPath} is not valid JSON: ${(e && e.message) || e}`) }
  if (ov) {
    overlay = ov.nodes || {}
    for (const id of Object.keys(overlay)) if (!byId.has(id)) fail(`status overlay: "${id}" is not a node in the model — ${src.statusPath} is stale.`)
  }
}

// 8) doc-derived programme state is RE-DERIVED, never trusted. `gen` reads the repo's capability
// tables and writes status2/completion from them; without this the document could flip a row to
// BACKLOG while the committed model keeps showing a green box at 100% and no gate would notice —
// the false green this command exists to kill. Same contract as assertion 2: recompute the truth.
// Skipped per field where the curated overlay owns it, since there the overlay is the authority.
const docPaths = (topo.docSources || []).map((e) => (typeof e === 'string' ? e : (e || {}).path)).filter(Boolean)
// A listed source that is GONE derives nothing — and "derives nothing" used to read as "no drift",
// so the committed model kept citing a file that no longer existed and the gate said OK.
for (const rel of docPaths) if (!existsSync(rp(rel))) fail(`DOC SOURCE: ${rel} is listed in docSources but the file is gone — every state derived from it is unverifiable.`)
const docRows = loadDocRows(REPO, topo.docSources)
for (const r of docRows.filter((x) => x.dead.length)) fail(`DOC ROW: ${r.from} row "${r.text.slice(0, 60)}" has missing or dead evidence: ${r.dead.join(', ')} — the row silently stops counting.`)
const docIdx = indexByNode(docRows, model.nodes || [])
for (const n of model.nodes || []) {
  const want = statusFor(docIdx, n.id)
  const owned = overlay[n.id] || {}
  if (!want) {
    // A state DERIVED from a document must keep deriving. The document can lose the row (a renamed
    // code_ref) or GROW past MAX_ROWS — either way the derivation falls silent while the committed
    // green box and its "(N/N done)" citation keep shipping. Trusting that silence IS the false green.
    if ((n.verify || {}).derived === true && owned.status2 === undefined && owned.completion === undefined && owned.verify === undefined) {
      fail(`DOC DRIFT: ${n.id} still claims "${n.verify.source}" (${n.status2}/${n.completion}) but no row in ${docPaths.join(', ')} derives a state for it any more. Regenerate c4-model.json.`)
    }
    continue
  }
  if (owned.status2 === undefined && n.status2 !== want.status2) fail(`DOC DRIFT: ${n.id} status2 is "${n.status2}" but ${want.source} derives "${want.status2}". Regenerate c4-model.json.`)
  if (owned.completion === undefined && n.completion !== want.completion) fail(`DOC DRIFT: ${n.id} completion is ${n.completion} but ${want.source} derives ${want.completion}. Regenerate c4-model.json.`)
}
// The BOX TEXT is quoted from those same rows, and nothing re-derived it: edit the sentence, delete
// the document, or push the node past MAX_ROWS, and the quote keeps shipping with `descSource:
// "docmap"` vouching for a document that no longer says it.
for (const n of model.nodes || []) {
  if (n.descSource !== 'docmap') continue
  const rows = describingRows(docIdx, n.id)
  const txt = rows ? rows.map((r) => r.text).join(' · ').slice(0, 240) : null
  if (n.func !== txt) fail(`DOC DRIFT: ${n.id} quotes "${String(n.func).slice(0, 60)}" as coming from ${docPaths.join(', ')}, which no longer says it. Regenerate c4-model.json.`)
}

// SOFT: LLM-enriched prose whose inputs changed is only a reminder, never a gate failure (structure
// is the gate; enrichment freshness is advisory). check never calls the LLM — it recomputes the hash.
for (const n of model.nodes || []) {
  if (n.descSource === 'llm' && n.descInputHash && n.descInputHash !== descInputHash(n, { repo: REPO, byId, containerOf })) {
    console.warn(`[check-c4] note: enrichment stale for ${n.id} — run \`forma gen --enrich\` to refresh (non-blocking).`)
  }
}

// 10) Control Room overlays — every assertion below is OPT-IN BY PRESENCE (docs/SCOPE-room.md):
// a repo that never ran `forma verify`/`forma room` sees none of this, exactly like assertions
// 3 and 7 gate on topo.countChecks/src.statusPath rather than requiring them.
const ISSUES = arg('--issues', rp('docs/architecture/c4-issues.json'))
let issuesSnapshot = null
if (existsSync(ISSUES)) {
  let raw = null
  try { raw = JSON.parse(readFileSync(ISSUES, 'utf-8')) } catch (e) { fail(`c4-issues.json: not valid JSON — ${(e && e.message) || e}`) }
  if (raw) {
    const errs10 = validateModel(raw, new URL('./schema/c4-issues.schema.json', import.meta.url))
    if (errs10.length) errs10.forEach((e) => fail('c4-issues.json: ' + e))
    else {
      issuesSnapshot = raw
      const known = new Set(issuesSnapshot.issues.map((it) => it.n))
      const cited = new Set()
      for (const n of model.nodes || []) for (const rawIssue of (n.issues || [])) { const mm = /^#?(\d+)$/.exec(String(rawIssue)); if (mm) cited.add(Number(mm[1])) }
      for (const n of cited) if (!known.has(n)) fail(`c4-issues.json: model cites #${n}, which the snapshot does not contain — refresh with \`forma verify\` or fix the reference.`)
    }
  }
}

// 11) c4-health.json (if present) — every verdict keeps its why and provenance. Evidence that no
// longer resolves is a derived stale verdict, not a fatal read error; the room must stay able to
// show what expired instead of dropping the old judgement entirely.
const HEALTH = arg('--health', rp('docs/architecture/c4-health.json'))
let health = { verdicts: [], dependencyConfirmations: [] }
if (existsSync(HEALTH)) {
  let raw = null
  try { raw = JSON.parse(readFileSync(HEALTH, 'utf-8')) } catch (e) { fail(`c4-health.json: not valid JSON — ${(e && e.message) || e}`) }
  if (raw) {
    const errsH = validateModel(raw, new URL('./schema/c4-health.schema.json', import.meta.url))
    if (errsH.length) errsH.forEach((e) => fail('c4-health.json: ' + e))
    else {
      health = raw
      for (const v of health.verdicts) {
        if (issuesSnapshot && !issuesSnapshot.issues.some((it) => it.n === v.n)) fail(`c4-health.json: verdict on #${v.n}, which is not in c4-issues.json.`)
      }
    }
  }
}

const FINDINGS = arg('--findings', rp('docs/architecture/c4-findings.json'))
if (existsSync(FINDINGS)) {
  let raw = null
  try { raw = JSON.parse(readFileSync(FINDINGS, 'utf-8')) } catch (e) { fail(`c4-findings.json: not valid JSON — ${(e && e.message) || e}`) }
  if (raw) {
    const errsF = validateModel(raw, new URL('./schema/c4-findings.schema.json', import.meta.url))
    if (errsF.length) errsF.forEach((e) => fail('c4-findings.json: ' + e))
    else {
      const known = issuesSnapshot || new Set()
      for (const finding of raw.findings) evidenceGate(REPO, finding.evidence, `c4-findings.json: ${finding.id} evidence`, known)
    }
  }
}

// 12/13) control-room.html (if present, alongside a manifest and an issue snapshot) — its
// aggregates are RE-DERIVED fresh from lib/roomderive.mjs (the same module `forma room` uses) and
// compared against the machine-readable `window.__ROOM__.derived` block the room writes, never
// against rendered markup — the same seam scripts/presentable.mjs uses to lift `rollEdges` out of
// the shipped viewer, so a template change can't silently stop this from ever running for real.
//
// Per PROGRAMME, because ADR-0005 made the room a portfolio: the derived block lives at
// `__ROOM__.programs[].derived`, and each programme brings its own repository, model and snapshot
// from the manifest. Reading a single top-level `derived` — the pre-ADR-0005 shape — compared every
// field against `undefined`, so this gate could only ever have failed, and only the `existsSync`
// guard below kept that from being noticed.
const ROOM_HTML = arg('--room', rp('docs/architecture/control-room.html'))
const MANIFEST = arg('--manifest', rp('forma.room.json'))
// A label per derived key, so a failure names the thing a reader recognizes on screen. A key with
// no entry still gets gated under its own name — a new derivation is gated the day it is added.
const DERIVED_LABEL = {
  kpis: 'Executive KPIs', milestones: 'WBS milestone aggregates', kanban: 'Kanban buckets',
  queue: 'the prioritized queue', health: 'health staleness', findings: 'findings staleness', brief: 'the brief (claims, staleness, verification)', briefDelta: 'what changed in the brief', commitDrift: 'commit-drift disclosure', link: 'the issue-to-code link', documentGate: 'document gate',
}
if (existsSync(ROOM_HTML) && existsSync(MANIFEST)) {
  const html = readFileSync(ROOM_HTML, 'utf-8')
  const seam = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(html)
  if (!seam) fail('control-room.html: window.__ROOM__ seam not found — did lib/viewer/control-room.html move?')
  else {
    let embedded = null
    try { embedded = JSON.parse(seam[1]) } catch (e) { fail(`control-room.html: embedded __ROOM__ is not valid JSON — ${(e && e.message) || e}`) }
    let manifest = null
    try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { fail(`forma.room.json: not valid JSON — ${(e && e.message) || e}`) }
    if (embedded && manifest) {
      const manifestDir = dirname(resolve(MANIFEST))
      const embeddedById = new Map((embedded.programs || []).map((p) => [p.id, p]))
      // Only what the composer composes: a programme turned off is absent from the artifact
      // by design, and demanding it be rendered would fail every briefing that excludes one.
      const composed = activePrograms(manifest)
      const declared = new Set(composed.map((p) => p.id))
      for (const id of embeddedById.keys()) {
        if (!declared.has(id)) fail(`control-room.html: renders programme "${id}", which forma.room.json no longer declares — regenerate with \`forma room\`.`)
      }
      for (const program of composed) {
        const rendered = embeddedById.get(program.id)
        if (!rendered) { fail(`control-room.html: forma.room.json declares programme "${program.id}", which the artifact does not render — regenerate with \`forma room\`.`); continue }
        const paths = resolveProgramPaths(manifestDir, manifest, program)
        const readOr = (path, label, fallback, optional = false) => {
          if (!path) return fallback
          if (!existsSync(path)) { if (optional) return fallback; fail(`forma.room.json: programme "${program.id}" ${label} is missing: ${path}`); return null }
          try { return JSON.parse(readFileSync(path, 'utf-8')) } catch (e) { fail(`forma.room.json: programme "${program.id}" ${label} is not valid JSON — ${(e && e.message) || e}`); return null }
        }
        const snapshot = readOr(paths.issues, 'issue snapshot', null)
        const pModel = readOr(paths.model, 'model', null)
        const pTopo = readOr(paths.topology, 'topology', null)
        // Overlays are optional by presence: declared but not yet written = empty (room.mjs agrees).
        const pHealth = readOr(paths.health, 'health overlay', { verdicts: [], dependencyConfirmations: [] }, true)
        const pFindings = readOr(paths.findings, 'findings overlay', { findings: [] }, true)
        const pBrief = paths.brief === null ? null : readOr(paths.brief, 'brief overlay', { claims: [] }, true)
        if (!snapshot || !pHealth || !pFindings || (paths.brief !== null && !pBrief)) continue
        const snapshotErrors = validateModel(snapshot, new URL('./schema/c4-issues.schema.json', import.meta.url))
        for (const error of snapshotErrors) fail(`forma.room.json: programme "${program.id}" issue snapshot: ${error}`)
        if (snapshotErrors.length) continue
        for (const error of snapshotManifestErrors(program, snapshot)) fail(`forma.room.json: programme "${program.id}": ${error}`)
        const healthErrors = validateModel(pHealth, new URL('./schema/c4-health.schema.json', import.meta.url))
        const findingErrors = validateModel(pFindings, new URL('./schema/c4-findings.schema.json', import.meta.url))
        for (const error of healthErrors) fail(`forma.room.json: programme "${program.id}" health overlay: ${error}`)
        for (const error of findingErrors) fail(`forma.room.json: programme "${program.id}" findings overlay: ${error}`)
        // The brief is graded like the other overlays: schema, then every claim's evidence must
        // resolve (an unanchored claim is a fatal read error); staleness is derived and REPORTED.
        const briefErrors = pBrief ? validateModel(pBrief, new URL('./schema/c4-brief.schema.json', import.meta.url)) : []
        for (const error of briefErrors) fail(`forma.room.json: programme "${program.id}" brief overlay: ${error}`)
        if (pBrief && !briefErrors.length) for (const claim of pBrief.claims) for (const e of claim.evidence) evidenceGate(paths.repo, e, `forma.room.json: programme "${program.id}" brief claim ${claim.id}`, snapshot)
        if (!findingErrors.length) for (const finding of pFindings.findings) evidenceGate(paths.repo, finding.evidence, `forma.room.json: programme "${program.id}" finding ${finding.id}`, snapshot)
        const loadedDocs = program.docs === undefined ? null : loadDocs(paths.repo, { include: program.docs.include, canon: program.docs.canon, maxBytes: (manifest.docs || {}).maxBytes, gate: program.docs.gate })
        const pArbiterMilestones = loadArbiterMilestones(arbiterMilestonesPath(program, paths.repo), (path) => JSON.parse(readFileSync(path, 'utf-8')))
        const fresh = deriveAll({ repo: paths.repo, model: pModel, topo: pTopo, issuesSnapshot: snapshot, health: pHealth, findings: pFindings, brief: pBrief, briefPath: paths.brief, manifest: paths.programManifest, gateInputs: loadedDocs && loadedDocs.gateInputs, arbiterMilestones: pArbiterMilestones, docs: stripGateInputs(loadedDocs), hasMapDeclared: Boolean(paths.model) })
        const derived = rendered.derived || {}
        const same = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`control-room.html: ${program.id} — ${label} does not match a fresh re-derivation — regenerate with \`forma room\`.`) }
        for (const key of Object.keys(fresh)) same(fresh[key], derived[key], DERIVED_LABEL[key] || key)
        same(pHealth, rendered.health, 'health overlay')
        same(pFindings, rendered.findings, 'findings overlay')
        same(pBrief, rendered.brief === undefined ? null : rendered.brief, 'brief overlay')
        // 13) source.commit staleness is REPORTED, never enforced to zero (docs/SCOPE-room.md §8) —
        // Forma's own dogfood model is already behind `main` at the time this was written. `check`
        // only fails if the disclosure is MISSING or WRONG, never because the layer is stale.
        if (!('commitDrift' in derived)) fail(`control-room.html: ${program.id} must report architecture-layer staleness (commitDrift) — the field is missing entirely.`)
        // No room aggregate may ever double as `completion` (scripts/presentable.mjs predicate 5):
        // closed/(open+closed) is a closureRate, a measurement of issue closure, never a declared %.
        for (const mrow of derived.milestones || []) if ('completion' in mrow) fail(`control-room.html: ${program.id} milestone "${mrow.title}" aggregate carries \`completion\` — must stay \`closureRate\`.`)
        if (fresh.documentGate) {
          for (const error of validateModel({ findings: fresh.documentGate.findings }, new URL('./schema/c4-findings.schema.json', import.meta.url))) fail(`DOCUMENT GATE ${program.id} finding contract: ${error}`)
          for (const finding of fresh.documentGate.findings) {
            evidenceGate(paths.repo, finding.evidence, `DOCUMENT GATE ${program.id} ${finding.id}`, snapshot)
          }
          for (const claim of fresh.documentGate.claims) {
            evidenceGate(paths.repo, claim.evidence, `DOCUMENT CLAIM ${program.id} ${claim.id}`, snapshot)
            if (claim.verdict === 'bad') fail(`DOCUMENT CLAIM ${program.id}: ${claim.id} writes ${JSON.stringify(claim.value)} but measures ${JSON.stringify(claim.measured)} (${claim.reason}).`)
          }
          for (const row of fresh.documentGate.rows.filter((entry) => entry.severity === 'bad')) fail(`DOCUMENT GATE ${program.id}: ${row.invariant} is contradicted (${row.reason}).`)
          for (const error of fresh.documentGate.errors) fail(`DOCUMENT GATE ${program.id}: ${error.path || 'git'} ${error.field} ${error.reason}.`)
          for (const signal of fresh.documentGate.freshness.filter((entry) => entry.verdict === 'warn')) console.warn(`[check-c4] WARN DOCUMENT FRESHNESS ${program.id}: ${signal.path} ${signal.reason}`)
        }

        // 14) The traceability chain, opt-in by presence of `rtm` in the manifest. Four holes, and
        // the last two together are the operational definition of "the GitHub issues ARE the WBS":
        // nothing planned is unaccounted for, and nothing open is unplanned. A repository that
        // declares no rtm block sees none of this.
        const matrix = fresh.rtm
        if (matrix) {
          const where = (o) => `${o.from}:${o.line}`
          for (const d of matrix.orphans.duplicateIds) fail(`RTM: ${program.id} — id "${d.id}" is declared twice (${where(d)} and ${d.first}); a matrix cannot have two rows answering to one name.`)
          for (const d of matrix.orphans.danglingRefs) fail(`RTM: ${program.id} — ${where(d)} row "${d.id}" cites ${d.kind} ${d.ref}, which does not exist. A reference that names nothing reads as traced.`)
          for (const u of matrix.orphans.uncovered) fail(`RTM: ${program.id} — ${where(u)} requirement "${u.id}" lands on no issue and names no verification: "${u.text.slice(0, 60)}".`)
          for (const o of matrix.orphans.orphanIssues) fail(`RTM: ${program.id} — open issue #${o.n} "${String(o.title).slice(0, 60)}" is cited by no requirement; either trace it or the matrix is not the whole of the work.`)
          for (const s of matrix.skipped) fail(`RTM: ${program.id} — ${s.path} contributed no rows (${s.why}); a document that quietly counts for nothing is how a matrix empties.`)
        }
      }
    }
  }
}

if (errs.length) { console.error('[check-c4] FAIL (' + errs.length + '):\n - ' + errs.join('\n - ')); process.exit(1) }
console.log('[check-c4] OK — model is adherent to src/ (leaves, table count, evidence, planned premises all verified)')
