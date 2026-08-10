#!/usr/bin/env node
// room-presentable.mjs — the acceptance instrument for the Control Room (docs/SCOPE-room.md),
// same role scripts/presentable.mjs plays for the single-lens viewer: `forma check` grades
// adherence to the code, this grades whether the rendered artifact keeps its own promises.
// Zero-dep, no network. Exit 2 = usage/seam broken, 1 = a predicate failed, 0 = every predicate
// holds. Every predicate always runs and always prints — no early return.
//
//   node scripts/room-presentable.mjs --room <path> --repo <path> --model <path>
//     --topology <path> --issues <path> --manifest <path> [--health <path>] [--findings <path>]
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const usage = () => { console.error('usage: node scripts/room-presentable.mjs --room <control-room.html> --repo <path> --model <path> --topology <path> --issues <path> --manifest <path> [--health <path>] [--findings <path>]'); process.exit(2) }

const ROOM_HTML = arg('--room'), REPO = arg('--repo'), MODEL = arg('--model'), TOPO = arg('--topology'), ISSUES = arg('--issues'), MANIFEST = arg('--manifest')
const HEALTH = arg('--health'), FINDINGS = arg('--findings')
if (!ROOM_HTML || !REPO || !MODEL || !TOPO || !ISSUES || !MANIFEST) usage()
if (!existsSync(ROOM_HTML)) { console.error(`room-presentable: not found: ${ROOM_HTML}`); process.exit(2) }

const html = readFileSync(ROOM_HTML, 'utf-8')
const seam = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(html)
if (!seam) { console.error('room-presentable: window.__ROOM__ seam not found — did lib/viewer/control-room.html move?'); process.exit(2) }
let ROOM
try { ROOM = JSON.parse(seam[1]) } catch (e) { console.error(`room-presentable: embedded __ROOM__ is not valid JSON — ${(e && e.message) || e}`); process.exit(2) }

const manifest = (() => { try { return JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { console.error(`room-presentable: ${MANIFEST} — ${(e && e.message) || e}`); process.exit(2) } })()

const knownIssues = new Set((ROOM.issuesSnapshot.issues || []).map((it) => it.n))
const openIssues = new Set((ROOM.issuesSnapshot.issues || []).filter((it) => it.state === 'OPEN').map((it) => it.n))

// 1) every issue number the room actually DISPLAYS (kanban + queue + link chips) resolves in the
// snapshot — an orphan reference is a pill pointing at nothing.
const shown = new Set()
for (const list of Object.values(ROOM.derived.kanban || {})) for (const n of list) shown.add(n)
for (const c of (ROOM.derived.queue || {}).clusters || []) for (const n of c.issues) shown.add(n)
const orphanPills = [...shown].filter((n) => !knownIssues.has(n))

// 2) every health verdict carries evidence that still resolves (path exists / commit resolves).
const badEvidence = []
for (const v of (ROOM.health && ROOM.health.verdicts) || []) {
  for (const e of v.evidence || []) {
    if (e.type === 'path' && !existsSync(join(REPO, e.ref))) badEvidence.push(`#${v.n} path ${e.ref}`)
    else if (e.type === 'commit') { try { execFileSync('git', ['-C', REPO, 'cat-file', '-e', e.ref], { stdio: 'ignore' }) } catch { badEvidence.push(`#${v.n} commit ${e.ref}`) } }
  }
}

// 3) every finding row carries a resolvable evidence ref (the seg tab's mandatory column).
const badFindings = []
for (const f of ROOM.findings || []) {
  const e = f.evidence
  if (!e || !e.ref) { badFindings.push(f.id); continue }
  if (e.type === 'path' && !existsSync(join(REPO, e.ref))) badFindings.push(f.id)
}

// 4) no room aggregate is ever presented as `completion` — closureRate only.
const fakedCompletion = (ROOM.derived.milestones || []).filter((m) => 'completion' in m).map((m) => m.title)

// 5) the gh snapshot is not stale past the manifest's own threshold.
const staleAfterDays = manifest.staleAfterDays || 14
const ageDays = Math.round((new Date(manifest.today) - new Date(ROOM.issuesSnapshot.fetchedAt)) / 86400000)
const stale = !Number.isFinite(ageDays) || ageDays > staleAfterDays

// 6) determinism: re-run `forma room` with the SAME inputs and byte-compare. Nothing in room.mjs
// reads Date.now()/Math.random() — fetchedAt/today both come from input files — so two runs on
// unchanged inputs must be byte-identical, or the template introduced non-determinism.
const tmpOut = join(HERE, '..', `.room-presentable-tmp-${process.pid}.html`)
let determinismNote = 'skipped (re-run failed)', deterministic = false
try {
  const roomScript = join(HERE, '..', 'lib', 'room.mjs')
  const args = [roomScript, '--repo', REPO, '--model', MODEL, '--topology', TOPO, '--issues', ISSUES, '--manifest', MANIFEST, '--out', tmpOut]
  if (HEALTH) args.push('--health', HEALTH)
  if (FINDINGS) args.push('--findings', FINDINGS)
  execFileSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const rerun = readFileSync(tmpOut, 'utf-8')
  deterministic = rerun === html
  determinismNote = deterministic ? 'byte-identical' : `differs (${rerun.length} vs ${html.length} bytes)`
} catch (e) {
  determinismNote = `re-run failed: ${String((e && e.stderr) || (e && e.message) || e).slice(0, 200)}`
} finally {
  if (existsSync(tmpOut)) unlinkSync(tmpOut)
}

// 7) no open issue is orphaned: every OPEN issue is either in a Kanban bucket or a queue cluster.
const covered = new Set()
for (const list of Object.values(ROOM.derived.kanban || {})) for (const n of list) covered.add(n)
for (const c of (ROOM.derived.queue || {}).clusters || []) for (const n of c.issues) covered.add(n)
const orphanOpen = [...openIssues].filter((n) => !covered.has(n))

const predicates = [
  ['every issue reference on screen resolves in the snapshot (no orphan pill)', orphanPills.length === 0, orphanPills.length ? `orphans: ${orphanPills.slice(0, 8).join(', ')}` : 'none'],
  ['every health verdict carries resolvable evidence', badEvidence.length === 0, badEvidence.length ? badEvidence.slice(0, 5).join('; ') : `${((ROOM.health && ROOM.health.verdicts) || []).length} verdict(s), 0 unresolvable`],
  ['every Segnalazioni row carries resolvable evidence', badFindings.length === 0, badFindings.length ? `id(s): ${badFindings.join(', ')}` : `${(ROOM.findings || []).length} finding(s), 0 unresolvable`],
  ['no aggregate is presented as `completion`', fakedCompletion.length === 0, fakedCompletion.length ? fakedCompletion.join(', ') : 'closureRate only'],
  ['the gh snapshot is not stale', !stale, `fetchedAt ${ROOM.issuesSnapshot.fetchedAt}, today ${manifest.today}, age ${ageDays}d, limit ${staleAfterDays}d`],
  ['re-generating from the same inputs is byte-deterministic', deterministic, determinismNote],
  ['every open issue is covered (Kanban or Coda), none orphaned', orphanOpen.length === 0, orphanOpen.length ? `orphaned: ${orphanOpen.join(', ')}` : `${openIssues.size} open, 0 orphaned`],
]

let ok = true
for (const [name, pass, note] of predicates) {
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}  (${note})`)
}
console.log(ok ? 'room-presentable: YES — now run `forma check` on the same inputs' : 'room-presentable: NO')
process.exit(ok ? 0 : 1)
