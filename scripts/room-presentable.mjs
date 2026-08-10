#!/usr/bin/env node
// room-presentable.mjs — the acceptance instrument for the Control Room (docs/SCOPE-room.md),
// same role scripts/presentable.mjs plays for the single-lens viewer: `forma check` grades
// adherence to the code, this grades whether the rendered artifact keeps its own promises.
// Zero-dep, no network. Exit 2 = usage/seam broken, 1 = a predicate failed, 0 = every predicate
// holds. Every predicate always runs and always prints — no early return.
//
// Takes the manifest and nothing else per repository: ADR-0005 made the room a portfolio over N
// programmes, so every path this needs (each programme's checkout, snapshot and overlays) is
// already named in the manifest, resolved against the manifest's own directory exactly as
// lib/room.mjs resolves it. Passing them again as flags is how this script came to describe a
// shape the composer had stopped producing.
//
//   node scripts/room-presentable.mjs --room <control-room.html> --manifest <forma.room.json>
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const usage = () => { console.error('usage: node scripts/room-presentable.mjs --room <control-room.html> --manifest <forma.room.json>'); process.exit(2) }

const ROOM_HTML = arg('--room'), MANIFEST = arg('--manifest')
if (!ROOM_HTML || !MANIFEST) usage()
if (!existsSync(ROOM_HTML)) { console.error(`room-presentable: not found: ${ROOM_HTML}`); process.exit(2) }

const html = readFileSync(ROOM_HTML, 'utf-8')
const seam = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(html)
if (!seam) { console.error('room-presentable: window.__ROOM__ seam not found — did lib/viewer/control-room.html move?'); process.exit(2) }
let ROOM
try { ROOM = JSON.parse(seam[1]) } catch (e) { console.error(`room-presentable: embedded __ROOM__ is not valid JSON — ${(e && e.message) || e}`); process.exit(2) }

