#!/usr/bin/env node
// gen-c4-model.mjs — emit docs/architecture/c4-model.json from real code + curated topology.
// Leaves are walked LIVE from src/ (always current). Topology/context/runtime-edges are curated.
// Usage: node gen-c4-model.mjs [--repo <path>] [--topology <path>] [--out <path>]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, basename, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { containerOf, componentsFor } from './cluster.mjs'
import { isGo, goEdges } from './lang.mjs'
import { makeDescribeCtx, resolveDescription } from './describe.mjs'
import { loadDocRows, indexByNode, describingRows, statusFor } from './docmap.mjs'
import { loadCache, mergeCache, enrich, agentPlan, applyFills } from './enrich.mjs'
import { materializeTimeline, validateModel } from './validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const TOPO = arg('--topology', join(REPO, 'docs/architecture/c4-topology.json'))
const OUT = arg('--out', join(REPO, 'docs/architecture/c4-model.json'))
const SCHEMA_VERSION = '1.6.0' // +optional cumulative architecture timeline (additive)
const CLUSTER = !process.argv.includes('--no-cluster') // §2: auto-cluster flat containers; --no-cluster to disable
const ENRICH = process.argv.includes('--enrich')       // §7: opt-in LLM prose for description holes
const ENRICHER = arg('--enricher', null)
const ENRICH_MODEL = arg('--enrich-model', null)
const STATUS = arg('--status', join(REPO, 'docs/architecture/c4-status.json')) // curated programme state, optional
const STATUS_SET = process.argv.includes('--status')
const APPLY = arg('--enrich-apply', null)          // prose written by the agent driving forma
const STATUS_APPLY = arg('--status-apply', null)   // §WP-A7: programme STATE written by that agent

const topo = JSON.parse(readFileSync(TOPO, 'utf-8'))
const rp = (p) => join(REPO, p)
const fail = (m) => { console.error('[gen-c4] FAIL: ' + m); process.exit(1) }
// §2 thresholds, overridable. Guarded: a non-integer would silently disable clustering
// (`length >= NaN` is false for every group), so a bad value fails loud instead.
const posInt = (flag, dflt) => { const v = Number(arg(flag, dflt)); if (!Number.isInteger(v) || v < 1) fail(`${flag}: expected a positive integer, got "${arg(flag, dflt)}"`); return v }
const CLUSTER_MIN = posInt('--cluster-min', 8), GROUP_MIN = posInt('--group-min', 3)
// §7 has no default provider ON PURPOSE. It used to be `anthropic`, i.e. the one path that needs
// an API key most people have not exported — so `--enrich` "worked", printed a skip line, exited 0
// and left every box empty: the defect this command exists to fix, reintroduced by its own default.
// Flipping the default to `agent` would be just as silent the other way (a CI job with a key would
// quietly stop filling boxes and start writing a plan file). So: choose, explicitly.
if (ENRICH && !ENRICHER) fail('--enrich needs an explicit --enricher: `agent` (no key — an agent writes the prose, see --enrich-apply), `anthropic`/`openai` (REST, needs the API key in the environment), `ollama` (localhost), or `echo` (offline, testing).')

function walk(spec) {
  const dir = rp(spec.dir)
  if (!existsSync(dir)) fail(`leafSource dir missing: ${spec.dir}`)
  const re = new RegExp(spec.match), ex = spec.exclude ? new RegExp(spec.exclude) : null
  return readdirSync(dir).filter((f) => {
    const full = join(dir, f)
    if (spec.filesOnly !== false && statSync(full).isDirectory()) return false
    if (!re.test(f)) return false
    if (ex && ex.test(f)) return false
    return true
  }).sort()
}
function countMatches(file, pattern, unique) {
  const p = rp(file)
  if (!existsSync(p)) fail(`countFrom file missing: ${file}`)
  const txt = readFileSync(p, 'utf-8')
  const m = txt.match(new RegExp(pattern, 'g')) || []
  return unique ? new Set(m).size : m.length
}

const nodes = []
const byId = new Map()
const add = (n) => { if (byId.has(n.id)) fail('dup node id ' + n.id); byId.set(n.id, n); nodes.push(n) }

