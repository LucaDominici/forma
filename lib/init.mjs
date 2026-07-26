#!/usr/bin/env node
// forma init — seed a c4-topology.json from the repo's real source directories.
// BEST-EFFORT: gives a valid, non-empty starting point (no cold-start). The human/agent then
// curates groupings, context externals, and plain-language descriptions. Never overwrites an
// existing topology unless --force.
import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { goPackages } from './lang.mjs'
import { parseFeatureDoc } from './describe.mjs'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const OUT = arg('--out', join(REPO, 'docs/architecture/c4-topology.json'))
const FORCE = process.argv.includes('--force')
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out', 'vendor', 'coverage', '.next', '.gradle', 'bin', 'obj'])
// A real directory that holds files but is not an architecture container (data/fixtures/docs).
// Kept separate from IGNORE (which is build/VCS junk, invisible even to language detection).
const DATA_DIRS = new Set(['docs', 'fixtures', 'testdata', 'demo', 'corpus', 'assets', 'examples'])
const SKIP_TESTS = process.argv.includes('--skip-tests') // test/ is real code by default; opt in to skip it
const KEEP = new Set((arg('--include', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
const SKIP_DIRS = new Set([...DATA_DIRS, ...(SKIP_TESTS ? ['test', 'tests'] : [])])
const EXT = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', mts: 'TypeScript', cts: 'TypeScript', py: 'Python', go: 'Go', java: 'Java', rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', kt: 'Kotlin', swift: 'Swift', cpp: 'C++', c: 'C' }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x'

if (existsSync(OUT) && !FORCE) { console.error(`[forma init] ${relative(REPO, OUT)} already exists — use --force to reseed.`); process.exit(1) }

// 1) detect dominant language by extension count. Skips the SAME dirs the container pass skips
// (build junk AND data/fixture/doc dirs): counting files that can never become a container is how
// a repo full of Python fixtures gets detected as a Python repo and then finds no source dir.
const counts = {}
;(function walk(dir, depth) {
  if (depth > 12) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents) {
    if (IGNORE.has(e) || e.startsWith('.')) continue
    if (SKIP_DIRS.has(e.toLowerCase()) && !KEEP.has(e.toLowerCase())) continue
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, depth + 1)
    else { const m = e.match(/\.([a-z0-9]+)$/i); if (m && EXT[m[1].toLowerCase()]) counts[m[1].toLowerCase()] = (counts[m[1].toLowerCase()] || 0) + 1 }
  }
})(REPO, 0)
const ext = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
if (!ext) { console.error('[forma init] no recognised source files found under ' + REPO); process.exit(1) }
const lang = EXT[ext[0]]
const matchRe = `\\.${ext[0]}$`

// 2) find the source root
function javaBase() {
  let d = join(REPO, 'src/main/java')
  if (!existsSync(d)) return null
  // descend while there is exactly one subdir (the package chain) until it branches
  for (;;) {
    const subs = readdirSync(d).filter((x) => { try { return statSync(join(d, x)).isDirectory() } catch { return false } })
    const files = readdirSync(d).some((x) => new RegExp(matchRe).test(x))
    if (subs.length === 1 && !files) d = join(d, subs[0]); else break
  }
  return d
}
// Go modules are rooted at go.mod, never at src/ — an import path is relative to the module root.
const root = ext[0] === 'java' ? (javaBase() || REPO) : ext[0] === 'go' ? REPO : (existsSync(join(REPO, 'src')) ? join(REPO, 'src') : REPO)
const GO = ext[0] === 'go'
const notSrc = GO ? /_test\.go$/ : null // a test file is not architecture (§Go adapter)

