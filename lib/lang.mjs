#!/usr/bin/env node
// lang.mjs — per-language adapters for TOPOLOGY and EDGES. Pure, no side effects at import.
//
// The name-matching heuristic in gen.mjs is the fallback for stacks that never say what depends on
// what. Some languages do say it, and guessing where a declaration exists is strictly worse. Go is
// the first case: its unit of architecture is the PACKAGE (any directory holding non-test *.go),
// and its dependency edge is the `import` block — both machine-readable, both unambiguous.
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'

// `forma init` writes meta.stack = 'Go'; a hand-curated topology opts in the same way.
export const isGo = (stack) => /^go\b/i.test(String(stack || ''))

// ponytail: name-based, no build-constraint evaluation — a file carrying `//go:build ignore` (or a
// tag not in the default build) still counts, so forma can see a package `go list` does not. The
// import it declares is real source either way; upgrade to reading the constraint line if it bites.
const isGoSrc = (f, includeTests = false) => /\.go$/.test(f) && (includeTests || !/_test\.go$/.test(f))
const posix = (p) => String(p).replace(/\\/g, '/')

// Source discovery never follows symbolic links. Besides escaping the repository boundary, a
// directory link can make a walk cyclic; rejecting it is the smallest fail-closed answer to both.
export function sourceStat(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are not source evidence: ${path}`)
  return stat
}

export function confinedSourceRoot(repo, path) {
  const root = realpathSync(repo), lexical = resolve(root, path)
  if (lexical !== root && !lexical.startsWith(root + sep)) throw new Error(`source path escapes repository: ${path}`)
  if (!existsSync(lexical)) return lexical
  const actual = realpathSync(lexical)
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error(`source path escapes repository: ${path}`)
  return actual
}

// Every directory under `root` holding at least one NON-TEST .go file is a package. Recurses past
// packages (Go nests them freely) and returns repo-relative posix dirs, sorted, '' for the module
// root. `skip(name)` filters directories (build junk, vendor/, data dirs) — the caller owns that
// policy so init keeps one source of truth for it.
export function goPackages(root, skip, includeTests = false) {
  const out = []
  ;(function walk(dir, rel) {
    let ents; try { ents = readdirSync(dir).sort() } catch { return }
    let src = false
    const subs = []
    for (const e of ents) {
      let st; try { st = sourceStat(join(dir, e)) } catch (error) { throw error }
      if (st.isDirectory()) { if (!skip(e)) subs.push(e) } else if (isGoSrc(e, includeTests)) src = true
    }
    if (src) out.push(rel)
    for (const s of subs) walk(join(dir, s), rel ? rel + '/' + s : s)
  })(confinedSourceRoot(root, root), '')
  return out
}

// The import paths a package declares, one entry per (file, path) pair so the count is "how many
// files import this". Handles `import "x"`, grouped `import ( … )`, aliases (`foo "x"`, `. "x"`,
// `_ "x"`) and trailing comments. Test files are excluded, so are their imports.
// ponytail: regex over gofmt'd source, no AST — an unformatted `import(` block on one line is missed.
export function goImports(absDir, includeTests = false) {
  const out = []
  let files; try { files = readdirSync(absDir).filter((f) => isGoSrc(f, includeTests)).sort() } catch { return out }
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

const goPackageImport = (repo, dir) => {
  const root = resolve(repo), pkg = resolve(root, dir)
  let at = pkg
  for (;;) {
    try {
      const mod = (readFileSync(join(at, 'go.mod'), 'utf-8').match(/^module\s+(\S+)/m) || [])[1]
      if (mod) {
        const rel = posix(relative(at, pkg))
        return rel ? mod + '/' + rel : mod
      }
    } catch {}
    if (at === root) return null
    const up = dirname(at)
    if (up === at || !(up === root || up.startsWith(root + sep))) return null
    at = up
  }
}

// Container→container edges from the import blocks. A Go package container carries its own
// DIRECTORY as glob evidence, so the model itself says which directory each container is — no id
// convention to keep in sync. Only intra-module imports become edges (the stdlib and third parties
// are outside the model). Direction is right by construction: from = the importer.
// Deliberately NOT the bidirectional dedup the heuristic pass uses — a declared import is a fact,
// and a curated edge pointing the other way must not suppress it.
// Keyed on the container's OWN id, not on containerOf(): a package is now one node, and keying on
// the ancestor would collapse every edge inside a future `internal` grouping into a self-loop.
export function goEdges({ repo, nodes, edges, includeTests = false }) {
  const pkgs = []
  for (const n of nodes) {
    if (n.kind !== 'container' || !isGo(n.tech)) continue
    const ev = (n.evidence || []).find((e) => e.type === 'glob')
    if (!ev) continue
    const dir = posix(ev.ref), importedAs = goPackageImport(repo, dir)
    if (importedAs) pkgs.push({ dir, container: n.id, importedAs })
  }
  const byImport = new Map(pkgs.map((p) => [p.importedAs, p.container]))
  const have = new Set((edges || []).map((e) => e.from + '|' + e.to))
  const out = []
  for (const p of pkgs) {
    const counts = new Map()
    for (const imp of goImports(join(repo, p.dir), includeTests)) {
      const to = byImport.get(imp)
      if (!to || to === p.container) continue
      counts.set(to, (counts.get(to) || 0) + 1)
    }
    for (const [to, c] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const k = p.container + '|' + to
      if (have.has(k)) continue
      have.add(k)
      out.push({ from: p.container, to, label: 'imports', weight: c, kind: 'import', estatus: 'inferred' })
    }
  }
  return out
}
