#!/usr/bin/env node
// forma init — seed a c4-topology.json from the repo's real source directories.
// BEST-EFFORT: gives a valid, non-empty starting point (no cold-start). The human/agent then
// curates groupings, context externals, and plain-language descriptions. Never overwrites an
// existing topology unless --force.
import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { goPackages } from './lang.mjs'
import { loadDocRows } from './docmap.mjs'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const OUT = arg('--out', join(REPO, 'docs/architecture/c4-topology.json'))
const FORCE = process.argv.includes('--force')
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out', 'vendor', 'coverage', '.next', '.gradle', 'bin', 'obj'])
// A real directory that holds files but is not an architecture container (data/fixtures/docs).
// Kept separate from IGNORE (which is build/VCS junk, invisible even to language detection).
const DATA_DIRS = new Set(['docs', 'fixtures', 'testdata', 'demo', 'corpus', 'assets', 'examples'])
const SKIP_TESTS = !process.argv.includes('--include-tests') || process.argv.includes('--skip-tests')
const KEEP = new Set((arg('--include', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'androidtest', 'testfixtures', 'uitests'])
const TEST_MATCH = '(?:_test\\.go|(?:^|/)test_[^/]+\\.py|_test\\.py|_spec\\.rb|\\.(?:spec|test)\\.(?:js|jsx|ts|tsx|mjs|cjs)|(?:Test|Tests)\\.(?:java|cs|kt|swift))$'
const TEST_FILE = new RegExp(TEST_MATCH, 'i')
const SKIP_DIRS = new Set([...DATA_DIRS, ...(SKIP_TESTS ? TEST_DIRS : [])])
const EXT = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', mts: 'TypeScript', cts: 'TypeScript', py: 'Python', go: 'Go', java: 'Java', rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', kt: 'Kotlin', swift: 'Swift', cpp: 'C++', c: 'C' }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x'

if (existsSync(OUT) && !FORCE) { console.error(`[forma init] ${relative(REPO, OUT)} already exists — use --force to reseed.`); process.exit(1) }

// 1) Detect every production stack. Tests and documentary/data trees are explicit exclusions:
// they remain visible to `check`, but cannot win language detection or become product containers.
const counts = {}
const extDirs = {}
const skipped = []
;(function walk(dir, depth) {
  if (depth > 12) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents) {
    if (IGNORE.has(e) || e.startsWith('.')) continue
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e.toLowerCase()) && !KEEP.has(e.toLowerCase())) {
        skipped.push({ dir: relative(REPO, p), reason: TEST_DIRS.has(e.toLowerCase()) ? 'test source excluded by forma init' : 'data/docs source excluded by forma init' })
      } else walk(p, depth + 1)
    }
    else {
      if (SKIP_TESTS && TEST_FILE.test(e)) continue
      const m = e.match(/\.([a-z0-9]+)$/i)
      if (!m || !EXT[m[1].toLowerCase()]) continue
      const x = m[1].toLowerCase()
      counts[x] = (counts[x] || 0) + 1
      const rel = relative(REPO, dir) || '.'
      const seenDirs = extDirs[x] || (extDirs[x] = new Map())
      seenDirs.set(rel, (seenDirs.get(rel) || 0) + 1)
    }
  }
})(REPO, 0)
const ext = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || null
// A repo with no recognised source is not an error: init is best-effort, and since §33 it always has
// something true to write — the context. Exiting 1 here left the caller with no file at all.
if (!ext) console.error(`[forma init] no recognised source files under ${REPO} — seeding the context only, no containers.`)
const extsOf = (name) => Object.keys(counts).filter((x) => EXT[x] === name).sort()
const anyOf = (exts) => (exts.length === 1 ? `\\.${exts[0]}$` : `\\.(${exts.join('|')})$`)
const languages = [...new Set(Object.keys(counts).map((x) => EXT[x]))].sort((a, b) =>
  extsOf(b).reduce((n, x) => n + counts[x], 0) - extsOf(a).reduce((n, x) => n + counts[x], 0))