// 3) build nodes + leafSources: one container per immediate subdir that holds source files directly
const sysId = slug(basename(REPO))
const nodes = [{ id: sysId, level: 'context', kind: 'system', name: basename(REPO), tech: lang, description: `${basename(REPO)} — drill for containers.` }]
const leafSources = []
const hasSrc = (dir) => { try { return readdirSync(dir).some((f) => { const p = join(dir, f); return statSync(p).isFile() && new RegExp(matchRe).test(f) && !(notSrc && notSrc.test(f)) }) } catch { return false } }

// Recurse to the SHALLOWEST dirs that directly contain source files → each is a container.
// (A dir with direct sources is a container; a dir with none is descended into. Works for nested
// layouts like src/app/routes/*.ts or Python packages, not just one level.)
const seen = new Set()
const skipped = []
const claim = (rel) => { let id = slug(rel.replace(/[\\/]+/g, '_')); if (seen.has(id)) id = slug(id + '_' + leafSources.length); seen.add(id); return id }
const findContainers = (dir, depth) => {
  if (depth > 10) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents.filter((x) => !IGNORE.has(x) && !x.startsWith('.')).sort()) {
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    if (SKIP_DIRS.has(e.toLowerCase()) && !KEEP.has(e.toLowerCase())) { skipped.push({ dir: relative(REPO, p), reason: 'data/fixtures/docs dir (name match) — curate if wrong' }); continue }
    if (hasSrc(p)) {
      const id = claim(relative(root, p) || e)
      nodes.push({ id, level: 'container', kind: 'container', parent: sysId, name: e, tech: lang })
      leafSources.push({ parent: id, dir: relative(REPO, p), match: matchRe })
    } else findContainers(p, depth + 1)
  }
}
const skipDir = (e) => IGNORE.has(e) || e.startsWith('.') || (SKIP_DIRS.has(e.toLowerCase()) && !KEEP.has(e.toLowerCase()))