// 1) curated non-leaf nodes (context/container/component)
for (const n of topo.nodes) add({ status: 'current', ...n })

// 2) live leaves from src/
for (const spec of topo.leafSources) {
  if (!byId.has(spec.parent)) fail('leafSource parent unknown: ' + spec.parent)
  const files = walk(spec)
  if (files.length === 0) fail(`leafSource matched 0 files (phantom node?): ${spec.dir}`)
  // `evidenceOnly`: the files are re-walked for the gate but never become boxes — the unit of
  // architecture is the container itself (a Go package). Its own `path` evidence is what joins it
  // to a capability table (docmap matches on `path`), points describe's README lookup at its own
  // directory rather than its parent's, and gives `check` an evidence path to assert exists.
  if (!spec.evidenceOnly) for (const f of files) {
    add({
      id: `${spec.parent}__${f.replace(/[^a-z0-9]+/gi, '_')}`,
      level: 'leaf', parent: spec.parent, kind: 'leaf',
      name: f.replace(/\.[a-z0-9]+$/i, ''), status: 'current',
      // `dir: "."` (loose top-level sources, or a Go package at the module root) must not produce
      // "./x": the ref is a repo-relative key, and the oracle caught the Go adapter failing to map
      // "./migrations" back to the import path <module>/migrations.
      evidence: [{ type: 'path', ref: spec.dir === '.' ? f : `${spec.dir}/${f}` }],
    })
  }
  // attach glob count to the parent (drift anchor)
  const parent = byId.get(spec.parent)
  parent.evidence = [...(parent.evidence || []), { type: 'glob', ref: spec.dir, count: files.length },
                     ...(spec.evidenceOnly ? [{ type: 'path', ref: spec.dir }] : [])]
}

// 3) curated leaves (mixed-location, with optional computed counts)
for (const l of topo.curatedLeaves || []) {
  if (!byId.has(l.parent)) fail('curatedLeaf parent unknown: ' + l.parent)
  if (l.evidence && !existsSync(rp(l.evidence))) fail('curatedLeaf evidence missing: ' + l.evidence)
  let tech = l.tech
  if (l.countFrom) { const c = countMatches(l.countFrom.file, l.countFrom.pattern, l.countFrom.unique); tech = `${c} ${l.tech || ''}`.trim() }
  add({ id: l.id, level: 'leaf', parent: l.parent, kind: 'leaf', name: l.name, tech, status: 'current',
        evidence: l.evidence ? [{ type: 'path', ref: l.evidence }] : [] })
}

// 4) planned leaves — verify their premise still holds in the docs (non-vacuous)
for (const p of topo.plannedLeaves || []) {
  if (!byId.has(p.parent)) fail('plannedLeaf parent unknown: ' + p.parent)
  if (p.sourceRef && !existsSync(rp(p.sourceRef))) fail('plannedLeaf sourceRef missing: ' + p.sourceRef)
  if (p.sourceMustContain) {
    const txt = readFileSync(rp(p.sourceRef), 'utf-8')
    if (!txt.includes(p.sourceMustContain)) fail(`planned "${p.name}" premise changed — "${p.sourceMustContain}" not in ${p.sourceRef}. Update the roadmap/model.`)
  }
  add({ id: p.id, level: 'leaf', parent: p.parent, kind: 'leaf', name: p.name, tech: p.tech, status: 'planned',
        status2: p.status2, completion: p.completion, current: p.current, target: p.target, verify: p.verify,
        evidence: [{ type: 'doc', ref: p.sourceRef }] })
}

// §2) synthesize a component layer for flat containers (auto; --no-cluster to disable).
// Runs BEFORE the enrich/func loops so components inherit category/status/func. Leaves that
// join a component are re-parented to it; containerOf() keeps edge/check logic container-scoped.
if (CLUSTER) for (const cid of [...new Set(topo.leafSources.map((s) => s.parent))]) {
  const container = byId.get(cid); if (!container) continue
  const leaves = nodes.filter((n) => n.kind === 'leaf' && n.parent === cid) // pre-reparent: plain filter valid here
  if (leaves.length <= CLUSTER_MIN) continue
  const { components, reparent } = componentsFor(container, leaves, { groupMin: GROUP_MIN })
  if (!components.length) { console.log(`[gen-c4] container ${cid}: ${leaves.length} leaf non-clusterable (flat)`); continue }
  for (const c of components) add(c)
  for (const n of leaves) { const to = reparent.get(n.id); if (to) n.parent = to }
  console.log(`[gen-c4] container ${cid}: clustered ${leaves.length} leaves into ${components.length} component(s)`)
}

