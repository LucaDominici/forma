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
// ext → Map(repo-relative dir → file count). The walk already sees every stack in the repo; only the
// dominant one used to survive it. Keeping the directories is what lets §34 below name the stacks
// init does NOT seed instead of dropping them in silence.
const extDirs = {}
;(function walk(dir, depth) {
  if (depth > 12) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents) {
    if (IGNORE.has(e) || e.startsWith('.')) continue
    if (SKIP_DIRS.has(e.toLowerCase()) && !KEEP.has(e.toLowerCase())) continue
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, depth + 1)
    else {
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
const lang = ext ? EXT[ext[0]] : null
// One `match` per LANGUAGE, not per extension. A React repo where *.tsx outnumbers *.ts used to be
// modelled from the .tsx half alone, with the .ts half neither seeded nor mentioned — and §34's
// report would then hand back "TypeScript: not seeded" for the same directories it had just seeded,
// so pasting it stacked a second container on top of the first.
const extsOf = (name) => Object.keys(counts).filter((x) => EXT[x] === name).sort()
const anyOf = (exts) => (exts.length === 1 ? `\\.${exts[0]}$` : `\\.(${exts.join('|')})$`)
const matchRe = ext ? anyOf(extsOf(lang)) : null

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
const root = !ext ? REPO : ext[0] === 'java' ? (javaBase() || REPO) : ext[0] === 'go' ? REPO : (existsSync(join(REPO, 'src')) ? join(REPO, 'src') : REPO)
const GO = !!ext && ext[0] === 'go'
const notSrc = GO ? /_test\.go$/ : null // a test file is not architecture (§Go adapter)

// 3) build nodes + leafSources: one container per immediate subdir that holds source files directly
const sysId = slug(basename(REPO))
// §33 — the first screen a reader meets was ONE dashed box holding a generated sentence, and nothing
// told them that curating it is mandatory rather than nice: "who touches this" is slide one of any
// architecture talk. So init seeds the two roles every system has, EXPLICITLY anonymous. The `TODO:`
// prefix is the whole point — a plausible invented actor ("End user") would be indistinguishable
// from curated truth, and `gen` keys its reminder off exactly this prefix.
const PERSON = 'todo_person', EXTERNAL = 'todo_external'
const PLACEHOLDER = 'Placeholder seeded by `forma init` — rename it to the real one, or delete it.'
const nodes = [
  { id: sysId, level: 'context', kind: 'system', name: basename(REPO), ...(lang ? { tech: lang } : {}), description: `${basename(REPO)} — drill for containers.` },
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
const hasSrc = (dir) => { try { return readdirSync(dir).some((f) => { const p = join(dir, f); return statSync(p).isFile() && new RegExp(matchRe).test(f) && !(notSrc && notSrc.test(f)) }) } catch { return false } }

// Recurse to the SHALLOWEST dirs that directly contain source files → each is a container.
// (A dir with direct sources is a container; a dir with none is descended into. Works for nested
// layouts like src/app/routes/*.ts or Python packages, not just one level.)
// The context ids are claimed up front: a directory named like the repo (or like a placeholder) would
// otherwise mint a duplicate id that only `gen` finds, one command later.
const seen = new Set([sysId, PERSON, EXTERNAL])
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
// package is ONE node. It used to be a container AND a leaf matching that same directory, so
// drilling into a package showed the package again — 53 of 53 on a real Go repo, a level drawn
// twice. Per #17 the leaf level stops at the package and the files inside stay internal detail, so
// the leafSource is `evidenceOnly`: the gate still re-walks the real *.go files, but they become a
// COUNT on the container instead of boxes. That count is also what the old shape could never see —
// it matched one fixed directory name, so adding or deleting a .go file passed the gate untouched.
if (GO) {
  for (const rel of goPackages(root, skipDir)) {
    // A package at the module ROOT is handled by the loose-files branch below (there is no parent
    // directory to name it from here). It is `evidenceOnly` too, and goEdges now keys on the
    // container's own glob evidence, so `dir: "."` maps to the bare module path and it gets edges.
    if (!rel) continue
    const id = claim(rel)
    nodes.push({ id, level: 'container', kind: 'container', parent: sysId, name: rel, tech: lang })
    leafSources.push({ parent: id, dir: rel, match: matchRe, exclude: '_test\\.go$', evidenceOnly: true })
  }
} else if (ext) findContainers(root, 0)
// loose files directly in root → an entry container
if (ext && hasSrc(root)) { nodes.push({ id: 'app', level: 'container', kind: 'container', parent: sysId, name: 'app', tech: lang, description: 'Entry point / loose top-level sources.' }); leafSources.push({ parent: 'app', dir: relative(REPO, root) || '.', match: matchRe, ...(GO ? { exclude: '_test\\.go$', evidenceOnly: true } : {}) }) }

// Nothing to seed is a fact to report, not a reason to exit: the context is written either way, and
// `--include` is named for what it actually does — it un-skips a data/doc dir BY NAME (docs,
// fixtures, testdata, …). It never took a path, so `--include frontend/src` was a promise the flag
// could not keep; the stacks it was reached for are named by §34 below instead.
if (ext && leafSources.length === 0) console.error(`[forma init] detected ${lang} (*.${ext[0]}) as the dominant language, but no directory under ${relative(REPO, root) || '.'}/ holds *.${ext[0]} files directly. Add leafSources by hand, or re-run with --include <name,...> to un-skip one of ${[...SKIP_DIRS].sort().join(', ')}.`)

// §34 — name every stack init SAW and did not seed. One run models ONE language (the whole container
// pass keys on a single `match`), and saying nothing about the rest is how a Go + React monorepo came
// out as 53 Go packages with no trace of the application its users actually open.
// Seeding them all instead was measured on that repo and rejected: the shallowest-dir rule stops at
// `frontend/`, whose only direct sources are two build configs, so the 302-file app under
// `frontend/src` would be modelled as `knip.config.ts` + `vite.config.ts` — a box that names the
// frontend and contains none of it, which is the false green forma exists to kill. Reaching the real
// app needs a per-stack root convention (src/, app/, frontend/src/) that has no honest general rule,
// and even then the container level goes from 53 boxes to 69 with 16 more carrying no prose.
// So the entries are built here — exactly as `gen` needs them, ids already de-duplicated against the
// seeded ones — and parked in `_unseeded`, where moving them in is a cut-and-paste, not a rewrite.
// Keyed on the DIRECTORIES that did not become a container, not on "every language but the dominant
// one": sources the container pass never reached are unmodelled whatever language they are in, and a
// directory already seeded must never come back as something to paste on top of itself. Covered is
// per LANGUAGE, though — `scripts/` can be a Go package AND hold 160 unmodelled *.mjs.
const covered = new Set(leafSources.map((s) => s.dir))
const byLang = new Map()
for (const [x, dirs] of Object.entries(extDirs)) {
  for (const d of dirs.keys()) {
    if (covered.has(d) && EXT[x] === lang) continue
    const L = byLang.get(EXT[x]) || new Set()
    L.add(d)
    byLang.set(EXT[x], L)
  }
}
// Counted the way `gen` walks a leafSource — same match, same exclusion — because the walk that fed
// `extDirs` counts every file: six directories on a real Go repo hold nothing but `_test.go`, which
// the Go adapter deliberately excludes from architecture. Offered as entries they would seed twenty
// boxes of test files, or (with the exclusion) match zero and make `gen` exit 1 on a phantom node.
const realFiles = (dir, re, ex) => {
  let out = 0
  try { for (const f of readdirSync(join(REPO, dir))) { if (!re.test(f) || (ex && ex.test(f))) continue; try { if (statSync(join(REPO, dir, f)).isFile()) out++ } catch {} } } catch {}
  return out
}
const unseeded = []
for (const [name, dirSet] of byLang) {
  // Every extension of the language in ONE match, the same rule the seeded side follows: a pasted
  // entry that under-matches models half a React app and reports it as whole.
  const match = anyOf(extsOf(name))
  const re = new RegExp(match), ex = name === 'Go' ? /_test\.go$/ : null
  const dirs = [...dirSet].sort().map((d) => [d, realFiles(d, re, ex)]).filter(([, n]) => n > 0)
  if (!dirs.length) continue
  const entry = { stack: name, files: dirs.reduce((a, b) => a + b[1], 0), match, nodes: [], leafSources: [] }
  for (const [d] of dirs) {
    const id = claim(d === '.' ? `${name}_root` : d)
    entry.nodes.push({ id, level: 'container', kind: 'container', parent: sysId, name: d === '.' ? `${name} (repo root)` : d, tech: name })
    entry.leafSources.push({ parent: id, dir: d, match, ...(name === 'Go' ? { exclude: '_test\\.go$', evidenceOnly: true } : {}) })
  }
  // The biggest directory rides alongside the entry, never inside it: `_unseeded` is pasted into the
  // topology by hand and every key in it has to be one `gen` understands.
  unseeded.push([entry, [...dirs].sort((a, b) => b[1] - a[1])[0]])
}
unseeded.sort((a, b) => b[0].files - a[0].files)
const unseededNotes = [] // printed after the file exists — the message points AT the file
for (const [entry, big] of unseeded) {
  const name = entry.stack
  const bigSrc = entry.leafSources.find((s) => s.dir === big[0])
  const bigNode = entry.nodes.find((n) => n.id === bigSrc.parent)
  unseededNotes.push(`[forma init] ${name}: ${entry.files} file(s) in ${entry.leafSources.length} directory(ies) NOT seeded${name === lang ? ' — the container pass never reached them' : lang ? ` — init models one stack per run, and ${lang} won` : ''}. Largest: ${big[0]} (${big[1]} files).`)
  unseededNotes.push(`[forma init]   the ${entry.leafSources.length} ready-made pair(s) are under "_unseeded" — move .nodes/.leafSources into the top-level arrays to model them. Largest: ${JSON.stringify(bigNode)} + ${JSON.stringify(bigSrc)}`)
}

// 4) find the documents that already say, in prose, what each part of the product does and whether
// it is finished — a feature matrix, a capability table, a requirements sheet. Detection is the
// reader itself: a doc qualifies when `loadDocRows` gets capability rows out of it, so nothing here
// can drift from what `gen` will actually parse, and no project's filenames are hardcoded.
// Threshold 3: a two-row table in a runbook is a config note, not a capability inventory.
const docSources = []
;(function findDocs(dir, depth) {
  if (depth > 4) return
  let ents; try { ents = readdirSync(dir) } catch { return }
  for (const e of ents.filter((x) => !IGNORE.has(x) && !x.startsWith('.')).sort()) {
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) findDocs(p, depth + 1)
    else if (/\.md$/i.test(e) && loadDocRows(REPO, [relative(REPO, p)], true).length >= 3) docSources.push(relative(REPO, p))
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
  meta: { repo: basename(REPO), ...(lang ? { stack: lang } : {}), seededBy: 'forma init', ...(ghRepo ? { ghRepo } : {}) },
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
  ...(unseeded.length ? { _unseeded: unseeded.map(([e]) => e) } : {}),
}
// ensure output dir exists
mkdirSync(join(OUT, '..'), { recursive: true })
writeFileSync(OUT, JSON.stringify(topo, null, 2) + '\n')
console.log(`[forma init] wrote ${relative(REPO, OUT)} — ${lang || 'no stack'}, ${leafSources.length} container(s) seeded from ${relative(REPO, root) || '.'}/${skipped.length ? `, ${skipped.length} data/doc dir(s) skipped` : ''}`)
for (const n of unseededNotes) console.error(n)
if (docSources.length) console.log(`[forma init] docSources: ${docSources.join(', ')} — capability rows will describe the containers they name.`)
// The context comes FIRST and alone on this line. It used to be the middle item of three, which read
// as one improvement among many; it is the only one without which the first screen says nothing.
console.log(`[forma init] NEXT: name the two "TODO:" actors in ${relative(REPO, OUT)} — that context screen is the first thing anyone sees. Then curate names/descriptions and run \`forma gen\`.`)
