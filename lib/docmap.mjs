#!/usr/bin/env node
// docmap.mjs — the DOCUMENTARY source of the description chain (§1a), and the only deterministic
// producer of programme state. Pure parsing, NO network, NO invention.
//
// A governed repo already writes, in prose, what each part of it does for the user and whether it
// is finished: a feature matrix, a capability table, a requirements sheet. Those rows carry code
// references. This module joins those rows to model nodes by path, so a CONTAINER's box can read
// "Account domain: bank/broker kinds, free-cash, IBAN, soft-archive" (a sentence a human wrote in a
// repo document) instead of a docstring belonging to the first file inside it.
//
// Every sentence it yields is quoted from a document under `repo`; provenance is `descSource:
// 'docmap'` plus `verify.source` naming the file. Nothing here composes, paraphrases or infers text.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// A node matching MORE rows than this is not DESCRIBED by the matrix — it is merely TOUCHED by
// many features (on haben, `internal/store` is referenced by 12 rows and `internal/server` by 20).
// Stitching those first sentences together would invent a claim no document makes, so past the cap
// the node yields nothing and the rest of the chain runs. Same constant, same reason as the
// component composition in gen.mjs: three sentences is the most a box can carry honestly.
export const MAX_ROWS = 3

// Column roles, by header name. Overridable per source; these defaults are conventions
// (`capability`, `code_ref`, `status`), never one project's identifiers.
const ROLES = {
  describe: /^(capabilit(y|ies)|feature|description|what|summary|purpose)$/i,
  ref: /^(code_?refs?|code|paths?|refs?|sources?|modules?|files?|impl(ementation)?)$/i,
  status: /^(status|state|progress)$/i,
}
const DONE = /^(done|shipped|complete[d]?|ready|✅)\b/i
// `./x` and `x/` are the same key as `x`; a bare `x` and `x/**` too.
const normRef = (s) => String(s).trim().replace(/^\.\//, '').replace(/\/?\*+.*$/, '').replace(/\/+$/, '')
// A ref is a path, not prose: `internal/account` or `deps.go`, never "2 kinds (bank/broker)".
const looksLikePath = (s) => /^[\w.@~-]+([/\\][\w.@~ -]+)*$/.test(s) && (s.includes('/') || /\.\w+$/.test(s))

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim())
const isRule = (line) => /^\|[\s:|-]+\|$/.test(line.trim())

// Every pipe table in the text, as [header, ...rows] of equal width. A malformed row is dropped,
// not repaired: a half-parsed row would put arbitrary text in a stakeholder's box.
function tables(text) {
  const out = []
  let cur = null
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('|') && line.endsWith('|') && line.length > 2) {
      if (isRule(line)) continue
      const row = cells(line)
      if (!cur) cur = { header: row, rows: [] }
      else if (row.length === cur.header.length) cur.rows.push(row)
    } else if (cur) { if (cur.rows.length) out.push(cur); cur = null }
  }
  if (cur && cur.rows.length) out.push(cur)
  return out
}

const roleIndex = (header, role, override) => {
  if (override) return header.findIndex((h) => h.toLowerCase() === String(override).toLowerCase())
  return header.findIndex((h) => ROLES[role].test(h))
}

