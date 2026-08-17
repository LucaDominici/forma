#!/usr/bin/env node
// forma verify — refresh programme status from LIVE GitHub issues, through the user's `gh` CLI.
// This is the ONLY command that touches the network, and it is opt-in: `gen` and `check` stay
// deterministic and offline forever (that is the product). It never touches structure — no nodes,
// no edges, no func — only the state fields of nodes that reference an issue.
// Usage: node verify.mjs [--repo <path>] [--model <path>] [--gh-repo <owner/repo>] [--gh-cmd <cmd>]
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { canonicalPath } from './roomload.mjs'
import { validateModel } from './validate.mjs'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const MODEL = arg('--model', join(REPO, 'docs/architecture/c4-model.json'))
const ISSUES = arg('--issues', join(REPO, 'docs/architecture/c4-issues.json'))
const GH_CMD = arg('--gh-cmd', 'gh') // split on whitespace; the tests point it at a stub
const START_LIMIT = Number(arg('--limit', '250'))
const fail = (m) => { console.error('[forma verify] ' + m); process.exit(1) }
const remove = (path) => { try { unlinkSync(path) } catch {} }
const publish = (outputs) => {
  const rows = outputs.map((output, i) => ({ ...output, temp: `${output.path}.forma-${process.pid}-${i}.tmp`, backup: `${output.path}.forma-${process.pid}-${i}.bak`, had: false, done: false }))
  try {
    for (const row of rows) { mkdirSync(dirname(row.path), { recursive: true }); remove(row.temp); remove(row.backup); writeFileSync(row.temp, row.text) }
    for (const row of rows) {
      if (existsSync(row.path)) { renameSync(row.path, row.backup); row.had = true }
      renameSync(row.temp, row.path); row.done = true
    }
    for (const row of rows) if (row.had) remove(row.backup)
  } catch (e) {
    for (const row of [...rows].reverse()) {
      if (row.done) remove(row.path)
      if (row.had && existsSync(row.backup)) { try { renameSync(row.backup, row.path) } catch {} }
      remove(row.temp)
    }
    throw e
  }
}

if (!Number.isSafeInteger(START_LIMIT) || START_LIMIT < 1) fail('--limit must be a positive integer (the initial adaptive fetch size).')
if (canonicalPath(MODEL) === canonicalPath(ISSUES)) fail('--model and --issues resolve to the same file; no fetch or write attempted.')

const model = existsSync(MODEL) ? JSON.parse(readFileSync(MODEL, 'utf-8')) : null
const GH_REPO = arg('--gh-repo', (model && model.meta && model.meta.ghRepo) || null)
if (!GH_REPO) fail('no target repo: pass --gh-repo <owner/repo>, or set meta.ghRepo in the topology.')

