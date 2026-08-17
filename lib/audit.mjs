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

// One prompt per issue that has no verdict yet. Names the C4 node(s) the git-linkage layer found
// for that issue, so the agent has somewhere to read before it writes — never asked to guess.
export function auditPlan(issuesSnapshot, linked, existingVerdicts) {
  const have = new Set((existingVerdicts || []).map((v) => v.n))
  return (issuesSnapshot.issues || [])
    .filter((it) => !have.has(it.n))
    .map((it) => ({ n: it.n, prompt: promptFor(it, [...(linked.byIssue.get(it.n) || [])]) }))
}

// Claims the briefing asserts as true, separate from the issue-audit prompts above. The agent
// runner consumes this stable contract; producing it reads only committed files and snapshots.
export function counterPlan(model, issuesSnapshot, health, modelRef = 'docs/architecture/c4-model.json') {
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
  for (const issue of [...(issuesSnapshot.issues || [])].filter((it) => it.state === 'OPEN' && (it.labels || []).includes('needs-human')).sort((a, b) => a.n - b.n)) {
    claims.push({
      id: `issue:waiting-human:${issue.n}`, kind: 'waiting-human',
      claim: `Issue #${issue.n} is waiting on a human because it carries label "needs-human".`,
      where: [{ type: 'gh', ref: `${gh}#${issue.n}` }],
    })
  }
  return claims
}

function promptFor(issue, nodeIds) {
  const where = nodeIds.length
    ? `Touches C4 node(s): ${nodeIds.join(', ')}.`
    : `No commit citing #${issue.n} was found touching any modeled node — read the issue itself.`
  return `Audit issue #${issue.n} "${issue.title}" (${issue.state}, milestone ${issue.ms || '-'}).
${where}
Read the source at the node(s) above (or the issue thread) if you need certainty — do not guess.
Reply with a verdict in {ok, warn, bad}, a one-sentence "why", and at least one evidence ref you
can point to (a file path that exists in this repo, a commit sha that resolves, or the issue
number itself). A verdict with no resolvable evidence is rejected, not silently accepted.`
}

// Validate + merge agent-written verdicts into the existing list (upsert by issue number).
export function applyVerdicts(repo, existingVerdicts, fills, knownIssues) {
  const out = [...(existingVerdicts || [])]
  const byN = new Map(out.map((v, i) => [v.n, i]))
  let applied = 0
  for (const f of fills || []) {
    if (!f || !Number.isInteger(f.n)) throw new Error(`audit apply: fill missing integer "n": ${JSON.stringify(f)}`)
    if (knownIssues && !knownIssues.has(f.n)) throw new Error(`audit apply: verdict issue #${f.n} is not in the snapshot`)
    if (!['ok', 'warn', 'bad'].includes(f.verdict)) throw new Error(`audit apply: #${f.n} verdict must be ok|warn|bad, got ${JSON.stringify(f.verdict)}`)
    if (!f.why || !String(f.why).trim()) throw new Error(`audit apply: #${f.n} has no "why"`)
    if (!Array.isArray(f.evidence) || !f.evidence.length) throw new Error(`audit apply: #${f.n} has no evidence`)
    for (const e of f.evidence) {
      validateEvidence(repo, e, `#${f.n}`, knownIssues)
    }
    const rec = { n: f.n, verdict: f.verdict, why: String(f.why).trim(), evidence: f.evidence }
    if (byN.has(f.n)) out[byN.get(f.n)] = rec
    else { out.push(rec); byN.set(f.n, out.length - 1) }
    applied++
  }
  return { verdicts: out, applied }
}

export function applyFindings(repo, existingFindings, fills, knownIssues) {
  const out = [...(existingFindings || [])]
  const byId = new Map(out.map((f, i) => [f.id, i]))
  for (const f of fills || []) {
    if (!f || !f.id) throw new Error(`audit apply: finding missing "id": ${JSON.stringify(f)}`)
    validateEvidence(repo, f.evidence, `finding ${f.id}`, knownIssues)
    if (byId.has(f.id)) out[byId.get(f.id)] = f
    else { out.push(f); byId.set(f.id, out.length - 1) }
  }
  return { findings: out }
}

