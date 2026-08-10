// rtm.mjs — the requirements traceability matrix, DERIVED from the documents a repo already writes
// and the issues it already has. Pure parsing plus set arithmetic: no network, no LLM, nothing
// curated into a second file that could disagree with the first.
//
// The chain it reads is the GAMP 5 V-model, left side to right side, with GitHub issues standing in
// for the work packages:
//
//   URS  what must be true for the user      docs/PRD.md          R-*
//   FS   which design choice satisfies it    docs/DESIGN.md       D-*
//        whether that is feasible            docs/FEASIBILITY.md  F-*
//   DS   what is decided and cannot break    docs/adr/, INVARIANTS
//   xQ   what proves it, and by what command docs/DELIVERY.md     V-*
//   WBS  the work to get there               GitHub issues        #N
//
// What this module does NOT do is infer any of it. A row traces to another row because a cell says
// so; forma only measures the coverage of those declarations and names what is uncovered at either
// end. Inferring the trace would put a requirement nobody wrote into a stakeholder's matrix, which
// is the same defect docmap.mjs exists to refuse one layer down.
//
// Determinism matters more here than anywhere else in the derivation layer, because `check`
// re-derives this and compares: the file list comes from `git ls-files` and is SORTED, so the
// answer cannot depend on directory order or on what is lying around untracked in the working tree.
// A document edited between `forma room` and `forma check` does make the gate fail — that is the
// drift it exists to find, not a false red.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tables, headerIndex } from './docmap.mjs'

// Column roles, by header name. Overridable per source; these defaults are conventions, never one
// project's identifiers (I13).
const COLUMNS = {
  id: /^(id|req|requirement[_ ]?id|ref)$/i,
  text: /^(requirement|capabilit(y|ies)|decision|feature|what|description|summary|purpose)$/i,
  satisfies: /^(satisfies|derives[_ ]?from|upstream|parent|traces[_ ]?to)$/i,
  verified: /^(verified[_ ]?by|verification|proof|test)$/i,
  issues: /^(issues?|work|wbs|tickets?)$/i,
}

