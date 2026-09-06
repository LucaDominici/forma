#!/usr/bin/env node
// forma room update — refresh the Control Room: re-pull each programme's LIVE gh snapshot, then
// recompose the self-contained HTML. This is the one verb to run after a wave of work ("aggiorna
// dashboard"). Network happens ONLY through `verify` (gh); composition stays offline and pure.
// The determinism anchor (`today`) is never touched here: update refreshes facts, not the day the
// briefing speaks for. Model-agnostic and zero-dep, like every other forma command.
// Usage: node lib/roomupdate.mjs --manifest <path> [--out <path>] [--gh-cmd <cmd>] [--limit <n>] [--skip-verify] [--counter] [--fill]
import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activePrograms, resolveProgramPaths, duplicateProgramIds, canonicalPath } from './roomload.mjs'
import { validateModel } from './validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const has = (f) => process.argv.indexOf(f) > -1
const fail = (m) => { console.error('[forma room update] ' + m); process.exit(1) }

const MANIFEST = resolve(arg('--manifest', join(process.cwd(), 'forma.room.json')))
const GH_CMD = arg('--gh-cmd', 'gh')
const LIMIT = arg('--limit', '250')
const SKIP_VERIFY = has('--skip-verify')
const COUNTER = has('--counter')
const FILL = has('--fill')
const OUT = arg('--out', null)

if (!existsSync(MANIFEST)) fail(`manifest not found: ${MANIFEST} — run \`forma room init\` first.`)
let manifest
try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { fail(`${MANIFEST} is not valid JSON — ${(e && e.message) || e}`) }
const manifestErrors = validateModel(manifest, new URL('./schema/forma.room.schema.json', import.meta.url))
if (manifestErrors.length) fail(`${MANIFEST} fails forma.room.schema.json:\n - ${manifestErrors.join('\n - ')}`)
const duplicateIds = duplicateProgramIds(manifest)
if (duplicateIds.length) fail(`manifest declares duplicate programme id(s): ${duplicateIds.join(', ')}`)
// `today` is the determinism anchor; the composer refuses the manifest without it, so we say so here
// rather than letting `room` fail three steps later with a less obvious message.
if (!manifest.today) fail(`${MANIFEST} has no "today" — set it (the determinism anchor) with \`forma room init --today YYYY-MM-DD\` before updating.`)
const dir = dirname(MANIFEST)
const active = activePrograms(manifest)
if (!active.length) fail('every programme in the manifest is disabled; there is nothing to update.')
const finalOut = resolve(OUT || join(dir, 'control-room.html'))

