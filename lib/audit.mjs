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

function validateEvidence(repo, e, label, knownIssues) {
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

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  const fail = (m) => { console.error('[forma audit] ' + m); process.exit(1) }
  const opts = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], value = process.argv[i + 1]
    if (!['--repo', '--issues', '--model', '--topology', '--health', '--findings', '--plan', '--apply'].includes(flag)) fail(`unknown option: ${flag}`)
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
    if (existsSync(paths.model) && existsSync(paths.topology)) linked = linkIssuesToNodes(repo, readJson(paths.model, 'model'), readJson(paths.topology, 'topology'))
    const plan = {
      schemaVersion: '0.1',
      issues: auditPlan(issues, linked, health.verdicts),
      findingsPrompt: 'Report any contradiction not owned by an issue as a finding with severity, text and one resolvable evidence ref; otherwise return an empty findings array.',
      output: { verdicts: [], findings: [] },
    }
    writeFileSync(resolve(opts['--plan']), JSON.stringify(plan, null, 2) + '\n')
    console.log(`[forma audit] wrote ${plan.issues.length} issue prompt(s) to ${resolve(opts['--plan'])}`)
  } else {
    const fill = readJson(resolve(opts['--apply']), 'audit fill')
    if (!fill || !Array.isArray(fill.verdicts) || !Array.isArray(fill.findings)) fail('audit fill must contain verdicts[] and findings[]')
    let nextHealth, nextFindings
    try {
      nextHealth = { verdicts: applyVerdicts(repo, health.verdicts, fill.verdicts, known).verdicts }
      nextFindings = applyFindings(repo, findings.findings, fill.findings, known)
    } catch (e) { fail((e && e.message) || e) }
    validate(nextHealth, 'c4-health.schema.json', 'resulting health overlay fails c4-health.schema.json')
    validate(nextFindings, 'c4-findings.schema.json', 'resulting findings overlay fails c4-findings.schema.json')
    writeFileSync(paths.health, JSON.stringify(nextHealth, null, 2) + '\n')
    writeFileSync(paths.findings, JSON.stringify(nextFindings, null, 2) + '\n')
    console.log(`[forma audit] applied ${fill.verdicts.length} verdict(s) and ${fill.findings.length} finding(s)`)
  }
}
