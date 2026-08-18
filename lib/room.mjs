#!/usr/bin/env node
// forma room — compose one portfolio manifest into one self-contained Control Room HTML.
// Read-only over every input; no network here: issue snapshots must already exist (`forma verify`).
// Usage: node lib/room.mjs --manifest <path> [--out <path>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateModel } from './validate.mjs'
import { deriveAll, derivePortfolio } from './roomderive.mjs'
import { resolveProgramPaths, activePrograms, excludedPrograms, snapshotManifestErrors } from './roomload.mjs'
import { loadDocs } from './roomdocs.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fail = (m) => { console.error('[forma room] ' + m); process.exit(1) }
const options = {}
let SERVE = false
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i]
  if (flag === '--serve') { SERVE = true; continue }
  if (flag !== '--manifest' && flag !== '--out' && flag !== '--port') fail(`unknown option: ${flag}`)
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`)
  options[flag] = value
  i += 1
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

// One pass over the manifest, start to finish. A function rather than straight-line code because
// `--serve` runs it again on every request: the served page is composed from the manifest as it is
// on disk right now, so a change made through the Options view is visible on the next reload and
// the file written by `--out` is the same artifact byte for byte.
function compose(writable) {
const manifest = readValidated(MANIFEST, 'forma.room.schema.json', 'manifest')
// A programme turned off stays in the manifest and out of the briefing, and Options says so: an
// absent entry and a deliberately excluded one are different claims (I7).
const excluded = excludedPrograms(manifest)
const active = activePrograms(manifest)
if (!active.length) fail('every program in the manifest is disabled; there is nothing to compose.')

const loadedPrograms = active.map((program) => {
  const label = `program "${program.id}"`
  // Same resolver `check` uses, so the gate can never re-derive from a different set of files.
  const paths = resolveProgramPaths(MANIFEST_DIR, manifest, program)
  const repo = paths.repo
  const issuesSnapshot = readValidated(paths.issues, 'c4-issues.schema.json', `${label} issue snapshot`)
  if (issuesSnapshot.truncated === true) fail(`${label}: issue snapshot is truncated; refusing to build counts and proportions from incomplete facts.`)
  for (const error of snapshotManifestErrors(program, issuesSnapshot)) fail(`${label}: ${error} — regenerate the snapshot or fix the manifest.`)

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
    ? { verdicts: [], dependencyConfirmations: [] }
    : readValidated(paths.health, 'c4-health.schema.json', `${label} health overlay`)
  const findings = paths.findings === null
    ? { findings: [] }
    : readValidated(paths.findings, 'c4-findings.schema.json', `${label} findings overlay`)
  // The brief is opt-in by presence (I11): a programme that declares none derives none, and the
  // Executive says so instead of showing an empty thesis.
  const brief = paths.brief === null
    ? null
    : (existsSync(paths.brief) ? readValidated(paths.brief, 'c4-brief.schema.json', `${label} brief overlay`) : { claims: [] })
  const loadedDocs = program.docs === undefined
    ? null
    : loadDocs(repo, { include: program.docs.include, canon: program.docs.canon, maxBytes: (manifest.docs || {}).maxBytes, gate: program.docs.gate })
  const gateInputs = loadedDocs && loadedDocs.gateInputs
  const docs = loadedDocs && Object.fromEntries(Object.entries(loadedDocs).filter(([key]) => key !== 'gateInputs'))
  // Every programme derives, mapped or not. The optional document gate consumes the same extracted
  // inputs check reloads; its scan is independent from the presentation byte budget.
  const deriveContext = {}
  const derived = deriveAll({ repo, model, topo, issuesSnapshot, health, findings, brief, manifest: paths.programManifest, gateInputs }, deriveContext)
  return { ...program, repo, issuesSnapshot, model, topo, health, findings, brief, hasMap, derived, deriveContext, docs }
})

const ROOM = {
  meta: {
    title: manifest.title || 'Control Room',
    today: manifest.today,
    theme: manifest.theme || 'light',
    generatedFrom: basename(MANIFEST),
    viewerNote: 'Architecture maps are read-only snapshots; programs without a map omit the viewer.',
    excluded: excluded.map((program) => ({ id: program.id, ghRepo: program.ghRepo })),
  },
  portfolio: derivePortfolio({ today: manifest.today, programs: loadedPrograms }),
  programs: loadedPrograms.map((program) => ({
    id: program.id,
    ghRepo: program.ghRepo,
    hasMap: program.hasMap,
    issuesSnapshot: program.issuesSnapshot,
    model: program.model,
    health: program.health,
    findings: program.findings,
    brief: program.brief,
    derived: program.derived,
    docs: program.docs,
  })),
}

// Safe embedding (ADR-0004 / PLAN.md "iniezione sicura"): model prose, issue titles and finding
// text are repository-controlled strings. `</script>` closes a <script> element even inside a
// JS string literal, so it must never appear verbatim in either injected blob.
const escJs = (s) => s.replace(/</g, '\\u003c')
const roomJson = escJs(JSON.stringify(ROOM))
const viewerHtml = readFileSync(join(HERE, 'viewer', 'c4-hologram.html'), 'utf-8').replace(/<\/script/gi, '<\\/script')
// The locale tables live outside the template: with seven views they were the largest thing in the
// file and nobody could edit around them. Same escaping — a translator writing "</script>" into a
// string must not be able to close the element (I14).
const stringsJson = escJs(JSON.stringify({
  en: readJson(join(HERE, 'viewer', 'strings', 'en.json'), 'en strings'),
  it: readJson(join(HERE, 'viewer', 'strings', 'it.json'), 'it strings'),
}))

let out = readFileSync(join(HERE, 'viewer', 'control-room.html'), 'utf-8')
for (const seam of ['/*__ROOM_JSON__*/null', '/*__STRINGS__*/null', '/*__WRITABLE__*/false', '<!--__HOLO_SRC__-->']) {
  if (!out.includes(seam)) fail(`template seam ${seam} not found in control-room.html — did it move?`)
}
// Whether the Options view may offer a control that writes. The page must be TOLD, not left to
// infer it from `location.protocol`: that only separates file: from everything else, so a briefing
// deployed to any static host — including forma's own public demo on Pages — would render live
// checkboxes whose PUT has nothing to answer it. A dead switch is exactly what the read-only mode
// exists to avoid, and shipping one on the showcase would be the loudest possible version of it.
out = out.replace('/*__ROOM_JSON__*/null', roomJson).replace('/*__STRINGS__*/null', stringsJson)
  .replace('/*__WRITABLE__*/false', writable ? 'true' : 'false')
  .replace('<!--__HOLO_SRC__-->', viewerHtml)
return { html: out, programs: loadedPrograms }
}

// `--serve`: the one place the briefing stops being read-only. It exists because the Options view
// is a page of checkboxes and static HTML cannot write a file — the alternative was to describe the
// manifest and ask the reader to go and edit it, which is the manual this product is not supposed
// to need. Bound tightly: loopback only, one writable field per programme (`enabled`), and the
// manifest is re-validated against its schema before anything is written, so a bad PUT leaves the
// file exactly as it was. Everything else about a programme is still edited by hand.
function serve() {
  const PORT = Number(options['--port'] || 4174)
  const host = '127.0.0.1'
  const server = createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/#') || req.url.startsWith('/?'))) {
      try { return send(200, 'text/html; charset=utf-8', compose(true).html) } catch (e) { return send(500, 'text/plain', String((e && e.message) || e)) }
    }
    if (req.method === 'PUT' && req.url === '/programs') {
      let body = ''
      req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy() })
      req.on('end', () => {
        let wanted
        try { wanted = JSON.parse(body) } catch (e) { return send(400, 'text/plain', `not JSON: ${(e && e.message) || e}`) }
        if (!wanted || typeof wanted !== 'object') return send(400, 'text/plain', 'expected {"<id>": true|false}')
        let current
        try { current = JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { return send(500, 'text/plain', String((e && e.message) || e)) }
        const known = new Set((current.programs || []).map((p) => p.id))
        for (const id of Object.keys(wanted)) {
          if (!known.has(id)) return send(400, 'text/plain', `unknown program: ${id}`)
          if (typeof wanted[id] !== 'boolean') return send(400, 'text/plain', `${id}: enabled must be true or false`)
        }
        for (const program of current.programs) if (Object.prototype.hasOwnProperty.call(wanted, program.id)) program.enabled = wanted[program.id]
        // Validate BEFORE writing: the same rule verify.mjs follows for the snapshot. A rejected
        // edit must leave the manifest untouched rather than half-applied.
        const errs = validateModel(current, schema('forma.room.schema.json'))
        if (errs.length) return send(400, 'text/plain', 'the edit would make the manifest invalid:\n - ' + errs.join('\n - '))
        if (!activePrograms(current).length) return send(400, 'text/plain', 'that would disable every program; there would be nothing to compose.')
        writeFileSync(MANIFEST, JSON.stringify(current, null, 2) + '\n')
        console.log(`[forma room] ${basename(MANIFEST)} updated: ${Object.keys(wanted).map((id) => id + '=' + wanted[id]).join(', ')}`)
        send(200, 'application/json', JSON.stringify({ ok: true }))
      })
      return
    }
    send(404, 'text/plain', 'not found')
  })
  // A busy port is an ordinary thing that happens to people, and answering it with a Node stack
  // trace teaches nothing. Say which port, and say the flag that changes it.
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') fail(`port ${PORT} is already in use — pass --port <n> to choose another.`)
    if (e && e.code === 'EACCES') fail(`port ${PORT} needs privileges this process does not have — pass --port <n> above 1024.`)
    fail(`could not serve on ${host}:${PORT} — ${(e && e.message) || e}`)
  })
  server.listen(PORT, host, () => {
    // The bound port, not the requested one: --port 0 is how a test asks the OS for a free one.
    console.log(`[forma room] serving http://${host}:${server.address().port} — the Options view can turn programmes on and off here.`)
    console.log('[forma room] the manifest is the only file this writes; every other field stays hand-edited.')
  })
}

// The file on disk is never writable: only the loopback server can answer a PUT.
const first = compose(false)
writeFileSync(OUT, first.html)
for (const program of first.programs) {
  const open = program.issuesSnapshot.issues.filter((issue) => issue.state === 'OPEN').length
  console.log(`[forma room] ${program.id}: ${program.issuesSnapshot.issues.length} issue(s), ${open} open, map ${program.hasMap ? 'yes' : 'no'}`)
}
console.log(`[forma room] wrote ${OUT} (${Buffer.byteLength(first.html)} bytes).`)
if (SERVE) serve()