export function validateCounterResults(plan, result) {
  if (!result || !Array.isArray(result.results)) throw new Error('audit counter: agent output must contain results[]')
  const claims = plan.claims || [], byId = new Map()
  for (const entry of result.results) {
    if (!entry || !entry.claimId || byId.has(entry.claimId)) throw new Error(`audit counter: missing or duplicate claimId: ${JSON.stringify(entry && entry.claimId)}`)
    if (!['holds', 'contradicted', 'unsupported'].includes(entry.verdict)) throw new Error(`audit counter: ${entry.claimId} verdict must be holds|contradicted|unsupported`)
    if (!entry.reason || !String(entry.reason).trim()) throw new Error(`audit counter: ${entry.claimId} has no reason`)
    if (!entry.evidence || !['file', 'commit', 'gh'].includes(entry.evidence.type) || !entry.evidence.ref) throw new Error(`audit counter: ${entry.claimId} has no file|commit|gh evidence anchor`)
    byId.set(entry.claimId, entry)
  }
  const unknown = [...byId.keys()].filter((id) => !claims.some((claim) => claim.id === id))
  const missing = claims.filter((claim) => !byId.has(claim.id)).map((claim) => claim.id)
  if (unknown.length || missing.length) throw new Error(`audit counter: result does not match plan (unknown: ${unknown.join(', ') || '-'}; missing: ${missing.join(', ') || '-'})`)
  return { results: claims.map((claim) => byId.get(claim.id)) }
}

