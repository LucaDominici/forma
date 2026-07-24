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
const GH_CMD = arg('--gh-cmd', 'gh') // split on whitespace; the tests point it at a stub
const LIMIT = arg('--limit', '250')
const fail = (m) => { console.error('[forma verify] ' + m); process.exit(1) }

if (!existsSync(MODEL)) fail(`model missing: ${MODEL} — run \`forma gen\` first.`)
const model = JSON.parse(readFileSync(MODEL, 'utf-8'))
const GH_REPO = arg('--gh-repo', (model.meta && model.meta.ghRepo) || null)
if (!GH_REPO) fail('no target repo: pass --gh-repo <owner/repo>, or set meta.ghRepo in the topology.')

// Which nodes claim which issue — from issues[] and from verify.issue.
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
if (!refs.size) { console.log('[forma verify] no issue references in the model — nothing to verify (add issues[] via the status overlay).'); process.exit(0) }

// ONE call for every issue: state for the whole repo, then match locally.
const parts = String(GH_CMD).split(/\s+/).filter(Boolean)
let raw
try {
  raw = execFileSync(parts[0], [...parts.slice(1), 'issue', 'list', '--repo', GH_REPO, '--state', 'all', '--limit', String(LIMIT), '--json', 'number,state'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  const why = (e && e.code === 'ENOENT') ? `\`${parts[0]}\` not found — install the GitHub CLI or pass --gh-cmd` : String((e && (e.stderr || e.message)) || e).trim()
  console.error(`[forma verify] ${why}`)
  fail('model left untouched.')
}
let issues
try { issues = JSON.parse(raw) } catch { fail(`unexpected output from \`${parts[0]}\` (wanted JSON): ${String(raw).slice(0, 160)}`) }
if (!Array.isArray(issues)) fail('unexpected output: expected a JSON array of {number,state}.')

const ts = new Date().toISOString()
const seen = new Set()
let closed = 0, decorated = 0
for (const it of issues) {
  const n = Number(it.number); seen.add(n)
  if (String(it.state || '').toUpperCase() !== 'CLOSED') continue
  const nodes = refs.get(n); if (!nodes) continue
  closed++
  for (const node of nodes) {
    node.status2 = 'done'; node.completion = 100
    // The badge shows statusWord when there is one, so a curated "NEXT"/"50%" would survive the
    // node turning green — a box claiming both at once. Marking done owns the badge too.
    if (node.statusWord) node.statusWord = '100%'
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
