#!/usr/bin/env node
// audit.mjs — the async on-demand audit channel behind c4-health.json / c4-findings.json.
// Same doctrine as lib/enrich.mjs's `--enricher agent`: emit a plan of prompts instead of calling
// an API (the agent driving forma already has the model in the room), then apply what comes
// back. `applyVerdicts` REJECTS a fill whose evidence does not resolve — "never a color without a
// why" is a gate rule here, not a suggestion (mirrors enrich.mjs's applyFills, which refuses to
// overwrite a documented node). No network in this file, ever.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkIssuesToNodes } from './link.mjs'
import { validateModel } from './validate.mjs'
import {
  auditDay, canonical, classifyClaimStaleness, classifyDependencyConfirmationStaleness, classifyVerdictStaleness,
  evidenceHashOrNull, evidenceIssueNumber, hashEvidence, issueRecords, milestoneRecord, resolveEvidencePath, sha256,
  signalRecord, validateEvidence, validDay,
} from './evidence.mjs'

// One prompt per issue that has no verdict yet. Names the C4 node(s) the git-linkage layer found
// for that issue, so the agent has somewhere to read before it writes — never asked to guess.
export function auditPlan(issuesSnapshot, linked, existingVerdicts, context = {}) {
  const byIssue = issueRecords(issuesSnapshot)
  const have = new Set((existingVerdicts || []).filter((verdict) => {
    if (!context.repo || !context.today) return true
    const evidenceHash = evidenceHashOrNull(context.repo, verdict.evidence, issuesSnapshot, `#${verdict.n}`)
    return byIssue.has(verdict.n) && classifyVerdictStaleness(verdict, byIssue.get(verdict.n), {
      today: context.today, staleAfterDays: context.staleAfterDays || 14, evidenceHash,
    }) === 'fresh'
  }).map((v) => v.n))
  // Only OPEN issues are audited: closure is a closed issue's state (the pill says "closed" and
  // that beats any verdict), and 2242 closed-issue prompts made a 1.5 MB plan nobody could read.
  return (issuesSnapshot.issues || [])
    .filter((it) => it.state === 'OPEN' && !have.has(it.n))
    .map((it) => ({ n: it.n, prompt: promptFor(it, [...(linked.byIssue.get(it.n) || [])]) }))
}