// 3) build nodes + recursive leafSources: one container per workspace+stack, except Go packages.
const sysId = slug(basename(REPO))
// §33 — the first screen a reader meets was ONE dashed box holding a generated sentence, and nothing
// told them that curating it is mandatory rather than nice: "who touches this" is slide one of any
// architecture talk. So init seeds the two roles every system has, EXPLICITLY anonymous. The `TODO:`
// prefix is the whole point — a plausible invented actor ("End user") would be indistinguishable
// from curated truth, and `gen` keys its reminder off exactly this prefix.
const PERSON = 'todo_person', EXTERNAL = 'todo_external'
const PLACEHOLDER = 'Placeholder seeded by `forma init` — rename it to the real one, or delete it.'
const stackLabel = languages.join(' + ')
const nodes = [
  { id: sysId, level: 'context', kind: 'system', name: basename(REPO), ...(stackLabel ? { tech: stackLabel } : {}), description: `${basename(REPO)} — drill for containers.` },
  { id: PERSON, level: 'context', kind: 'person', name: 'TODO: who uses it', description: PLACEHOLDER },
  { id: EXTERNAL, level: 'context', kind: 'external', name: 'TODO: what it depends on', description: PLACEHOLDER },
]
// Seeded with the actors, not after them: a context screen of boxes with no arrows is a bulleted
// list in rectangles (predicate 4 of scripts/presentable.mjs), and the arrows are what say which
// side of the system each placeholder stands on — so renaming them is a fill-in, not a design job.
const edges = [
  { from: PERSON, to: sysId, label: 'uses' },
  { from: sysId, to: EXTERNAL, label: 'depends on' },
]
const leafSources = []
const seen = new Set([sysId, PERSON, EXTERNAL])
const claim = (rel) => { let id = slug(rel.replace(/[\\/]+/g, '_')); if (seen.has(id)) id = slug(id + '_' + leafSources.length); seen.add(id); return id }
const skipDir = (e) => IGNORE.has(e) || e.startsWith('.') || (SKIP_DIRS.has(e.toLowerCase()) && !KEEP.has(e.toLowerCase()))

// Keep familiar `src/domain` containers in single-package repos. In a workspace (`frontend/src`,
// `backend/src/main/java`) the workspace is the honest cold-start boundary and is walked recursively.
const sourceRoot = (dir) => {
  if (dir === '.') return '.'
  const p = dir.split(/[\\/]/)
  if (p[0] === 'src') return p.length > 1 ? p.slice(0, 2).join('/') : 'src'
  if (p[1] === 'src') return p[0]
  return p[0]
}
const recursiveSkips = [...new Set([...IGNORE, ...SKIP_DIRS])].sort()
for (const name of languages) {
  const match = anyOf(extsOf(name))
  if (name === 'Go') {
    for (const rel of goPackages(REPO, skipDir, !SKIP_TESTS)) {
      const dir = rel || '.'
      const id = claim(rel || `${name}_root`)
      nodes.push({ id, level: 'container', kind: 'container', parent: sysId, name: rel || 'app', tech: name })
      leafSources.push({ parent: id, dir, match, ...(SKIP_TESTS ? { exclude: '_test\\.go$' } : {}), evidenceOnly: true })
    }
    continue
  }
  const direct = new Set()
  for (const [x, dirs] of Object.entries(extDirs)) if (EXT[x] === name) for (const dir of dirs.keys()) direct.add(sourceRoot(dir))
  const roots = [...direct].sort().filter((root, i, all) => !all.some((other, j) => j !== i && (other === '.' || root.startsWith(other + '/'))))
  for (const root of roots) {
    const id = claim(root === '.' ? `${name}_root` : basename(root))
    const baseName = root === '.' ? 'app' : basename(root)
    const twin = nodes.find((n) => n.kind === 'container' && n.name === baseName && n.tech !== name)
    if (twin) twin.name = `${baseName} (${twin.tech})`
    nodes.push({ id, level: 'container', kind: 'container', parent: sysId, name: twin ? `${baseName} (${name})` : baseName, tech: name })
    leafSources.push({ parent: id, dir: root, match, recursive: true, excludeDirs: recursiveSkips,
      ...(SKIP_TESTS ? { exclude: TEST_MATCH } : {}) })
  }
}