// Path tokens in a cell: backticked first (the markdown convention), else comma-separated.
function refsIn(cell) {
  const ticked = [...String(cell).matchAll(/`([^`]+)`/g)].map((m) => normRef(m[1]))
  const raw = ticked.length ? ticked : String(cell).split(',').map(normRef)
  return [...new Set(raw.filter(looksLikePath))]
}

/**
 * Read every `docSources` entry into flat rows.
 * @param inventoryOnly require a status column too. `forma init` sets it when AUTO-DETECTING a
 *   source: "feature + file" is also the shape of a change plan ("C1 translator import |
 *   decision/ChildTimeline.tsx"), and auto-adopting one of those would put a task line in a
 *   stakeholder's box — inventing, which is the one thing this must never do. An inventory says
 *   whether each capability is finished; a work plan does not. A source listed BY HAND is trusted
 *   as-is, status column or not.
 * @returns {{text:string, refs:string[], done:boolean|null, from:string}[]}
 */
export function loadDocRows(repo, docSources, inventoryOnly = false) {
  const out = []
  for (const entry of docSources || []) {
    // Normalize FIRST: a bare-string source is not an options bag, and probing one for `.ref` or
    // `.match` reaches String.prototype instead of undefined — a truthy "override" that silently
    // matched no column and made every capability table parse to zero rows.
    const src = typeof entry === 'string' ? { path: entry } : (entry || {})
    const rel = src.path
    if (!rel) continue
    const abs = join(repo, rel)
    if (!existsSync(abs)) continue
    let text
    try { text = readFileSync(abs, 'utf-8') } catch { continue }
    for (const t of tables(text)) {
      const iD = roleIndex(t.header, 'describe', src.describe)
      const iM = roleIndex(t.header, 'ref', src.ref)
      if (iD < 0 || iM < 0) continue // not a capability table — a changelog or a config table
      const iS = roleIndex(t.header, 'status', src.status)
      if (inventoryOnly && iS < 0) continue // see loadDocRows' third argument
      for (const r of t.rows) {
        const refs = refsIn(r[iM])
        const txt = String(r[iD]).replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()
        if (!refs.length || !txt) continue
        out.push({ text: txt.slice(0, 240), refs, done: iS < 0 ? null : DONE.test(String(r[iS]).replace(/[*_`]+/g, '').trim()), from: rel })
      }
    }
  }
  return out
}

// A row's ref points AT a node when it names the node's own file/dir, something inside it, or the
// directory that contains it. `internal/store/account_repo.go` therefore reaches the `internal/store`
// package and NOT `internal/account` — the join has to be specific or every row lands on every
// ancestor.
const touches = (ref, path) => ref === path || ref.startsWith(path + '/') || path.startsWith(ref + '/')

/**
 * Map every node id to the rows that name it, itself or through its descendants (a Go container's
 * own evidence is a glob over its PARENT directory, so only its leaves carry the real path).
 * @returns {Map<string, object[]>}
 */
export function indexByNode(rows, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const kids = new Map()
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) || []), n.id])
  const ownPaths = (n) => (n.evidence || []).filter((e) => e.type === 'path').map((e) => normRef(e.ref))
  const subtree = (id, seen = new Set()) => {
    if (seen.has(id)) return [] // a malformed parent cycle must not hang gen
    seen.add(id)
    const out = [...ownPaths(byId.get(id) || {})]
    for (const k of kids.get(id) || []) out.push(...subtree(k, seen))
    return out
  }
  const idx = new Map()
  for (const n of nodes) {
    const paths = subtree(n.id)
    if (!paths.length) continue
    const hit = rows.filter((r) => r.refs.some((ref) => paths.some((p) => touches(ref, p))))
    if (hit.length) idx.set(n.id, hit)
  }
  return idx
}

// The rows that DESCRIBE a node (past the cap it is only touched by them — see MAX_ROWS).
export const describingRows = (idx, id) => {
  const rows = idx.get(id)
  return rows && rows.length <= MAX_ROWS ? rows : null
}

// Programme state a document states outright: how many of the capabilities living in this node are
// finished. Derived, never curated — the c4-status.json overlay still overrides it (gen.mjs §WP-A1),
// and `check` re-derives it from the same document rather than trusting the committed model.
export function statusFor(idx, id) {
  const rows = describingRows(idx, id)
  if (!rows || rows.some((r) => r.done == null)) return null // no status column: describe only
  const done = rows.filter((r) => r.done).length
  return {
    status2: done === rows.length ? 'done' : done === 0 ? 'planned' : 'in-progress',
    completion: Math.round((done / rows.length) * 100),
    source: `${rows[0].from} (${done}/${rows.length} done)`,
  }
}