// §docmap) join the repo's own capability tables to the nodes, ONCE: the same match feeds both the
// description (§1a below) and the programme state derived just under here.
const docRows = loadDocRows(REPO, topo.docSources)
// A row whose code_ref resolves to nothing does not merely go unverified: it stops TOUCHING its
// node, so the capability it describes leaves the completion denominator and the box goes green.
// Renaming one cell took a container from in-progress/50 to done/100 with a fresh "(1/1 done)"
// citation, and `check` re-derived and confirmed the new number. Fail on it.
const deadRows = docRows.filter((r) => r.dead.length)
if (deadRows.length) fail('docSources cite code that does not exist:\n - ' +
  deadRows.map((r) => `${r.from}: "${r.text.slice(0, 60)}" → ${r.dead.join(', ')}`).join('\n - ') +
  '\n[gen-c4] a row whose code_ref resolves to nothing silently stops counting: its capability drops out of the denominator and the box turns green. Fix the ref, or the path.')
const docIndex = indexByNode(docRows, nodes)
if (docRows.length) console.log(`[gen-c4] docSources: ${docRows.length} row(s) → ${docIndex.size} node(s) touched, ${nodes.filter((n) => describingRows(docIndex, n.id)).length} described`)

// enrich: fill hologram defaults (category, 6-status, completion, current/target) where absent
for (const n of nodes) {
  // A leaf's category is the CONTAINER it belongs to, not its parent's category. Inheriting the
  // parent's handed every leaf in the repo the literal string "container", and the viewer's
  // catalogue collapse groups childless siblings BY CATEGORY — so a repo's leaves collapsed into a
  // single box labelled "container" (53 of them on the Go repo this was measured on). With the real
  // container they group the way that feature was written for, or stay apart when they belong apart.
  if (!n.category) n.category = n.kind === 'leaf' ? (byId.get(containerOf(n, byId)) || {}).name || 'leaf' : n.kind
  // Progress a DOCUMENT states outright — the only generated alternative to hand-writing the
  // overlay. Derived, so it is re-derived by `check` rather than trusted; the curated overlay
  // (§WP-A1, applied further down) still overrides every field of it.
  // NOT the system node. Its subtree is the whole repo, so EVERY row in the document touches it and
  // its denominator is "the rows somebody wrote", never "the repo". A three-row all-done matrix
  // rendered the whole product as done/100 on the first screen anyone opens, with a container the
  // document never mentions sitting right underneath at `unknown`. The whole-product verdict is
  // exactly what the curated overlay is for.
  const ds = !n.status2 && n.kind !== 'system' ? statusFor(docIndex, n.id) : null
  // `derived: true` is the marker `check` keys off to know this state must keep re-deriving. A
  // string match on the citation would break the moment anyone rewords it.
  // `coverage` rides in `verify` (additionalProperties: true there, so no schema churn) and says how
  // much of the node the citation actually reaches — the difference between "3 of 3 rows are done"
  // and "this module is done".
  // `ds.completion` is ABSENT when the document declares rather than measures (docmap §statusFor).
  // Assigning it anyway would put an own `completion: undefined` on the node — invisible in the
  // written JSON, but validateModel walks own properties and would reject it against `integer`.
  if (ds) { n.status2 = ds.status2; if (n.completion == null && ds.completion != null) n.completion = ds.completion; if (!n.verify) n.verify = { source: ds.source, derived: true, ...(ds.coverage ? { coverage: ds.coverage } : {}) } }
  // Code can prove a file EXISTS; it cannot prove the work behind it is finished. Marking every
  // undecorated node done/100 turned a virgin repo into a board reading "10/10 complete" — the
  // exact false green this tool exists to kill. No overlay (§WP-A1), no verdict: `unknown`, and
  // no completion at all (a percentage nobody curated is a made-up number, including 0).
  if (!n.status2) n.status2 = n.status === 'planned' ? 'planned' : 'unknown'
  if (n.completion == null && n.status === 'planned') n.completion = 0
  // `current` is left EMPTY unless curated (topology or status overlay): the viewer falls back to
  // `func`, which since §1a carries the module's real documentation. The old "Exists: <path>"
  // filler restated the evidence path in the one field meant for programme facts.
  if (n.target == null) n.target = ''
}

