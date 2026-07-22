#!/usr/bin/env node
// gen-c4-model.mjs — emit docs/architecture/c4-model.json from real code + curated topology.
// Leaves are walked LIVE from src/ (always current). Topology/context/runtime-edges are curated.
// Usage: node gen-c4-model.mjs [--repo <path>] [--topology <path>] [--out <path>]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const TOPO = arg('--topology', join(REPO, 'docs/architecture/c4-topology.json'))
const OUT = arg('--out', join(REPO, 'docs/architecture/c4-model.json'))
const SCHEMA_VERSION = '1.1.0'

const topo = JSON.parse(readFileSync(TOPO, 'utf-8'))
const rp = (p) => join(REPO, p)
const fail = (m) => { console.error('[gen-c4] FAIL: ' + m); process.exit(1) }

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
  for (const f of files) {
    add({
      id: `${spec.parent}__${f.replace(/[^a-z0-9]+/gi, '_')}`,
      level: 'leaf', parent: spec.parent, kind: 'leaf',
      name: f.replace(/\.[a-z0-9]+$/i, ''), status: 'current',
      evidence: [{ type: 'path', ref: `${spec.dir}/${f}` }],
    })
  }
  // attach glob count to the parent (drift anchor)
  const parent = byId.get(spec.parent)
  parent.evidence = [...(parent.evidence || []), { type: 'glob', ref: spec.dir, count: files.length }]
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

// enrich: fill hologram defaults (category, 5-status, completion, current/target) where absent
for (const n of nodes) {
  const par = n.parent ? byId.get(n.parent) : null
  if (!n.category) n.category = n.kind === 'leaf' ? (par && par.category) || 'leaf' : n.kind
  if (!n.status2) n.status2 = n.status === 'planned' ? 'planned' : 'done'
  if (n.completion == null) n.completion = n.status === 'planned' ? 0 : 100
  if (!n.current) { const pth = (n.evidence || []).find((e) => e.type === 'path'); n.current = pth ? `Exists: ${pth.ref}` : (n.tech || '') }
  if (n.target == null) n.target = ''
}

// func: plain-language "what it does" (non-dev). Leaves from the descriptions map; else the description.
const D = topo.descriptions || {}
for (const n of nodes) {
  const key = n.parent ? `${n.parent}/${String(n.name).replace(/\.\w+$/, '').replace(/ .*/, '')}` : null
  n.func = (key && D[key]) || n.description || (n.kind === 'leaf' ? `Component of module ${(byId.get(n.parent) || {}).name || n.parent}.` : '')
}

// 4b) derive container↔container edges from REAL code references (deterministic, additive).
// Auto-walk gives structure (containers+leaves) but not relationships. Here we recover them from the
// code itself: for each container, count how many of ANOTHER container's exposed leaf names (class/
// module names) appear as whole-word references in this container's files. count>0 ⇒ a real edge.
// Language-agnostic (matches symbol names, not import syntax). Additive: never removes curated edges.
if (!process.argv.includes('--no-auto-edges')) {
  const STOP = new Set(['index', 'main', 'app', 'utils', 'util', 'types', 'model', 'base', 'core', 'const', 'style', 'theme'])
  const srcs = (topo.leafSources || []).filter((s) => byId.has(s.parent))
  const exposes = new Map(), text = new Map()
  for (const s of srcs) {
    exposes.set(s.parent, [...new Set(nodes.filter((n) => n.parent === s.parent && n.kind === 'leaf')
      .map((n) => String(n.name)).filter((nm) => nm.length >= 5 && !STOP.has(nm.toLowerCase())))])
    let t = ''; const dir = rp(s.dir)
    try { for (const f of readdirSync(dir)) { const fp = join(dir, f); if (statSync(fp).isFile()) t += '\n' + readFileSync(fp, 'utf-8') } } catch {}
    text.set(s.parent, t)
  }
  const have = new Set((topo.edges || []).flatMap((e) => [e.from + '|' + e.to, e.to + '|' + e.from]))
  const derived = []
  for (const from of exposes.keys()) {
    const t = text.get(from) || ''
    for (const to of exposes.keys()) {
      if (to === from || have.has(from + '|' + to)) continue
      let c = 0
      for (const nm of exposes.get(to)) { if (new RegExp('\\b' + nm.replace(/[^\w]/g, '') + '\\b').test(t)) c++ }
      if (c > 0) { derived.push({ from, to, label: c + '×', kind: 'import', estatus: 'active' }); have.add(from + '|' + to); have.add(to + '|' + from) }
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

const model = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  source: { repo: topo.meta.repo, commit, branch, docPath: topo.docPath, generator: 'gen-c4-model@' + SCHEMA_VERSION },
  meta: { ...topo.meta, verifiedAt: new Date().toISOString(), verifyMethod: 'code+topology (gh re-verify optional)' },
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
writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n')
const counts = { total: nodes.length, leaves: nodes.filter((n) => n.kind === 'leaf').length, planned: nodes.filter((n) => n.status === 'planned').length }
console.log(`[gen-c4] wrote ${OUT}`)
console.log(`[gen-c4] nodes=${counts.total} leaves=${counts.leaves} planned=${counts.planned} edges=${model.edges.length} commit=${commit.slice(0,8)}`)
