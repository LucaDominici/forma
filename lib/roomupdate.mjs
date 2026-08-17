#!/usr/bin/env node
// forma room update — refresh the Control Room: re-pull each programme's LIVE gh snapshot, then
// recompose the self-contained HTML. This is the one verb to run after a wave of work ("aggiorna
// dashboard"). Network happens ONLY through `verify` (gh); composition stays offline and pure.
// The determinism anchor (`today`) is never touched here: update refreshes facts, not the day the
// briefing speaks for. Model-agnostic and zero-dep, like every other forma command.
// Usage: node lib/roomupdate.mjs --manifest <path> [--out <path>] [--gh-cmd <cmd>] [--limit <n>] [--skip-verify] [--counter]
import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
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
  const temp = `${target}.forma-room-${process.pid}-${staged.length}.tmp`
  mkdirSync(dirname(target), { recursive: true }); remove(temp)
  if (copy) copyFileSync(target, temp)
  staged.push({ target, temp, backup: `${target}.forma-room-${process.pid}-${staged.length}.bak`, had: false, done: false })
  return temp
}
const cleanup = () => { for (const row of staged) { remove(row.temp); remove(row.backup) } }
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
    for (const row of [...staged].reverse()) {
      if (row.done) remove(row.target)
      if (row.had && existsSync(row.backup)) { try { renameSync(row.backup, row.target) } catch {} }
    }
    cleanup()
    throw e
  }
}
const work = active.map((program) => ({ program, p: resolveProgramPaths(dir, manifest, program) }))
const targets = [{ path: MANIFEST, label: 'manifest', writable: false }, { path: finalOut, label: 'Control Room output', writable: true }]
for (const { program, p } of work) {
  for (const [key, writable] of [['issues', true], ['model', true], ['health', true], ['findings', true], ['auditPlan', true], ['topology', false], ['counterResults', false]]) {
    if (p[key]) targets.push({ path: p[key], label: `${program.id}.${key}`, writable })
  }
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
    } catch (e) { abort(`${program.id}: could not stage existing inputs — ${(e && e.message) || e}`) }
    const a = ['--repo', p.repo, '--gh-repo', program.ghRepo, '--issues', item.issues, ...(item.model ? ['--model', item.model] : []), '--gh-cmd', GH_CMD, '--limit', LIMIT]
    const r = spawnSync(process.execPath, [join(HERE, 'verify.mjs'), ...a], { stdio: 'inherit' })
    if (r.status === 0) refreshed++
    else abort(`verify failed for: ${program.id} — every staged snapshot/model was discarded; the Control Room remains unchanged.`)
  }
} else {
  console.log('[forma room update] --skip-verify: recomposing from the snapshots already on disk.')
  for (const item of work) { item.issues = item.p.issues; item.model = item.p.model }
}

let countered = 0
if (COUNTER) {
  const configs = []
  for (const item of work) {
    const { program, p } = item
    if (!p.health || !p.findings || !p.auditPlan || !p.counterResults) abort(`${program.id}: --counter needs health, findings, auditPlan and counterResults paths in the manifest.`)
    try { item.health = stage(p.health, true); item.findings = stage(p.findings, true); item.auditPlan = stage(p.auditPlan, false) } catch (e) { abort(`${program.id}: could not stage audit overlays — ${(e && e.message) || e}`) }
    const base = ['--repo', p.repo, '--issues', item.issues, '--health', item.health, '--findings', item.findings,
      ...(item.model ? ['--model', item.model] : []), ...(p.topology ? ['--topology', p.topology] : [])]
    const planned = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--plan', item.auditPlan], { stdio: 'inherit' })
    if (planned.status !== 0) abort(`${program.id}: counter-verification plan failed; no result was applied.`)
    configs.push({ program, p, base, auditPlan: item.auditPlan })
  }
  const missing = configs.filter(({ p }) => !existsSync(p.counterResults))
  if (missing.length) abort(`counter result missing for ${missing.map(({ program, p }) => `${program.id} (${p.counterResults})`).join(', ')} — run the external Codex adapter over the generated plan(s), then repeat with --skip-verify --counter.`)
  for (const { program, p, base, auditPlan } of configs) {
    const applied = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--apply', p.counterResults, '--counter-plan', auditPlan], { stdio: 'inherit' })
    if (applied.status !== 0) abort(`${program.id}: counter result was rejected; every staged overlay was discarded.`)
    countered++
  }
}

// Compose against the staged portfolio, under a manifest with the same basename so the artifact's
// provenance stays truthful. Only after composition succeeds do all facts and the HTML swap in.
const stagingDir = mkdtempSync(join(dir, '.forma-room-'))
const stagedManifest = JSON.parse(JSON.stringify(manifest))
for (const item of work) {
  const target = stagedManifest.programs.find((program) => program.id === item.program.id)
  target.repo = item.p.repo; target.issues = item.issues
  if (item.model) target.model = item.model
  if (item.p.topology) target.topology = item.p.topology
  if (item.health) target.health = item.health; else if (item.p.health) target.health = item.p.health
  if (item.findings) target.findings = item.findings; else if (item.p.findings) target.findings = item.p.findings
}
const manifestTemp = join(stagingDir, basename(MANIFEST))
writeFileSync(manifestTemp, JSON.stringify(stagedManifest, null, 2) + '\n')
let roomTemp
try { roomTemp = stage(finalOut, false) } catch (e) { rmSync(stagingDir, { recursive: true, force: true }); abort(`could not stage Control Room output — ${(e && e.message) || e}`) }
const rr = spawnSync(process.execPath, [join(HERE, 'room.mjs'), '--manifest', manifestTemp, '--out', roomTemp], { stdio: 'inherit' })
rmSync(stagingDir, { recursive: true, force: true })
if (rr.status !== 0) abort('composition failed; every staged snapshot/model/overlay was discarded and the Control Room remains unchanged.')
try { commit() } catch (e) { fail(`could not publish the staged portfolio atomically; previous files restored: ${(e && e.message) || e}`) }

console.log(`[forma room update] done — ${refreshed} snapshot(s) refreshed${COUNTER ? `, ${countered} counter-verified` : ''}. Control Room recomposed.`)