export function validateEvidence(repo, e, label, knownIssues) {
  if (!e || !e.type || !e.ref) throw new Error(`audit apply: ${label} evidence missing type/ref: ${JSON.stringify(e)}`)
  if (e.type === 'path') {
    const root = resolve(repo), target = resolve(root, e.ref), rel = relative(root, target)
    if (!rel || rel === '..' || rel.startsWith('../') || !existsSync(target)) throw new Error(`audit apply: ${label} evidence path does not exist in repo: ${e.ref}`)
  } else if (e.type === 'commit') {
    try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${e.ref}^{commit}`], { stdio: 'ignore' }) }
    catch { throw new Error(`audit apply: ${label} evidence commit does not resolve: ${e.ref}`) }
  } else if (e.type === 'issue') {
    const match = /^#?(\d+)$/.exec(String(e.ref))
    if (!match || (knownIssues && !knownIssues.has(Number(match[1])))) throw new Error(`audit apply: ${label} evidence issue does not resolve: ${e.ref}`)
  } else throw new Error(`audit apply: ${label} unknown evidence type "${e.type}"`)
}

function issueForClaim(id) {
  const match = /^(?:health:|issue:waiting-human:)(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

function counterEvidence(repo, evidence, issuesSnapshot, issuesPath) {
  if (evidence.type === 'file') {
    const out = { type: 'path', ref: evidence.ref }
    validateEvidence(repo, out, 'counter result', new Set(issuesSnapshot.issues.map((it) => it.n)))
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
    const ref = relative(resolve(repo), resolve(issuesPath))
    if (!ref || ref === '..' || ref.startsWith('../')) throw new Error('audit counter: milestone evidence snapshot is outside the repo')
    return { type: 'path', ref }
  }
  throw new Error(`audit counter: gh evidence does not resolve in the snapshot: ${evidence.ref}`)
}

export function applyCounterResults(repo, issuesSnapshot, issuesPath, health, findings, plan, rawResult) {
  const result = validateCounterResults(plan, rawResult)
  const known = new Set(issuesSnapshot.issues.map((it) => it.n))
  const verdictFills = [], findingFills = []
  const ids = new Set(result.results.map((entry) => `counter:${entry.claimId}`))
  const keptFindings = (findings || []).filter((finding) => !ids.has(finding.id))
  for (const entry of result.results) {
    if (entry.verdict === 'holds') continue
    const evidence = counterEvidence(repo, entry.evidence, issuesSnapshot, issuesPath)
    const issue = issueForClaim(entry.claimId)
    if (issue !== null) verdictFills.push({ n: issue, verdict: entry.verdict === 'contradicted' ? 'bad' : 'warn', why: entry.reason, evidence: [evidence] })
    findingFills.push({ id: `counter:${entry.claimId}`, severity: entry.verdict === 'contradicted' ? 'bad' : 'warn', text: entry.reason, evidence, trace: issue === null ? 'azione' : 'issue' })
  }
  return {
    health: { verdicts: applyVerdicts(repo, health || [], verdictFills, known).verdicts },
    findings: applyFindings(repo, keptFindings, findingFills, known),
  }
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  const fail = (m) => { console.error('[forma audit] ' + m); process.exit(1) }
  const opts = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], value = process.argv[i + 1]
    if (!['--repo', '--issues', '--model', '--topology', '--health', '--findings', '--plan', '--apply', '--counter-plan'].includes(flag)) fail(`unknown option: ${flag}`)
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`)
    opts[flag] = value
  }
  if (Boolean(opts['--plan']) === Boolean(opts['--apply'])) fail('choose exactly one of --plan <path> or --apply <path>')

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
  const health = readOverlay(paths.health, { verdicts: [] })
  const findings = readOverlay(paths.findings, { findings: [] })
  validate(health, 'c4-health.schema.json', 'health overlay fails c4-health.schema.json')
  validate(findings, 'c4-findings.schema.json', 'findings overlay fails c4-findings.schema.json')
  const known = new Set(issues.issues.map((issue) => issue.n))

  if (opts['--plan']) {
    let linked = { byIssue: new Map() }
    const model = existsSync(paths.model) ? readJson(paths.model, 'model') : null
    if (model) validate(model, 'c4-model.schema.json', 'model fails c4-model.schema.json')
    if (model && existsSync(paths.topology)) linked = linkIssuesToNodes(repo, model, readJson(paths.topology, 'topology'))
    const plan = {
      schemaVersion: '0.1',
      issues: auditPlan(issues, linked, health.verdicts),
      claims: counterPlan(model, issues, health, relative(repo, paths.model) || 'c4-model.json'),
      findingsPrompt: 'Report any contradiction not owned by an issue as a finding with severity, text and one resolvable evidence ref; otherwise return an empty findings array.',
      output: { verdicts: [], findings: [] },
    }
    writeFileSync(resolve(opts['--plan']), JSON.stringify(plan, null, 2) + '\n')
    console.log(`[forma audit] wrote ${plan.issues.length} issue prompt(s) to ${resolve(opts['--plan'])}`)
  } else {
    const fill = readJson(resolve(opts['--apply']), 'audit fill')
    let nextHealth, nextFindings
    try {
      if (fill && Array.isArray(fill.results)) {
        const plan = readJson(resolve(opts['--counter-plan'] || join(arch, 'audit-plan.json')), 'counter-verification plan')
        const applied = applyCounterResults(repo, issues, paths.issues, health.verdicts, findings.findings, plan, fill)
        nextHealth = applied.health; nextFindings = applied.findings
      } else {
        if (!fill || !Array.isArray(fill.verdicts) || !Array.isArray(fill.findings)) fail('audit fill must contain verdicts[] and findings[], or counter results[]')
        nextHealth = { verdicts: applyVerdicts(repo, health.verdicts, fill.verdicts, known).verdicts }
        nextFindings = applyFindings(repo, findings.findings, fill.findings, known)
      }
    } catch (e) { fail((e && e.message) || e) }
    validate(nextHealth, 'c4-health.schema.json', 'resulting health overlay fails c4-health.schema.json')
    validate(nextFindings, 'c4-findings.schema.json', 'resulting findings overlay fails c4-findings.schema.json')
    writeFileSync(paths.health, JSON.stringify(nextHealth, null, 2) + '\n')
    writeFileSync(paths.findings, JSON.stringify(nextFindings, null, 2) + '\n')
    console.log(`[forma audit] wrote ${nextHealth.verdicts.length} health verdict(s) and ${nextFindings.findings.length} finding(s)`)
  }
}
