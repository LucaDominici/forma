#!/usr/bin/env node
// forma room init — get a repository from nothing to a manifest the Control Room can compose.
// It seeds (or updates) forma.room.json with one programme entry for --repo, deriving ghRepo from
// the git remote and wiring whatever inputs already exist (model/topology/issue snapshot). Unlike
// `scan` — which walks a tree and refuses to invent `today` — init is an explicit human action, so
// it MAY set `today` when you pass it. It is a scaffolder: it never fails on a bare repo, it tells
// you the next steps. Model-agnostic, zero-dep. Merges, never clobbers a decision already recorded.
// Usage: node lib/roominit.mjs [--repo <path>] [--manifest <path>] [--today YYYY-MM-DD]
//        node lib/roominit.mjs --scan --root <dir> [--manifest <path>] [--depth <n>] [--today YYYY-MM-DD]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tables, headerIndex } from './docmap.mjs'
import { parseRequirements, trackedFiles } from './rtm.mjs'
import { confinedSourceRoot } from './lang.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const has = (f) => process.argv.indexOf(f) > -1
const fail = (m) => { console.error('[forma room init] ' + m); process.exit(1) }
const ARCH = 'docs/architecture'

const TODAY = arg('--today', null)
if (TODAY && !/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) fail('--today must be YYYY-MM-DD (it is the determinism anchor, not a timestamp).')

function discoverProgramme(repo) {
  const tracked = trackedFiles(repo)
  if (!tracked) return {}
  const markdown = [...tracked].filter((path) => /\.md$/i.test(path)).sort()
  const include = []
  if (markdown.some((path) => !path.includes('/'))) include.push('*.md')
  if (markdown.some((path) => path.startsWith('docs/'))) include.push('docs/**/*.md')

  // A filename is only a candidate hint. It enters RTM only when a real table exposes an id and
  // description column and the existing RTM parser can read at least one row from it. Column names
  // are recorded as overrides; no relationship, verification or blocking rule is inferred.
  const idRole = /^(id|req|req[_ ]?id|requirement[_ ]?id|ref)$/i
  const textRole = /^(requirement|capabilit(y|ies)|decision|feature|what|description|summary|purpose)$/i
  const satisfiesRole = /^(satisfies|derives[_ ]?from|upstream|parent|traces[_ ]?to)$/i
  const verifiedRole = /^(verified[_ ]?by|verification|proof|test)$/i
  const issuesRole = /^(issues?|issue[_ ]?ref|work|wbs|tickets?)$/i
  const docs = []
  for (const path of markdown.filter((p) => /(^|\/)(requirements?|traceability|rtm)[^/]*\.md$/i.test(p))) {
    let text
    try { text = readFileSync(confinedSourceRoot(repo, join(repo, path)), 'utf-8') } catch { continue }
    const table = tables(text).find((t) => headerIndex(t.header, idRole) >= 0 && headerIndex(t.header, textRole) >= 0)
    if (!table) continue
    const entry = {
      path,
      role: 'requirement',
      id: table.header[headerIndex(table.header, idRole)],
      describe: table.header[headerIndex(table.header, textRole)],
    }
    for (const [key, pattern] of [['satisfies', satisfiesRole], ['verified', verifiedRole], ['issues', issuesRole]]) {
      const i = headerIndex(table.header, pattern)
      if (i >= 0) entry[key] = table.header[i]
    }
    if (parseRequirements(repo, [entry], tracked).rows.length) docs.push(entry)
  }
  return {
    ...(include.length ? { docs: { include } } : {}),
    ...(docs.length ? { rtm: { docs } } : {}),
  }
}

function enrichManifest(manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  if (TODAY) m.today = TODAY
  const dir = dirname(manifestPath)
  for (const program of m.programs || []) {
    const found = discoverProgramme(resolve(dir, program.repo))
    if (program.docs === undefined && found.docs) program.docs = found.docs
    if (program.rtm === undefined && found.rtm) program.rtm = found.rtm
  }
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n')
}

