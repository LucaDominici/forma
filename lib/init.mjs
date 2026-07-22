#!/usr/bin/env node
// forma init — seed a c4-topology.json from the repo's real source directories.
// BEST-EFFORT: gives a valid, non-empty starting point (no cold-start). The human/agent then
// curates groupings, context externals, and plain-language descriptions. Never overwrites an
// existing topology unless --force.
import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const OUT = arg('--out', join(REPO, 'docs/architecture/c4-topology.json'))
const FORCE = process.argv.includes('--force')
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out', 'vendor', 'coverage', '.next', '.gradle', 'bin', 'obj'])
const EXT = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', py: 'Python', go: 'Go', java: 'Java', rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', kt: 'Kotlin', swift: 'Swift', cpp: 'C++', c: 'C' }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x'

if (existsSync(OUT) && !FORCE) { console.error(`[forma init] ${relative(REPO, OUT)} already exists — use --force to reseed.`); process.exit(1) }

// 1) detect dominant language by extension count (skipping ignored dirs)
const counts = {}
;(function walk(dir, depth) {
  if (depth > 12) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents) {
    if (IGNORE.has(e) || e.startsWith('.')) continue
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
const root = ext[0] === 'java' ? (javaBase() || REPO) : (existsSync(join(REPO, 'src')) ? join(REPO, 'src') : REPO)

// 3) build nodes + leafSources: one container per immediate subdir that holds source files directly
const sysId = slug(basename(REPO))
const nodes = [{ id: sysId, level: 'context', kind: 'system', name: basename(REPO), tech: lang, description: `${basename(REPO)} — drill for containers.` }]
const leafSources = []
const hasSrc = (dir) => { try { return readdirSync(dir).some((f) => { const p = join(dir, f); return statSync(p).isFile() && new RegExp(matchRe).test(f) }) } catch { return false } }

// Recurse to the SHALLOWEST dirs that directly contain source files → each is a container.
// (A dir with direct sources is a container; a dir with none is descended into. Works for nested
// layouts like src/app/routes/*.ts or Python packages, not just one level.)
const seen = new Set()
;(function findContainers(dir, depth) {
  if (depth > 10) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents.filter((x) => !IGNORE.has(x) && !x.startsWith('.')).sort()) {
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    if (hasSrc(p)) {
      const rel = relative(root, p) || e
      let id = slug(rel.replace(/[\\/]+/g, '_'))
      if (seen.has(id)) id = slug(id + '_' + leafSources.length)
      seen.add(id)
      nodes.push({ id, level: 'container', kind: 'container', parent: sysId, name: e, tech: lang })
      leafSources.push({ parent: id, dir: relative(REPO, p), match: matchRe })
    } else findContainers(p, depth + 1)
  }
})(root, 0)
// loose files directly in root → an entry container
if (hasSrc(root)) { nodes.push({ id: 'app', level: 'container', kind: 'container', parent: sysId, name: 'app', tech: lang, description: 'Entry point / loose top-level sources.' }); leafSources.push({ parent: 'app', dir: relative(REPO, root) || '.', match: matchRe }) }

if (leafSources.length === 0) { console.error('[forma init] found a source root but no directory with source files directly in it. Add leafSources manually.'); process.exit(1) }

const topo = {
  meta: { repo: basename(REPO), stack: lang, seededBy: 'forma init' },
  docPath: 'docs/architecture/ARCHITECTURE.md',
  levels: ['context', 'container', 'component', 'leaf'],
  nodes,
  leafSources,
  edges: [],
  descriptions: {},
}
// ensure output dir exists
mkdirSync(join(OUT, '..'), { recursive: true })
writeFileSync(OUT, JSON.stringify(topo, null, 2) + '\n')
console.log(`[forma init] wrote ${relative(REPO, OUT)} — ${lang}, ${leafSources.length} container(s) seeded from ${relative(REPO, root) || '.'}/`)
console.log('[forma init] NEXT: curate names/descriptions + add context externals + run `forma gen`.')
