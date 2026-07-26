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
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

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
 * @returns {{text:string, refs:string[], dead:string[], done:boolean|null, from:string}[]}
 */
// A ref is the row's EVIDENCE: the code it claims implements the capability. If nothing on disk
// answers to it, the claim is unfalsifiable — and worse, the row silently stops touching the node
// it used to describe, so an unfinished capability drops OUT of the completion denominator and the
// box turns green with a freshly re-derived "(1/1 done)". Measured: renaming one `code_ref` cell
// took a container from in-progress/50 to done/100, and `check` confirmed the new number.
// ponytail: prefix match, so a truncated ref (`src/billing/dunn`) still reads as alive — the price
// of supporting glob stems like `internal/imports/statement*.go`. Upgrade path: keep the raw cell
// and relax the rule only for refs that actually carried a `*`.
const alive = (repo, ref) => {
  if (existsSync(join(repo, ref))) return true
  try { return readdirSync(join(repo, dirname(ref))).some((e) => e.startsWith(basename(ref))) } catch { return false }
}
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
    const before = out.length
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
        out.push({ text: txt.slice(0, 240), refs, dead: refs.filter((x) => !alive(repo, x)),
                   done: iS < 0 ? null : DONE.test(String(r[iS]).replace(/[*_`]+/g, '').trim()), from: rel })
      }
    }
    // A status column that never once says "not done" is an INVENTORY, not a measure. `done /
    // rows.length` is then pinned to 1 by arithmetic, for every node and every subset of rows:
    // haben's feature matrix is 39 rows, 39 DONE, and all 27 nodes it reached came out at exactly
    // 100 — a constant a stakeholder reads as a measurement. The document is still saying
    // something (it declares those capabilities finished), so the VERDICT survives; the percentage
    // does not. Per source, because that is the unit that either discriminates or does not.
    const mine = out.slice(before)
    const measures = mine.some((r) => r.done === false)
    for (const r of mine) r.measures = measures
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
    // `located`: does this node have evidence of its OWN? A curated grouping box has none — every
    // path in its subtree belongs to a child — so no row ever names IT, only things inside it.
    // Reporting what is underneath is the viewer's job (rollStatus); claiming it as the box's own
    // verdict is not. See statusFor.
    if (hit.length) idx.set(n.id, { rows: hit, cover: coverOf(n, byId, kids, hit, paths), located: (n.evidence || []).length > 0 })
  }
  return idx
}

// How much of a node the rows actually reach. `done / rows.length` answers "of the capabilities
// somebody wrote down, how many are finished" — never "how much of this module is finished". A
// container holding 8 files that a matrix names 3 of, all done, reads 100%: the other 5 are not
// counted as unfinished, they are not counted at all. So the number ships with its own reach.
// `whole` means a row names the module itself, i.e. the document IS talking about all of it.
function coverOf(node, byId, kids, hit, paths) {
  const own = (node.evidence || []).filter((e) => e.type === 'path').map((e) => normRef(e.ref))
  const whole = hit.some((r) => r.refs.some((ref) => own.some((p) => ref === p || p.startsWith(ref + '/'))))
  const leaves = (kids.get(node.id) || []).map((k) => byId.get(k)).filter((k) => k && k.kind === 'leaf')
  const glob = (node.evidence || []).find((e) => e.type === 'glob')
  // Units = the boxes below it, or — for a node whose children are internal detail (a Go package) —
  // the file count its own drift anchor already carries.
  const total = leaves.length || (glob && glob.count) || paths.length
  if (whole) return { named: total, total, whole: true }
  const named = new Set()
  for (const r of hit) for (const ref of r.refs) if (own.some((p) => ref.startsWith(p + '/'))) named.add(ref)
  return { named: Math.min(named.size, total), total, whole: false }
}

// The rows that DESCRIBE a node (past the cap it is only touched by them — see MAX_ROWS).
export const describingRows = (idx, id) => {
  const e = idx.get(id)
  return e && e.rows.length <= MAX_ROWS ? e.rows : null
}
export const coverageFor = (idx, id) => (idx.get(id) || {}).cover || null

// Programme state a document states outright: how many of the capabilities living in this node are
// finished. Derived, never curated — the c4-status.json overlay still overrides it (gen.mjs §WP-A1),
// and `check` re-derives it from the same document rather than trusting the committed model.
//
// A DECLARATION, and only sometimes a measurement. The verdict is what the document says; the
// percentage is only emitted when the document's status column can say no (see `measures` in
// loadDocRows). A number nobody could have varied is not a measurement, and on a board it is read
// as one — which is worse than no number at all.
export function statusFor(idx, id) {
  const rows = describingRows(idx, id)
  if (!rows || rows.some((r) => r.done == null)) return null // no status column: describe only
  // A box the document cannot name did not get ruled on: the rows reached it only through its
  // children. The demo's `fisco` and `accesso` are curated groupings with no evidence of their own,
  // and both came out done/100 with coverage {named:0} — a verdict borrowed from below and printed
  // as the box's own. Reporting what is underneath is the viewer's job (rollStatus), not gen's.
  if (!(idx.get(id) || {}).located) return null
  const c = coverageFor(idx, id)
  const done = rows.filter((r) => r.done).length
  return {
    status2: done === rows.length ? 'done' : done === 0 ? 'planned' : 'in-progress',
    ...(rows.every((r) => r.measures) ? { completion: Math.round((done / rows.length) * 100) } : {}),
    // The citation says what it is: a repo document declaring itself finished, not a verification.
    source: `${rows[0].from} (${done}/${rows.length} declared done)`,
    ...(c ? { coverage: c } : {}),
  }
}