// §33) the context actors `init` seeds are placeholders, and a placeholder nobody renamed is the
// first screen a stakeholder sees. Not a failure — the model is valid and the rest of it is real —
// but it must never pass unremarked, so the names are printed back verbatim. Matched on the `TODO:`
// prefix, which is also what a human writing "TODO: the family" gets, and not on the seeded ids: an
// actor that was renamed properly keeps its id and must stop being nagged about.
const anon = nodes.filter((n) => /^TODO:/.test(String(n.name)))
if (anon.length) console.error(`[gen-c4] note: ${anon.length} context box(es) still unnamed — ${anon.map((n) => `"${n.name}"`).join(', ')}. Rename them in the topology; nothing else derives them.`)

// §1a) func: plain-language "what it does" resolved from existing docs (curated → docstring → README
// → arc42 → generated fallback), with provenance in descSource. No LLM here — pure parsing.
const dctx = makeDescribeCtx({ repo: REPO, byId, descriptions: topo.descriptions || {}, docPath: topo.docPath, containerOf, docIndex })
for (const n of nodes) { const r = resolveDescription(n, dctx); n.func = r.func; n.descSource = r.descSource }

// §1a-bis) a synthesized component has no doc of its own: before settling for "Groups related
// files under X", compose its box from its children's docs (first sentence of up to 3, ordered by
// name — deterministic). descSource stays 'fallback': this is a heuristic, and --enrich may still
// improve it. Separate pass so it does not depend on components being added after their leaves.
const firstSentence = (s) => (String(s).match(/^[^.!?]*[.!?]/) || [String(s)])[0].trim()
for (const n of nodes) {
  if (n.kind !== 'component' || n.descSource !== 'fallback') continue
  const kids = nodes.filter((k) => k.parent === n.id && ['curated', 'docmap', 'docstring', 'readme'].includes(k.descSource))
    .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0)).slice(0, 3)
  const txt = kids.map((k) => firstSentence(k.func)).filter(Boolean).join(' ')
  if (txt) n.func = txt.length > 200 ? txt.slice(0, 199) + '…' : txt
}

// §WP-A1) programme-status overlay: the one channel for curated STATE (what is true now, where it
// must land, what proves it). Code can't know it, so a human/agent writes it in c4-status.json and
// gen validates only its FORM — ids resolve, fields are known, enums/ranges hold. Never `func`:
// what a module DOES comes from its docs (§1a), what it's WORTH is programme state.
const STATUS_FIELDS = new Set(['status2', 'completion', 'statusWord', 'current', 'target', 'verify', 'issues'])
const STATUS2 = new Set(['done', 'in-progress', 'next', 'planned', 'problem'])
// One validator, two callers: the overlay FILE below, and --status-apply just above it. A writer
// that validated differently from the reader would commit a c4-status.json the very next `gen`
// rejects. Returns the complaints; the caller decides whether that is a fail or a refusal to write.
function statusPatchErrors(id, patch, known) {
  const out = []
  if (!known(id)) out.push(`unknown node id "${id}" — it is not in the model (stale overlay?)`)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [...out, `"${id}" must map to an object of state fields`]
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('$')) continue // $comment and friends
    if (!STATUS_FIELDS.has(k)) { out.push(`"${id}" has field "${k}"; allowed: ${[...STATUS_FIELDS].join(', ')}${k === 'func' ? ' (func comes from the docs, not the overlay)' : ''}`); continue }
    if (k === 'status2' && !STATUS2.has(v)) out.push(`"${id}" status2 "${v}" — expected one of ${[...STATUS2].join('|')}`)
    if (k === 'completion' && !(Number.isInteger(v) && v >= 0 && v <= 100)) out.push(`"${id}" completion must be an integer 0-100, got ${JSON.stringify(v)}`)
    if (k === 'issues') {
      if (!Array.isArray(v)) out.push(`"${id}" issues must be an array`)
      else for (const is of v) if (!/^#?\d+$/.test(String(is))) out.push(`"${id}" issue ${JSON.stringify(is)} — expected "#123"`)
    }
  }
  return out
}