const staged = []
const remove = (path) => { try { unlinkSync(path) } catch {} }
const stage = (target, copy) => {
  const existing = staged.find((row) => row.target === target)
  if (existing) return existing.temp
  const temp = `${target}.forma-room-${process.pid}-${staged.length}.tmp`
  mkdirSync(dirname(target), { recursive: true }); remove(temp)
  if (copy) copyFileSync(target, temp)
  staged.push({ target, temp, backup: `${target}.forma-room-${process.pid}-${staged.length}.bak`, had: false, done: false })
  return temp
}
const cleanup = (backups = true) => { for (const row of staged) { remove(row.temp); if (backups) remove(row.backup) } }
const abort = (message) => { cleanup(); fail(message) }
const commit = () => {
  try {
    for (const row of staged) {
      remove(row.backup)
      if (existsSync(row.target)) { renameSync(row.target, row.backup); row.had = true }
      renameSync(row.temp, row.target); row.done = true
    }
    for (const row of staged) if (row.had) remove(row.backup)
  } catch (e) {
    const rollbackFailures = []
    for (const row of [...staged].reverse()) {
      if (row.done) remove(row.target)
      if (row.had && existsSync(row.backup)) {
        try { renameSync(row.backup, row.target) } catch (rollbackError) { rollbackFailures.push(`${row.target}: ${rollbackError.message}`) }
      }
    }
    cleanup(rollbackFailures.length === 0)
    if (rollbackFailures.length) throw new Error(`publish failed and rollback was incomplete; backup files were preserved (${rollbackFailures.join('; ')}) — original error: ${e.message}`)
    throw new Error(`publish failed; previous files restored: ${e.message}`)
  }
}
const work = active.map((program) => {
  const p = resolveProgramPaths(dir, manifest, program)
  // audit has an opt-in default brief even when the room manifest does not declare one. It is still
  // a writer during this transaction, so stage it too; the composer deliberately will not read it
  // unless `brief.path` was declared (I11).
  const defaultBrief = join(p.repo, 'docs/architecture/c4-brief.json')
  return { program, p, auditBrief: p.brief || (existsSync(defaultBrief) ? defaultBrief : null) }
})
const targets = [{ path: MANIFEST, label: 'manifest', writable: false }, { path: finalOut, label: 'Control Room output', writable: true }]
for (const { program, p, auditBrief } of work) {
  for (const [key, writable] of [['repo', false], ['issues', true], ['model', true], ['health', true], ['findings', true], ['auditPlan', true], ['auditFill', true], ['brief', true], ['topology', false], ['counterResults', true]]) {
    if (p[key]) targets.push({ path: p[key], label: `${program.id}.${key}`, writable })
  }
  if (!p.brief && auditBrief && (COUNTER || FILL)) targets.push({ path: auditBrief, label: `${program.id}.defaultBrief`, writable: true })
}
const owners = new Map()
for (const target of targets) {
  const key = canonicalPath(target.path), prior = owners.get(key)
  if (prior && (prior.writable || target.writable)) abort(`write target collision: ${prior.label} and ${target.label} resolve to ${key}`)
  if (!prior) owners.set(key, target)
}
let refreshed = 0
if (!SKIP_VERIFY) {
  const missing = work.filter(({ program }) => !program.ghRepo)
  if (missing.length) abort(`active programme(s) have no ghRepo: ${missing.map(({ program }) => program.id).join(', ')} — add it, or use --skip-verify only with snapshots you already refreshed.`)
  for (const item of work) {
    const { program, p } = item
    try {
      item.issues = stage(p.issues, false)
      item.model = p.model ? stage(p.model, true) : null
      // verify only reads health. Do not make an empty staged row for a declared-but-absent
      // overlay: there would be nothing to commit on a verify-only run.
      item.health = p.health && existsSync(p.health) ? stage(p.health, true) : null
    } catch (e) { abort(`${program.id}: could not stage existing inputs — ${(e && e.message) || e}`) }
    const a = ['--repo', p.repo, '--gh-repo', program.ghRepo, '--issues', item.issues,
      ...(item.model ? ['--model', item.model] : []), '--gh-cmd', GH_CMD, '--limit', LIMIT,
      ...(p.health ? ['--health', item.health || p.health] : []), '--today', p.programManifest.today,
      '--stale-after-days', String(p.programManifest.staleAfterDays || 14),
      ...(program.workflows || []).flatMap(({ id, path }) => ['--workflow', `${id}=${path}`]),
      ...(program.release ? ['--release'] : [])]
    const r = spawnSync(process.execPath, [join(HERE, 'verify.mjs'), ...a], { stdio: 'inherit' })
    if (r.status === 0) refreshed++
    else abort(`verify failed for: ${program.id} — every staged snapshot/model was discarded; the Control Room remains unchanged.`)
  }
} else {
  console.log('[forma room update] --skip-verify: recomposing from the snapshots already on disk.')
  for (const item of work) { item.issues = item.p.issues; item.model = item.p.model }
}

