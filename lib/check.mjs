#!/usr/bin/env node
// check-c4-model.mjs — NON-VACUOUS anti-drift gate for the C4 model.
// Fails LOUD (never SKIP). Asserts the committed model against INDEPENDENT ground truth in src/,
// and flags architecture-doc numbers that disagree with code (the "14 vs 25 tables" trap).
// Usage: node check-c4-model.mjs [--repo <path>] [--model <path>] [--topology <path>]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containerOf } from './cluster.mjs'
import { renderBlock, extractBetween, norm } from './render.mjs'
import { descInputHash } from './enrich.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const MODEL = arg('--model', join(REPO, 'docs/architecture/c4-model.json'))
const TOPO = arg('--topology', join(REPO, 'docs/architecture/c4-topology.json'))
const rp = (p) => join(REPO, p)
const errs = []
const fail = (m) => errs.push(m)

if (!existsSync(MODEL)) { console.error('[check-c4] FAIL: model missing (no SKIP): ' + MODEL); process.exit(1) }
if (!existsSync(TOPO)) { console.error('[check-c4] FAIL: topology missing: ' + TOPO); process.exit(1) }
const model = JSON.parse(readFileSync(MODEL, 'utf-8'))
const topo = JSON.parse(readFileSync(TOPO, 'utf-8'))
const byId = new Map((model.nodes || []).map((n) => [n.id, n]))

// 1) schemaVersion present + basic shape
if (!/^\d+\.\d+\.\d+$/.test(model.schemaVersion || '')) fail('missing/invalid schemaVersion')
if (!Array.isArray(model.nodes) || model.nodes.length === 0) fail('no nodes')

// 2) re-derive leaf counts from src/ INDEPENDENTLY and compare to the model
function walk(spec) {
  const dir = rp(spec.dir); if (!existsSync(dir)) { fail('leafSource dir missing: ' + spec.dir); return [] }
  const re = new RegExp(spec.match), ex = spec.exclude ? new RegExp(spec.exclude) : null
  return readdirSync(dir).filter((f) => {
    if (spec.filesOnly !== false && statSync(join(dir, f)).isDirectory()) return false
    return re.test(f) && !(ex && ex.test(f))
  })
}
for (const spec of topo.leafSources) {
  const live = walk(spec).length
  const inModel = model.nodes.filter((n) => n.kind === 'leaf' && n.status === 'current' && containerOf(n, byId) === spec.parent).length
  if (live === 0) fail(`phantom parent "${spec.parent}": src glob ${spec.dir} matches 0 files`)
  if (live !== inModel) fail(`DRIFT: ${spec.parent} — src has ${live} files, model has ${inModel}. Regenerate c4-model.json.`)
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
if (src.statusPath && existsSync(rp(src.statusPath))) {
  let ov = null
  try { ov = JSON.parse(readFileSync(rp(src.statusPath), 'utf-8')) } catch (e) { fail(`status overlay: ${src.statusPath} is not valid JSON: ${(e && e.message) || e}`) }
  if (ov) for (const id of Object.keys(ov.nodes || {})) if (!byId.has(id)) fail(`status overlay: "${id}" is not a node in the model — ${src.statusPath} is stale.`)
}

// SOFT: LLM-enriched prose whose inputs changed is only a reminder, never a gate failure (structure
// is the gate; enrichment freshness is advisory). check never calls the LLM — it recomputes the hash.
for (const n of model.nodes || []) {
  if (n.descSource === 'llm' && n.descInputHash && n.descInputHash !== descInputHash(n, { repo: REPO, byId, containerOf })) {
    console.warn(`[check-c4] note: enrichment stale for ${n.id} — run \`forma gen --enrich\` to refresh (non-blocking).`)
  }
}

if (errs.length) { console.error('[check-c4] FAIL (' + errs.length + '):\n - ' + errs.join('\n - ')); process.exit(1) }
console.log('[check-c4] OK — model is adherent to src/ (leaves, table count, evidence, planned premises all verified)')
