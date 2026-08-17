// EXPERIMENTAL until #65 wires this seam into `forma audit`; no command calls it yet.
// audit.mjs — the async on-demand audit channel behind c4-health.json / c4-findings.json.
// Same doctrine as lib/enrich.mjs's `--enricher agent`: emit a plan of prompts instead of calling
// an API (the agent driving forma already has the model in the room), then apply what comes
// back. `applyVerdicts` REJECTS a fill whose evidence does not resolve — "never a color without a
// why" is a gate rule here, not a suggestion (mirrors enrich.mjs's applyFills, which refuses to
// overwrite a documented node). No network in this file, ever.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

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
export function applyVerdicts(repo, existingVerdicts, fills) {
  const out = [...(existingVerdicts || [])]
  const byN = new Map(out.map((v, i) => [v.n, i]))
  let applied = 0
  for (const f of fills || []) {
    if (!f || !Number.isInteger(f.n)) throw new Error(`audit apply: fill missing integer "n": ${JSON.stringify(f)}`)
    if (!['ok', 'warn', 'bad'].includes(f.verdict)) throw new Error(`audit apply: #${f.n} verdict must be ok|warn|bad, got ${JSON.stringify(f.verdict)}`)
    if (!f.why || !String(f.why).trim()) throw new Error(`audit apply: #${f.n} has no "why"`)
    if (!Array.isArray(f.evidence) || !f.evidence.length) throw new Error(`audit apply: #${f.n} has no evidence`)
    for (const e of f.evidence) {
      if (!e || !e.type || !e.ref) throw new Error(`audit apply: #${f.n} evidence missing type/ref: ${JSON.stringify(e)}`)
      if (e.type === 'path') {
        if (!existsSync(join(repo, e.ref))) throw new Error(`audit apply: #${f.n} evidence path does not exist: ${e.ref}`)
      } else if (e.type === 'commit') {
        try { execFileSync('git', ['-C', repo, 'cat-file', '-e', e.ref], { stdio: 'ignore' }) }
        catch { throw new Error(`audit apply: #${f.n} evidence commit does not resolve: ${e.ref}`) }
      } else if (e.type !== 'issue') {
        throw new Error(`audit apply: #${f.n} unknown evidence type "${e.type}"`)
      }
    }
    const rec = { n: f.n, verdict: f.verdict, why: String(f.why).trim(), evidence: f.evidence }
    if (byN.has(f.n)) out[byN.get(f.n)] = rec
    else { out.push(rec); byN.set(f.n, out.length - 1) }
    applied++
  }
  return { verdicts: out, applied }
}
