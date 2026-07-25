#!/usr/bin/env node
// lang.mjs — per-language adapters for TOPOLOGY and EDGES. Pure, no side effects at import.
//
// The name-matching heuristic in gen.mjs is the fallback for stacks that never say what depends on
// what. Some languages do say it, and guessing where a declaration exists is strictly worse. Go is
// the first case: its unit of architecture is the PACKAGE (any directory holding non-test *.go),
// and its dependency edge is the `import` block — both machine-readable, both unambiguous.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// `forma init` writes meta.stack = 'Go'; a hand-curated topology opts in the same way.
export const isGo = (stack) => /^go\b/i.test(String(stack || ''))

// ponytail: name-based, no build-constraint evaluation — a file carrying `//go:build ignore` (or a
// tag not in the default build) still counts, so forma can see a package `go list` does not. The
// import it declares is real source either way; upgrade to reading the constraint line if it bites.
const isGoSrc = (f) => /\.go$/.test(f) && !/_test\.go$/.test(f)
const posix = (p) => String(p).replace(/\\/g, '/')

// Every directory under `root` holding at least one NON-TEST .go file is a package. Recurses past
// packages (Go nests them freely) and returns repo-relative posix dirs, sorted, '' for the module
// root. `skip(name)` filters directories (build junk, vendor/, data dirs) — the caller owns that
// policy so init keeps one source of truth for it.
export function goPackages(root, skip) {
  const out = []
  ;(function walk(dir, rel, depth) {
    if (depth > 12) return
    let ents; try { ents = readdirSync(dir).sort() } catch { return }
    let src = false
    const subs = []
    for (const e of ents) {
      let st; try { st = statSync(join(dir, e)) } catch { continue }
      if (st.isDirectory()) { if (!skip(e)) subs.push(e) } else if (isGoSrc(e)) src = true
    }
    if (src) out.push(rel)
    for (const s of subs) walk(join(dir, s), rel ? rel + '/' + s : s, depth + 1)
  })(root, '', 0)
  return out
}

// The import paths a package declares, one entry per (file, path) pair so the count is "how many
// files import this". Handles `import "x"`, grouped `import ( … )`, aliases (`foo "x"`, `. "x"`,
// `_ "x"`) and trailing comments. Test files are excluded, so are their imports.
// ponytail: regex over gofmt'd source, no AST — an unformatted `import(` block on one line is missed.
export function goImports(absDir) {
  const out = []
  let files; try { files = readdirSync(absDir).filter(isGoSrc).sort() } catch { return out }
  for (const f of files) {
    let src; try { src = readFileSync(join(absDir, f), 'utf-8') } catch { continue }
    const here = new Set()
    for (const m of src.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
      for (const line of m[1].split('\n')) {
        const q = line.replace(/\/\/.*$/, '').trim().match(/"([^"]+)"$/)
        if (q) here.add(q[1])
      }
    }
    for (const m of src.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) here.add(m[1])
    out.push(...[...here].sort())
  }
  return out
}

const goModulePath = (repo) => {
  try { return (readFileSync(join(repo, 'go.mod'), 'utf-8').match(/^module\s+(\S+)/m) || [])[1] || null } catch { return null }
}

// Container→container edges from the import blocks. A Go package leaf carries its own DIRECTORY as
// path evidence, so the model itself says which directory each container is — no id convention to
// keep in sync. Only intra-module imports become edges (the stdlib and third parties are outside
// the model). Direction is right by construction: from = the importer.
// Deliberately NOT the bidirectional dedup the heuristic pass uses — a declared import is a fact,
// and a curated edge pointing the other way must not suppress it.
export function goEdges({ repo, nodes, byId, containerOf, edges }) {
  const mod = goModulePath(repo)
  if (!mod) return []
  const pkgs = []
  for (const n of nodes) {
    if (n.kind !== 'leaf') continue
    const ev = (n.evidence || []).find((e) => e.type === 'path')
    if (!ev) continue
    try { if (!statSync(join(repo, ev.ref)).isDirectory()) continue } catch { continue }
    pkgs.push({ dir: posix(ev.ref), container: containerOf(n, byId) })
  }
  const byImport = new Map(pkgs.map((p) => [p.dir === '.' ? mod : mod + '/' + p.dir, p.container]))
  const have = new Set((edges || []).map((e) => e.from + '|' + e.to))
  const out = []
  for (const p of pkgs) {
    const counts = new Map()
    for (const imp of goImports(join(repo, p.dir))) {
      const to = byImport.get(imp)
      if (!to || to === p.container) continue
      counts.set(to, (counts.get(to) || 0) + 1)
    }
    for (const [to, c] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const k = p.container + '|' + to
      if (have.has(k)) continue
      have.add(k)
      out.push({ from: p.container, to, label: c + '×', kind: 'import', estatus: 'active' })
    }
  }
  return out
}
