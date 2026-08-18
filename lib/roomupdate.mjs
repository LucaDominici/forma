#!/usr/bin/env node
// forma room update — refresh the Control Room: re-pull each programme's LIVE gh snapshot, then
// recompose the self-contained HTML. This is the one verb to run after a wave of work ("aggiorna
// dashboard"). Network happens ONLY through `verify` (gh); composition stays offline and pure.
// The determinism anchor (`today`) is never touched here: update refreshes facts, not the day the
// briefing speaks for. Model-agnostic and zero-dep, like every other forma command.
// Usage: node lib/roomupdate.mjs --manifest <path> [--out <path>] [--gh-cmd <cmd>] [--skip-verify] [--counter] [--fill]
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activePrograms, resolveProgramPaths } from './roomload.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const has = (f) => process.argv.indexOf(f) > -1
const fail = (m) => { console.error('[forma room update] ' + m); process.exit(1) }

const MANIFEST = resolve(arg('--manifest', join(process.cwd(), 'forma.room.json')))
const GH_CMD = arg('--gh-cmd', 'gh')
const SKIP_VERIFY = has('--skip-verify')
const COUNTER = has('--counter')
const FILL = has('--fill')
const OUT = arg('--out', null)

if (!existsSync(MANIFEST)) fail(`manifest not found: ${MANIFEST} — run \`forma room init\` first.`)
let manifest
try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { fail(`${MANIFEST} is not valid JSON — ${(e && e.message) || e}`) }
// `today` is the determinism anchor; the composer refuses the manifest without it, so we say so here
// rather than letting `room` fail three steps later with a less obvious message.
if (!manifest.today) fail(`${MANIFEST} has no "today" — set it (the determinism anchor) with \`forma room init --today YYYY-MM-DD\` before updating.`)
const dir = dirname(MANIFEST)
const active = activePrograms(manifest)
if (!active.length) fail('every programme in the manifest is disabled; there is nothing to update.')

let refreshed = 0, skipped = 0
const failedProgrammes = []
if (!SKIP_VERIFY) {
  for (const program of active) {
    const p = resolveProgramPaths(dir, manifest, program)
    if (!program.ghRepo) { console.error(`[forma room update] ${program.id}: no ghRepo in the manifest — leaving its snapshot as-is.`); skipped++; continue }
    const a = ['--repo', p.repo, '--gh-repo', program.ghRepo, '--issues', p.issues,
      ...(p.model ? ['--model', p.model] : []), '--gh-cmd', GH_CMD,
      ...(p.health ? ['--health', p.health] : []), '--today', p.programManifest.today,
      '--stale-after-days', String(p.programManifest.staleAfterDays || 14),
      ...(program.workflows || []).flatMap(({ id, path }) => ['--workflow', `${id}=${path}`]),
      ...(program.release ? ['--release'] : [])]
    const r = spawnSync(process.execPath, [join(HERE, 'verify.mjs'), ...a], { stdio: 'inherit' })
    if (r.status === 0) refreshed++
    else failedProgrammes.push(program.id)
  }
  if (failedProgrammes.length) fail(`verify failed for: ${failedProgrammes.join(', ')} — Control Room not recomposed from stale snapshots.`)
  if (skipped) fail('one or more active programmes have no ghRepo — add it, or use --skip-verify only with snapshots you already refreshed.')
} else {
  console.log('[forma room update] --skip-verify: recomposing from the snapshots already on disk.')
}

// The two agent channels share one plan: `--fill` applies what the writing agent produced
// (verdicts, findings, brief claims), `--counter` applies what the hostile verifier produced.
// The plan is regenerated first so a fill written against a changed model/issues/health is
// refused; `today` is NOT part of the plan identity, so a fill written yesterday still applies.
let countered = 0, filled = 0
if (COUNTER || FILL) {
  const configs = []
  for (const program of active) {
    const p = resolveProgramPaths(dir, manifest, program)
    if (!p.health || !p.findings || !p.auditPlan) fail(`${program.id}: --counter/--fill need health, findings and auditPlan paths in the manifest.`)
    if (COUNTER && !p.counterResults) fail(`${program.id}: --counter needs a counterResults path in the manifest.`)
    if (FILL && !p.auditFill) fail(`${program.id}: --fill needs an auditFill path in the manifest.`)
    const base = ['--repo', p.repo, '--issues', p.issues, '--health', p.health, '--findings', p.findings, '--today', p.programManifest.today,
      '--stale-after-days', String(p.programManifest.staleAfterDays || 14),
      '--blocked-labels', JSON.stringify(((p.programManifest.blockedBy || {}).labels) || []),
      ...(p.model ? ['--model', p.model] : []), ...(p.topology ? ['--topology', p.topology] : []),
      ...(p.brief ? ['--brief', p.brief] : [])]
    const planned = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--plan', p.auditPlan], { stdio: 'inherit' })
    if (planned.status !== 0) fail(`${program.id}: audit plan failed; no result was applied.`)
    configs.push({ program, p, base })
  }
  if (FILL) {
    const missing = configs.filter(({ p }) => !existsSync(p.auditFill))
    if (missing.length) fail(`audit fill missing for ${missing.map(({ program, p }) => `${program.id} (${p.auditFill})`).join(', ')} — let the agent write it over the generated plan(s), then repeat with --skip-verify --fill.`)
    for (const { program, p, base } of configs) {
      const applied = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--apply', p.auditFill, '--audit-plan', p.auditPlan], { stdio: 'inherit' })
      if (applied.status !== 0) fail(`${program.id}: audit fill was refused entirely; composition stopped.`)
      filled++
    }
  }
  if (COUNTER) {
    // Re-plan after a fill: the counter-claims must name the brief the fill just wrote.
    if (FILL) for (const { program, p, base } of configs) {
      const replanned = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--plan', p.auditPlan], { stdio: 'inherit' })
      if (replanned.status !== 0) fail(`${program.id}: audit re-plan after fill failed.`)
    }
    const missing = configs.filter(({ p }) => !existsSync(p.counterResults))
    if (missing.length) fail(`counter result missing for ${missing.map(({ program, p }) => `${program.id} (${p.counterResults})`).join(', ')} — run the external Codex adapter over the generated plan(s), then repeat with --skip-verify --counter.`)
    for (const { program, p, base } of configs) {
      const applied = spawnSync(process.execPath, [join(HERE, 'audit.mjs'), ...base, '--apply', p.counterResults, '--counter-plan', p.auditPlan], { stdio: 'inherit' })
      if (applied.status !== 0) fail(`${program.id}: counter result was refused entirely; composition stopped.`)
      countered++
    }
  }
}

// Recompose. `room` is read-only and offline; if a snapshot is missing or truncated it fails here
// with its own precise message, which is the honest place for that failure to surface.
const roomArgs = ['--manifest', MANIFEST, ...(OUT ? ['--out', OUT] : [])]
const rr = spawnSync(process.execPath, [join(HERE, 'room.mjs'), ...roomArgs], { stdio: 'inherit' })
if (rr.status !== 0) fail('composition failed; see errors above (the snapshots were refreshed, only the HTML did not build).')

console.log(`[forma room update] done — ${refreshed} snapshot(s) refreshed${skipped ? `, ${skipped} left as-is` : ''}${failedProgrammes.length ? `, ${failedProgrammes.length} failed` : ''}${FILL ? `, ${filled} filled` : ''}${COUNTER ? `, ${countered} counter-verified` : ''}. Control Room recomposed.`)
