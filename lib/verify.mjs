#!/usr/bin/env node
// forma verify — refresh programme status from LIVE GitHub issues, through the user's `gh` CLI.
// This is the ONLY command that touches the network, and it is opt-in: `gen` and `check` stay
// deterministic and offline forever (that is the product). It never touches structure — no nodes,
// no edges, no func — only the state fields of nodes that reference an issue.
// Usage: node verify.mjs [--repo <path>] [--model <path>] [--gh-repo <owner/repo>] [--gh-cmd <cmd>]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const MODEL = arg('--model', join(REPO, 'docs/architecture/c4-model.json'))
const ISSUES = arg('--issues', join(REPO, 'docs/architecture/c4-issues.json'))
const GH_CMD = arg('--gh-cmd', 'gh') // split on whitespace; the tests point it at a stub
const LIMIT = arg('--limit', '250')
const fail = (m) => { console.error('[forma verify] ' + m); process.exit(1) }

if (!existsSync(MODEL)) fail(`model missing: ${MODEL} — run \`forma gen\` first.`)
const model = JSON.parse(readFileSync(MODEL, 'utf-8'))
const GH_REPO = arg('--gh-repo', (model.meta && model.meta.ghRepo) || null)
if (!GH_REPO) fail('no target repo: pass --gh-repo <owner/repo>, or set meta.ghRepo in the topology.')

// Which nodes claim which issue — from issues[] and from verify.issue. Computed up front but
// NOT an early exit any more: the Control Room (`forma room`) reads live issue/milestone state
// even when no node cites a specific issue yet, so the gh call and the c4-issues.json snapshot
// always happen once a target repo is known.
const num = (v) => { const m = /^#?(\d+)$/.exec(String(v)); return m ? Number(m[1]) : null }
const refs = new Map()
for (const n of model.nodes || []) {
  const claimed = [...(n.issues || []), ...(n.verify && n.verify.issue != null ? [n.verify.issue] : [])]
  for (const raw of claimed) {
    const i = num(raw); if (!i) continue
    if (!refs.has(i)) refs.set(i, [])
    refs.get(i).push(n)
  }
}

// ONE call for every issue: state for the whole repo, then match locally. Wider fields than the
// node-decoration path needs (title/milestone/labels) because the Control Room snapshot is about
// the whole programme, not just the issues a node currently cites.
const parts = String(GH_CMD).split(/\s+/).filter(Boolean)
let raw
try {
  // Node's 1 MiB default is too small here: 2,246 issues measured 1,079,693 bytes of JSON.
  // createdAt/closedAt are what make history derivable from ONE snapshot: the number of issues open
  // on any date at or before the manifest's `today` is a count over these two fields, so "where we
  // were" needs no persistent register and no second fetch. The register this replaces was deleted
  // on purpose (0cda825); a stored series is a fact that survives regeneration, which I4 forbids.
  raw = execFileSync(parts[0], [...parts.slice(1), 'issue', 'list', '--repo', GH_REPO, '--state', 'all', '--limit', String(LIMIT), '--json', 'number,title,state,milestone,labels,createdAt,closedAt'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 64 })
} catch (e) {
  const why = (e && e.code === 'ENOENT') ? `\`${parts[0]}\` not found — install the GitHub CLI or pass --gh-cmd`
    : (e && e.code === 'ENOBUFS') ? `\`${parts[0]}\` output exceeded the 64 MiB buffer — reduce --limit or increase maxBuffer`
      : String((e && (e.stderr || e.message)) || e).trim()
  console.error(`[forma verify] ${why}`)
  fail('model and c4-issues.json left untouched.')
}
let issues
try { issues = JSON.parse(raw) } catch { fail(`unexpected output from \`${parts[0]}\` (wanted JSON): ${String(raw).slice(0, 160)}`) }
if (!Array.isArray(issues)) fail('unexpected output: expected a JSON array of {number,state}.')
// gh silently stops at --limit: measured runs returned 1200 of 1429 and 1200 of 2246 issues.
const truncated = issues.length >= Number(LIMIT)
if (truncated) console.error(`[forma verify] WARNING: likely truncated: --limit ${LIMIT} returned ${issues.length} issue(s); re-run with a higher --limit.`)

// Everything above this line can fail without touching disk (R2: writes only follow a fully
// parsed, validated fetch). From here on both outputs are written — the snapshot always, the
// model only if there was something to decorate — so a partial fetch can never leave a truncated
// c4-issues.json next to an untouched model.
const ts = new Date().toISOString()
const milestones = new Map()
for (const it of issues) {
  const ms = it.milestone; if (!ms || !ms.title) continue
  if (!milestones.has(ms.title)) milestones.set(ms.title, { title: ms.title, due: ms.dueOn || null, open: 0, closed: 0 })
  const m = milestones.get(ms.title)
  if (String(it.state || '').toUpperCase() === 'CLOSED') m.closed++; else m.open++
}
writeFileSync(ISSUES, JSON.stringify({
  fetchedAt: ts,
  ghRepo: GH_REPO,
  truncated,
  issues: issues.map((it) => ({
    n: Number(it.number), title: it.title || '', state: String(it.state || '').toUpperCase(),
    ms: (it.milestone && it.milestone.title) || null, labels: (it.labels || []).map((l) => l.name),
    // Dates are stored as the day, not the instant: the briefing buckets by day and a time of day
    // would be precision the reader cannot use and the gate would have to compare exactly.
    ...(it.createdAt ? { createdAt: String(it.createdAt).slice(0, 10) } : {}),
    ...(it.closedAt ? { closedAt: String(it.closedAt).slice(0, 10) } : {}),
  })),
  milestones: [...milestones.values()],
}, null, 2) + '\n')
console.log(`[forma verify] ${GH_REPO}: snapshot written to ${ISSUES} (${issues.length} issue(s), ${milestones.size} milestone(s)).`)

if (!refs.size) { console.log('[forma verify] no issue references in the model — nothing to decorate (add issues[] via the status overlay).'); process.exit(0) }

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
writeFileSync(MODEL, JSON.stringify(model, null, 2) + '\n')
console.log(`[forma verify] ${GH_REPO}: ${refs.size} referenced issue(s), ${closed} closed → ${decorated} node(s) marked done`)
if (unknown.length) console.log(`[forma verify] not returned by gh (closed long ago, wrong repo, or beyond --limit ${LIMIT}): ${unknown.map((n) => '#' + n).join(', ')}`)
console.log(`[forma verify] fact base stamped ${ts} — structure untouched, \`forma check\` unaffected.`)