let countered = 0, filled = 0
if (COUNTER || FILL) {
  const configs = []
  for (const item of work) {
    const { program, p } = item
    if (!p.health || !p.findings || !p.auditPlan) abort(`${program.id}: --counter/--fill need health, findings and auditPlan paths in the manifest.`)
    if (COUNTER && !p.counterResults) abort(`${program.id}: --counter needs a counterResults path in the manifest.`)
    if (FILL && !p.auditFill) abort(`${program.id}: --fill needs an auditFill path in the manifest.`)
    try {
      item.health = item.health || stage(p.health, existsSync(p.health))
      item.findings = stage(p.findings, existsSync(p.findings))
      item.auditPlan = stage(p.auditPlan, false)
      item.brief = item.auditBrief ? stage(item.auditBrief, existsSync(item.auditBrief)) : null
    } catch (e) { abort(`${program.id}: could not stage audit overlays — ${(e && e.message) || e}`) }
    const base = ['--repo', p.repo, '--issues', item.issues, '--health', item.health, '--findings', item.findings,
      '--today', p.programManifest.today, '--stale-after-days', String(p.programManifest.staleAfterDays || 14),
      '--blocked-labels', JSON.stringify(((p.programManifest.blockedBy || {}).labels) || []),
      ...(item.model ? ['--model', item.model, '--model-ref', p.model] : []), ...(p.topology ? ['--topology', p.topology] : []),
      ...(item.brief ? ['--brief', item.brief] : [])]
    const planned = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--plan', item.auditPlan], { stdio: 'inherit' })
    if (planned.status !== 0) abort(`${program.id}: counter-verification plan failed; no result was applied.`)
    configs.push({ program, p, base, auditPlan: item.auditPlan })
  }
  if (FILL) {
    const missing = configs.filter(({ p }) => !existsSync(p.auditFill))
    if (missing.length) abort(`audit fill missing for ${missing.map(({ program, p }) => `${program.id} (${p.auditFill})`).join(', ')}`)
    for (const { program, p, base, auditPlan } of configs) {
      const applied = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--apply', p.auditFill, '--audit-plan', auditPlan], { stdio: 'inherit' })
      if (applied.status !== 0) abort(`${program.id}: audit fill was refused; every staged overlay was discarded.`)
      filled++
    }
    if (COUNTER) for (const { program, base, auditPlan } of configs) {
      const replanned = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--plan', auditPlan], { stdio: 'inherit' })
      if (replanned.status !== 0) abort(`${program.id}: audit re-plan after fill failed.`)
    }
  }
  if (COUNTER) {
  const missing = configs.filter(({ p }) => !existsSync(p.counterResults))
  if (missing.length) abort(`counter result missing for ${missing.map(({ program, p }) => `${program.id} (${p.counterResults})`).join(', ')} — run the external Codex adapter over the generated plan(s), then repeat with --skip-verify --counter.`)
  for (const { program, p, base, auditPlan } of configs) {
    const applied = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--apply', p.counterResults, '--counter-plan', auditPlan], { stdio: 'inherit' })
    if (applied.status !== 0) abort(`${program.id}: counter result was rejected; every staged overlay was discarded.`)
    countered++
  }
  }
}

// Compose from staged reads while keeping the real manifest. The room receives only its inputs as
// temporary paths; its provenance keeps using the declared paths (especially brief.previous).
const stagingDir = mkdtempSync(join(dir, '.forma-room-'))
const stagedInputs = {}
for (const item of work) {
  const inputs = { issues: item.issues }
  if (item.model) inputs.model = item.model
  if (item.health) inputs.health = item.health
  if (item.findings) inputs.findings = item.findings
  if (item.p.brief && item.brief) inputs.brief = item.brief
  stagedInputs[item.program.id] = inputs
}
const inputsTemp = join(stagingDir, 'inputs.json')
writeFileSync(inputsTemp, JSON.stringify(stagedInputs, null, 2) + '\n')
let roomTemp
try { roomTemp = stage(finalOut, false) } catch (e) { rmSync(stagingDir, { recursive: true, force: true }); abort(`could not stage Control Room output — ${(e && e.message) || e}`) }
const rr = spawnSync(process.execPath, [join(HERE, 'room.mjs'), '--manifest', MANIFEST, '--staged-inputs', inputsTemp, '--out', roomTemp], { stdio: 'inherit' })
rmSync(stagingDir, { recursive: true, force: true })
if (rr.status !== 0) abort('composition failed; every staged snapshot/model/overlay was discarded and the Control Room remains unchanged.')
try { commit() } catch (e) { fail((e && e.message) || e) }

console.log(`[forma room update] done — ${refreshed} snapshot(s) refreshed${FILL ? `, ${filled} filled` : ''}${COUNTER ? `, ${countered} counter-verified` : ''}. Control Room recomposed.`)
