#!/usr/bin/env node
// audit.mjs — the async on-demand audit channel behind c4-health.json / c4-findings.json.
// Same doctrine as lib/enrich.mjs's `--enricher agent`: emit a plan of prompts instead of calling
// an API (the agent driving forma already has the model in the room), then apply what comes
// back. `applyVerdicts` REJECTS a fill whose evidence does not resolve — "never a color without a
// why" is a gate rule here, not a suggestion (mirrors enrich.mjs's applyFills, which refuses to
// overwrite a documented node). No network in this file, ever.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkIssuesToNodes } from './link.mjs'
import { validateModel } from './validate.mjs'

// One prompt per issue that has no verdict yet. Names the C4 node(s) the git-linkage layer found
// for that issue, so the agent has somewhere to read before it writes — never asked to guess.
export function auditPlan(issuesSnapshot, linked, existingVerdicts, context = {}) {
  const byIssue = issueRecords(issuesSnapshot)
  const have = new Set((existingVerdicts || []).filter((verdict) => {
    if (!context.repo || !context.today) return true
    let evidenceHash = null
    try { evidenceHash = hashEvidence(context.repo, verdict.evidence, issuesSnapshot, `#${verdict.n}`) } catch {}
    return byIssue.has(verdict.n) && classifyVerdictStaleness(verdict, byIssue.get(verdict.n), {
      today: context.today, staleAfterDays: context.staleAfterDays || 14, evidenceHash,
    }) === 'fresh'
  }).map((v) => v.n))
  return (issuesSnapshot.issues || [])
    .filter((it) => !have.has(it.n))
    .map((it) => ({ n: it.n, prompt: promptFor(it, [...(linked.byIssue.get(it.n) || [])]) }))
}