// Which nodes claim which issue — from issues[] and from verify.issue. Computed up front but
// NOT an early exit any more: the Control Room (`forma room`) reads live issue/milestone state
// even when no node cites a specific issue yet, so the gh call and the c4-issues.json snapshot
// always happen once a target repo is known.
const num = (v) => { const m = /^#?(\d+)$/.exec(String(v)); return m ? Number(m[1]) : null }
const refs = new Map()
for (const n of (model && model.nodes) || []) {
  const claimed = [...(n.issues || []), ...(n.verify && n.verify.issue != null ? [n.verify.issue] : [])]
  for (const raw of claimed) {
    const i = num(raw); if (!i) continue
    if (!refs.has(i)) refs.set(i, [])
    refs.get(i).push(n)
  }
}

// Fetch every issue, then match locally. `gh issue list` has no completeness marker, so a full page
// is retried at twice the limit until GitHub returns a short page. `--limit` is only the initial
// fetch size; callers no longer have to guess the repository's lifetime issue count.
const parts = String(GH_CMD).split(/\s+/).filter(Boolean)
let issues, limit = START_LIMIT
for (;;) {
  let raw
  try {
    // Node's 1 MiB default is too small here: 2,246 issues measured 1,079,693 bytes of JSON.
    // createdAt/closedAt are what make history derivable from ONE snapshot: the number of issues
    // open on any date is a count over these fields, with no persistent register (I4).
    raw = execFileSync(parts[0], [...parts.slice(1), 'issue', 'list', '--repo', GH_REPO, '--state', 'all', '--limit', String(limit), '--json', 'number,title,state,milestone,labels,createdAt,closedAt'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 64 })
  } catch (e) {
    const why = (e && e.code === 'ENOENT') ? `\`${parts[0]}\` not found — install the GitHub CLI or pass --gh-cmd`
      : (e && e.code === 'ENOBUFS') ? `\`${parts[0]}\` output exceeded the 64 MiB buffer`
        : String((e && (e.stderr || e.message)) || e).trim()
    console.error(`[forma verify] ${why}`)
    fail('complete fetch not proven; model (if present) and c4-issues.json left untouched.')
  }
  try { issues = JSON.parse(raw) } catch { fail(`unexpected output from \`${parts[0]}\` (wanted JSON): ${String(raw).slice(0, 160)}; files left untouched.`) }
  if (!Array.isArray(issues)) fail('unexpected output: expected a JSON array of {number,state}; files left untouched.')
  if (issues.length < limit) break
  if (limit > Number.MAX_SAFE_INTEGER / 2) fail('complete fetch not proven before the safe integer limit; files left untouched.')
  limit *= 2
  console.error(`[forma verify] ${issues.length} issue(s) filled --limit ${limit / 2}; retrying with ${limit}.`)
}

// Everything above this line can fail without touching disk (R2: writes only follow a fully
// parsed, complete fetch). From here on both outputs are written — the snapshot always, the model
// only if there was something to decorate — so a partial fetch can never be published.
const ts = new Date().toISOString()
const milestones = new Map()
for (const it of issues) {
  const ms = it.milestone; if (!ms || !ms.title) continue
  if (!milestones.has(ms.title)) milestones.set(ms.title, { title: ms.title, due: ms.dueOn || null, open: 0, closed: 0 })
  const m = milestones.get(ms.title)
  if (String(it.state || '').toUpperCase() === 'CLOSED') m.closed++; else m.open++
}
const snapshot = {
  fetchedAt: ts,
  ghRepo: GH_REPO,
  truncated: false,
  issues: issues.map((it) => ({
    n: Number(it.number), title: it.title || '', state: String(it.state || '').toUpperCase(),
    ms: (it.milestone && it.milestone.title) || null, labels: (it.labels || []).map((l) => l.name),
    // Dates are stored as the day, not the instant: the briefing buckets by day and a time of day
    // would be precision the reader cannot use and the gate would have to compare exactly.
    ...(it.createdAt ? { createdAt: String(it.createdAt).slice(0, 10) } : {}),
    ...(it.closedAt ? { closedAt: String(it.closedAt).slice(0, 10) } : {}),
  })),
  milestones: [...milestones.values()],
}
const snapshotErrors = validateModel(snapshot, new URL('./schema/c4-issues.schema.json', import.meta.url))
const seenNumbers = new Set(), duplicateNumbers = new Set()
for (const issue of snapshot.issues) { if (seenNumbers.has(issue.n)) duplicateNumbers.add(issue.n); seenNumbers.add(issue.n) }
if (snapshotErrors.length || duplicateNumbers.size) fail(`refusing invalid issue snapshot; files left untouched.${snapshotErrors.length ? '\n - ' + snapshotErrors.join('\n - ') : ''}${duplicateNumbers.size ? '\n - duplicate issue number(s): ' + [...duplicateNumbers].sort((a, b) => a - b).join(', ') : ''}`)
const snapshotText = JSON.stringify(snapshot, null, 2) + '\n'

if (!model || !refs.size) {
  try { publish([{ path: ISSUES, text: snapshotText }]) } catch (e) { fail(`could not publish snapshot atomically; previous file restored: ${(e && e.message) || e}`) }
  console.log(`[forma verify] ${GH_REPO}: snapshot written to ${ISSUES} (${issues.length} issue(s), ${milestones.size} milestone(s)).`)
  console.log(!model ? '[forma verify] no model — snapshot refreshed; nothing to decorate.' : '[forma verify] no issue references in the model — nothing to decorate (add issues[] via the status overlay).')
  process.exit(0)
}

const seen = new Set()
let closed = 0, decorated = 0
for (const it of issues) {
  const n = Number(it.number); seen.add(n)
  if (String(it.state || '').toUpperCase() !== 'CLOSED') continue
  const nodes = refs.get(n); if (!nodes) continue
  closed++
  for (const node of nodes) {
    // #43: a closed issue justifies a VERDICT, never a percentage. Writing completion = 100 here
    // was the widest path back to the defect this release exists to close: the number carried no
    // citation, so the publication gate - which grades provenance - waved it through as a
    // measurement. Nothing in forma measures completion; a closed issue least of all.
    node.status2 = 'done'
    delete node.completion
    // The badge shows statusWord when there is one, so a curated "NEXT"/"50%" would survive the
    // node turning green — a box claiming both at once. Marking done owns the badge too. It used
    // to own it by writing '100%', which put a percentage back on screen through the side door;
    // clearing the word lets the badge fall through to the verdict, which is what is known.
    if (node.statusWord) delete node.statusWord
    const mark = `(#${n} CLOSED` // re-running must not stack prefixes
    if (!String(node.current || '').includes(mark)) {
      node.current = `Closed with evidence ${mark}, gh ${ts}). ${String(node.current || '').trim()}`.trim()
      decorated++
    }
  }
}
const unknown = [...refs.keys()].filter((n) => !seen.has(n))

model.meta = model.meta || {}
model.meta.verifiedAt = ts // the ONE field only verify writes — gen must stay single-volatile (R2)
model.meta.verifyMethod = 'gh live'
try { publish([{ path: ISSUES, text: snapshotText }, { path: MODEL, text: JSON.stringify(model, null, 2) + '\n' }]) } catch (e) { fail(`could not publish snapshot and model atomically; previous files restored: ${(e && e.message) || e}`) }
console.log(`[forma verify] ${GH_REPO}: snapshot written to ${ISSUES} (${issues.length} issue(s), ${milestones.size} milestone(s)).`)
console.log(`[forma verify] ${GH_REPO}: ${refs.size} referenced issue(s), ${closed} closed → ${decorated} node(s) marked done`)
if (unknown.length) console.log(`[forma verify] not returned by gh (closed long ago or wrong repo): ${unknown.map((n) => '#' + n).join(', ')}`)
console.log(`[forma verify] fact base stamped ${ts} — structure untouched, \`forma check\` unaffected.`)
