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
import { daysBetween } from '../lib/roomderive.mjs'
import { DERIVED_KEYS, LENSES, derivedLenses, ownershipViolations } from '../lib/lenses.mjs'
import { validateEvidence } from '../lib/audit.mjs'

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
const badPublication = []
let publishedCount = 0
const orphanPills = [], badEvidence = [], badFindings = [], badDocumentEvidence = [], fakedCompletion = [], orphanOpen = [], staleSnapshots = []
const badBriefEvidence = [], colouredUnheld = [], unheldDecisions = []
let briefClaimCount = 0
let verdictCount = 0, findingCount = 0, documentFindingCount = 0, openCount = 0

// Publication-level UI contracts. Browser tests own measured layout and DOM counts; these checks
// make it impossible to publish a composed artifact that silently restores the discarded routes,
// eager rendering, an unbounded issue page, or the inaccessible mobile navigation.
// The IA is no longer a hard-coded list compared against another hard-coded list. It is the table
// in lib/lenses.mjs, injected into the artifact — so what this grades is that the artifact carries
// the table it claims, that every derived surface has exactly one home lens (I20), and, per
// programme, that a lens is mounted when and only when its backing artifacts exist (I7).
const injected = (() => {
  const m = /window\.__LENSES__ = (\[[\s\S]*?\]);/.exec(html)
  try { return m ? JSON.parse(m[1]) : null } catch { return null }
})()
const declaredIds = LENSES.map((lens) => lens.id)
const injectedIa = Boolean(injected) && JSON.stringify(injected.map((lens) => lens.id)) === JSON.stringify(declaredIds)
const oneHome = ownershipViolations(html, DERIVED_KEYS)
const pageSize = Number((/var ISSUE_PAGE_SIZE=(\d+)/.exec(html) || [])[1])
const boundedDom = pageSize > 0 && pageSize <= 50 && /function pagedList\(/.test(html) && /function ensureView\(/.test(html) && !/function buildAll\(/.test(html)
const mobileNav = /id="mobile-program"/.test(html) && /id="mobile-view"/.test(html) && /@media\(max-width:600px\)/.test(html)
const boundedPrint = /\.screen-list,\.workflow\{display:none!important\}/.test(html) && !/details:not\(\[open\]\)/.test(html)
// A single programme opens on its own first published lens: the aggregate front door that read
// "0 things need you out of 4 open" over one programme is not mounted at N=1 (map ticket #90).
const singleHome = /function home\(\)\{return ROOM\.programs\.length===1\?homeOf\(ROOM\.programs\[0\]\):"\/";\}/.test(html) && /if\(ROOM\.programs\.length!==1\)\{mount\("\/"\)/.test(html)
// The shell is viewport-locked, so an unbounded answer tier does not overflow — it STARVES the
// evidence row to zero and lays six panels out below a page that cannot scroll. Measured at
// 1440x900, 1280x800 and 1920x1080 before this cap existed. A layout property, checked here as a
// source contract because this gate has no browser; the measurement lives in the commit that set it.
const boundedAnswer = /\.answer\{[^}]*max-height:\d+vh[^}]*overflow:auto/.test(html)
const documentGateVisible = /var documentPanel=documentGatePanel\(program\);if\(documentPanel\)ev\.appendChild\(documentPanel\)/.test(html)

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
      try { validateEvidence(repo, e, `#${v.n}`, snapshot) }
      catch (error) { badEvidence.push(`${program.id} #${v.n} ${String((error && error.message) || error).replace(/^audit apply:\s*/, '')}`) }
    }
  }

  // 3) every finding row carries a resolvable evidence ref (the mandatory column).
  for (const f of (program.findings && program.findings.findings) || []) {
    findingCount++
    const e = f.evidence
    if (!e || !e.ref) { badFindings.push(`${program.id} ${f.id}`); continue }
    try { validateEvidence(repo, e, `finding ${f.id}`, snapshot) }
    catch (error) { badFindings.push(`${program.id} ${f.id}: ${String((error && error.message) || error).replace(/^audit apply:\s*/, '')}`) }
  }
  for (const f of [...((derived.documentGate && derived.documentGate.findings) || []), ...((derived.documentGate && derived.documentGate.claims) || [])]) {
    documentFindingCount++
    try { validateEvidence(repo, f.evidence, `document gate ${f.id}`, snapshot) }
    catch (error) { badDocumentEvidence.push(`${program.id} ${f.id}: ${String((error && error.message) || error).replace(/^audit apply:\s*/, '')}`) }
  }

  // 4) no room aggregate is ever presented as `completion` — closureRate only (D9).
  for (const m of derived.milestones || []) if ('completion' in m) fakedCompletion.push(`${program.id} ${m.title}`)

  // 4b) the brief: a claim is coloured only under a fresh hostile hold (by derivation), every
  // claim's evidence still resolves, and no decision goes out unheld — a DECIDI TU nobody
  // looked at is the "falso tutto fatto" this artefact exists to refuse.
  const brief = derived.brief
  if (brief) {
    for (const c of brief.claims || []) {
      briefClaimCount++
      if (c.coloured && c.state !== 'holds') colouredUnheld.push(`${program.id} ${c.id}`)
      for (const e of c.evidence || []) {
        try { validateEvidence(repo, e, `claim ${c.id}`, snapshot) }
        catch (error) { badBriefEvidence.push(`${program.id} ${c.id}: ${String((error && error.message) || error).replace(/^audit apply:\s*/, '')}`) }
      }
    }
    for (const c of brief.decisions || []) if (c.state !== 'holds') unheldDecisions.push(`${program.id} ${c.id} (${c.state})`)
  }

  // 4c) the lens partition, per programme: what the briefing published must equal what a fresh
  // derivation over the same artifacts says it may publish. A route mounted for a lens with nothing
  // behind it is the reserved empty panel I7 forbids and UX finding F1 measured; a lens withheld
  // while its artifacts exist is a question silently dropped.
  const claimed = derived.lenses || {}
  const recomputed = derivedLenses(program)
  for (const lens of LENSES) {
    if (claimed[lens.id] === true) publishedCount++
    if (claimed[lens.id] === recomputed[lens.id]) continue
    badPublication.push(`${program.id} ${lens.id}: published ${String(claimed[lens.id])}, artifacts say ${String(recomputed[lens.id])}`)
  }

  // 5) this programme's gh snapshot is not stale past the manifest's own threshold.
  const ageDays = daysBetween(snapshot.fetchedAt, manifest.today)
  const staleAfterDays = manifest.staleAfterDays || 14
  if (ageDays === null || ageDays > staleAfterDays) staleSnapshots.push(`${program.id} ${snapshot.fetchedAt} (${ageDays === null ? 'unknown' : ageDays}d)`)
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
  ['every document-gate row carries resolvable evidence', badDocumentEvidence.length === 0, badDocumentEvidence.length ? badDocumentEvidence.join(', ') : `${documentFindingCount} row(s), 0 unresolvable`],
  ['document-gate evidence is rendered in the provenance lens', documentGateVisible, documentGateVisible ? 'shared documentGatePanel mounted' : 'panel missing from the provenance lens'],
  ['no aggregate is presented as `completion`', fakedCompletion.length === 0, fakedCompletion.length ? fakedCompletion.join(', ') : 'closureRate only'],
  ['every brief claim carries resolvable evidence', badBriefEvidence.length === 0, badBriefEvidence.length ? badBriefEvidence.slice(0, 5).join('; ') : `${briefClaimCount} claim(s), 0 unresolvable`],
  ['no brief claim is coloured without a fresh hostile hold', colouredUnheld.length === 0, colouredUnheld.length ? colouredUnheld.join(', ') : `${briefClaimCount} claim(s), colour only on holds`],
  ['no decision goes out without a fresh hostile hold', unheldDecisions.length === 0, unheldDecisions.length ? unheldDecisions.join(', ') : 'every decision held (or none claimed)'],
  ['no gh snapshot is stale', staleSnapshots.length === 0, staleSnapshots.length ? staleSnapshots.join('; ') : `today ${manifest.today}, limit ${staleAfterDays}d`],
  ['re-generating from the same manifest is byte-deterministic', deterministic, determinismNote],
  ['every open issue is covered (Kanban or queue), none orphaned', orphanOpen.length === 0, orphanOpen.length ? `orphaned: ${orphanOpen.join(', ')}` : `${openCount} open, 0 orphaned`],
  ['a single programme opens on its own first lens, not on an aggregate over itself', singleHome, singleHome ? (programs.length === 1 ? 'one programme: front door is its first published lens' : `${programs.length} programmes: the briefing stays the front door`) : 'home()/registerAll() contract missing'],
  ['the artifact carries the declared lens table, not a copy of it', injectedIa, injected ? injected.map((lens) => lens.id).join(', ') : 'the __LENSES__ seam is missing or unparseable'],
  ['every derived surface has exactly one home lens (I20)', oneHome.length === 0, oneHome.length ? oneHome.slice(0, 4).join('; ') : `${DERIVED_KEYS.length} surfaces, ${declaredIds.length} homes, no surface twice`],
  ['every published lens has backing artifacts, and every absent one has none', badPublication.length === 0, badPublication.length ? badPublication.join('; ') : `${publishedCount} lens(es) published across ${programs.length} programme(s)`],
  ['issue DOM is lazy and page-bounded', boundedDom, Number.isFinite(pageSize) ? `${pageSize} issue rows per page` : 'pagination contract missing'],
  ['mobile navigation has native programme and view controls', mobileNav, mobileNav ? 'two labelled selects at the 600px breakpoint' : 'mobile controls missing'],
  ['print does not expand interactive issue archives', boundedPrint, boundedPrint ? 'interactive lists summarized on paper' : 'unbounded print path detected'],
  ['the answer tier cannot starve the evidence tier', boundedAnswer, boundedAnswer ? 'answer capped and scrollable inside the locked shell' : 'the answer row is unbounded — evidence can be laid out below an unscrollable fold'],
]

let ok = true
for (const [name, pass, note] of predicates) {
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}  (${note})`)
}
console.log(ok ? 'room-presentable: YES — now run `forma check` on the same inputs' : 'room-presentable: NO')
process.exit(ok ? 0 : 1)
