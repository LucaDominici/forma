#!/usr/bin/env node
// forma scan — find the programmes under a directory and write them into a manifest.
// Read-only over every repository it finds; the only file it writes is the manifest itself.
// Usage: node lib/scan.mjs --root <dir> --manifest <path> [--depth <n>] [--dry-run]
//
// A programme is a git checkout with a resolvable GitHub repository. Model and snapshot are optional:
// `room update` can create the snapshot without a model. A checkout with no GitHub identity cannot
// satisfy the manifest contract, so it is left for explicit curation rather than emitted invalid.
//
// The one rule that matters on a second run: an existing entry is UPDATED, never replaced, and
// `enabled: false` is never overwritten. Turning a programme off is a decision, and a tool that
// silently re-enables it on the next scan has taken that decision away.
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join, relative, resolve, dirname } from 'node:path'

const fail = (m) => { console.error('[forma scan] ' + m); process.exit(1) }
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const has = (f) => process.argv.indexOf(f) > -1

const ROOT = resolve(arg('--root', process.cwd()))
const MANIFEST = resolve(arg('--manifest', join(process.cwd(), 'forma.room.json')))
const DEPTH = Number(arg('--depth', '2'))
const DRY = has('--dry-run')
if (!existsSync(ROOT)) fail(`root not found: ${ROOT}`)
if (!Number.isFinite(DEPTH) || DEPTH < 1) fail('--depth must be a positive integer')

// Never descend into these: a naive walk of one measured repository found 8899 files because 8544
// of them were agent working copies. The same directories would each look like a programme.
const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.next', '.venv', '__pycache__', 'worktrees'])
const ARCH = 'docs/architecture'

const idFor = (dir) => basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'programme'

function ghRepoOf(dir, issues) {
  try {
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url)
    if (m) return `${m[1]}/${m[2]}`
  } catch {}
  try {
    const repo = JSON.parse(readFileSync(issues, 'utf-8')).ghRepo
    return /^[^/\s]+\/[^/\s]+$/.test(repo || '') ? repo : null
  } catch { return null }
}

function findPrograms(dir, depth, out) {
  if (depth < 0) return out
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  if (entries.includes('.git')) {
    const model = join(dir, ARCH, 'c4-model.json'), issues = join(dir, ARCH, 'c4-issues.json'), topo = join(dir, ARCH, 'c4-topology.json')
    const ghRepo = ghRepoOf(dir, issues)
    if (ghRepo) out.push({ dir, hasModel: existsSync(model) && existsSync(topo), hasIssues: existsSync(issues), ghRepo })
    return out // a checkout is one programme; submodules are that repository's business
  }
  for (const entry of entries.sort()) {
    if (SKIP.has(entry) || entry.startsWith('.') || entry.endsWith('.worktrees')) continue
    const child = join(dir, entry)
    // A linked checkout is outside the discovery root's ownership and can also form a cycle.
    try { const stat = lstatSync(child); if (stat.isSymbolicLink() || !stat.isDirectory()) continue } catch { continue }
    findPrograms(child, depth - 1, out)
  }
  return out
}

const found = findPrograms(ROOT, DEPTH, [])
if (!found.length) fail(`no programmes under ${ROOT}: a programme needs a GitHub origin or a snapshot carrying ghRepo.`)

const manifestDir = dirname(MANIFEST)
const rel = (p) => { const r = relative(manifestDir, p); return r === '' ? '.' : r }

let manifest = { today: null, programs: [] }
if (existsSync(MANIFEST)) {
  try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) } catch (e) { fail(`${MANIFEST} is not valid JSON — ${(e && e.message) || e}`) }
  if (!Array.isArray(manifest.programs)) manifest.programs = []
}
// `today` is the determinism anchor and is NOT invented here: scan has no business choosing which
// day a briefing speaks for, and a tool that stamps the current date would make every run differ.
if (!manifest.today) manifest.today = null

const byId = new Map(manifest.programs.map((p) => [p.id, p]))
const added = [], updated = [], kept = []
for (const program of found) {
  const id = idFor(program.dir)
  const existing = byId.get(id)
  const paths = {
    repo: rel(program.dir),
    issues: rel(join(program.dir, ARCH, 'c4-issues.json')),
    ...(program.hasModel ? { model: rel(join(program.dir, ARCH, 'c4-model.json')), topology: rel(join(program.dir, ARCH, 'c4-topology.json')) } : {}),
  }
  if (existing) {
    // Merge, never replace: taxonomy, blockedBy, rtm, docs and above all `enabled` are decisions a
    // human made about this programme, and rediscovering the directory is not a reason to lose them.
    Object.assign(existing, paths)
    if (program.ghRepo && !existing.ghRepo) existing.ghRepo = program.ghRepo
    ;(existing.enabled === false ? kept : updated).push(id)
    continue
  }
  manifest.programs.push({ id, ghRepo: program.ghRepo, ...paths })
  added.push(id)
}
manifest.programs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const text = JSON.stringify(manifest, null, 2) + '\n'
if (DRY) { process.stdout.write(text); console.error(`[forma scan] --dry-run: ${MANIFEST} not written.`) }
else writeFileSync(MANIFEST, text)

for (const program of found) {
  const id = idFor(program.dir)
  console.log(`[forma scan] ${id}: ${rel(program.dir)} — model ${program.hasModel ? 'yes' : 'no'}, snapshot ${program.hasIssues ? 'yes' : 'no'}`)
}
console.log(`[forma scan] ${added.length} added, ${updated.length} updated, ${kept.length} left disabled.`)
if (!manifest.today) console.log('[forma scan] NEXT: set "today" — it is the determinism anchor, and forma room will refuse the manifest without it.')