// Prose is only a candidate until an agent confirms it. The snapshot stays verify-owned; the
// confirmation lives in c4-health and is keyed by the candidate's deterministic fingerprint.
function dependencyPlan(issuesSnapshot, existingConfirmations, repo) {
  const edges = (((issuesSnapshot.dependencies || {}).edges) || [])
  const candidates = new Map(edges.filter((edge) => edge.source === 'prose').map((edge) => [edge.fingerprint, edge]))
  const have = new Set((existingConfirmations || []).filter((confirmation) => {
    if (!repo) return candidates.has(confirmation.fingerprint)
    const currentHash = evidenceHashOrNull(repo, confirmation.evidence, issuesSnapshot, `dependency ${confirmation.fingerprint}`)
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
export function counterPlan(model, issuesSnapshot, health, modelRef = 'docs/architecture/c4-model.json', humanLabels = [], brief = null) {
  const claims = []
  const gh = issuesSnapshot.ghRepo
  const fromEvidence = (e) => {
    if (['path', 'doc', 'adr', 'test', 'glob'].includes(e.type)) return { type: 'file', ref: e.ref }
    if (e.type === 'commit') return { type: 'commit', ref: e.ref }
    if (e.type === 'issue') return { type: 'gh', ref: `${gh}#${String(e.ref).replace(/^#/, '')}` }
    if (e.type === 'signal') return { type: 'gh', ref: `${gh}:signal:${e.ref}` }
    if (e.type === 'milestone') return { type: 'gh', ref: `${gh}:milestone:${e.ref}` }
    return { type: e.type, ref: e.ref }
  }
  // The brief is the layer that gets colour only under a hostile verdict, so every claim in it is
  // a counter-claim: "disprove this sentence at its own evidence".
  for (const claim of [...((brief && brief.claims) || [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    claims.push({ id: `brief:${claim.id}`, kind: 'brief-claim', claim: `[${claim.kind}] ${claim.text}`, where: claim.evidence.map(fromEvidence) })
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

function makeAuditPlan({ repo, issuesSnapshot, linked, health, model, modelRef, today, staleAfterDays = 14, humanLabels = [], brief = null }) {
  const core = {
    schemaVersion: '0.1',
    today,
    staleAfterDays,
    issues: auditPlan(issuesSnapshot, linked, health.verdicts, { repo, today, staleAfterDays }),
    dependencyCandidates: dependencyPlan(issuesSnapshot, health.dependencyConfirmations, repo),
    claims: counterPlan(model, issuesSnapshot, health, modelRef, humanLabels, brief),
    findingsPrompt: 'Report any contradiction not owned by an issue as a finding with severity, text and one resolvable evidence ref; otherwise return an empty findings array.',
    ...(brief ? { brief: briefPlan(brief, issuesSnapshot, repo, { today, staleAfterDays }) } : {}),
  }
  // `today` is carried for the agent to read but stays OUT of the identity of the plan: the plan
  // is about model, issues and health, not about the calendar. Otherwise every change of day would
  // invalidate a fill the agent has already written, and with it every counter-verdict.
  const { today: _today, ...identity } = core
  const planHash = sha256(JSON.stringify(canonical(identity)))
  return { ...core, planHash, output: { planHash, verdicts: [], dependencyConfirmations: [], findings: [], ...(brief ? { brief: { claims: [] } } : {}) } }
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
// Every field that makes two claim records the SAME claim, provenance aside (#123 R1): a fill that
// keeps the sentence but changes kind, severity, class/ifBroken or staleAfterDays is a rewrite, and
// must not keep an earlier author/verifier pair (and with it, a cross-engine hold that no longer
// describes what the claim now says).
const claimSemanticsEqual = (a, b) =>
  a.kind === b.kind && a.text === b.text && a.evidenceHash === b.evidenceHash &&
  a.severity === b.severity && a.class === b.class && a.ifBroken === b.ifBroken &&
  a.staleAfterDays === b.staleAfterDays && JSON.stringify(a.about) === JSON.stringify(b.about)

// ---- The brief: the judgement layer as claims -------------------------------------------------
// One thesis, at most five risks, at most five decisions: the caps are the reference dashboard's
// own discipline ("DECIDI TU: massimo 4-5 voci"), and they keep the hostile round small enough to
// be run on every update. Notes and invariants are uncapped: they carry no colour.
const BRIEF_CAPS = { thesis: 1, risk: 5, decide: 5 }
const BRIEF_KINDS = ['thesis', 'risk', 'decide', 'invariant', 'note']
const RECENT_COMMIT_DAYS = 30
const briefIndex = (brief) => new Map(((brief && brief.claims) || []).map((claim, i) => [claim.id, i]))

// The subject of a claim: what makes it stale when it moves. Resolved against the snapshot / repo.
function resolveAbout(repo, about, issuesSnapshot, label) {
  const keys = Object.keys(about || {})
  if (keys.length !== 1) throw new Error(`audit apply: ${label} about must name exactly one subject (issue|signal|milestone|path)`)
  const [key] = keys, value = about[key]
  if (key === 'issue') {
    if (!Number.isInteger(value) || !issueRecords(issuesSnapshot).has(value)) throw new Error(`audit apply: ${label} about.issue is not in the snapshot: ${value}`)
  } else if (key === 'signal') {
    try { signalRecord(issuesSnapshot, value) } catch (error) { throw new Error(`audit apply: ${label} about.${error.message}`) }
  } else if (key === 'milestone') {
    try { milestoneRecord(issuesSnapshot, value) } catch (error) { throw new Error(`audit apply: ${label} about.${error.message}`) }
  } else if (key === 'path') {
    try { resolveEvidencePath(repo, value) } catch (error) { throw new Error(`audit apply: ${label} about.path ${error.message}: ${value}`) }
  } else throw new Error(`audit apply: ${label} about has an unknown subject kind: ${key}`)
  return { [key]: value }
}

// A risk or a decision must rest on something that can move: an OPEN issue, a workflow/release
// record, a milestone, or a recent commit. A closed, quiescent issue (viafera: 1890 of them) or a
// README path would give the claim an anchor that never expires — which is no anchor at all.
function anchorCanMove(repo, evidence, issuesSnapshot, today) {
  return (evidence || []).some((e) => {
    if (e.type === 'signal' || e.type === 'milestone') return true
    if (e.type === 'issue') { const issue = issueRecords(issuesSnapshot).get(evidenceIssueNumber(e)); return Boolean(issue && issue.state === 'OPEN') }
    if (e.type === 'commit') {
      try {
        const day = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cs', '--end-of-options', `${e.ref}^{commit}`], { encoding: 'utf-8' }).trim()
        return validDay(day) && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000 <= RECENT_COMMIT_DAYS
      } catch { return false }
    }
    return false
  })
}

// What the plan asks the agent for: the missing kinds, and the claims that went stale. Caps travel
// with the prompts so the agent never writes what forma would then refuse.
function briefPlan(brief, issuesSnapshot, repo, { today, staleAfterDays = 14 } = {}) {
  const claims = (brief && brief.claims) || []
  const count = (kind) => claims.filter((claim) => claim.kind === kind).length
  const stale = []
  for (const claim of claims) {
    const evidenceHash = evidenceHashOrNull(repo, claim.evidence, issuesSnapshot, `brief ${claim.id}`)
    const reason = classifyClaimStaleness(claim, issuesSnapshot, { today, staleAfterDays, evidenceHash })
    if (reason !== 'fresh') stale.push({ id: claim.id, kind: claim.kind, reason })
  }
  const prompts = []
  const rule = 'Every claim needs `about` (its subject: {issue}|{signal}|{milestone}|{path}), and evidence that resolves in this repository or snapshot. A risk or a decision must cite at least one thing that can move: an OPEN issue, a `signal` (workflows/<id> | release), a `milestone`, or a commit from the last 30 days — a closed issue or a README path alone is refused. Do not invent; if you cannot anchor it, do not write it. Provenance (writtenAt, evidenceHash, verified) is stamped by forma, never by you.'
  if (!count('thesis')) prompts.push({ kind: 'thesis', prompt: `Write ONE sentence saying where this programme stands today, anchored to what the snapshot and the repository show. ${rule}` })
  if (count('risk') < BRIEF_CAPS.risk) prompts.push({ kind: 'risk', prompt: `List up to ${BRIEF_CAPS.risk - count('risk')} more risks (severity warn|bad), each with first-hand evidence. ${rule}` })
  if (count('decide') < BRIEF_CAPS.decide) prompts.push({ kind: 'decide', prompt: `List up to ${BRIEF_CAPS.decide - count('decide')} more decisions only a human can take now, ordered by how much each one unblocks, each actionable in one sentence. ${rule}` })
  prompts.push({ kind: 'invariant', prompt: `For each declared invariant you can locate, say how it is guarded: class MECCANIZZATO (a test or gate goes red), DOCUMENTATO (written, nothing checks it) or SCOPERTO (neither), and \`ifBroken\`: what falls if it falls. ${rule}` })
  if (stale.length) prompts.push({ kind: 'stale', prompt: `Re-check these claims: their subject or evidence moved, or they aged out. Rewrite, re-anchor, or retire them with {id, drop: true}: ${stale.map((entry) => `${entry.id} (${entry.reason})`).join(', ')}.` })
  return { caps: BRIEF_CAPS, counts: Object.fromEntries(BRIEF_KINDS.map((kind) => [kind, count(kind)])), stale, prompts }
}

// Validate + merge agent-written claims (upsert by id). A rewritten claim loses its previous
// verification: the verifier held a different sentence.
export function applyBrief(repo, existingBrief, fills, issuesSnapshot, context = {}) {
  const out = { claims: [...((existingBrief && existingBrief.claims) || [])] }
  let byId = briefIndex(out)
  const today = auditDay(context.today, 'brief apply')
  let applied = 0
  for (const f of fills || []) {
    const label = `brief ${f && f.id}`
    if (!f || typeof f.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(f.id)) throw new Error(`audit apply: brief claim has no valid id: ${JSON.stringify(f && f.id)}`)
    // A decision that has been taken, or a claim whose subject is gone, must be able to LEAVE the
    // brief: an upsert-only channel can only grow, which is the rot this layer exists to prevent.
    // Explicit (`drop: true`), never by omission — a partial fill must not silently empty the brief.
    if (f.drop === true) {
      if (!byId.has(f.id)) throw new Error(`audit apply: ${label} cannot be dropped: the brief holds no such claim`)
      out.claims.splice(byId.get(f.id), 1)
      byId = briefIndex(out)
      applied++
      continue
    }
    if (!BRIEF_KINDS.includes(f.kind)) throw new Error(`audit apply: ${label} kind must be ${BRIEF_KINDS.join('|')}, got ${JSON.stringify(f.kind)}`)
    if (!f.text || !String(f.text).trim()) throw new Error(`audit apply: ${label} has no text`)
    if (String(f.text).trim().length > 600) throw new Error(`audit apply: ${label} text exceeds 600 characters`)
    if (own(f, 'writtenAt') || own(f, 'evidenceHash') || own(f, 'verified') || own(f, 'author')) throw new Error(`audit apply: ${label} provenance is controlled by forma, not the fill`)
    if (own(f, 'severity') && !['ok', 'warn', 'bad'].includes(f.severity)) throw new Error(`audit apply: ${label} severity must be ok|warn|bad`)
    if (own(f, 'severity') && !['risk', 'invariant'].includes(f.kind)) throw new Error(`audit apply: ${label} only a risk or an invariant carries a severity`)
    if (f.kind === 'invariant' && (!['MECCANIZZATO', 'DOCUMENTATO', 'SCOPERTO'].includes(f.class) || !f.ifBroken || !String(f.ifBroken).trim())) throw new Error(`audit apply: ${label} an invariant needs class MECCANIZZATO|DOCUMENTATO|SCOPERTO and ifBroken (what falls if it falls)`)
    if (f.kind !== 'invariant' && (own(f, 'class') || own(f, 'ifBroken'))) throw new Error(`audit apply: ${label} class/ifBroken belong to invariants only`)
    if (own(f, 'staleAfterDays') && (!Number.isInteger(f.staleAfterDays) || f.staleAfterDays < 1)) throw new Error(`audit apply: ${label} staleAfterDays must be a positive integer`)
    if (!Array.isArray(f.evidence) || !f.evidence.length) throw new Error(`audit apply: ${label} has no evidence`)
    const about = resolveAbout(repo, f.about, issuesSnapshot, label)
    for (const e of f.evidence) validateEvidence(repo, e, label, issuesSnapshot)
    if ((f.kind === 'risk' || f.kind === 'decide') && !anchorCanMove(repo, f.evidence, issuesSnapshot, today)) throw new Error(`audit apply: ${label} a ${f.kind} needs an anchor that can move (open issue, signal, milestone or a commit from the last ${RECENT_COMMIT_DAYS} days) — a closed issue or a path alone never expires`)
    const cap = BRIEF_CAPS[f.kind]
    if (cap && !byId.has(f.id) && out.claims.filter((claim) => claim.kind === f.kind).length >= cap) throw new Error(`audit apply: ${label} the brief already holds ${cap} ${f.kind} claim(s); replace one by id or drop one`)
    const evidenceHash = hashEvidence(repo, f.evidence, issuesSnapshot, label)
    const rec = {
      id: f.id, kind: f.kind, text: String(f.text).trim(),
      ...(own(f, 'severity') ? { severity: f.severity } : {}),
      about,
      ...(f.kind === 'invariant' ? { class: f.class, ifBroken: String(f.ifBroken).trim() } : {}),
      evidence: f.evidence, writtenAt: today, evidenceHash,
      ...(own(f, 'staleAfterDays') ? { staleAfterDays: f.staleAfterDays } : {}),
      ...(context.engine ? { author: { engine: context.engine } } : {}),
    }
    const prior = byId.has(f.id) ? out.claims[byId.get(f.id)] : null
    // Unchanged content is not a rewrite: keep the original authorship and verification, whoever
    // resubmitted the identical fill. "Unchanged" means EVERY semantic field the claim carries —
    // kind, text, evidence, about, severity, invariant class/ifBroken, staleAfterDays — not just
    // text/evidence/about: a same-engine fill that keeps the sentence but changes severity, class
    // or staleAfterDays is a real rewrite and must not smuggle a stale cross-engine hold through on
    // an otherwise-untouched claim (#123 R1).
    if (prior && claimSemanticsEqual(prior, rec)) {
      if (prior.verified) rec.verified = prior.verified
      if (prior.author) rec.author = prior.author
    }
    if (prior) out.claims[byId.get(f.id)] = rec
    else { out.claims.push(rec); byId.set(f.id, out.claims.length - 1) }
    applied++
  }
  return { brief: out, applied }
}

// Validate + merge agent-written verdicts into the existing list (upsert by issue number).
function applyVerdicts(repo, existingVerdicts, fills, knownIssues, context = {}) {
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
function applyFindings(repo, existingFindings, fills, knownIssues, context = {}) {
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
  const signal = `${issuesSnapshot.ghRepo}:signal:`
  if (evidence.ref.startsWith(signal)) {
    const out = { type: 'signal', ref: evidence.ref.slice(signal.length) }
    validateEvidence(repo, out, 'counter result', issuesSnapshot)
    return out
  }
  throw new Error(`audit counter: gh evidence does not resolve in the snapshot: ${evidence.ref}`)
}

export function applyCounterResults(repo, issuesSnapshot, health, findings, plan, rawResult, context = {}) {
  const result = validateCounterResults(plan, rawResult)
  const known = new Set(issuesSnapshot.issues.map((it) => it.n))
  const existingVerdicts = health.verdicts
  const verdictFills = [], findingFills = []
  const ids = new Set(result.results.map((entry) => `counter:${entry.claimId}`))
  const keptFindings = (findings || []).filter((finding) => !ids.has(finding.id))
  const brief = context.brief ? { claims: [...context.brief.claims] } : null
  for (const entry of result.results) {
    const evidence = counterEvidence(repo, entry.evidence, issuesSnapshot)
    const issue = issueForClaim(entry.claimId)
    if (entry.claimId.startsWith('brief:')) {
      // The verdict lands ON the claim, with its own date: colour is granted only on a fresh
      // `holds`; contradicted / unsupported also become findings so the "does not add up" list
      // keeps them even after the claim itself is rewritten.
      const claimId = entry.claimId.slice('brief:'.length)
      const index = brief ? briefIndex(brief).get(claimId) : undefined
      if (index === undefined) throw new Error(`audit counter: ${entry.claimId} names a claim the brief no longer holds`)
      brief.claims[index] = { ...brief.claims[index], verified: { verdict: entry.verdict, reason: String(entry.reason).trim(), evidence, at: auditDay(context.today, 'audit counter'), ...(context.engine ? { engine: context.engine } : {}) } }
      if (entry.verdict !== 'holds') findingFills.push({ id: `counter:${entry.claimId}`, severity: entry.verdict === 'contradicted' ? 'bad' : 'warn', text: entry.reason, evidence, trace: 'azione' })
      continue
    }
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
      dependencyConfirmations: health.dependencyConfirmations || [],
    },
    findings: applyFindings(repo, keptFindings, findingFills, known, { ...context, issuesSnapshot }),
    brief,
    unanswered: result.unanswered,
  }
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  const fail = (m) => { console.error('[forma audit] ' + m); process.exit(1) }
  const opts = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], value = process.argv[i + 1]
    if (!['--repo', '--issues', '--model', '--model-ref', '--topology', '--health', '--findings', '--brief', '--plan', '--apply', '--audit-plan', '--counter-plan', '--today', '--stale-after-days', '--blocked-labels', '--engine'].includes(flag)) fail(`unknown option: ${flag}`)
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
    // The brief is opt-in by presence (I11): only a declared --brief path, or an existing file at
    // the default location, puts the judgement layer in play.
    brief: opts['--brief'] ? resolve(opts['--brief']) : (existsSync(join(arch, 'c4-brief.json')) ? join(arch, 'c4-brief.json') : null),
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
  const brief = paths.brief ? readOverlay(paths.brief, { claims: [] }) : null
  if (brief) validate(brief, 'c4-brief.schema.json', 'brief overlay fails c4-brief.schema.json')
  const known = new Set(issues.issues.map((issue) => issue.n))
  let linked = { byIssue: new Map() }
  const model = existsSync(paths.model) ? readJson(paths.model, 'model') : null
  if (model) validate(model, 'c4-model.schema.json', 'model fails c4-model.schema.json')
  if (model && existsSync(paths.topology)) linked = linkIssuesToNodes(repo, model, readJson(paths.topology, 'topology'))
  const currentPlan = () => makeAuditPlan({
    // An update may read a staged model, but the counter-plan is handed to a human/agent after
    // staging has gone away. Keep its evidence anchor on the logical, durable model path.
    repo, issuesSnapshot: issues, linked, health, model, modelRef: relative(repo, resolve(opts['--model-ref'] || paths.model)) || 'c4-model.json', today, staleAfterDays, humanLabels, brief,
  })

  if (opts['--plan']) {
    const plan = currentPlan()
    writeFileSync(resolve(opts['--plan']), JSON.stringify(plan, null, 2) + '\n')
    console.log(`[forma audit] wrote ${plan.issues.length} issue prompt(s)${plan.brief ? `, ${plan.brief.prompts.length} brief prompt(s) (${plan.brief.stale.length} stale claim(s))` : ''} and ${plan.claims.length} counter-claim(s) to ${resolve(opts['--plan'])}`)
  } else {
    const fill = readJson(resolve(opts['--apply']), 'audit fill')
    const planPath = opts['--audit-plan'] || opts['--counter-plan']
    if (!planPath) fail('--apply requires --audit-plan <path> (or --counter-plan for counter-verification)')
    const plan = readJson(resolve(planPath), 'audit plan')
    const freshPlan = currentPlan()
    if (!plan.planHash || plan.planHash !== freshPlan.planHash) fail('audit plan is stale for the current model, issues or health; regenerate it before apply')
    if (!fill || fill.planHash !== plan.planHash) fail('audit fill planHash does not match the current plan')
    const context = { today, issuesSnapshot: issues, engine: opts['--engine'] }
    // A fill is applied ITEM BY ITEM. What resolves is written; what does not is refused and named
    // in `lastApply.rejected` — one record, overwritten on every apply (its history is git), so
    // "how much of what the agent wrote did forma refuse" is a number the room can show instead
    // of an abort nobody sees. Refusing the whole fill for one bad row would hide the other rows
    // and leave no trace of the bad one.
    let nextHealth, nextFindings, unanswered = []
    let nextBrief = brief ? { claims: [...brief.claims] } : null
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
          const one = applyCounterResults(repo, issues, nextHealth, nextFindings.findings, plan, { planHash: fill.planHash, results: [entry] }, { ...context, brief: nextBrief })
          nextHealth = one.health; nextFindings = one.findings; if (one.brief) nextBrief = one.brief
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
      if (fill.brief && Array.isArray(fill.brief.claims)) {
        if (!nextBrief) fail('audit fill carries brief claims but no brief overlay is declared (--brief <path>)')
        for (const item of fill.brief.claims) {
          attempt('brief', item && item.id, () => { nextBrief = applyBrief(repo, nextBrief, [item], issues, context).brief })
        }
      }
    }
    nextHealth.lastApply = { at: today, accepted, rejected, ...(unanswered.length ? { unanswered } : {}) }
    validate(nextHealth, 'c4-health.schema.json', 'resulting health overlay fails c4-health.schema.json')
    validate(nextFindings, 'c4-findings.schema.json', 'resulting findings overlay fails c4-findings.schema.json')
    if (nextBrief) validate(nextBrief, 'c4-brief.schema.json', 'resulting brief overlay fails c4-brief.schema.json')
    writeFileSync(paths.health, JSON.stringify(nextHealth, null, 2) + '\n')
    writeFileSync(paths.findings, JSON.stringify(nextFindings, null, 2) + '\n')
    if (nextBrief) writeFileSync(paths.brief, JSON.stringify(nextBrief, null, 2) + '\n')
    for (const r of rejected) console.error(`[forma audit] rejected ${r.kind} ${r.ref}: ${r.reason}`)
    if (unanswered.length) console.error(`[forma audit] ${unanswered.length} claim(s) unanswered by the counter-verifier: ${unanswered.join(', ')}`)
    console.log(`[forma audit] wrote ${nextHealth.verdicts.length} health verdict(s), ${nextHealth.dependencyConfirmations.length} dependency confirmation(s), ${nextFindings.findings.length} finding(s)${nextBrief ? ` and ${nextBrief.claims.length} brief claim(s)` : ''}; accepted ${accepted}, rejected ${rejected.length}`)
    if (rejected.length && !accepted) process.exit(1)
  }
}