// 4) find the documents that already say, in prose, what each part of the product does and whether
// it is finished — a feature matrix, a capability table, a requirements sheet. Detection is the
// reader itself: a doc qualifies when `loadDocRows` gets capability rows out of it, so nothing here
// can drift from what `gen` will actually parse, and no project's filenames are hardcoded.
// Threshold 3: a two-row table in a runbook is a config note, not a capability inventory.
const docSources = []
const docRootSet = new Set(leafSources.map((s) => s.dir).filter((d) => d !== '.'))
for (const dirs of Object.values(extDirs)) for (const dir of dirs.keys()) {
  const parts = dir.split(/[\\/]/)
  for (let i = 1; i <= parts.length; i++) docRootSet.add(parts.slice(0, i).join('/'))
}
const docRoots = [...docRootSet].sort()
;(function findDocs(dir, depth) {
  if (depth > 4) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents.filter((x) => !IGNORE.has(x) && !x.startsWith('.')).sort()) {
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) findDocs(p, depth + 1)
    else if (/\.md$/i.test(e)) {
      const rel = relative(REPO, p)
      const direct = loadDocRows(REPO, [rel], true)
      if (direct.length >= 3 && direct.every((r) => !r.dead.length)) docSources.push(rel)
      else {
        const rooted = { path: rel, roots: docRoots }
        const rows = loadDocRows(REPO, [rooted], true)
        if (rows.length >= 3 && rows.every((r) => !r.dead.length)) docSources.push(rooted)
      }
    }
  }
})(join(REPO, 'docs'), 0)

// `forma verify` is the one command that derives progress from something other than a claim in a
// document — the live state of a GitHub issue — and it needs `meta.ghRepo` to know where to look.
// `init` never wrote it, so on a freshly seeded repo verify had nowhere to point and exited. The
// remote already says it. Handles scp-style (git@host:owner/repo.git) and URL remotes alike.
const ghRepo = (() => {
  let url
  try { url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
  const m = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
  return m ? m[1] : null
})()

const topo = {
  meta: { repo: basename(REPO), ...(stackLabel ? { stack: stackLabel, stacks: languages } : {}), seededBy: 'forma init', ...(ghRepo ? { ghRepo } : {}) },
  docPath: 'docs/architecture/ARCHITECTURE.md',
  levels: ['context', 'container', 'component', 'leaf'],
  nodes,
  leafSources,
  edges,
  // Capability tables: the box text and the progress for context/container come from HERE first,
  // ahead of the code. Each entry is a path, or {path, describe, ref, status} to name the columns.
  docSources,
  descriptions: {},
  _skipped: skipped,
  sourceCoverage: { exclusions: [
    ...skipped,
    ...(SKIP_TESTS ? [{ match: TEST_MATCH, reason: 'co-located test source excluded by forma init' }] : []),
  ] },
}
// ensure output dir exists
mkdirSync(join(OUT, '..'), { recursive: true })
writeFileSync(OUT, JSON.stringify(topo, null, 2) + '\n')
console.log(`[forma init] wrote ${relative(REPO, OUT)} — ${languages.join(' + ') || 'no stack'}, ${leafSources.length} container(s) seeded${skipped.length ? `, ${skipped.length} test/data/doc dir(s) explicitly excluded` : ''}`)
for (const name of languages) console.log(`[forma init] coverage ${name}: ${extsOf(name).reduce((n, x) => n + counts[x], 0)} recognised source file(s), seeded`)
if (docSources.length) console.log(`[forma init] docSources: ${docSources.map((s) => typeof s === 'string' ? s : s.path).join(', ')} — all code refs resolved atomically.`)
// The context comes FIRST and alone on this line. It used to be the middle item of three, which read
// as one improvement among many; it is the only one without which the first screen says nothing.
console.log(`[forma init] NEXT: name the two "TODO:" actors in ${relative(REPO, OUT)} — that context screen is the first thing anyone sees. Then curate names/descriptions and run \`forma gen\`.`)
