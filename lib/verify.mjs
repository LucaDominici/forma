#!/usr/bin/env node
// forma verify — refresh programme facts from LIVE GitHub data, through the user's `gh` CLI.
// This is the ONLY snapshot writer and the only networked path used by the Control Room.
// Usage: node verify.mjs [--repo <path>] [--model <path>] [--issues <path>]
//   [--gh-repo <owner/repo>] [--gh-cmd <cmd>] [--workflow <id=path>]... [--release]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { classifyVerdictStaleness, hashEvidence } from './audit.mjs'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const has = (f) => process.argv.includes(f)
const REPO = arg('--repo', process.cwd())
const MODEL = arg('--model', join(REPO, 'docs/architecture/c4-model.json'))
const ISSUES = arg('--issues', join(REPO, 'docs/architecture/c4-issues.json'))
const GH_CMD = arg('--gh-cmd', 'gh') // split on whitespace; tests point it at a stub
const BODY_MAX_BYTES = Number(arg('--body-max-bytes', '65536'))
const HEALTH = arg('--health', null)
const TODAY = arg('--today', null)
const STALE_AFTER_DAYS = Number(arg('--stale-after-days', '14'))
const fail = (m) => { console.error('[forma verify] ' + m); process.exit(1) }
if (!Number.isSafeInteger(BODY_MAX_BYTES) || BODY_MAX_BYTES < 1) fail('--body-max-bytes must be a positive integer.')
if (!Number.isSafeInteger(STALE_AFTER_DAYS) || STALE_AFTER_DAYS < 1) fail('--stale-after-days must be a positive integer.')
const model = existsSync(MODEL) ? JSON.parse(readFileSync(MODEL, 'utf-8')) : null
const GH_REPO = arg('--gh-repo', (model && model.meta && model.meta.ghRepo) || null)
if (!/^[^/\s]+\/[^/\s]+$/.test(String(GH_REPO || ''))) fail('no target repo: pass --gh-repo <owner/repo>, or set meta.ghRepo in the topology.')
const WORKFLOWS = process.argv.flatMap((value, i) => value === '--workflow' ? [String(process.argv[i + 1] || '')] : []).map((value) => {
  const at = value.indexOf('='); return { id: value.slice(0, at), path: at < 0 ? '' : value.slice(at + 1) }
})
const RELEASE = has('--release')
for (const { id, path } of WORKFLOWS) if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !path.trim()) fail(`invalid --workflow declaration ${JSON.stringify(`${id}=${path}`)}.`)
if (new Set(WORKFLOWS.map(({ id }) => id)).size !== WORKFLOWS.length) fail('--workflow ids must be unique.')