// Go: the container is the PACKAGE, not the shallowest directory that happens to hold code. Go
// nests packages freely (internal/store, internal/server, …) and `internal/` itself is usually not
// one — stopping at the first level collapses thirty units of architecture into a single box. The
// leaf is the package too: the files inside it are internal organisation nobody presents, so the
// leafSource points at the parent directory and matches the package directory by name (a leaf must
// stay a real, re-derivable entry on disk — that is what the drift gate re-counts).
if (GO) {
  for (const rel of goPackages(root, skipDir)) {
    // ponytail: a package at the module ROOT falls through to the loose-files branch below, which
    // keeps the old file-per-leaf shape (there is no parent directory to match its name in). Its
    // box is real but stays edge-less, since goEdges only follows directory leaves. Rare layout —
    // give the root package its own directory (cmd/…) and it behaves like every other one.
    if (!rel) continue
    const cut = rel.lastIndexOf('/')
    const id = claim(rel)
    nodes.push({ id, level: 'container', kind: 'container', parent: sysId, name: rel, tech: lang })
    leafSources.push({ parent: id, dir: cut < 0 ? '.' : rel.slice(0, cut), match: '^' + rel.slice(cut + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', filesOnly: false })
  }
} else findContainers(root, 0)
// loose files directly in root → an entry container
if (hasSrc(root)) { nodes.push({ id: 'app', level: 'container', kind: 'container', parent: sysId, name: 'app', tech: lang, description: 'Entry point / loose top-level sources.' }); leafSources.push({ parent: 'app', dir: relative(REPO, root) || '.', match: matchRe, ...(GO ? { exclude: '_test\\.go$' } : {}) }) }

if (leafSources.length === 0) { console.error(`[forma init] detected ${lang} (*.${ext[0]}) as the dominant language, but no directory under ${relative(REPO, root) || '.'}/ holds *.${ext[0]} files directly. Pass --include <dir,...> if the sources live in a skipped dir, or add leafSources manually.`); process.exit(1) }

// Discover markdown feature matrices under docs/ up to 3 levels deep. Seeding this is the whole
// difference between "forma reads your feature matrix" and "forma reads it if you hand-write the
// path" — nobody hand-writes it, which is how `descriptions` stayed empty in every repo that ever
// ran `forma init`.
const scanFeatureDocs = (repo) => {
  const root = join(repo, 'docs')
  if (!existsSync(root)) return []
  const files = []
  const walk = (dir, rel, depth) => {
    if (depth > 3 || files.length >= 200) return
    let ents; try { ents = readdirSync(dir) } catch { return }
    for (const e of ents.filter((x) => !IGNORE.has(x) && !x.startsWith('.')).sort()) {
      const p = join(dir, e)
      let st; try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p, rel ? `${rel}/${e}` : e, depth + 1); continue }
      if (files.length >= 200) return
      if (/\.md$/i.test(e)) files.push(rel ? `${rel}/${e}` : e)
    }
  }
  walk(root, 'docs', 0)
  return files.sort()
}

// A parseable table is not yet a feature matrix: every doc that tabulates code mentions parses too,
// and seeding one of those makes forma describe a container with a line out of an audit.
// What separates them is that a capability matrix ADDRESSES THE TREE ON EVERY ROW — a directory or
// file path, never a bare symbol. Measured, which is why the bar is `every` and not a majority:
//
//   forma  docs/ORIENTATION.md            67 rows, 13% address the tree   (a wiring audit)
//   haben  docs/FEATURE_MATRIX.md         39 rows, 100%                   (the real thing)
//   haben  docs/design/*-analysis.md      addresses on most rows, prose is critique not capability
//   haben  docs/architecture/*/README.md  a doc index — rows point at other docs
//
// Relaxing to a majority admitted all three of the bottom rows on haben and moved the container
// count from 28 to 32. The strict bar is the one that holds.
// ponytail: `every` is a cliff — one row naming a root-level `main.go` disqualifies a real matrix.
// Upgrade path if that ever bites: exclude non-addressing rows instead of the whole document.
const qualifyFeatureDoc = (repo, rel) => {
  let txt; try { txt = readFileSync(join(repo, rel), 'utf-8') } catch { return false }
  const rows = parseFeatureDoc(txt)
  if (rows.length < 3) return false
  if (!rows.every((r) => r.paths.some((p) => p.includes('/')))) return false
  // …and the addresses must be real: a table of aspirational paths describes nothing that exists.
  const resolving = new Set()
  for (const r of rows) for (const p of r.paths) if (existsSync(join(repo, p))) resolving.add(p)
  return resolving.size >= 3
}

const featureDocs = scanFeatureDocs(REPO).filter((rel) => qualifyFeatureDoc(REPO, rel))

// `forma verify` is the one command that derives progress from something other than a human's
// opinion — closed GitHub issues — and it needs `meta.ghRepo` to know where to look. `init` never
// wrote it, so on a freshly seeded repo verify has nowhere to point and exits. The remote already
// says it. Handles both scp-style (git@host:owner/repo.git) and URL remotes.
const ghRepo = (() => {
  let url
  try { url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
  const m = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
  return m ? m[1] : null
})()

const topo = {
  meta: { repo: basename(REPO), stack: lang, seededBy: 'forma init', ...(ghRepo ? { ghRepo } : {}) },
  docPath: 'docs/architecture/ARCHITECTURE.md',
  levels: ['context', 'container', 'component', 'leaf'],
  nodes,
  leafSources,
  edges: [],
  featureDocs,
  descriptions: {},
  _skipped: skipped,
}
// ensure output dir exists
mkdirSync(join(OUT, '..'), { recursive: true })
writeFileSync(OUT, JSON.stringify(topo, null, 2) + '\n')
console.log(`[forma init] wrote ${relative(REPO, OUT)} — ${lang}, ${leafSources.length} container(s) seeded from ${relative(REPO, root) || '.'}/${skipped.length ? `, ${skipped.length} data/doc dir(s) skipped` : ''}`)
console.log('[forma init] NEXT: curate names/descriptions + add context externals + run `forma gen`.')