// A cell lists references: backticked first (the markdown convention), else comma-separated. Same
// shape as docmap's refsIn, minus the path test — these are identifiers, not file paths.
const refsIn = (cell) => {
  const text = String(cell == null ? '' : cell)
  const ticked = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
  const raw = ticked.length ? ticked : text.split(',').map((s) => s.replace(/[*_`]+/g, '').trim())
  return [...new Set(raw.filter(Boolean))]
}
// `#12`, `12`, and `owner/repo#12` all mean an issue number; anything else in the cell is not one.
const issueNumbersIn = (cell) => [...new Set(refsIn(cell)
  .map((token) => { const m = /(?:^|#)(\d+)$/.exec(token); return m ? Number(m[1]) : null })
  .filter((n) => n !== null))]
const clean = (s) => String(s == null ? '' : s).replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()

// Only files git tracks, in sorted order. A naive walk of a real repo finds agent working copies
// and build output (measured on one: 8899 files, 8544 of them under .claude/worktrees), and an
// untracked file entering the matrix would make the gate depend on the state of somebody's desk.
export function trackedFiles(repo) {
  try {
    return new Set(execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 })
      .split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    return null // not a checkout we can read; the caller reports it rather than silently finding nothing
  }
}

/**
 * Read every declared document into flat requirement rows.
 * @returns {{rows: object[], skipped: object[]}} `skipped` names every document that yielded
 *   nothing and why — a document silently contributing zero rows is how a matrix quietly empties.
 */
export function parseRequirements(repo, docs, tracked) {
  const rows = [], skipped = []
  for (const entry of [...(docs || [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const rel = entry && entry.path
    if (!rel) continue
    if (tracked && !tracked.has(rel)) { skipped.push({ path: rel, why: 'not tracked by git' }); continue }
    let text
    try { text = readFileSync(join(repo, rel), 'utf-8') } catch (e) { skipped.push({ path: rel, why: `unreadable: ${(e && e.message) || e}` }); continue }
    const idPattern = entry.idPattern ? new RegExp(entry.idPattern) : null
    const before = rows.length
    for (const table of tables(text)) {
      const iId = headerIndex(table.header, COLUMNS.id, entry.id)
      const iText = headerIndex(table.header, COLUMNS.text, entry.describe)
      if (iId < 0 || iText < 0) continue // not a requirements table — a changelog, a config table
      const iSat = headerIndex(table.header, COLUMNS.satisfies, entry.satisfies)
      const iVer = headerIndex(table.header, COLUMNS.verified, entry.verified)
      const iIss = headerIndex(table.header, COLUMNS.issues, entry.issues)
      for (let r = 0; r < table.rows.length; r++) {
        const row = table.rows[r]
        const id = clean(row[iId])
        // An id column that does not match the declared pattern is not a near-miss to repair: it is
        // a different table that happens to have a column called "id".
        if (!id || (idPattern && !idPattern.test(id))) continue
        const text2 = clean(row[iText])
        if (!text2) continue
        rows.push({
          id,
          text: text2.slice(0, 240),
          role: entry.role || 'requirement',
          from: rel,
          line: table.lines[r],
          satisfies: iSat < 0 ? [] : refsIn(row[iSat]).map(clean).filter(Boolean),
          verified: iVer < 0 ? [] : refsIn(row[iVer]).map(clean).filter(Boolean),
          issues: iIss < 0 ? [] : issueNumbersIn(row[iIss]),
        })
      }
    }
    if (rows.length === before) skipped.push({ path: rel, why: 'no table with both an id column and a text column, or no row matched idPattern' })
  }
  return { rows, skipped }
}

const sortIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The matrix and its holes. Every count here is over declarations that exist; nothing is inferred,
 * and nothing is reported as a percentage when its denominator is empty (I6).
 */
export function deriveRtm({ repo, rtm, issuesSnapshot }) {
  if (!rtm || !(rtm.docs || []).length) return null // opt-in by presence (I11)
  // `tracked` being null means git could not be read — an export, a tarball, a fixture copy. That is
  // NOT the same condition as "a declared document contributed nothing", and treating it as one made
  // `check` fail on any non-git copy of a repository that declares a matrix.
  //
  // The rows are the same either way, and deliberately so: rtm.docs is an explicit LIST of paths,
  // not a glob. The git filter exists to catch a declared path that points at something untracked;
  // without git there is nothing to discover and nothing to filter, so the derivation stays
  // deterministic. Recording the filter's presence in the result would make the gate depend on the
  // environment it runs in, which is a worse failure than the one it would disclose.
  const tracked = trackedFiles(repo)
  const { rows, skipped } = parseRequirements(repo, rtm.docs, tracked)

  const byId = new Map()
  const duplicateIds = []
  for (const row of rows) {
    if (byId.has(row.id)) {
      const first = byId.get(row.id)
      duplicateIds.push({ id: row.id, from: row.from, line: row.line, first: `${first.from}:${first.line}` })
      continue
    }
    byId.set(row.id, row)
  }

  const issues = (issuesSnapshot && issuesSnapshot.issues) || []
  const known = new Map(issues.map((it) => [it.n, it]))
  const requireFrom = new Set(rtm.requireIssuesFrom || [])

  // A reference that names nothing is worse than a missing one: it reads as traced.
  const danglingRefs = []
  const citedIssues = new Set()
  for (const row of rows) {
    for (const ref of row.satisfies) if (!byId.has(ref)) danglingRefs.push({ id: row.id, from: row.from, line: row.line, kind: 'satisfies', ref })
    for (const n of row.issues) {
      citedIssues.add(n)
      if (!known.has(n)) danglingRefs.push({ id: row.id, from: row.from, line: row.line, kind: 'issue', ref: `#${n}` })
    }
  }

  // Uncovered: a row that must land on work, and does not — with nothing verifying it either.
  const uncovered = rows
    .filter((row) => requireFrom.has(row.from))
    .filter((row) => !row.issues.length && !row.verified.length)
    .map((row) => ({ id: row.id, from: row.from, line: row.line, text: row.text }))

  // Orphan work: an OPEN issue no row cites. Closed work is deliberately out of scope — the matrix
  // answers "is everything left to do accounted for", not "was every past commit foreseen".
  const orphanIssues = issues
    .filter((it) => it.state === 'OPEN' && !citedIssues.has(it.n))
    .map((it) => ({ n: it.n, title: it.title }))
    .sort((a, b) => a.n - b.n)

  // Progress is issue closure, never code (I5: code proves existence, never completion). A row
  // citing no issue has no percentage at all rather than a zero.
  const progress = {}
  for (const row of rows) {
    const cited = row.issues.filter((n) => known.has(n))
    const closed = cited.filter((n) => known.get(n).state === 'CLOSED').length
    progress[row.id] = { issues: cited.length, closed, open: cited.length - closed, pct: cited.length ? Math.round((100 * closed) / cited.length) : null }
  }

  // "Covered" has to mean one thing, or the briefing contradicts itself. The gate treats a row as
  // covered when it lands on an issue OR names a verification, so the headline number counts the
  // same thing — reporting `withIssues` as coverage while the gate reported no holes put "0 of 9
  // have work behind them" directly above "the matrix has no holes" on the same screen.
  const withIssues = rows.filter((row) => row.issues.length).length
  const verifiedOnly = rows.filter((row) => !row.issues.length && row.verified.length).length
  const accounted = withIssues + verifiedOnly
  return {
    requirements: rows.map((row) => ({ ...row })).sort((a, b) => sortIds(a.from, b.from) || a.line - b.line),
    byRole: [...rows.reduce((acc, row) => acc.set(row.role, (acc.get(row.role) || 0) + 1), new Map())]
      .sort(([a], [b]) => sortIds(a, b)).map(([role, count]) => ({ role, count })),
    coverage: {
      requirements: rows.length, withIssues, verifiedOnly, accounted,
      pct: rows.length ? Math.round((100 * accounted) / rows.length) : null,
    },
    progress,
    orphans: {
      duplicateIds: duplicateIds.sort((a, b) => sortIds(a.id, b.id)),
      danglingRefs: danglingRefs.sort((a, b) => sortIds(a.id, b.id) || sortIds(a.ref, b.ref)),
      uncovered: uncovered.sort((a, b) => sortIds(a.id, b.id)),
      orphanIssues,
    },
    // I9: a document that contributed nothing is named, never silently absent from the matrix.
    skipped: skipped.sort((a, b) => sortIds(a.path, b.path)),
  }
}