// --scan delegates to the tree walker, then stamps `today` if the human supplied one.
if (has('--scan')) {
  const MANIFEST = resolve(arg('--manifest', join(process.cwd(), 'forma.room.json')))
  const a = ['--root', resolve(arg('--root', process.cwd())), '--manifest', MANIFEST, '--depth', arg('--depth', '2')]
  const r = spawnSync(process.execPath, [join(HERE, 'scan.mjs'), ...a], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
  if (existsSync(MANIFEST)) enrichManifest(MANIFEST)
  console.log(`[forma room init] scanned. ${TODAY ? `today = ${TODAY}. ` : 'NEXT: set "today". '}Then \`forma room update --manifest ${relative(process.cwd(), MANIFEST) || basename(MANIFEST)}\`.`)
  process.exit(0)
}

// Single-programme seed.
const REPO = resolve(arg('--repo', process.cwd()))
if (!existsSync(REPO)) fail(`repo not found: ${REPO}`)
const MANIFEST = resolve(arg('--manifest', join(process.cwd(), 'forma.room.json')))
const manifestDir = dirname(MANIFEST)
const rel = (p) => { const r = relative(manifestDir, p); return r === '' ? '.' : r }

const idFor = (dir) => basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'programme'
function ghRepoOf(dir) {
  try {
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url)
    return m ? `${m[1]}/${m[2]}` : null
  } catch { return null }
}

const id = idFor(REPO)
const modelPath = join(REPO, ARCH, 'c4-model.json')
const topoPath = join(REPO, ARCH, 'c4-topology.json')
const issuesPath = join(REPO, ARCH, 'c4-issues.json')
const ghRepo = ghRepoOf(REPO)
const hasMap = existsSync(modelPath) && existsSync(topoPath)

const entry = {
  id,
  ...(ghRepo ? { ghRepo } : {}),
  repo: rel(REPO),
  issues: rel(issuesPath),
  ...(hasMap ? { model: rel(modelPath), topology: rel(topoPath) } : {}),
}

let manifest = { today: TODAY || null, programs: [] }
if (existsSync(MANIFEST)) {
  try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { fail(`${MANIFEST} is not valid JSON — ${(e && e.message) || e}`) }
  if (!Array.isArray(manifest.programs)) manifest.programs = []
}
if (TODAY) manifest.today = TODAY
else if (!('today' in manifest)) manifest.today = null

const existing = manifest.programs.find((p) => p.id === id)
if (existing) {
  // Merge structural paths; never touch a decision (enabled/taxonomy/blockedBy/rtm/docs) already made.
  Object.assign(existing, entry, { enabled: existing.enabled })
  if (existing.enabled === undefined) delete existing.enabled
} else {
  manifest.programs.push({ ghRepo: '', ...entry })
}
const selected = existing || manifest.programs.find((p) => p.id === id)
const discovered = discoverProgramme(REPO)
if (selected.docs === undefined && discovered.docs) selected.docs = discovered.docs
if (selected.rtm === undefined && discovered.rtm) selected.rtm = discovered.rtm
manifest.programs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')

console.log(`[forma room init] ${existing ? 'updated' : 'seeded'} "${id}" in ${rel(MANIFEST)} — ghRepo ${ghRepo || '(unknown: add it by hand)'}, map ${hasMap ? 'yes' : 'no'}, docs ${((selected.docs || {}).include || []).length ? 'yes' : 'no'}, RTM ${((selected.rtm || {}).docs || []).length} candidate(s).`)
const next = []
if (!manifest.today) next.push('set "today" (the determinism anchor) — pass --today YYYY-MM-DD')
if (!ghRepo) next.push(`add "ghRepo" for ${id} (no git remote named origin)`)
if (!hasMap) next.push(`optional: \`forma gen --repo ${rel(REPO)}\` to add the architecture map`)
next.push(`\`forma room update --manifest ${rel(MANIFEST)}\` (pulls the gh snapshot, composes the HTML)`)
console.log('[forma room init] NEXT:\n  - ' + next.join('\n  - '))
