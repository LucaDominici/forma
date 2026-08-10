#!/usr/bin/env node
// forma room — compose one portfolio manifest into one self-contained Control Room HTML.
// Read-only over every input; no network here: issue snapshots must already exist (`forma verify`).
// Usage: node lib/room.mjs --manifest <path> [--out <path>]
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateModel } from './validate.mjs'
import { deriveAll, derivePortfolio } from './roomderive.mjs'
import { resolveProgramPaths } from './roomload.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fail = (m) => { console.error('[forma room] ' + m); process.exit(1) }
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1]
  if (flag !== '--manifest' && flag !== '--out') fail(`unknown option: ${flag}`)
  if (!value || value.startsWith('--')) fail(`${flag} requires a path`)
  options[flag] = value
}
if (!options['--manifest']) fail('missing required --manifest <path>')

const MANIFEST = resolve(options['--manifest'])
const MANIFEST_DIR = dirname(MANIFEST)
const OUT = options['--out'] || join(MANIFEST_DIR, 'control-room.html')
const schema = (name) => new URL(`./schema/${name}`, import.meta.url)
const readJson = (path, label) => { try { return JSON.parse(readFileSync(path, 'utf-8')) } catch (e) { fail(`${label}: ${path} — ${(e && e.message) || e}`) } }
const readValidated = (path, schemaName, label) => {
  const obj = readJson(path, label)
  const errs = validateModel(obj, schema(schemaName))
  if (errs.length) fail(`${label}: ${path} fails ${schemaName}:\n - ` + errs.join('\n - '))
  return obj
}

const manifest = readValidated(MANIFEST, 'forma.room.schema.json', 'manifest')
const loadedPrograms = manifest.programs.map((program) => {
  const label = `program "${program.id}"`
  // Same resolver `check` uses, so the gate can never re-derive from a different set of files.
  const paths = resolveProgramPaths(MANIFEST_DIR, manifest, program)
  const repo = paths.repo
  const issuesSnapshot = readValidated(paths.issues, 'c4-issues.schema.json', `${label} issue snapshot`)
  if (issuesSnapshot.truncated === true) fail(`${label}: issue snapshot is truncated; refusing to build counts and proportions from incomplete facts.`)
  if (issuesSnapshot.ghRepo !== program.ghRepo) fail(`${label}: issue snapshot names ${issuesSnapshot.ghRepo}, manifest names ${program.ghRepo} — regenerate the snapshot or fix the manifest.`)

  if (Boolean(paths.model) !== Boolean(paths.topology)) fail(`${label}: model and topology must either both be present or both be absent.`)
  const hasMap = Boolean(paths.model)
  let model = null, topo = null
  if (hasMap) {
    model = readJson(paths.model, `${label} model`)
    const modelErrs = validateModel(model)
    if (modelErrs.length) fail(`${label} model: ${paths.model} fails c4-model.schema.json:\n - ` + modelErrs.join('\n - '))
    topo = readJson(paths.topology, `${label} topology`)
  }
  const health = paths.health === null
    ? { verdicts: [] }
    : readValidated(paths.health, 'c4-health.schema.json', `${label} health overlay`)
  const findings = paths.findings === null
    ? { findings: [] }
    : readValidated(paths.findings, 'c4-findings.schema.json', `${label} findings overlay`)
  // Every programme derives, mapped or not: without a map the two map-dependent answers come back
  // null (see deriveAll), but its issues still get gated aggregates instead of none at all.
  const derived = deriveAll({ repo, model, topo, issuesSnapshot, healthVerdicts: health.verdicts, manifest: paths.programManifest })
  return { ...program, repo, issuesSnapshot, model, topo, health, findings, hasMap, derived }
})

const ROOM = {
  meta: {
    title: manifest.title || 'Control Room',
    today: manifest.today,
    theme: manifest.theme || 'dark',
    generatedFrom: basename(MANIFEST),
    viewerNote: 'Architecture maps are read-only snapshots; programs without a map omit the viewer.',
  },
  portfolio: derivePortfolio({ today: manifest.today, programs: loadedPrograms, linkMaxFiles: manifest.linkMaxFiles }),
  programs: loadedPrograms.map((program) => ({
    id: program.id,
    ghRepo: program.ghRepo,
    hasMap: program.hasMap,
    issuesSnapshot: program.issuesSnapshot,
    model: program.model,
    health: program.health,
    findings: program.findings,
    derived: program.derived,
  })),
}

// Safe embedding (ADR-0004 / PLAN.md "iniezione sicura"): model prose, issue titles and finding
// text are repository-controlled strings. `</script>` closes a <script> element even inside a
// JS string literal, so it must never appear verbatim in either injected blob.
const escJs = (s) => s.replace(/</g, '\\u003c')
const roomJson = escJs(JSON.stringify(ROOM))
const viewerHtml = readFileSync(join(HERE, 'viewer', 'c4-hologram.html'), 'utf-8').replace(/<\/script/gi, '<\\/script')

let out = readFileSync(join(HERE, 'viewer', 'control-room.html'), 'utf-8')
if (!out.includes('/*__ROOM_JSON__*/null')) fail('template seam /*__ROOM_JSON__*/null not found in control-room.html — did it move?')
if (!out.includes('<!--__HOLO_SRC__-->')) fail('template seam <!--__HOLO_SRC__--> not found in control-room.html — did it move?')
out = out.replace('/*__ROOM_JSON__*/null', roomJson).replace('<!--__HOLO_SRC__-->', viewerHtml)

writeFileSync(OUT, out)
for (const program of loadedPrograms) {
  const open = program.issuesSnapshot.issues.filter((issue) => issue.state === 'OPEN').length
  console.log(`[forma room] ${program.id}: ${program.issuesSnapshot.issues.length} issue(s), ${open} open, map ${program.hasMap ? 'yes' : 'no'}`)
}
console.log(`[forma room] wrote ${OUT} (${Buffer.byteLength(out)} bytes).`)