// §WP-A7) --status-apply: the WRITER the overlay never had. `c4-status.json` is the authority —
// every field it sets outranks anything §17 derives from a document — and nothing in the repo has
// ever written one, so on a fresh repo the authority channel was reachable only by hand-editing
// JSON. This is the state counterpart of `--enrich-apply`: an agent or a human hands in the fields
// a document cannot supply, and they land in the curated file, reviewed in the diff like any other.
if (STATUS_APPLY) {
  if (!existsSync(STATUS_APPLY)) fail(`--status-apply: file missing: ${STATUS_APPLY}`)
  let incoming
  try { incoming = JSON.parse(readFileSync(STATUS_APPLY, 'utf-8')).nodes } catch (e) { fail(`--status-apply: ${STATUS_APPLY} is not valid JSON: ${(e && e.message) || e}`) }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) fail(`--status-apply: ${STATUS_APPLY} must contain {"nodes":{"<id>":{…}}}`)
  // Validate EVERYTHING before touching disk. A half-written overlay is a file the next `gen`
  // refuses to read, in a repo where that file is committed.
  const errs = Object.entries(incoming).flatMap(([id, patch]) => statusPatchErrors(id, patch, (x) => byId.has(x)))
  if (errs.length) fail(`--status-apply: ${STATUS_APPLY} rejected, ${relative(REPO, STATUS)} left untouched:\n - ` + errs.join('\n - '))
  let base = { nodes: {} }
  if (existsSync(STATUS)) {
    try { base = JSON.parse(readFileSync(STATUS, 'utf-8')) } catch (e) { fail(`--status-apply: existing ${relative(REPO, STATUS)} is not valid JSON: ${(e && e.message) || e}`) }
    base.nodes = base.nodes || {}
  }
  for (const [id, patch] of Object.entries(incoming)) base.nodes[id] = { ...(base.nodes[id] || {}), ...patch }
  // The first apply on a repo IS the one that creates the overlay, and a repo that has never run
  // `forma doc` has no docs/architecture/ to create it in.
  mkdirSync(dirname(STATUS), { recursive: true })
  writeFileSync(STATUS, JSON.stringify(base, null, 2) + '\n')
  console.log(`[gen-c4] --status-apply: ${Object.keys(incoming).length} node(s) merged into ${relative(REPO, STATUS)}`)
}

let statusPath = null
if (existsSync(STATUS) || STATUS_SET) {
  if (!existsSync(STATUS)) fail(`--status: file missing: ${STATUS}`)
  let ov
  try { ov = JSON.parse(readFileSync(STATUS, 'utf-8')) } catch (e) { fail(`--status: ${STATUS} is not valid JSON: ${(e && e.message) || e}`) }
  let decorated = 0
  for (const [id, patch] of Object.entries(ov.nodes || {})) {
    const errs = statusPatchErrors(id, patch, (x) => byId.has(x))
    if (errs.length) fail('status overlay: ' + errs.join('\n[gen-c4] FAIL: status overlay: '))
    const target = byId.get(id)
    for (const [k, v] of Object.entries(patch)) { if (!k.startsWith('$')) target[k] = v }
    decorated++
  }
  statusPath = relative(REPO, STATUS)
  console.log(`[gen-c4] status overlay: ${decorated} node(s) decorated from ${statusPath}`)
}