// Prose is only a candidate until an agent confirms it. The snapshot stays verify-owned; the
// confirmation lives in c4-health and is keyed by the candidate's deterministic fingerprint.
export function dependencyPlan(issuesSnapshot, existingConfirmations, repo) {
  const edges = (((issuesSnapshot.dependencies || {}).edges) || [])
  const candidates = new Map(edges.filter((edge) => edge.source === 'prose').map((edge) => [edge.fingerprint, edge]))
  const have = new Set((existingConfirmations || []).filter((confirmation) => {
    if (!repo) return candidates.has(confirmation.fingerprint)
    let currentHash = null
    try { currentHash = hashEvidence(repo, confirmation.evidence, issuesSnapshot, `dependency ${confirmation.fingerprint}`) } catch {}
    return classifyDependencyConfirmationStaleness(confirmation, candidates.get(confirmation.fingerprint), currentHash) === 'fresh'
  }).map((confirmation) => confirmation.fingerprint))
  return edges
    .filter((edge) => edge.source === 'prose' && edge.fingerprint && !have.has(edge.fingerprint))
    .sort((a, b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)
    .map((edge) => ({
      fingerprint: edge.fingerprint,
      candidate: edge,
      prompt: `Confirm or reject this prose dependency candidate. To confirm it, return its fingerprint and at least one current evidence ref: ${JSON.stringify(edge)}`,
    }))
}

// Claims the briefing asserts as true, separate from the issue-audit prompts above. The agent
// runner consumes this stable contract; producing it reads only committed files and snapshots.
export function counterPlan(model, issuesSnapshot, health, modelRef = 'docs/architecture/c4-model.json', humanLabels = []) {
  const claims = []
  const gh = issuesSnapshot.ghRepo
  const fromEvidence = (e) => {
    if (['path', 'doc', 'adr', 'test', 'glob'].includes(e.type)) return { type: 'file', ref: e.ref }
    if (e.type === 'commit') return { type: 'commit', ref: e.ref }
    if (e.type === 'issue') return { type: 'gh', ref: `${gh}#${String(e.ref).replace(/^#/, '')}` }
    return { type: e.type, ref: e.ref }
  }
  for (const node of [...((model && model.nodes) || [])].filter((n) => n.status2 === 'done').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const where = (node.evidence || []).map(fromEvidence)
    for (const issue of node.issues || []) {
      const match = /^#?(\d+)$/.exec(String(issue))
      if (match) where.push({ type: 'gh', ref: `${gh}#${match[1]}` })
    }
    if (!where.length) where.push({ type: 'file', ref: modelRef, selector: `node:${node.id}` })
    claims.push({ id: `node:done:${node.id}`, kind: 'done-node', claim: `Node "${node.name}" (${node.id}) is done.`, where })
  }
  for (const verdict of [...((health && health.verdicts) || [])].sort((a, b) => a.n - b.n)) {
    claims.push({
      id: `health:${verdict.n}`, kind: 'health-verdict',
      claim: `Issue #${verdict.n} health is ${verdict.verdict}: ${verdict.why}`,
      where: verdict.evidence.map(fromEvidence),
    })
  }
  for (const milestone of [...(issuesSnapshot.milestones || [])].sort((a, b) => a.title < b.title ? -1 : a.title > b.title ? 1 : 0)) {
    const total = milestone.open + milestone.closed
    const rate = total ? Math.round((100 * milestone.closed) / total) : null
    claims.push({
      id: `milestone:${milestone.title}`, kind: 'milestone-rate',
      claim: `Milestone "${milestone.title}" closure rate is ${rate === null ? 'unmeasured' : rate + '%'} (${milestone.closed} closed of ${total}).`,
      where: [{ type: 'gh', ref: `${gh}:milestone:${milestone.title}` }],
    })
  }
  const human = new Set(humanLabels)
  for (const issue of [...(issuesSnapshot.issues || [])].filter((it) => it.state === 'OPEN' && (it.labels || []).some((label) => human.has(label))).sort((a, b) => a.n - b.n)) {
    const labels = (issue.labels || []).filter((label) => human.has(label))
    claims.push({
      id: `issue:waiting-human:${issue.n}`, kind: 'waiting-human',
      claim: `Issue #${issue.n} is waiting on a human because it carries declared label(s) ${labels.map((label) => JSON.stringify(label)).join(', ')}.`,
      where: [{ type: 'gh', ref: `${gh}#${issue.n}` }],
    })
  }
  return claims
}

export function makeAuditPlan({ repo, issuesSnapshot, linked, health, model, modelRef, today, staleAfterDays = 14, humanLabels = [] }) {
  const core = {
    schemaVersion: '0.1',
    today,
    staleAfterDays,
    issues: auditPlan(issuesSnapshot, linked, health.verdicts, { repo, today, staleAfterDays }),
    dependencyCandidates: dependencyPlan(issuesSnapshot, health.dependencyConfirmations, repo),
    claims: counterPlan(model, issuesSnapshot, health, modelRef, humanLabels),
    findingsPrompt: 'Report any contradiction not owned by an issue as a finding with severity, text and one resolvable evidence ref; otherwise return an empty findings array.',
  }
  // `today` is carried for the agent to read but stays OUT of the identity of the plan: the plan
  // is about model, issues and health, not about the calendar. Otherwise every change of day would
  // invalidate a fill the agent has already written, and with it every counter-verdict.
  const { today: _today, ...identity } = core
  const planHash = sha256(JSON.stringify(canonical(identity)))
  return { ...core, planHash, output: { planHash, verdicts: [], dependencyConfirmations: [], findings: [] } }
}

function promptFor(issue, nodeIds) {
  const where = nodeIds.length
    ? `Touches C4 node(s): ${nodeIds.join(', ')}.`
    : `No commit citing #${issue.n} was found touching any modeled node — read the issue itself.`
  return `Audit issue #${issue.n} "${issue.title}" (${issue.state}, updated ${issue.updatedAt || '-'}, milestone ${issue.ms || '-'}).
${where}
Read the source at the node(s) above (or the issue thread) if you need certainty — do not guess.
Reply with a verdict in {ok, warn, bad}, a one-sentence "why", and at least one evidence ref you
can point to (a file path that exists in this repo, a commit sha that resolves, or the issue
number itself). A verdict with no resolvable evidence is rejected, not silently accepted.`
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
const issueRecords = (snapshot) => new Map(((snapshot && snapshot.issues) || (Array.isArray(snapshot) ? snapshot : [])).map((issue) => [issue.n, issue]))
const validDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
const auditDay = (today, label = 'audit apply') => {
  if (!validDay(today)) throw new Error(`${label}: today must be a real YYYY-MM-DD determinism anchor`)
  return today
}
const evidenceIssueNumber = (e) => {
  const match = /^#?(\d+)$/.exec(String(e.ref))
  return match ? Number(match[1]) : null
}

// Hash only the cited, current evidence: file bytes, the resolved commit, or the current issue
// record. Sorting makes evidence order immaterial; no whole-snapshot hash is involved.
export function hashEvidence(repo, evidence, issuesSnapshot, label = 'evidence') {
  const records = issueRecords(issuesSnapshot)
  const material = (evidence || []).map((e) => {
    const resolved = validateEvidence(repo, e, label, issuesSnapshot)
    if (e.type === 'path') {
      return { type: 'path', ref: resolved.ref, sha256: sha256(readFileSync(resolved.target)) }
    }
    if (e.type === 'commit') {
      const commit = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--end-of-options', `${e.ref}^{commit}`], { encoding: 'utf-8' }).trim()
      return { type: 'commit', commit }
    }
    if (e.type === 'signal') return { type: 'signal', ref: e.ref, record: signalRecord(issuesSnapshot, e.ref) }
    if (e.type === 'milestone') return { type: 'milestone', ref: e.ref, record: milestoneRecord(issuesSnapshot, e.ref) }
    const n = evidenceIssueNumber(e), issue = records.get(n)
    if (!issue) throw new Error(`audit apply: ${label} evidence issue has no current record: ${e.ref}`)
    return { type: 'issue', repo: issuesSnapshot && issuesSnapshot.ghRepo, issue }
  }).map(canonical).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  return sha256(JSON.stringify(material))
}

// Pure classifier. Callers recompute `evidenceHash` with hashEvidence; null means the evidence no
// longer resolves. Dates are compared at the manifest's declared day granularity.
export function classifyVerdictStaleness(verdict, issue, { today, staleAfterDays, evidenceHash } = {}) {
  const day = auditDay(today, 'audit staleness')
  const auditedAt = String((verdict && verdict.auditedAt) || '')
  if (!validDay(auditedAt)) return 'evidence-changed'
  if (auditedAt > day) return 'future'
  const changed = [issue && issue.closedAt, issue && issue.updatedAt].filter(Boolean).some((at) => String(at).slice(0, 10) > auditedAt)
  if (changed) return 'issue-changed'
  if (!evidenceHash || evidenceHash !== verdict.evidenceHash) return 'evidence-changed'
  if (!Number.isInteger(staleAfterDays) || staleAfterDays < 1) throw new Error('audit staleness: staleAfterDays must be a positive integer')
  const age = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${auditedAt}T00:00:00Z`)) / 86400000
  return age > staleAfterDays ? 'expired' : 'fresh'
}

export function classifyDependencyConfirmationStaleness(confirmation, candidate, evidenceHash) {
  if (!candidate || candidate.fingerprint !== confirmation.fingerprint) return 'candidate-changed'
  return evidenceHash && evidenceHash === confirmation.evidenceHash ? 'fresh' : 'evidence-changed'
}

// Validate + merge agent-written verdicts into the existing list (upsert by issue number).
export function applyVerdicts(repo, existingVerdicts, fills, knownIssues, context = {}) {
  const out = [...(existingVerdicts || [])]
  const byN = new Map(out.map((v, i) => [v.n, i]))
  let applied = 0
  for (const f of fills || []) {
    if (!f || !Number.isInteger(f.n)) throw new Error(`audit apply: fill missing integer "n": ${JSON.stringify(f)}`)
    if (knownIssues && !knownIssues.has(f.n)) throw new Error(`audit apply: verdict issue #${f.n} is not in the snapshot`)
    if (!['ok', 'warn', 'bad'].includes(f.verdict)) throw new Error(`audit apply: #${f.n} verdict must be ok|warn|bad, got ${JSON.stringify(f.verdict)}`)
    if (!f.why || !String(f.why).trim()) throw new Error(`audit apply: #${f.n} has no "why"`)
    if (!Array.isArray(f.evidence) || !f.evidence.length) throw new Error(`audit apply: #${f.n} has no evidence`)
    if (own(f, 'auditedAt') || own(f, 'evidenceHash')) throw new Error(`audit apply: #${f.n} provenance is controlled by forma, not the fill`)
    const auditedAt = auditDay(context.today)
    const evidenceHash = hashEvidence(repo, f.evidence, context.issuesSnapshot, `#${f.n}`)
    const rec = { n: f.n, verdict: f.verdict, why: String(f.why).trim(), evidence: f.evidence, auditedAt, evidenceHash }
    if (byN.has(f.n)) out[byN.get(f.n)] = rec
    else { out.push(rec); byN.set(f.n, out.length - 1) }
    applied++
  }
  return { verdicts: out, applied }
}

export function applyDependencyConfirmations(repo, existingConfirmations, fills, issuesSnapshot, context = {}) {
  const out = [...(existingConfirmations || [])], byFingerprint = new Map(out.map((confirmation, i) => [confirmation.fingerprint, i]))
  const candidates = new Map((((issuesSnapshot && issuesSnapshot.dependencies) || {}).edges || []).filter((edge) => edge.source === 'prose').map((edge) => [edge.fingerprint, edge]))
  let applied = 0
  for (const fill of fills || []) {
    if (!fill || !fill.fingerprint || !candidates.has(fill.fingerprint)) throw new Error(`audit apply: dependency confirmation fingerprint does not resolve: ${JSON.stringify(fill && fill.fingerprint)}`)
    if (!Array.isArray(fill.evidence) || !fill.evidence.length) throw new Error(`audit apply: dependency ${fill.fingerprint} has no evidence`)
    if (own(fill, 'confirmedAt') || own(fill, 'evidenceHash')) throw new Error(`audit apply: dependency ${fill.fingerprint} provenance is controlled by forma, not the fill`)
    const rec = {
      fingerprint: fill.fingerprint,
      confirmedAt: auditDay(context.today),
      evidenceHash: hashEvidence(repo, fill.evidence, issuesSnapshot, `dependency ${fill.fingerprint}`),
      evidence: fill.evidence,
    }
    if (byFingerprint.has(fill.fingerprint)) out[byFingerprint.get(fill.fingerprint)] = rec
    else { out.push(rec); byFingerprint.set(fill.fingerprint, out.length - 1) }
    applied++
  }
  return { dependencyConfirmations: out, applied }
}

// Findings carry the same provenance as verdicts (auditedAt + evidenceHash stamped by forma), so a
// finding can expire too. Findings derived by the document gate are re-derived on every run and
// carry no stamp: fresh by construction, which is why both fields stay optional in the schema.
export function applyFindings(repo, existingFindings, fills, knownIssues, context = {}) {
  const out = [...(existingFindings || [])]
  const byId = new Map(out.map((f, i) => [f.id, i]))
  for (const f of fills || []) {
    if (!f || !f.id) throw new Error(`audit apply: finding missing "id": ${JSON.stringify(f)}`)
    if (!['ok', 'warn', 'bad'].includes(f.severity)) throw new Error(`audit apply: finding ${f.id} severity must be ok|warn|bad, got ${JSON.stringify(f.severity)}`)
    if (!f.text || !String(f.text).trim()) throw new Error(`audit apply: finding ${f.id} has no text`)
    if (own(f, 'auditedAt') || own(f, 'evidenceHash')) throw new Error(`audit apply: finding ${f.id} provenance is controlled by forma, not the fill`)
    validateEvidence(repo, f.evidence, `finding ${f.id}`, context.issuesSnapshot || knownIssues)
    const rec = { id: f.id, severity: f.severity, text: String(f.text).trim(), evidence: f.evidence, ...(f.trace ? { trace: f.trace } : {}) }
    if (context.today) {
      rec.auditedAt = auditDay(context.today)
      rec.evidenceHash = hashEvidence(repo, [f.evidence], context.issuesSnapshot, `finding ${f.id}`)
    }
    if (byId.has(f.id)) out[byId.get(f.id)] = rec
    else { out.push(rec); byId.set(f.id, out.length - 1) }
  }
  return { findings: out }
}

// A finding's staleness has no issue subject: it expires by evidence and by age only.
export function classifyFindingStaleness(finding, { today, staleAfterDays, evidenceHash } = {}) {
  if (!own(finding, 'auditedAt') && !own(finding, 'evidenceHash')) return 'derived'
  return classifyVerdictStaleness(finding, null, { today, staleAfterDays, evidenceHash })
}

export function validateCounterResults(plan, result) {
  if (!result || !Array.isArray(result.results)) throw new Error('audit counter: agent output must contain results[]')
  if (!plan.planHash || result.planHash !== plan.planHash) throw new Error('audit counter: result planHash does not match the current plan')
  const claims = plan.claims || [], byId = new Map()
  for (const entry of result.results) {
    if (!entry || !entry.claimId || byId.has(entry.claimId)) throw new Error(`audit counter: missing or duplicate claimId: ${JSON.stringify(entry && entry.claimId)}`)
    if (!['holds', 'contradicted', 'unsupported'].includes(entry.verdict)) throw new Error(`audit counter: ${entry.claimId} verdict must be holds|contradicted|unsupported`)
    if (!entry.reason || !String(entry.reason).trim()) throw new Error(`audit counter: ${entry.claimId} has no reason`)
    if (!entry.evidence || !['file', 'commit', 'gh'].includes(entry.evidence.type) || !entry.evidence.ref) throw new Error(`audit counter: ${entry.claimId} has no file|commit|gh evidence anchor`)
    byId.set(entry.claimId, entry)
  }
  const unknown = [...byId.keys()].filter((id) => !claims.some((claim) => claim.id === id))
  if (unknown.length) throw new Error(`audit counter: result names claims the plan does not contain: ${unknown.join(', ')}`)
  // A claim the verifier did not answer is not an error: it simply gets no fresh verdict, so it
  // stays (or becomes) "not verified" on screen. Refusing the whole result for one unanswered
  // claim would turn every partial pass into no pass at all.
  const unanswered = claims.filter((claim) => !byId.has(claim.id)).map((claim) => claim.id)
  return { planHash: result.planHash, results: claims.filter((claim) => byId.has(claim.id)).map((claim) => byId.get(claim.id)), unanswered }
}

// A path evidence ref may end in `:<line>`. Try the whole string as a real path first, so a tracked
// file whose name itself ends in `:12` stays addressable. Only a missing literal path is split into
// file + line. The resolved target must remain inside the repository after following symlinks, and
// a line anchor must point to a line that actually exists in a regular file.
export function resolveEvidencePath(repo, ref) {
  const root = resolve(repo), raw = String(ref || '')
  const outside = (rel) => !rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
  let pathRef = raw, line = null, target = resolve(root, pathRef)
  if (!existsSync(target)) {
    const anchor = /^(.*):([1-9]\d*)$/.exec(raw)
    if (anchor) { pathRef = anchor[1]; line = Number(anchor[2]); target = resolve(root, pathRef) }
  }
  const rel = relative(root, target)
  if (outside(rel) || !existsSync(target)) throw new Error('path does not exist in repo')
  const realRoot = realpathSync(root), realTarget = realpathSync(target), realRel = relative(realRoot, realTarget)
  if (outside(realRel)) throw new Error('path does not exist in repo')
  if (line !== null) {
    let lines = 0
    try {
      if (!statSync(realTarget).isFile()) throw new Error('not a file')
      const text = readFileSync(realTarget, 'utf-8')
      lines = text.length ? (text.match(/\n/g) || []).length + (text.endsWith('\n') ? 0 : 1) : 0
    } catch { throw new Error('line does not resolve in file') }
    if (line > lines) throw new Error('line does not resolve in file')
  }
  const normalized = relative(realRoot, realTarget).split(sep).join('/')
  return { target: realTarget, ref: normalized + (line === null ? '' : `:${line}`), line }
}

// A whole workflow-run / release record, or a whole milestone record: like `issue`, the hash covers
// the record, so a new run (new headSha/createdAt) or a moved milestone marks the evidence changed.
// `conclusion` alone would read "success" for months — an anchor that never expires is no anchor.
const signalRecord = (snapshot, ref) => {
  const signals = (snapshot && snapshot.signals) || {}
  const match = /^workflows\/([^/]+)$/.exec(String(ref))
  const record = match ? (signals.workflows || {})[match[1]] : (ref === 'release' ? signals.release : null)
  if (!record) throw new Error(`signal is not in the snapshot: ${ref}`)
  if ((match ? record.state : record.listState) !== 'present') throw new Error(`signal is unknown in the snapshot: ${ref}`)
  return record
}
const milestoneRecord = (snapshot, ref) => {
  const record = ((snapshot && snapshot.milestones) || []).find((m) => m.title === String(ref))
  if (!record) throw new Error(`milestone is not in the snapshot: ${ref}`)
  return record
}

// `known` is either a Set of issue numbers (issue evidence only) or the issue snapshot itself,
// which is what `signal` and `milestone` evidence need to resolve against.
export function validateEvidence(repo, e, label, known) {
  if (!e || !e.type || !e.ref) throw new Error(`audit apply: ${label} evidence missing type/ref: ${JSON.stringify(e)}`)
  const knownIssues = known instanceof Set ? known : (known ? new Set(issueRecords(known).keys()) : null)
  const snapshot = known instanceof Set ? null : known
  if (e.type === 'path') {
    try { return resolveEvidencePath(repo, e.ref) }
    catch (error) { throw new Error(`audit apply: ${label} evidence ${error.message}: ${e.ref}`) }
  } else if (e.type === 'commit') {
    try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${e.ref}^{commit}`], { stdio: 'ignore' }) }
    catch { throw new Error(`audit apply: ${label} evidence commit does not resolve: ${e.ref}`) }
  } else if (e.type === 'issue') {
    const match = /^#?(\d+)$/.exec(String(e.ref))
    if (!match || (knownIssues && !knownIssues.has(Number(match[1])))) throw new Error(`audit apply: ${label} evidence issue does not resolve: ${e.ref}`)
  } else if (e.type === 'signal' || e.type === 'milestone') {
    if (!snapshot) throw new Error(`audit apply: ${label} evidence ${e.type} needs the issue snapshot to resolve: ${e.ref}`)
    try { (e.type === 'signal' ? signalRecord : milestoneRecord)(snapshot, e.ref) }
    catch (error) { throw new Error(`audit apply: ${label}: ${error.message}`) }
  } else throw new Error(`audit apply: ${label} unknown evidence type "${e.type}"`)
}

function issueForClaim(id) {
  const match = /^(?:health:|issue:waiting-human:)(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

function counterEvidence(repo, evidence, issuesSnapshot) {
  if (evidence.type === 'file') {
    const out = { type: 'path', ref: evidence.ref }
    validateEvidence(repo, out, 'counter result', issuesSnapshot)
    return out
  }
  if (evidence.type === 'commit') {
    const out = { type: 'commit', ref: evidence.ref }
    validateEvidence(repo, out, 'counter result')
    return out
  }
  const issue = new RegExp('^' + issuesSnapshot.ghRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '#(\\d+)$').exec(evidence.ref)
  if (issue && issuesSnapshot.issues.some((it) => it.n === Number(issue[1]))) return { type: 'issue', ref: issue[1] }
  const milestone = `${issuesSnapshot.ghRepo}:milestone:`
  if (evidence.ref.startsWith(milestone) && issuesSnapshot.milestones.some((m) => m.title === evidence.ref.slice(milestone.length))) {
    return { type: 'milestone', ref: evidence.ref.slice(milestone.length) }
  }
  throw new Error(`audit counter: gh evidence does not resolve in the snapshot: ${evidence.ref}`)
}

export function applyCounterResults(repo, issuesSnapshot, _issuesPath, health, findings, plan, rawResult, context = {}) {
  const result = validateCounterResults(plan, rawResult)
  const known = new Set(issuesSnapshot.issues.map((it) => it.n))
  const existingVerdicts = Array.isArray(health) ? health : health.verdicts
  const verdictFills = [], findingFills = []
  const ids = new Set(result.results.map((entry) => `counter:${entry.claimId}`))
  const keptFindings = (findings || []).filter((finding) => !ids.has(finding.id))
  for (const entry of result.results) {
    const evidence = counterEvidence(repo, entry.evidence, issuesSnapshot)
    const issue = issueForClaim(entry.claimId)
    if (entry.verdict === 'holds') {
      const prior = entry.claimId.startsWith('health:') && existingVerdicts.find((verdict) => verdict.n === issue)
      if (prior) verdictFills.push({ n: issue, verdict: prior.verdict, why: prior.why, evidence: [evidence] })
      continue
    }
    if (issue !== null) verdictFills.push({ n: issue, verdict: entry.verdict === 'contradicted' ? 'bad' : 'warn', why: entry.reason, evidence: [evidence] })
    findingFills.push({ id: `counter:${entry.claimId}`, severity: entry.verdict === 'contradicted' ? 'bad' : 'warn', text: entry.reason, evidence, trace: issue === null ? 'azione' : 'issue' })
  }
  return {
    health: {
      verdicts: applyVerdicts(repo, existingVerdicts, verdictFills, known, { ...context, issuesSnapshot }).verdicts,
      dependencyConfirmations: Array.isArray(health) ? (context.dependencyConfirmations || []) : (health.dependencyConfirmations || []),
    },
    findings: applyFindings(repo, keptFindings, findingFills, known, { ...context, issuesSnapshot }),
    unanswered: result.unanswered,
  }
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  const fail = (m) => { console.error('[forma audit] ' + m); process.exit(1) }
  const opts = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], value = process.argv[i + 1]
    if (!['--repo', '--issues', '--model', '--topology', '--health', '--findings', '--plan', '--apply', '--audit-plan', '--counter-plan', '--today', '--stale-after-days', '--blocked-labels'].includes(flag)) fail(`unknown option: ${flag}`)
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`)
    opts[flag] = value
  }
  if (Boolean(opts['--plan']) === Boolean(opts['--apply'])) fail('choose exactly one of --plan <path> or --apply <path>')
  let today
  try { today = auditDay(opts['--today']) } catch (e) { fail((e && e.message) || e) }
  const staleAfterDays = Number(opts['--stale-after-days'] || 14)
  if (!Number.isSafeInteger(staleAfterDays) || staleAfterDays < 1) fail('--stale-after-days must be a positive integer')
  let humanLabels = []
  try { humanLabels = JSON.parse(opts['--blocked-labels'] || '[]') } catch { fail('--blocked-labels must be a JSON array of strings') }
  if (!Array.isArray(humanLabels) || humanLabels.some((label) => typeof label !== 'string')) fail('--blocked-labels must be a JSON array of strings')

  const repo = resolve(opts['--repo'] || process.cwd()), arch = join(repo, 'docs/architecture')
  const path = (flag, fallback) => resolve(opts[flag] || join(arch, fallback))
  const paths = {
    issues: path('--issues', 'c4-issues.json'), model: path('--model', 'c4-model.json'), topology: path('--topology', 'c4-topology.json'),
    health: path('--health', 'c4-health.json'), findings: path('--findings', 'c4-findings.json'),
  }
  const readJson = (p, label) => { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch (e) { fail(`${label}: ${p} — ${(e && e.message) || e}`) } }
  const readOverlay = (p, empty) => existsSync(p) ? readJson(p, 'invalid overlay') : empty
  const validate = (obj, schema, label) => {
    const errors = validateModel(obj, new URL(`./schema/${schema}`, import.meta.url))
    if (errors.length) fail(`${label}:\n - ` + errors.join('\n - '))
  }
  const issues = readJson(paths.issues, 'issue snapshot')
  validate(issues, 'c4-issues.schema.json', 'issue snapshot fails c4-issues.schema.json')
  const health = readOverlay(paths.health, { verdicts: [], dependencyConfirmations: [] })
  const findings = readOverlay(paths.findings, { findings: [] })
  validate(health, 'c4-health.schema.json', 'health overlay fails c4-health.schema.json')
  validate(findings, 'c4-findings.schema.json', 'findings overlay fails c4-findings.schema.json')
  const known = new Set(issues.issues.map((issue) => issue.n))
  let linked = { byIssue: new Map() }
  const model = existsSync(paths.model) ? readJson(paths.model, 'model') : null
  if (model) validate(model, 'c4-model.schema.json', 'model fails c4-model.schema.json')
  if (model && existsSync(paths.topology)) linked = linkIssuesToNodes(repo, model, readJson(paths.topology, 'topology'))
  const currentPlan = () => makeAuditPlan({
    repo, issuesSnapshot: issues, linked, health, model, modelRef: relative(repo, paths.model) || 'c4-model.json', today, staleAfterDays, humanLabels,
  })

  if (opts['--plan']) {
    const plan = currentPlan()
    writeFileSync(resolve(opts['--plan']), JSON.stringify(plan, null, 2) + '\n')
    console.log(`[forma audit] wrote ${plan.issues.length} issue prompt(s) to ${resolve(opts['--plan'])}`)
  } else {
    const fill = readJson(resolve(opts['--apply']), 'audit fill')
    const planPath = opts['--audit-plan'] || opts['--counter-plan']
    if (!planPath) fail('--apply requires --audit-plan <path> (or --counter-plan for counter-verification)')
    const plan = readJson(resolve(planPath), 'audit plan')
    const freshPlan = currentPlan()
    if (!plan.planHash || plan.planHash !== freshPlan.planHash) fail('audit plan is stale for the current model, issues or health; regenerate it before apply')
    if (!fill || fill.planHash !== plan.planHash) fail('audit fill planHash does not match the current plan')
    const context = { today, issuesSnapshot: issues }
    // A fill is applied ITEM BY ITEM. What resolves is written; what does not is refused and named
    // in `lastApply.rejected` — one record, overwritten on every apply (its history is git), so
    // "how much of what the agent wrote did forma refuse" is a number the room can show instead
    // of an abort nobody sees. Refusing the whole fill for one bad row would hide the other rows
    // and leave no trace of the bad one.
    let nextHealth, nextFindings, unanswered = []
    const rejected = []
    let accepted = 0
    const attempt = (kind, ref, fn) => { try { fn(); accepted++ } catch (e) { rejected.push({ kind, ref: String(ref), reason: String((e && e.message) || e).replace(/^audit (?:apply|counter):\s*/, '') }) } }
    if (fill && Array.isArray(fill.results)) {
      // Counter results are validated as a set (planHash, unknown ids); each entry is then applied
      // through the same stamping code, and a bad anchor in one entry rejects only that entry.
      let perEntry = null
      try { perEntry = validateCounterResults(plan, fill) } catch (e) { fail((e && e.message) || e) }
      nextHealth = { verdicts: [...health.verdicts], dependencyConfirmations: [...health.dependencyConfirmations] }
      nextFindings = { findings: [...findings.findings] }
      unanswered = perEntry.unanswered
      for (const entry of perEntry.results) {
        attempt('counter', entry.claimId, () => {
          const one = applyCounterResults(repo, issues, paths.issues, nextHealth, nextFindings.findings, plan, { planHash: fill.planHash, results: [entry] }, context)
          nextHealth = one.health; nextFindings = one.findings
        })
      }
    } else {
      if (!fill || !Array.isArray(fill.verdicts) || !Array.isArray(fill.findings)) fail('audit fill must contain verdicts[] and findings[], or counter results[]')
      const plannedIssues = new Set((plan.issues || []).map((item) => item.n))
      const plannedDependencies = new Set((plan.dependencyCandidates || []).map((item) => item.fingerprint))
      nextHealth = { verdicts: [...health.verdicts], dependencyConfirmations: [...health.dependencyConfirmations] }
      nextFindings = { findings: [...findings.findings] }
      for (const item of fill.verdicts) {
        attempt('verdict', `#${item && item.n}`, () => {
          if (!plannedIssues.has(item.n)) throw new Error(`verdict #${item.n} was not in the plan`)
          nextHealth.verdicts = applyVerdicts(repo, nextHealth.verdicts, [item], known, context).verdicts
        })
      }
      for (const item of fill.dependencyConfirmations || []) {
        attempt('dependency', item && item.fingerprint, () => {
          if (!plannedDependencies.has(item.fingerprint)) throw new Error(`dependency ${item.fingerprint} was not in the plan`)
          nextHealth.dependencyConfirmations = applyDependencyConfirmations(repo, nextHealth.dependencyConfirmations, [item], issues, context).dependencyConfirmations
        })
      }
      for (const item of fill.findings) {
        attempt('finding', item && item.id, () => { nextFindings = applyFindings(repo, nextFindings.findings, [item], known, context) })
      }
    }
    nextHealth.lastApply = { at: today, accepted, rejected, ...(unanswered.length ? { unanswered } : {}) }
    validate(nextHealth, 'c4-health.schema.json', 'resulting health overlay fails c4-health.schema.json')
    validate(nextFindings, 'c4-findings.schema.json', 'resulting findings overlay fails c4-findings.schema.json')
    writeFileSync(paths.health, JSON.stringify(nextHealth, null, 2) + '\n')
    writeFileSync(paths.findings, JSON.stringify(nextFindings, null, 2) + '\n')
    for (const r of rejected) console.error(`[forma audit] rejected ${r.kind} ${r.ref}: ${r.reason}`)
    if (unanswered.length) console.error(`[forma audit] ${unanswered.length} claim(s) unanswered by the counter-verifier: ${unanswered.join(', ')}`)
    console.log(`[forma audit] wrote ${nextHealth.verdicts.length} health verdict(s), ${nextHealth.dependencyConfirmations.length} dependency confirmation(s) and ${nextFindings.findings.length} finding(s); accepted ${accepted}, rejected ${rejected.length}`)
    if (rejected.length && !accepted) process.exit(1)
  }
}