const parts = String(GH_CMD).split(/\s+/).filter(Boolean)
const errorText = (e) => {
  const text = (e && e.code === 'ENOENT') ? `\`${parts[0]}\` not found — install the GitHub CLI or pass --gh-cmd`
    : (e && e.code === 'ENOBUFS') ? `\`${parts[0]}\` output exceeded the 64 MiB buffer`
      : String((e && (e.stderr || e.message)) || e).trim()
  return text.replace(/\s+/g, ' ').slice(0, 500)
}
const call = (args) => execFileSync(parts[0], [...parts.slice(1), ...args], {
  encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 64,
})
const json = (args) => {
  const raw = call(args)
  try { return JSON.parse(raw) } catch { throw new Error(`unexpected output from \`${parts[0]}\` (wanted JSON): ${String(raw).slice(0, 160)}`) }
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const endpointKey = (p) => `${p.repo}\u0000${p.number}`
const edgeKey = (from, to) => `${endpointKey(from)}\u0000${endpointKey(to)}`
const endpoint = (it, fallbackRepo = GH_REPO) => {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+(?:[/?#]|$)/.exec(String(it.url || ''))
  return {
    repo: (it.repository && it.repository.nameWithOwner) || (match && match[1]) || fallbackRepo,
    number: Number(it.number), url: it.url || `https://github.com/${fallbackRepo}/issues/${Number(it.number)}`,
    state: String(it.state || '').toUpperCase(),
  }
}
const validEndpoint = (value) => value && /^[^/\s]+\/[^/\s]+$/.test(value.repo) && Number.isSafeInteger(value.number) && value.number > 0 && /^https?:\/\//.test(value.url) && ['OPEN', 'CLOSED'].includes(value.state)

// `gh api graphql --paginate --slurp` is the completeness primitive: pageInfo, not a guessed
// issue-list limit, proves that every repository issue was returned. Dependency connections are
// intentionally capped at 50; their totalCount is retained as the per-relation truncation guard.
const query = (withDependencies) => `query($owner:String!,$name:String!,$endCursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number title state url createdAt updatedAt closedAt milestone{title dueOn}labels(first:100){nodes{name}}${withDependencies ? 'blockedBy(first:50){totalCount nodes{number state url repository{nameWithOwner}}}blocking(first:50){totalCount nodes{number state url repository{nameWithOwner}}}' : ''}}pageInfo{hasNextPage endCursor}}}}`
const [owner, name] = GH_REPO.split('/')
const fetchPages = (withDependencies) => json(['api', 'graphql', '--paginate', '--slurp', '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${query(withDependencies)}`])
let pages, dependenciesSupported = true, dependencyReason = ''
try {
  pages = fetchPages(true)
} catch (e) {
  dependencyReason = `GitHub dependency fields unavailable: ${errorText(e)}`
  dependenciesSupported = false
  console.error(`[forma verify] ${dependencyReason}`)
  try { pages = fetchPages(false) } catch (fallbackError) {
    console.error(`[forma verify] ${errorText(fallbackError)}`)
    fail('complete issue fetch not proven; model (if present) and c4-issues.json left untouched.')
  }
}
if (!Array.isArray(pages) || !pages.length) fail('unexpected GraphQL output: expected a non-empty --slurp page array; files left untouched.')
const issues = []
for (const page of pages) {
  const connection = page && page.data && page.data.repository && page.data.repository.issues
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) fail('unexpected GraphQL issue page; files left untouched.')
  issues.push(...connection.nodes)
}
const lastPage = pages[pages.length - 1].data.repository.issues.pageInfo
if (lastPage.hasNextPage !== false) fail('GraphQL pagination ended while pageInfo.hasNextPage was true; files left untouched.')
if (new Set(issues.map((it) => Number(it.number))).size !== issues.length) fail('GraphQL pagination returned duplicate issues; files left untouched.')
for (const it of issues) {
  if (!Number.isSafeInteger(Number(it.number)) || !it.updatedAt || !['OPEN', 'CLOSED'].includes(String(it.state).toUpperCase())) fail('GraphQL returned an issue with an invalid number, state or updatedAt; files left untouched.')
}

const byNumber = new Map(issues.map((it) => [Number(it.number), it]))
const nativeEdges = new Map()
let truncatedRelations = 0
for (const it of issues) {
  it.dependenciesComplete = dependenciesSupported
  if (!dependenciesSupported) continue
  const current = endpoint(it)
  for (const [field, direction] of [['blockedBy', 'out'], ['blocking', 'in']]) {
    const relation = it[field]
    if (!relation || !Array.isArray(relation.nodes) || !Number.isInteger(relation.totalCount)) {
      it.dependenciesComplete = false; truncatedRelations++; continue
    }
    if (relation.nodes.length < relation.totalCount) { it.dependenciesComplete = false; truncatedRelations++ }
    for (const node of relation.nodes) {
      const related = endpoint(node)
      if (!validEndpoint(related)) { it.dependenciesComplete = false; continue }
      const from = direction === 'out' ? current : related
      const to = direction === 'out' ? related : current
      nativeEdges.set(edgeKey(from, to), { from, to, source: 'native' })
    }
  }
}

// Bodies are deliberately a bounded second fetch: open issues plus closed local endpoints of a
// native relation. The snapshot stores citations and hashes, never the bodies themselves.
const scanNumbers = new Set(issues.filter((it) => String(it.state).toUpperCase() === 'OPEN').map((it) => Number(it.number)))
for (const edge of nativeEdges.values()) {
  if (edge.from.repo === GH_REPO && byNumber.has(edge.from.number)) scanNumbers.add(edge.from.number)
  if (edge.to.repo === GH_REPO && byNumber.has(edge.to.number)) scanNumbers.add(edge.to.number)
}
for (const it of issues) it.proseScanComplete = false
const proseEdges = new Map()
let accepted = 0, discarded = 0, ambiguous = 0, bodyBytes = 0
for (const n of [...scanNumbers].sort((a, b) => a - b)) {
  const it = byNumber.get(n)
  let body
  try {
    const value = json(['issue', 'view', String(n), '--repo', GH_REPO, '--json', 'body'])
    body = typeof value.body === 'string' ? value.body : null
    if (body == null) throw new Error('body field missing')
  } catch (e) {
    console.error(`[forma verify] #${n}: prose scan unavailable — ${errorText(e)}`)
    continue
  }
  const bytes = Buffer.byteLength(body); bodyBytes += bytes
  it.proseScanComplete = bytes <= BODY_MAX_BYTES
  const bodyHash = sha256(body)
  let used = 0
  const lines = body.split('\n')
  for (const [index, rawLine] of lines.entries()) {
    const lineBytes = Buffer.byteLength(rawLine) + (index < lines.length - 1 ? 1 : 0)
    if (used + lineBytes > BODY_MAX_BYTES) break
    used += lineBytes
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const statement = line.trim().replace(/^(?:(?:[-+>]|#{1,6})\s*)+/, '').replace(/\*\*/g, '')
    // Anchored at the start of a SENTENCE, not only of a line: "Part of epic #12 (…). Depends on
    // #34 (…)" is a common shape. Mid-sentence keywords ("not blocked by", "previously blocked by",
    // a quoted phrase) stay outside — the negatives in test/stub-gh.mjs guard that.
    const refs = new Set()
    for (const sentence of statement.split(/(?<=[.!?])\s+/)) {
      const match = /^(?:blocked by|blocc(?:ato|ata|ati|ate) da|depends on|dipende da)\s*:?\s+(.+)$/i.exec(sentence)
      if (!match) continue
      const refList = /^(#\d+(?:\s*(?:,|and|e|&|\/)\s*#\d+)*)\b/i.exec(match[1])
      if (!refList) { discarded++; continue }
      for (const m of refList[1].matchAll(/#(\d+)\b/g)) refs.add(Number(m[1]))
    }
    for (const targetNumber of refs) {
      if (targetNumber === n) { discarded++; continue }
      const targetIssue = byNumber.get(targetNumber)
      if (!targetIssue) { ambiguous++; continue }
      const from = endpoint(it), to = endpoint(targetIssue), quote = line.trim(), lineNumber = index + 1
      const fingerprint = sha256(`${edgeKey(from, to)}\u0000${bodyHash}\u0000${lineNumber}\u0000${quote}`)
      const candidate = { from, to, source: 'prose', quote, bodyHash, line: lineNumber, fingerprint }
      const key = edgeKey(from, to)
      if (nativeEdges.has(key) && !nativeEdges.get(key).bodyHash) { Object.assign(nativeEdges.get(key), { quote, bodyHash, line: lineNumber, fingerprint }); accepted++ }
      else if (nativeEdges.has(key)) discarded++
      else if (!proseEdges.has(key)) { proseEdges.set(key, candidate); accepted++ }
      else discarded++
    }
  }
}

const signalUnknown = (reason) => ({ state: 'unknown', reason: String(reason).replace(/\s+/g, ' ').slice(0, 500) })
const workflows = {}
for (const { id, path } of WORKFLOWS) {
  try {
    const runs = json(['run', 'list', '--repo', GH_REPO, `--workflow=${path}`, '--limit', '1', '--json', 'name,headBranch,headSha,event,status,conclusion,createdAt,url'])
    if (!Array.isArray(runs) || !runs[0]) workflows[id] = signalUnknown(`No run was returned for declared workflow ${path}.`)
    else {
      const run = runs[0]
      for (const field of ['name', 'headBranch', 'headSha', 'event', 'status', 'createdAt', 'url']) if (typeof run[field] !== 'string' || !run[field]) throw new Error(`run payload missing ${field}`)
      if (run.conclusion != null && typeof run.conclusion !== 'string') throw new Error('run payload has invalid conclusion')
      workflows[id] = {
        state: 'present', name: String(run.name || ''), path, headBranch: String(run.headBranch || ''),
        headSha: String(run.headSha || ''), event: String(run.event || ''), status: String(run.status || ''),
        conclusion: run.conclusion == null ? null : String(run.conclusion), createdAt: String(run.createdAt || ''), url: String(run.url || ''),
      }
    }
  } catch (e) { workflows[id] = signalUnknown(`gh run list failed for ${path}: ${errorText(e)}`) }
}

let release = { listState: 'unknown', reason: 'Release collection was not declared in the manifest.' }
if (RELEASE) {
  try {
    const listed = json(['release', 'list', '--repo', GH_REPO, '--limit', '1', '--exclude-drafts', '--json', 'tagName,publishedAt,isLatest,isDraft'])
    if (!Array.isArray(listed) || !listed[0] || !listed[0].tagName) throw new Error('no published release returned')
    const tag = String(listed[0].tagName)
    const viewed = json(['release', 'view', tag, '--repo', GH_REPO, '--json', 'tagName,publishedAt,url'])
    const commit = json(['api', `repos/${GH_REPO}/commits/${encodeURIComponent(tag)}`])
    if (!viewed || !viewed.url || !(viewed.publishedAt || listed[0].publishedAt) || !commit || !commit.sha || !(commit.commit && commit.commit.committer && commit.commit.committer.date) || !commit.html_url) throw new Error('release payload is missing required fields')
    release = {
      listState: 'present', tag, publishedAt: String(viewed.publishedAt || listed[0].publishedAt || ''), url: String(viewed.url || ''),
      resolvableTag: {
        name: tag, sha: String(commit.sha || ''), committedAt: String(commit.commit && commit.commit.committer && commit.commit.committer.date || ''),
        url: String(commit.html_url || `https://github.com/${GH_REPO}/commit/${commit.sha || ''}`),
      },
    }
  } catch (e) { release = { listState: 'unknown', reason: `Release signal unavailable: ${errorText(e)}` } }
}

const ts = new Date().toISOString()
const milestones = new Map()
for (const it of issues) {
  const ms = it.milestone; if (!ms || !ms.title) continue
  if (!milestones.has(ms.title)) milestones.set(ms.title, { title: ms.title, due: ms.dueOn || null, open: 0, closed: 0 })
  const m = milestones.get(ms.title)
  if (String(it.state).toUpperCase() === 'CLOSED') m.closed++; else m.open++
}
const dependenciesComplete = dependenciesSupported && issues.every((it) => it.dependenciesComplete)
const edges = [...nativeEdges.values(), ...proseEdges.values()].sort((a, b) => edgeKey(a.from, a.to).localeCompare(edgeKey(b.from, b.to)))
const unknownSignals = Object.values(workflows).filter((it) => it.state === 'unknown').length + (release.listState === 'unknown' ? 1 : 0)
const snapshot = {
  fetchedAt: ts, ghRepo: GH_REPO, truncated: false,
  collection: {
    pagination: 'gh api graphql --paginate --slurp', nativeEdges: nativeEdges.size, truncatedRelations,
    prose: { accepted, discarded, ambiguous, bodyBytes, maxBytesPerIssue: BODY_MAX_BYTES },
    signalsUnknown: unknownSignals, staleVerdicts: 0,
    milestonesComplete: false, milestonesReason: 'Milestones are derived from issue payloads; milestones with zero issues are not observable.',
    payloadBytes: 0,
  },
  dependencies: { supported: dependenciesSupported, complete: dependenciesComplete, edges, ...(dependencyReason ? { reason: dependencyReason } : {}) },
  signals: { workflows, release },
  issues: issues.map((it) => ({
    n: Number(it.number), title: it.title || '', state: String(it.state).toUpperCase(), url: it.url || `https://github.com/${GH_REPO}/issues/${it.number}`,
    ms: (it.milestone && it.milestone.title) || null, labels: ((it.labels && it.labels.nodes) || []).map((label) => label.name),
    updatedAt: String(it.updatedAt), dependenciesComplete: it.dependenciesComplete, proseScanComplete: it.proseScanComplete,
    ...(it.createdAt ? { createdAt: String(it.createdAt).slice(0, 10) } : {}),
    ...(it.closedAt ? { closedAt: String(it.closedAt).slice(0, 10) } : {}),
  })),
  milestones: [...milestones.values()],
}
if (HEALTH) {
  let health
  try { health = JSON.parse(readFileSync(HEALTH, 'utf-8')) } catch (e) { fail(`health overlay cannot be read for staleness collection: ${(e && e.message) || e}`) }
  const verdicts = (health && health.verdicts) || []
  if (!Array.isArray(verdicts)) fail('health overlay verdicts must be an array.')
  if (verdicts.length && !TODAY) fail('--today is required when --health carries verdicts.')
  const issueRecords = new Map(snapshot.issues.map((issue) => [issue.n, issue]))
  for (const verdict of verdicts) {
    const issue = issueRecords.get(verdict.n)
    let evidenceHash = null
    try { evidenceHash = hashEvidence(REPO, verdict.evidence, snapshot, `#${verdict.n}`) } catch {}
    if (!issue || classifyVerdictStaleness(verdict, issue, { today: TODAY, staleAfterDays: STALE_AFTER_DAYS, evidenceHash }) !== 'fresh') snapshot.collection.staleVerdicts++
  }
}
let payload
for (;;) {
  payload = JSON.stringify(snapshot, null, 2) + '\n'
  const bytes = Buffer.byteLength(payload)
  if (snapshot.collection.payloadBytes === bytes) break
  snapshot.collection.payloadBytes = bytes
}

// Every optional signal has already degraded to unknown. This is the single snapshot write.
mkdirSync(dirname(ISSUES), { recursive: true })
writeFileSync(ISSUES, payload)
console.log(`[forma verify] dependencies: supported=${dependenciesSupported}, complete=${dependenciesComplete}, native=${nativeEdges.size}, truncated relations=${truncatedRelations}.`)
console.log(`[forma verify] prose: accepted=${accepted}, discarded=${discarded}, ambiguous=${ambiguous}, body bytes=${bodyBytes}.`)
console.log(`[forma verify] health: stale verdicts=${snapshot.collection.staleVerdicts}.`)
for (const [id, signal] of Object.entries(workflows)) console.log(`[forma verify] workflow ${id}: ${signal.state}${signal.reason ? ` — ${signal.reason}` : ''}`)
console.log(`[forma verify] release: ${release.listState}${release.reason ? ` — ${release.reason}` : ''}`)
console.log(`[forma verify] signals: unknown=${unknownSignals}.`)
console.log(`[forma verify] ${GH_REPO}: snapshot written to ${ISSUES} (${issues.length} issue(s), ${milestones.size} milestone(s), ${snapshot.collection.payloadBytes} bytes).`)

if (!model) { console.log('[forma verify] no model — snapshot refreshed; nothing to decorate.'); process.exit(0) }

// Which nodes claim which issue — from issues[] and from verify.issue.
const num = (v) => { const m = /^#?(\d+)$/.exec(String(v)); return m ? Number(m[1]) : null }
const refs = new Map()
for (const node of model.nodes || []) {
  const claimed = [...(node.issues || []), ...(node.verify && node.verify.issue != null ? [node.verify.issue] : [])]
  for (const raw of claimed) {
    const n = num(raw); if (!n) continue
    if (!refs.has(n)) refs.set(n, [])
    refs.get(n).push(node)
  }
}
if (!refs.size) { console.log('[forma verify] no issue references in the model — nothing to decorate (add issues[] via the status overlay).'); process.exit(0) }

const seen = new Set()
let closed = 0, decorated = 0
for (const it of issues) {
  const n = Number(it.number); seen.add(n)
  if (String(it.state).toUpperCase() !== 'CLOSED') continue
  const nodes = refs.get(n); if (!nodes) continue
  closed++
  for (const node of nodes) {
    node.status2 = 'done'
    delete node.completion
    if (node.statusWord) delete node.statusWord
    const mark = `(#${n} CLOSED`
    if (!String(node.current || '').includes(mark)) {
      node.current = `Closed with evidence ${mark}, gh ${ts}). ${String(node.current || '').trim()}`.trim()
      decorated++
    }
  }
}
const unknown = [...refs.keys()].filter((n) => !seen.has(n))
model.meta = model.meta || {}
model.meta.verifiedAt = ts
model.meta.verifyMethod = 'gh live'
writeFileSync(MODEL, JSON.stringify(model, null, 2) + '\n')
console.log(`[forma verify] ${GH_REPO}: ${refs.size} referenced issue(s), ${closed} closed → ${decorated} node(s) marked done`)
if (unknown.length) console.log(`[forma verify] not returned by gh (closed long ago or wrong repo): ${unknown.map((n) => '#' + n).join(', ')}`)
console.log(`[forma verify] fact base stamped ${ts} — structure untouched, \`forma check\` unaffected.`)
