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
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'

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
const LEDGER_COLUMNS = {
  id: /^(id|[\w -]+[_ ]id)$/i,
  describe: /^(capabilit(y|ies)|feature|description|what|summary|purpose|goal|name)$/i,
  issues: /^(issues?|issue[_ ]?refs?|tickets?|work|work[_ ]?items?|wbs)$/i,
  release: /^(release|milestone|version|target[_ ]?release|train)$/i,
  parents: /^(feature_ids|parent[_ ]?ids?|implemented[_ ]?by)$/i,
}
const DONE = /^(done|shipped|complete[d]?|ready|✅)\b/i
// `./x` and `x/` are the same key as `x`; a bare `x` and `x/**` too.
const normRef = (s) => String(s).trim().replace(/^\.\//, '').replace(/\/?\*+.*$/, '').replace(/\/+$/, '')
// A ref is a path, not prose: `internal/account` or `deps.go`, never "2 kinds (bank/broker)".
const looksLikePath = (s) => /^[\w.@~-]+([/\\][\w.@~ -]+)*$/.test(s) && (s.includes('/') || /\.\w+$/.test(s))

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim())
const isRule = (line) => /^\|[\s:|-]+\|$/.test(line.trim())

// Every pipe table in the text, as {header, rows, lines, invalid}. Malformed rows stay marked:
// dropping one could remove an unfinished capability from the denominator before validation.
// `lines[i]` is the 1-based source line of `rows[i]`, so a consumer can cite the row it read rather
// than only the file — the difference between "docs/PRD.md says so" and a link a reader can follow.
export function tables(text) {
  const out = []
  let cur = null, lineNo = 0
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    lineNo++
    const line = raw.trim()
    if (line.startsWith('|') && line.endsWith('|') && line.length > 2) {
      if (isRule(line)) continue
      const row = cells(line)
      if (!cur) cur = { header: row, rows: [], lines: [], invalid: [] }
      else { cur.rows.push(row); cur.lines.push(lineNo); cur.invalid.push(row.length !== cur.header.length) }
    } else if (cur) { if (cur.rows.length) out.push(cur); cur = null }
  }
  if (cur && cur.rows.length) out.push(cur)
  return out
}

// Which column plays a role, by header name, with a per-source override that wins outright. Shared
// so a second table reader (lib/rtm.mjs) matches columns the same way instead of growing its own
// near-miss vocabulary.
export const headerIndex = (header, pattern, override) => {
  if (override) return header.findIndex((h) => h.toLowerCase() === String(override).toLowerCase())
  return header.findIndex((h) => pattern.test(h))
}
const roleIndex = (header, role, override) => headerIndex(header, ROLES[role], override)

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
const inside = (repo, rel) => {
  const root = resolve(repo), abs = resolve(root, rel)
  return abs === root || abs.startsWith(root + sep)
}
const realInside = (repo, path) => {
  try {
    const root = realpathSync(resolve(repo)), actual = realpathSync(path)
    return actual === root || actual.startsWith(root + sep)
  } catch { return false }
}
const alive = (repo, ref) => {
  if (!inside(repo, ref)) return false
  const abs = resolve(repo, ref)
  if (existsSync(abs)) return realInside(repo, abs)
  try {
    const dir = resolve(repo, dirname(ref))
    if (!realInside(repo, dir)) return false
    return readdirSync(dir).some((e) => e.startsWith(basename(ref)) && realInside(repo, join(dir, e)))
  } catch { return false }
}
const resolvedRef = (repo, ref, roots) => {
  if (alive(repo, ref)) return ref
  const hits = [...new Set((Array.isArray(roots) ? roots : []).map((root) => normRef(`${root}/${ref}`)).filter((p) => alive(repo, p)))]
  return hits.length === 1 ? hits[0] : null
}

const clean = (s) => String(s == null ? '' : s).replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()
const issueNumbersIn = (cell) => {
  const value = String(cell == null ? '' : cell)
  return [...new Set([
    ...[...value.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])),
    ...value.split(',').map(clean).filter((token) => /^\d+$/.test(token)).map(Number),
  ])]
}
const idsIn = (cell) => {
  const value = String(cell == null ? '' : cell)
  const ticked = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1])
  return [...new Set((ticked.length ? ticked : value.split(',')).map(clean).filter((id) => id && id !== '—' && id !== '-'))]
}
const trackedDocFiles = (repo) => {
  try {
    return new Set(execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 })
      .split('\n').map((s) => s.trim()).filter(Boolean))
  } catch { return null }
}