const MANIFEST_DIR = dirname(resolve(MANIFEST))
const manifestPath = (p) => isAbsolute(p) ? p : resolve(MANIFEST_DIR, p)
const manifest = (() => { try { return JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { console.error(`room-presentable: ${MANIFEST} — ${(e && e.message) || e}`); process.exit(2) } })()
const repoFor = new Map((manifest.programs || []).map((p) => [p.id, manifestPath(p.repo)]))

const programs = ROOM.programs || []
const orphanPills = [], badEvidence = [], badFindings = [], fakedCompletion = [], orphanOpen = [], staleSnapshots = []
let verdictCount = 0, findingCount = 0, openCount = 0

for (const program of programs) {
  const snapshot = program.issuesSnapshot || {}
  const derived = program.derived || {}
  const repo = repoFor.get(program.id)
  const known = new Set((snapshot.issues || []).map((it) => it.n))
  const open = (snapshot.issues || []).filter((it) => it.state === 'OPEN').map((it) => it.n)
  openCount += open.length

  // 1+7) every issue number the room DISPLAYS for this programme, and every OPEN issue that ought
  // to be displayed. Both directions matter: a pill pointing at nothing, and work the briefing
  // silently omits, are the same defect seen from either end.
  const shown = new Set()
  for (const list of Object.values(derived.kanban || {})) for (const n of list) shown.add(n)
  for (const cluster of (derived.queue || {}).clusters || []) for (const n of cluster.issues) shown.add(n)
  for (const entry of ROOM.portfolio.blocked || []) if (entry.program === program.id) shown.add(entry.n)
  for (const entry of ROOM.portfolio.moving || []) {
    if (entry.program !== program.id) continue
    for (const cluster of entry.byCluster || []) for (const n of cluster.issues) shown.add(n)
  }
  for (const n of shown) if (!known.has(n)) orphanPills.push(`${program.id} #${n}`)
  for (const n of open) if (!shown.has(n)) orphanOpen.push(`${program.id} #${n}`)

  // 2) every health verdict carries evidence that still resolves (path exists / commit resolves).
  for (const v of (program.health && program.health.verdicts) || []) {
    verdictCount++
    for (const e of v.evidence || []) {
      if (e.type === 'path' && !existsSync(join(repo, e.ref))) badEvidence.push(`${program.id} #${v.n} path ${e.ref}`)
      else if (e.type === 'commit') { try { execFileSync('git', ['-C', repo, 'cat-file', '-e', e.ref], { stdio: 'ignore' }) } catch { badEvidence.push(`${program.id} #${v.n} commit ${e.ref}`) } }
    }
  }

  // 3) every finding row carries a resolvable evidence ref (the mandatory column).
  for (const f of (program.findings && program.findings.findings) || []) {
    findingCount++
    const e = f.evidence
    if (!e || !e.ref) { badFindings.push(`${program.id} ${f.id}`); continue }
    if (e.type === 'path' && !existsSync(join(repo, e.ref))) badFindings.push(`${program.id} ${f.id}`)
  }

  // 4) no room aggregate is ever presented as `completion` — closureRate only (D9).
  for (const m of derived.milestones || []) if ('completion' in m) fakedCompletion.push(`${program.id} ${m.title}`)

  // 5) this programme's gh snapshot is not stale past the manifest's own threshold.
  const ageDays = Math.round((new Date(manifest.today) - new Date(snapshot.fetchedAt)) / 86400000)
  const staleAfterDays = manifest.staleAfterDays || 14
  if (!Number.isFinite(ageDays) || ageDays > staleAfterDays) staleSnapshots.push(`${program.id} ${snapshot.fetchedAt} (${ageDays}d)`)
}

// 6) determinism: re-run `forma room` with the SAME manifest and byte-compare. Nothing in room.mjs
// reads Date.now()/Math.random() — fetchedAt/today both come from input files — so two runs on
// unchanged inputs must be byte-identical, or the template introduced non-determinism.
const tmpOut = join(HERE, '..', `.room-presentable-tmp-${process.pid}.html`)
let determinismNote = 'skipped (re-run failed)', deterministic = false
try {
  execFileSync(process.execPath, [join(HERE, '..', 'lib', 'room.mjs'), '--manifest', MANIFEST, '--out', tmpOut], { stdio: ['ignore', 'pipe', 'pipe'] })
  const rerun = readFileSync(tmpOut, 'utf-8')
  deterministic = rerun === html
  determinismNote = deterministic ? 'byte-identical' : `differs (${rerun.length} vs ${html.length} bytes)`
} catch (e) {
  determinismNote = `re-run failed: ${String((e && e.stderr) || (e && e.message) || e).slice(0, 200)}`
} finally {
  if (existsSync(tmpOut)) unlinkSync(tmpOut)
}

const staleAfterDays = manifest.staleAfterDays || 14
const predicates = [
  ['every issue reference on screen resolves in its snapshot (no orphan pill)', orphanPills.length === 0, orphanPills.length ? `orphans: ${orphanPills.slice(0, 8).join(', ')}` : `${programs.length} programme(s), none`],
  ['every health verdict carries resolvable evidence', badEvidence.length === 0, badEvidence.length ? badEvidence.slice(0, 5).join('; ') : `${verdictCount} verdict(s), 0 unresolvable`],
  ['every finding row carries resolvable evidence', badFindings.length === 0, badFindings.length ? badFindings.join(', ') : `${findingCount} finding(s), 0 unresolvable`],
  ['no aggregate is presented as `completion`', fakedCompletion.length === 0, fakedCompletion.length ? fakedCompletion.join(', ') : 'closureRate only'],
  ['no gh snapshot is stale', staleSnapshots.length === 0, staleSnapshots.length ? staleSnapshots.join('; ') : `today ${manifest.today}, limit ${staleAfterDays}d`],
  ['re-generating from the same manifest is byte-deterministic', deterministic, determinismNote],
  ['every open issue is covered (Kanban or queue), none orphaned', orphanOpen.length === 0, orphanOpen.length ? `orphaned: ${orphanOpen.join(', ')}` : `${openCount} open, 0 orphaned`],
]

let ok = true
for (const [name, pass, note] of predicates) {
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}  (${note})`)
}
console.log(ok ? 'room-presentable: YES — now run `forma check` on the same inputs' : 'room-presentable: NO')
process.exit(ok ? 0 : 1)