// §7) enrichment (prose only, never structure/gate). Cache-merge ALWAYS: preserve prior LLM prose
// whose inputs are unchanged, so a plain regen doesn't discard it. --enrich additionally fills the
// remaining holes over the network (best-effort — a failure keeps the deterministic fallback).
const ectx = { repo: REPO, byId, containerOf }
mergeCache(nodes, loadCache(OUT))
// --enrich-apply: prose written by the agent that drives forma (see --enricher agent below).
// Independent of --enrich, and applied first — an explicit fill outranks anything generated.
if (APPLY) {
  if (!existsSync(APPLY)) fail(`--enrich-apply: file missing: ${APPLY}`)
  let fills
  try { fills = JSON.parse(readFileSync(APPLY, 'utf-8')).fills } catch (e) { fail(`--enrich-apply: ${APPLY} is not valid JSON: ${(e && e.message) || e}`) }
  if (!Array.isArray(fills)) fail(`--enrich-apply: ${APPLY} must contain {"fills":[{"id","func"}]}`)
  try { console.log(`[gen-c4] --enrich-apply: ${applyFills(nodes, ectx, fills)} fill(s) applied`) }
  catch (e) { fail(String((e && e.message) || e)) }
}
if (ENRICH && ENRICHER === 'agent') {
  // No network: emit the work for the agent already in the session, keep the deterministic model.
  const plan = agentPlan(nodes, ectx)
  const planPath = join(dirname(OUT), 'enrich-plan.json')
  writeFileSync(planPath, JSON.stringify({ entries: plan }, null, 2) + '\n')
  console.log(`[gen-c4] --enricher agent: ${plan.length} hole(s) → ${relative(REPO, planPath)} — write the prose yourself, then:`)
  console.log(`[gen-c4]   forma gen --enrich-apply ${relative(REPO, join(dirname(OUT), 'enrich-fill.json'))}`)
} else if (ENRICH) {
  try { const r = await enrich(nodes, ectx, { provider: ENRICHER, model: ENRICH_MODEL }); console.log(`[gen-c4] --enrich (${ENRICHER}): filled ${r.filled}/${r.holes} description hole(s)`) }
  catch (e) { console.error('[gen-c4] --enrich skipped: ' + String((e && e.message) || e)) }
}