/**
 * Parse declared capability ledgers without reducing their status vocabulary to `done`/not-done.
 * @returns {{rows: object[], skipped: object[], duplicates: object[]}}
 */
export function parseCapabilities(repo, capabilityConfig, tracked = trackedDocFiles(repo)) {
  const config = Array.isArray(capabilityConfig) ? { docs: capabilityConfig } : (capabilityConfig || {})
  const statusMap = config.statusMap || {}
  const rows = [], skipped = []
  const docs = [...(config.docs || [])].sort((a, b) => {
    const pa = typeof a === 'string' ? a : (a && a.path) || ''
    const pb = typeof b === 'string' ? b : (b && b.path) || ''
    return pa < pb ? -1 : pa > pb ? 1 : 0
  })
  for (const entry of docs) {
    const src = typeof entry === 'string' ? { path: entry } : (entry || {})
    const rel = src.path && normRef(src.path)
    if (!rel) { skipped.push({ path: '', why: 'missing path' }); continue }
    if (!inside(repo, rel)) { skipped.push({ path: rel, why: 'outside repository' }); continue }
    if (tracked && !tracked.has(rel)) { skipped.push({ path: rel, why: 'not tracked by git' }); continue }
    const abs = resolve(repo, rel)
    if (existsSync(abs) && !realInside(repo, abs)) { skipped.push({ path: rel, why: 'outside repository' }); continue }
    let text
    try { text = readFileSync(abs, 'utf-8') } catch (e) { skipped.push({ path: rel, why: `unreadable: ${(e && e.message) || e}` }); continue }
    const before = rows.length
    for (const table of tables(text)) {
      const iText = headerIndex(table.header, LEDGER_COLUMNS.describe, src.describe)
      const iStatus = headerIndex(table.header, ROLES.status, src.status)
      if (iText < 0 || iStatus < 0) continue
      const iId = headerIndex(table.header, LEDGER_COLUMNS.id, src.id)
      const iRef = headerIndex(table.header, ROLES.ref, src.ref)
      const iIssues = headerIndex(table.header, LEDGER_COLUMNS.issues, src.issues)
      const iRelease = headerIndex(table.header, LEDGER_COLUMNS.release, src.release)
      const iParents = headerIndex(table.header, LEDGER_COLUMNS.parents, src.parents)
      const resolutions = new Map()
      const resolveOne = (ref) => {
        if (!resolutions.has(ref)) resolutions.set(ref, resolvedRef(repo, ref, src.roots))
        return resolutions.get(ref)
      }
      for (let r = 0; r < table.rows.length; r++) {
        const row = table.rows[r], line = table.lines[r]
        if ((table.invalid || [])[r]) { skipped.push({ path: rel, line, why: 'malformed row: column count mismatch' }); continue }
        const capability = clean(row[iText]), originalStatus = clean(row[iStatus])
        if (!capability || !originalStatus) { skipped.push({ path: rel, line, why: `malformed row: missing ${!capability ? 'capability' : 'status'}` }); continue }
        const rawRefs = iRef < 0 ? [] : refsIn(row[iRef])
        const mapped = Object.prototype.hasOwnProperty.call(statusMap, originalStatus)
        rows.push({
          id: iId < 0 ? null : clean(row[iId]) || null,
          capability: capability.slice(0, 240),
          originalStatus,
          status: mapped ? statusMap[originalStatus] : 'unknown',
          refs: rawRefs.map((ref) => resolveOne(ref) || ref),
          dead: rawRefs.filter((ref) => !resolveOne(ref)),
          issues: iIssues < 0 ? [] : issueNumbersIn(row[iIssues]),
          parents: iParents < 0 ? [] : idsIn(row[iParents]),
          ...(iRelease >= 0 && clean(row[iRelease]) ? { release: clean(row[iRelease]) } : {}),
          source: { path: rel, line },
        })
      }
    }
    if (rows.length === before) skipped.push({ path: rel, why: 'empty or no table with both capability and status columns' })
  }
  const firstById = new Map(), duplicates = []
  for (const row of rows) {
    if (!row.id) continue
    if (firstById.has(row.id)) duplicates.push({ id: row.id, source: row.source, first: firstById.get(row.id).source })
    else firstById.set(row.id, row)
  }
  const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0
  const cmp = (a, b) => byText(a.path || '', b.path || '') || (a.line || 0) - (b.line || 0) || byText(a.why || '', b.why || '')
  skipped.sort(cmp)
  duplicates.sort((a, b) => byText(a.id, b.id) || cmp(a.source, b.source))
  return { rows, skipped, duplicates }
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
    if (!inside(repo, rel) || (existsSync(resolve(repo, rel)) && !realInside(repo, resolve(repo, rel)))) {
      out.push({ text: 'document source outside repository', refs: [], dead: [rel], done: null, from: rel, measures: false })
      continue
    }
    const abs = resolve(repo, rel)
    if (!existsSync(abs)) continue
    let text
    try { text = readFileSync(abs, 'utf-8') } catch { continue }
    const resolutions = new Map()
    const resolveOne = (ref) => {
      if (!resolutions.has(ref)) resolutions.set(ref, resolvedRef(repo, ref, src.roots))
      return resolutions.get(ref)
    }
    const before = out.length
    for (const t of tables(text)) {
      const iD = roleIndex(t.header, 'describe', src.describe)
      const iM = roleIndex(t.header, 'ref', src.ref)
      if (iD < 0 || iM < 0) continue // not a capability table — a changelog or a config table
      const iS = roleIndex(t.header, 'status', src.status)
      if (inventoryOnly && iS < 0) continue // see loadDocRows' third argument
      for (let rowIndex = 0; rowIndex < t.rows.length; rowIndex++) {
        const r = t.rows[rowIndex]
        if ((t.invalid || [])[rowIndex]) {
          out.push({ text: '(malformed table row)', refs: [], dead: ['<column count mismatch>'], done: null, from: rel })
          continue
        }
        const rawRefs = refsIn(r[iM])
        const refs = rawRefs.map((ref) => resolveOne(ref) || ref)
        const txt = String(r[iD]).replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()
        if (!refs.length || !txt) {
          out.push({ text: txt || '(missing description)', refs, dead: [!txt ? '<missing description>' : '<missing code_ref>'], done: null, from: rel })
          continue
        }
        out.push({ text: txt.slice(0, 240), refs, dead: rawRefs.filter((x) => !resolveOne(x)),
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

// The rows that RULE on a node: every row that names it, cap or no cap. MAX_ROWS is a limit on how
// much prose a box can carry honestly; counting how many named capabilities are finished is not
// prose, and inheriting the cap made the verdict scale backwards — the more rows named a module,
// the less it was judged. `internal_budget`, named by four DONE rows, came out unassessed next to
// modules nobody documented at all (#43).
export const rulingRows = (idx, id) => {
  const e = idx.get(id)
  return e && e.rows.length ? e.rows : null
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
  const rows = rulingRows(idx, id)
  if (!rows || rows.some((r) => r.done == null)) return null // no status column: describe only
  // A box the document cannot name did not get ruled on: the rows reached it only through its
  // children. The demo's `fisco` and `accesso` are curated groupings with no evidence of their own,
  // and both came out done/100 with coverage {named:0} — a verdict borrowed from below and printed
  // as the box's own. Reporting what is underneath is the viewer's job (rollStatus), not gen's.
  if (!(idx.get(id) || {}).located) return null
  const c = coverageFor(idx, id)
  const done = rows.filter((r) => r.done).length
  // Past the cap the document TOUCHES the node rather than describing it (see MAX_ROWS), and the
  // two halves of the answer part company: "of the rows that name this, N are done" is still
  // something the document says, so the verdict stands — but a percentage over a reach nobody can
  // state is the invented number this file exists to refuse. Verdict yes, percentage no.
  const described = rows.length <= MAX_ROWS
  return {
    status2: done === rows.length ? 'done' : done === 0 ? 'planned' : 'in-progress',
    ...(described && rows.every((r) => r.measures) ? { completion: Math.round((done / rows.length) * 100) } : {}),
    // The citation says what it is: a repo document declaring itself finished, not a verification.
    source: `${rows[0].from} (${done}/${rows.length} declared done)`,
    ...(c ? { coverage: c } : {}),
  }
}