// 4b) derive container↔container edges from REAL code references (deterministic, additive).
// Auto-walk gives structure (containers+leaves) but not relationships. Here we recover them from the
// code itself: for each container, count how many of ANOTHER container's exposed leaf names (class/
// module names) appear as whole-word references in this container's files. count>0 ⇒ a real edge.
// Language-agnostic (matches symbol names, not import syntax). Additive: never removes curated edges.
// A language that DECLARES its dependencies gets its adapter instead (lib/lang.mjs): guessing from
// names where an `import` block states the fact is strictly worse, and gets the direction wrong.
if (!process.argv.includes('--no-auto-edges') && isGo(topo.meta && topo.meta.stack)) {
  // Grouping 53 packages into domains is the only cure for a wall of boxes, and the intuitive way
  // to curate it — stamping `kind: "component"` on the grouped package — takes 189 edges to 13
  // without a word: goEdges reads a package's directory off its `glob` evidence and skips anything
  // that is not kind "container". The node still LOOKS right in the JSON. Say it out loud, because
  // the only other symptom is arrows the reader never knew were supposed to be there.
  const mute = nodes.filter((n) => n.kind !== 'container' && (n.evidence || []).some((e) => e.type === 'glob'))
  if (mute.length) console.error(`[gen-c4] WARNING: ${mute.length} node(s) carry glob evidence but kind ≠ "container", so no import edge is derived from them: ` +
    mute.slice(0, 5).map((n) => `${n.id} (kind "${n.kind}")`).join(', ') + (mute.length > 5 ? `, +${mute.length - 5} more` : '') +
    '\n[gen-c4] to group packages, keep kind:"container" and move only level/parent.')
  const derived = goEdges({ repo: REPO, nodes, edges: topo.edges })
  topo.edges = [...(topo.edges || []), ...derived]
  console.log(`[gen-c4] auto-edges: +${derived.length} container edge(s) derived from Go import blocks`)
} else if (!process.argv.includes('--no-auto-edges')) {
  const STOP = new Set(['index', 'main', 'app', 'utils', 'util', 'types', 'model', 'base', 'core', 'const', 'style', 'theme'])
  const srcs = (topo.leafSources || []).filter((s) => byId.has(s.parent))
  const exposes = new Map(), text = new Map()
  for (const s of srcs) {
    exposes.set(s.parent, [...new Set(nodes.filter((n) => n.kind === 'leaf' && containerOf(n, byId) === s.parent)
      .map((n) => String(n.name)).filter((nm) => nm.length >= 5 && !STOP.has(nm.toLowerCase())))])
    let t = ''; const dir = rp(s.dir)
    try { for (const f of readdirSync(dir)) { const fp = join(dir, f); if (statSync(fp).isFile()) t += '\n' + readFileSync(fp, 'utf-8') } } catch {}
    text.set(s.parent, t)
  }
  // ponytail: per-line kind is a heuristic (import > drives > reads > references); the count `c` below
  // is untouched, and curated edges always win where precision matters. The verb is what an executive
  // reads; the count lives in `weight` so the viewer can roll it up without parsing the label.
  const VERB = [[/^\s*(?:import|export)\b[\s\S]*?\bfrom\b|^\s*const\s+\S+\s*=\s*require\s*\(/, 'imports'],
    [/\b(?:spawn|exec)(?:Sync|File)?\s*\(/, 'drives'],
    [/\breadFileSync\s*\(|\breaddirSync\s*\(|\breadJson\b/, 'reads']]
  const RANK = { imports: 3, drives: 2, reads: 1, references: 0 }
  const classify = (line) => { for (const [re, v] of VERB) if (re.test(line)) return v; return 'references' }
  const exposesRe = new Map()
  for (const to of exposes.keys()) {
    const alts = exposes.get(to).map((nm) => nm.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&')).join('|')
    exposesRe.set(to, alts ? new RegExp('(^|[^\\w-])(?:' + alts + ')([^\\w-]|$)') : null)
  }
  const have = new Set((topo.edges || []).flatMap((e) => [e.from + '|' + e.to, e.to + '|' + e.from]))
  const derived = []
  for (const from of exposes.keys()) {
    const t = text.get(from) || ''
    for (const to of exposes.keys()) {
      if (to === from || have.has(from + '|' + to)) continue
      let c = 0
      // A module name is matched VERBATIM (metacharacters escaped, never deleted: stripping them
      // turned "session-store" into /\bsessionstore\b/, which matches nothing — every kebab-case
      // repo, i.e. most JS/TS ones, rendered edges=0). `-` and `.` are word separators here, so
      // the boundary is spelled out instead of using \b (which sits INSIDE "session-store").
      for (const nm of exposes.get(to)) { if (new RegExp('(^|[^\\w-])' + nm.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&') + '([^\\w-]|$)').test(t)) c++ }
      if (c > 0) {
        let verb = 'references'
        const re = exposesRe.get(to)
        if (re) for (const line of t.split('\n')) { if (re.test(line)) { const v = classify(line); if (RANK[v] > RANK[verb]) verb = v } }
        derived.push({ from, to, label: verb, weight: c, kind: 'import', estatus: 'inferred' })
        have.add(from + '|' + to); have.add(to + '|' + from)
      }
    }
  }
  topo.edges = [...(topo.edges || []), ...derived]
  if (derived.length) console.log(`[gen-c4] auto-edges: +${derived.length} container edge(s) derived from code references`)
}

// 5) validate edges resolve
for (const e of topo.edges) { if (!byId.has(e.from)) fail('edge from unknown: ' + e.from); if (!byId.has(e.to)) fail('edge to unknown: ' + e.to) }

// 6) provenance
let commit = 'unknown', branch = 'unknown'
const gitOpts = { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }
try { commit = execSync('git rev-parse HEAD', gitOpts).toString().trim() } catch {}
try { branch = execSync('git rev-parse --abbrev-ref HEAD', gitOpts).toString().trim() } catch {}

// §1b) carry the attach registry forward from the prior model — `forma doc --attach` writes it
// there, and without this a plain regen would drop it and un-govern the attached docs.
// The registry lives ONLY in the generated model, so that model has to be committed (or at least
// kept) for the gate to keep governing. If a prior model is there but unreadable, say so rather
// than silently ungoverning every attached doc.
let attachedDocs = []
if (existsSync(OUT)) {
  try { attachedDocs = JSON.parse(readFileSync(OUT, 'utf-8')).source.attachedDocs || [] }
  catch (e) { console.error(`[gen-c4] WARNING: ${OUT} is unreadable (${(e && e.message) || e}) — any source.attachedDocs registry in it is lost; re-run \`forma doc --attach\` for each attached doc.`) }
}

// generatedAt is the ONE per-run volatile field (a plain `gen` x2 must diff on nothing else).
// meta.verifiedAt is reserved for `forma verify` (network, opt-in) — gen never writes it.
const model = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  source: { repo: topo.meta.repo, commit, branch, docPath: topo.docPath, generator: 'gen-c4-model@' + SCHEMA_VERSION, ...(attachedDocs.length ? { attachedDocs } : {}), ...(statusPath ? { statusPath } : {}) },
  ...(topo.timeline ? { timeline: topo.timeline } : {}),
  // topo.layout (optional curated coordinates, keyed by parent id) rides along verbatim: the
  // viewer pins those nodes and auto-arranges the rest. `meta` is the model's free-form area.
  meta: { ...topo.meta, ...(topo.layout ? { layout: topo.layout } : {}), verifyMethod: 'code+topology (gh re-verify optional)' },
  levels: topo.levels,
  nodes,
  edges: topo.edges.map((e) => ({ status: 'current', estatus: e.estatus || 'active', ...e })),
}
// --from-docs (optional): derive the TARGET layer from documentation (PRD→docs), not code.
// Surfaces project-status milestones + ADR statuses so "stato finito" is doc-driven. Best-effort.
if (process.argv.includes('--from-docs')) {
  try {
    const ps = existsSync(rp('docs/project-status.md')) ? readFileSync(rp('docs/project-status.md'), 'utf-8') : ''
    const planned = [...ps.matchAll(/\|\s*(M\d+)\s*\|\s*PLANNED\s*\|[^|]*\|\s*([^|]+?)\s*\|/g)].map((m) => `${m[1]}: ${m[2].trim()}`)
    let accepted = 0, adrs = 0
    const adrDir = rp('docs/adr')
    if (existsSync(adrDir)) for (const f of readdirSync(adrDir)) if (/\.md$/.test(f) && !/template/i.test(f)) { adrs++; if (/Status[:*\s]+Accepted/i.test(readFileSync(join(adrDir, f), 'utf-8'))) accepted++ }
    model.meta.docTargets = planned
    model.meta.adr = { total: adrs, accepted }
    model.meta.verifyMethod = 'from-docs (project-status milestones + ADR statuses)'
    console.log(`[gen-c4] --from-docs: ${planned.length} planned milestone(s), ${accepted}/${adrs} ADR accepted`)
  } catch (e) { model.meta.verifyError = 'from-docs: ' + String((e && e.message) || e) }
}
// topo.nodes and timeline patches are copied into the model, so validate both the static schema and
// EVERY cumulative checkpoint before touching OUT. A rejected projection must not corrupt the last
// committed model any more than a rejected status overlay does.
const schemaErrors = validateModel(model)
if (schemaErrors.length) fail('model does not validate against lib/schema/c4-model.schema.json:\n - ' + schemaErrors.join('\n - '))
const timelineErrors = materializeTimeline(model, { sourceExists: (rel) => existsSync(rp(rel)) }).errors
if (timelineErrors.length) fail('timeline is not a valid cumulative architecture projection:\n - ' + timelineErrors.join('\n - '))
writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n')
const counts = { total: nodes.length, leaves: nodes.filter((n) => n.kind === 'leaf').length, planned: nodes.filter((n) => n.status === 'planned').length }
console.log(`[gen-c4] wrote ${OUT}`)
console.log(`[gen-c4] nodes=${counts.total} leaves=${counts.leaves} planned=${counts.planned} edges=${model.edges.length} commit=${commit.slice(0,8)}`)
