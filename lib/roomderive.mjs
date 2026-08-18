// roomderive.mjs — the ONLY place Control Room aggregates are computed. Imported by both
// `room.mjs` (which writes the numbers into window.__ROOM__.derived) and `check.mjs` (which
// recomputes them from the same raw inputs and compares against what room wrote). If they ever
// disagreed the gate would prove nothing — see ADR-0004 and PLAN.md's roomderive contract.
// Pure functions only: no fs, no network, no Date.now() (determinism anchor is manifest.today).
import { execFileSync } from 'node:child_process'
import { detectFamilies, valueFor } from './taxonomy.mjs'
import { linkIssuesToNodes, coverageOf } from './link.mjs'
import { deriveRtm, parseCapabilityVerification } from './rtm.mjs'
import { parseCapabilities } from './docmap.mjs'
import { rtmFor } from './roomload.mjs'
import { classifyClaimStaleness, classifyDependencyConfirmationStaleness, classifyFindingStaleness, classifyVerdictStaleness, classifyVerification, hashEvidence } from './audit.mjs'

const isOpen = (it) => it.state === 'OPEN'

// Compare civil dates, never instants. GitHub supplies fetchedAt as an instant while `today` is a
// manifest date; subtracting them directly made a snapshot captured later on `today` read -1 day
// old. Invalid dates stay unknown instead of leaking NaN into the briefing.
export function daysBetween(a, b) {
  const day = (value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''))
    if (!m) return null
    const y = Number(m[1]), month = Number(m[2]), d = Number(m[3])
    const at = Date.UTC(y, month - 1, d), date = new Date(at)
    return date.getUTCFullYear() === y && date.getUTCMonth() === month - 1 && date.getUTCDate() === d ? at : null
  }
  const from = day(a), to = day(b)
  return from === null || to === null ? null : (to - from) / 86400000
}

// The document gate consumes only facts extracted by roomdocs. It never opens a file, guesses a
// command from prose, or treats a token occurrence as proof: only an invariant-specific pattern
// matched in its declared registry can establish wiring. Freshness is advisory; only a
// missing/contradicted enforcement fact is bad. Each parsed invariant yields one strict
// c4-findings row plus the richer rendering row.
export function documentGate(gateInputs, today) {
  if (!gateInputs) return null
  const rows = [], errors = [...(gateInputs.errors || [])]
  const seen = new Map()
  for (const document of gateInputs.documents || []) {
    if (document.reason) { errors.push({ path: document.path, field: 'document', reason: document.reason }); continue }
    for (const invariant of document.invariants || []) {
      const count = (seen.get(invariant.id) || 0) + 1
      seen.set(invariant.id, count)
      const id = count === 1 ? `document-gate:${invariant.id}` : `document-gate:${invariant.id}@${invariant.line}:${count}`
      const tokens = [...new Set((invariant.claims || []).flatMap((claim) => claim.tokens || []))]
      const wiring = (gateInputs.wiring || []).filter((entry) => entry.invariant === invariant.id)
      const matched = wiring.filter((entry) => entry.resolved).map((entry) => `${entry.registry}:${entry.line}`)
      let severity = 'warn', reason = 'documented-only'
      if (!(invariant.claims || []).length) reason = 'no-enforcement-claim'
      else if (!tokens.length) reason = 'prose-only'
      else if (!wiring.length) reason = 'registry-not-mapped'
      else if (matched.length < wiring.length) { severity = 'bad'; reason = 'wiring-missing' }
      else { severity = 'ok'; reason = 'wired' }
      const at = (invariant.claims[0] || invariant).line
      rows.push({ id, severity, invariant: invariant.id, heading: invariant.heading, reason, tokens, matched, evidence: { type: 'path', ref: `${document.path}:${at}` } })
    }
  }
  const freshness = []
  for (const rule of gateInputs.freshness || []) for (const path of rule.paths || []) {
    const document = (gateInputs.documents || []).find((entry) => entry.path === path)
    const meta = (document && document.metadata) || []
    const status = meta.find((entry) => entry.key.toLowerCase() === 'status')
    const statusDate = status && /(\d{4}-\d{2}-\d{2})/.exec(status.value)
    const review = meta.find((entry) => entry.key.toLowerCase() === 'last_review') || meta.find((entry) => entry.key.toLowerCase() === 'date') || (statusDate && { ...status, value: statusDate[1] })
    const validReview = review && /^\d{4}-\d{2}-\d{2}$/.test(review.value) && daysBetween(review.value, review.value) === 0
    const at = validReview ? review.value : (!review && document && document.lastChangedAt ? document.lastChangedAt.slice(0, 10) : null)
    const ageDays = at ? daysBetween(at, today) : null
    const reason = review && !validReview ? 'date-invalid' : (ageDays === null ? 'date-unknown' : (ageDays < 0 ? 'date-future' : (ageDays > rule.staleAfterDays ? 'stale' : 'fresh')))
    freshness.push({ id: rule.id, path, at, ageDays, staleAfterDays: rule.staleAfterDays, verdict: reason === 'fresh' ? 'ok' : 'warn', reason, evidence: { type: 'path', ref: `${path}:${(review && review.line) || 1}` } })
  }
  const findings = rows.map((row) => ({ id: row.id, severity: row.severity, text: `${row.invariant}: ${row.reason}; declared ${row.tokens.length}, measured ${row.matched.length}`, evidence: row.evidence }))
  const claims = (gateInputs.claims || []).map((claim) => ({ ...claim, verdict: claim.resolved ? 'ok' : 'bad', evidence: { type: 'path', ref: `${claim.path}:${claim.line || 1}` } }))
  return { rows, findings, claims, freshness, errors, summary: { ok: rows.filter((row) => row.severity === 'ok').length, warn: rows.filter((row) => row.severity === 'warn').length, bad: rows.filter((row) => row.severity === 'bad').length + claims.filter((claim) => claim.verdict === 'bad').length + errors.length, stale: freshness.filter((entry) => entry.verdict === 'warn').length } }
}

// KPI line for `exec` — every number here must be ri-derivabile: no field here is ever a
// declaration, only a count over raw facts.
export function deriveKpis(issuesSnapshot, linkedCoverage, manifest) {
  const open = issuesSnapshot.issues.filter(isOpen)
  const humanLabels = new Set(((manifest.blockedBy || {}).labels) || [])
  const needsHuman = manifest.blockedBy === undefined ? null : open.filter((it) => it.labels.some((label) => humanLabels.has(label))).length
  const staleMilestones = issuesSnapshot.milestones.filter((m) => m.due && m.open > 0 && daysBetween(m.due, manifest.today) > 0)
  const noMilestone = open.filter((it) => !it.ms)
  return {
    openCount: open.length,
    needsHumanCount: needsHuman,
    snapshotAgeDays: daysBetween(issuesSnapshot.fetchedAt, manifest.today),
    staleMilestones: staleMilestones.map((m) => ({ title: m.title, daysLate: daysBetween(m.due, manifest.today) })),
    noMilestoneCount: noMilestone.length,
    // No map means the issue->node question was never asked, which is not the same claim as "asked
    // and nothing matched" (I6). A programme participating through issues alone reports null here.
    linkCoveragePct: linkedCoverage ? linkedCoverage.pct : null,
  }
}

// WBS: milestone -> issues, % = closed/(open+closed). Never invented for a milestone with 0
// issues — closureRate is null there, not a divide-by-zero 0 or a fake 100.
export function deriveMilestones(issuesSnapshot) {
  return issuesSnapshot.milestones.map((m) => {
    const total = m.open + m.closed
    return { ...m, closureRate: total ? Math.round((100 * m.closed) / total) : null }
  }).sort((a, b) => b.open + b.closed - (a.open + a.closed))
}

// Where we were, from ONE snapshot. An issue is open on day D when it was created on or before D
// and not closed on or before D — so the whole series is a count over createdAt/closedAt, needing
// no persistent register (I4) and no second fetch. The clock stays the manifest's `today` (I12).
//
// Returns null, not an empty series, when the snapshot predates those fields: "this snapshot cannot
// answer" and "nothing happened" are different claims, and only one of them is true (I6/I7).
export function deriveHistory(issuesSnapshot, today, maxPoints = 24) {
  const issues = issuesSnapshot.issues || []
  const dated = issues.filter((it) => it.createdAt)
  if (!dated.length) return null
  const unplaceable = dated.filter((it) => it.state === 'CLOSED' && !it.closedAt).length
  const placeable = dated.filter((it) => it.state !== 'CLOSED' || it.closedAt)
  if (!placeable.length) return { points: [], unplaceable, counted: 0, total: issues.length }
  // The window starts when the first issue was opened, not a fixed number of months back: padding
  // the left edge with months in which the programme did not yet exist draws a long flat run that
  // reads as stagnation. Capped so a decade-old repository stays a chart and not a hairline.
  const earliest = placeable.reduce((min, it) => (it.createdAt < min ? it.createdAt : min), placeable[0].createdAt)
  const first = new Date(earliest + 'T00:00:00Z'), last = new Date(today + 'T00:00:00Z')
  const span = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + (last.getUTCMonth() - first.getUTCMonth()) + 1
  const months = Math.max(2, Math.min(maxPoints, span))
  // A CLOSED issue with no closedAt cannot be placed in time. Counting it as closed-forever would
  // bend the curve down at the left edge; counting it as open would bend it up. It is excluded and
  // named instead (I9).
  const end = new Date(today + 'T00:00:00Z')
  const points = []
  for (let back = months - 1; back >= 0; back--) {
    const at = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - back + 1, 0))
    const day = at > end ? today : at.toISOString().slice(0, 10)
    let open = 0, closed = 0, created = 0
    for (const it of placeable) {
      if (it.createdAt > day) continue
      created++
      if (it.closedAt && it.closedAt <= day) closed++; else open++
    }
    points.push({ at: day, open, closed, created })
  }
  return { points, unplaceable, counted: placeable.length, total: issues.length }
}

// Kanban buckets. Precedence is a hard fact first, then an audited verdict, then a status label,
// never guessed: CLOSED state > c4-health verdict > needs-human label > unaudited.
// bucket vocabulary is a DECLARED mapping (docs/SCOPE-room.md §5.3), not invented per issue:
//   sane=ok  a-meta=warn  premessa-falsa=bad  aspettano-umano=needs-human label  chiuse=CLOSED
export function deriveKanban(issuesSnapshot, healthVerdicts, humanLabels = []) {
  const verdictByN = new Map((healthVerdicts || []).map((v) => [v.n, v]))
  const human = new Set(humanLabels)
  const buckets = { chiuse: [], sane: [], 'a-meta': [], 'premessa-falsa': [], 'aspettano-umano': [], 'non-auditate': [] }
  for (const it of issuesSnapshot.issues) {
    if (it.state === 'CLOSED') { buckets.chiuse.push(it.n); continue }
    const v = verdictByN.get(it.n)
    if (v) { buckets[{ ok: 'sane', warn: 'a-meta', bad: 'premessa-falsa' }[v.verdict]].push(it.n); continue }
    if (it.labels.some((label) => human.has(label))) { buckets['aspettano-umano'].push(it.n); continue }
    buckets['non-auditate'].push(it.n)
  }
  return buckets
}

// `auto`: open issues clustered by the auto-detected `priority`-like family (if present) and by
// every other detected family, sorted by that family's dominant value. No curated file required —
// this derives the queue; c4-blocks.json (if it ever exists) only overrides individual entries.
export function deriveQueue(issuesSnapshot, taxonomyOpts) {
  const open = issuesSnapshot.issues.filter(isOpen)
  const allLabels = issuesSnapshot.issues.flatMap((it) => it.labels)
  const { axes, other } = detectFamilies(allLabels, taxonomyOpts)
  const priorityOrder = (axes.find((a) => a.family === 'priority') || { values: [] }).values.map((v) => v.value)
  const rank = (it) => {
    const p = valueFor(it.labels, 'priority', taxonomyOpts.alias)
    const i = priorityOrder.indexOf(p)
    return i === -1 ? priorityOrder.length : i
  }
  const clustered = new Map()
  for (const it of open) {
    const fam = axes[0] && axes[0].family
    const key = fam ? (valueFor(it.labels, fam, taxonomyOpts.alias) || 'altro') : 'tutte'
    if (!clustered.has(key)) clustered.set(key, [])
    clustered.get(key).push(it)
  }
  for (const list of clustered.values()) list.sort((a, b) => rank(a) - rank(b))
  return { axes, other, clusterFamily: (axes[0] && axes[0].family) || null, clusters: [...clustered.entries()].map(([key, issues]) => ({ key, issues: issues.map((i) => i.n) })) }
}

// Issue dependency edges are facts in c4-issues.json. Prose-only edges are candidates until the
// audit overlay confirms their fingerprint; native edges need no second opinion. `active` is a
// derivation from the blocker endpoint's current state, never another snapshot field that can age.
export function deriveDependencies(repo, issuesSnapshot, health = { dependencyConfirmations: [] }) {
  const raw = issuesSnapshot.dependencies || { supported: false, complete: false, edges: [] }
  const candidatesByFingerprint = new Map((raw.edges || []).filter((edge) => edge.source === 'prose').map((edge) => [edge.fingerprint, edge]))
  const staleConfirmations = []
  const confirmed = new Set((health.dependencyConfirmations || []).filter((entry) => {
    let evidenceHash = null
    try { evidenceHash = hashEvidence(repo, entry.evidence, issuesSnapshot, `dependency ${entry.fingerprint}`) } catch {}
    const fresh = classifyDependencyConfirmationStaleness(entry, candidatesByFingerprint.get(entry.fingerprint), evidenceHash) === 'fresh'
    if (!fresh) staleConfirmations.push(entry.fingerprint)
    return fresh
  }).map((entry) => entry.fingerprint))
  const candidates = [], edges = []
  for (const edge of raw.edges || []) {
    if (edge.source === 'prose' && !confirmed.has(edge.fingerprint)) { candidates.push(edge); continue }
    edges.push({ ...edge, active: edge.to.state === 'OPEN' })
  }
  const activeBlocked = [...new Set(edges.filter((edge) => edge.active && edge.from.repo === issuesSnapshot.ghRepo).map((edge) => edge.from.number))].sort((a, b) => a - b)
  return { supported: raw.supported, complete: raw.complete, edges, candidates, activeBlocked, staleConfirmations }
}

export function deriveHealth(repo, issuesSnapshot, health, manifest) {
  const byIssue = new Map((issuesSnapshot.issues || []).map((issue) => [issue.n, issue]))
  const verdicts = (health.verdicts || []).map((verdict) => {
    let evidenceHash = null
    try { evidenceHash = hashEvidence(repo, verdict.evidence, issuesSnapshot, `health #${verdict.n}`) } catch {}
    const staleReason = byIssue.has(verdict.n)
      ? classifyVerdictStaleness(verdict, byIssue.get(verdict.n), { today: manifest.today, staleAfterDays: manifest.staleAfterDays || 14, evidenceHash })
      : 'issue-missing'
    return { ...verdict, stale: staleReason !== 'fresh', staleReason: staleReason === 'fresh' ? null : staleReason }
  })
  return { verdicts, staleCount: verdicts.filter((verdict) => verdict.stale).length }
}

// Agent-written findings expire like verdicts (evidence moved, too old); gate-derived rows are
// re-derived every run and read `derived`. `lastApply` is carried through so the room can say how
// much of the last fill forma refused — a number, not a register (one record, overwritten).
export function deriveFindings(repo, issuesSnapshot, findings, health, manifest) {
  const rows = ((findings && findings.findings) || []).map((finding) => {
    let evidenceHash = null
    try { evidenceHash = hashEvidence(repo, [finding.evidence], issuesSnapshot, `finding ${finding.id}`) } catch {}
    const staleReason = classifyFindingStaleness(finding, { today: manifest.today, staleAfterDays: manifest.staleAfterDays || 14, evidenceHash })
    const stale = staleReason !== 'fresh' && staleReason !== 'derived'
    return { ...finding, stale, staleReason: stale ? staleReason : null }
  })
  return { findings: rows, staleCount: rows.filter((row) => row.stale).length, lastApply: (health && health.lastApply) || null }
}

// The brief, derived: for every claim its staleness (subject moved, evidence moved, aged out) and
// the state of the hostile verdict on it. `state` is the ONLY thing the viewer reads to decide a
// colour: `holds` on a fresh claim → the claim's own severity; anything else → grey with the word.
// Never a colour because an agent wrote a sentence — a colour because a second agent, with a
// mandate to disprove it, could not, and said so on a date the reader can see.
export function deriveBrief(repo, issuesSnapshot, brief, manifest) {
  if (!brief) return null
  const window = manifest.staleAfterDays || 14
  const claims = (brief.claims || []).map((claim) => {
    let evidenceHash = null
    try { evidenceHash = hashEvidence(repo, claim.evidence, issuesSnapshot, `brief ${claim.id}`) } catch {}
    const staleReason = classifyClaimStaleness(claim, issuesSnapshot, { today: manifest.today, staleAfterDays: window, evidenceHash })
    const stale = staleReason !== 'fresh'
    const verification = classifyVerification(claim, { today: manifest.today, staleAfterDays: window })
    const state = stale ? 'stale' : verification
    return { ...claim, stale, staleReason: stale ? staleReason : null, verification, state, coloured: state === 'holds' }
  })
  const byKind = (kind) => claims.filter((claim) => claim.kind === kind)
  const verifiable = claims.filter((claim) => claim.kind !== 'note')
  return {
    claims,
    thesis: byKind('thesis')[0] || null,
    risks: byKind('risk'),
    decisions: byKind('decide'),
    invariants: byKind('invariant'),
    notes: byKind('note'),
    counts: { total: claims.length, stale: claims.filter((claim) => claim.stale).length, holds: claims.filter((claim) => claim.state === 'holds').length, contradicted: claims.filter((claim) => claim.state === 'contradicted').length, unsupported: claims.filter((claim) => claim.state === 'unsupported').length, unverified: claims.filter((claim) => claim.state === 'unverified').length, verifiable: verifiable.length },
    // A brief is "ready" when every decision it asks for has been held by the verifier: a DECIDI TU
    // nobody looked at is the reference dashboard's "falso tutto fatto" in a new coat.
    ready: byKind('decide').every((claim) => claim.state === 'holds') && Boolean(byKind('thesis')[0]) && byKind('thesis')[0].state === 'holds',
  }
}

// The queue already has the only deterministic grouping rule Forma owns. A work block is that
// grouping with one inspect command, not a new curated plan. The command contains each issue
// number exactly once; a blocked-label or cross-repository blocker removes the command entirely.
export function deriveBlocks(issuesSnapshot, queue, dependencies, manifest) {
  const byN = new Map((issuesSnapshot.issues || []).map((issue) => [issue.n, issue]))
  const blockedLabels = new Set(((manifest.blockedBy || {}).labels) || [])
  const external = new Set((dependencies.edges || [])
    .filter((edge) => edge.active && edge.from.repo === issuesSnapshot.ghRepo && edge.to.repo !== issuesSnapshot.ghRepo)
    .map((edge) => edge.from.number))
  return (queue.clusters || []).map((cluster, index) => {
    const issues = cluster.issues.map((n) => byN.get(n)).filter((issue) => issue && issue.state === 'OPEN')
    const numbers = issues.map((issue) => issue.n).sort((a, b) => a - b)
    const labelled = issues.filter((issue) => (issue.labels || []).some((label) => blockedLabels.has(label))).map((issue) => issue.n)
    const outside = numbers.filter((n) => external.has(n))
    const auto = labelled.length === 0 && outside.length === 0
    const cmd = !auto ? null : numbers.length === 1
      ? `gh issue view ${numbers[0]}`
      : `for n in ${numbers.join(' ')}; do gh issue view "$n"; done`
    const commandNumbers = cmd ? (numbers.length === 1 ? [Number(/\d+/.exec(cmd)[0])] : [.../for n in ([\d ]+);/.exec(cmd)[1].matchAll(/\d+/g)].map((m) => Number(m[0]))) : []
    if (cmd && JSON.stringify(commandNumbers.sort((a, b) => a - b)) !== JSON.stringify(numbers)) throw new Error(`derived block ${cluster.key}: command issue set drifted`)
    const milestones = [...new Set(issues.map((issue) => issue.ms).filter(Boolean))]
    const active = (dependencies.edges || []).filter((edge) => edge.active && edge.from.repo === issuesSnapshot.ghRepo && numbers.includes(edge.from.number))
    return {
      n: index + 1,
      t: cluster.key,
      ms: milestones.length === 1 ? milestones[0] : null,
      cmd,
      auto,
      why: active.map((edge) => ({ from: edge.from, to: edge.to })),
      iss: issues.sort((a, b) => a.n - b.n).map((issue) => [issue.n, issue.title]),
      note: !auto ? { labelled, external: outside } : null,
    }
  }).filter((block) => block.iss.length)
}

export function deriveCapabilities(repo, config, issuesSnapshot, dependencies) {
  if (!config || !(config.docs || []).length) return null
  const parsed = parseCapabilities(repo, config)
  const verification = parseCapabilityVerification(repo, config.verification)
  const byIssue = new Map((issuesSnapshot.issues || []).map((issue) => [issue.n, issue]))
  const evidenceById = new Map()
  for (const row of verification.rows) for (const id of [...row.featureIds, ...row.useCaseIds]) {
    if (!evidenceById.has(id)) evidenceById.set(id, [])
    evidenceById.get(id).push(row)
  }
  const childrenByParent = new Map()
  for (const row of parsed.rows) for (const parent of row.parents || []) {
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
    childrenByParent.get(parent).push(row)
  }
  return {
    rows: parsed.rows.map((row) => {
      const openIssues = row.issues.filter((n) => (byIssue.get(n) || {}).state === 'OPEN')
      const children = row.id ? (childrenByParent.get(row.id) || []) : []
      const evidence = [...new Map([row, ...children].flatMap((item) => evidenceById.get(item.id) || []).map((item) => [`${item.source.path}:${item.source.line}`, item])).values()]
      return {
        ...row,
        openIssues,
        blockers: (dependencies.edges || []).filter((edge) => edge.active && edge.from.repo === issuesSnapshot.ghRepo && openIssues.includes(edge.from.number)),
        useCases: children.map((child) => child.id).filter((id) => /^UC-/i.test(id)),
        verification: evidence,
      }
    }),
    skipped: [...parsed.skipped, ...verification.skipped],
    duplicates: parsed.duplicates,
  }
}

// The timeline, given a completion it can be held to. A checkpoint is a set of typed patches over
// the AS-IS baseline, and it carries no dates and no progress of its own — which is why it reads as
// choreography: a stepper that always looks the same however much of it is done.
//
// The nodes a checkpoint names are already known, and `link.mjs` already knows which issues touched
// which node. Intersecting the two gives a completion that is MEASURED: closed issues over issues
// reaching those nodes. A checkpoint no issue reaches reports null, never 0 — nobody measured it
// (I6). This never claims the checkpoint is finished, only how much of the work that landed on its
// nodes is closed; the distinction is the same one `docmap.mjs` draws between reach and completion.
export function deriveCheckpoints(model, issuesSnapshot, byIssue) {
  const timeline = model && model.timeline
  if (!timeline || !(timeline.checkpoints || []).length) return null
  const stateByIssue = new Map((issuesSnapshot.issues || []).map((it) => [it.n, it.state]))
  const nodesForIssue = new Map([...byIssue].map(([n, ids]) => [n, ids]))
  return timeline.checkpoints.map((cp) => {
    const patch = cp.patch || {}, nodes = new Set()
    for (const entry of (patch.nodes && patch.nodes.add) || []) if (entry.node && entry.node.id) nodes.add(entry.node.id)
    for (const entry of (patch.nodes && patch.nodes.update) || []) if (entry.id) nodes.add(entry.id)
    for (const entry of (patch.nodes && patch.nodes.remove) || []) if (entry.id) nodes.add(entry.id)
    const issues = []
    for (const [n, ids] of nodesForIssue) if ([...ids].some((id) => nodes.has(id)) && stateByIssue.has(n)) issues.push(n)
    issues.sort((a, b) => a - b)
    const closed = issues.filter((n) => stateByIssue.get(n) === 'CLOSED').length
    return {
      id: cp.id,
      label: cp.label,
      nodes: [...nodes].sort(),
      issues,
      closed,
      total: issues.length,
      pct: issues.length ? Math.round((100 * closed) / issues.length) : null,
    }
  })
}

// `tec`: how far the architecture layer (model.source.commit) sits behind the target repo's real
// HEAD. Reported, never enforced to zero (docs/SCOPE-room.md §8) — a repo Forma cannot check out
// (private, not present) reports "unresolvable", the honest blank, not a false zero.
export function deriveCommitDrift(repo, sourceCommit) {
  if (!sourceCommit) return { resolvable: false, reason: 'model has no source.commit' }
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', sourceCommit], { stdio: 'ignore' })
  } catch {
    return { resolvable: false, reason: `commit ${sourceCommit} not found in ${repo} (private/absent checkout, or repo has moved on)` }
  }
  try {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    const behind = Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', `${sourceCommit}..HEAD`], { encoding: 'utf-8' }).trim())
    return { resolvable: true, head, sourceCommit, commitsBehind: behind }
  } catch (e) {
    return { resolvable: false, reason: String((e && e.message) || e) }
  }
}

// The git issue<->node link, re-derived fresh (never cached) so `check` and `room` can never see
// two different answers to "which node did this issue touch".
export function deriveLink(repo, model, topo, manifest) {
  const linked = linkIssuesToNodes(repo, model, topo, { linkMaxFiles: manifest.linkMaxFiles || 50 })
  return linked
}

// The single entry point both room.mjs and check.mjs call — same inputs in, same object out.
//
// Four of the six answers below need only the issue snapshot; two need the architecture map. Tying
// all six to the map made a programme without one derive NOTHING, so its issues were carried by the
// portfolio layer alone and the gate had nothing per-programme to re-derive. The map-dependent pair
// is null when there is no map — never an empty object that reads as a measured zero (I6).
export function deriveAll({ repo, model, topo, issuesSnapshot, health, healthVerdicts, findings, brief, manifest, gateInputs }, context) {
  const hasMap = Boolean(model && topo)
  const linked = deriveLink(repo, hasMap ? model : { nodes: [] }, hasMap ? topo : null, manifest)
  if (context) context.linked = linked
  const coverage = hasMap ? coverageOf(linked.byIssue, issuesSnapshot.issues.map((it) => it.n)) : null
  const healthState = health || { verdicts: healthVerdicts || [], dependencyConfirmations: [] }
  const healthDerived = deriveHealth(repo, issuesSnapshot, healthState, manifest)
  const dependencies = deriveDependencies(repo, issuesSnapshot, healthState)
  const queue = deriveQueue(issuesSnapshot, manifest.taxonomy || {})
  return {
    kpis: deriveKpis(issuesSnapshot, coverage, manifest),
    milestones: deriveMilestones(issuesSnapshot),
    history: deriveHistory(issuesSnapshot, manifest.today),
    health: healthDerived,
    findings: deriveFindings(repo, issuesSnapshot, findings || { findings: [] }, healthState, manifest),
    brief: deriveBrief(repo, issuesSnapshot, brief || null, manifest),
    kanban: deriveKanban(issuesSnapshot, healthDerived.verdicts.filter((verdict) => !verdict.stale), ((manifest.blockedBy || {}).labels) || []),
    kanbanHumanDeclared: manifest.blockedBy !== undefined,
    queue,
    dependencies,
    blocks: deriveBlocks(issuesSnapshot, queue, dependencies, manifest),
    capabilities: deriveCapabilities(repo, manifest.capabilities, issuesSnapshot, dependencies),
    documentGate: documentGate(gateInputs, manifest.today),
    commitDrift: hasMap ? deriveCommitDrift(repo, model.source && model.source.commit) : null,
    checkpoints: hasMap ? deriveCheckpoints(model, issuesSnapshot, linked.byIssue) : null,
    link: hasMap ? {
      byIssue: Object.fromEntries([...linked.byIssue].map(([n, ids]) => [n, [...ids]])),
      excludedSweeps: linked.excludedSweeps,
      coverage,
    } : null,
    // null when the programme declares no rtm block — and because `check` compares every key this
    // returns, the matrix is gated from the moment it exists, with no assertion written for it.
    rtm: deriveRtm({ repo, rtm: rtmFor(manifest), issuesSnapshot }),
  }
}

// Portfolio blocking stays declared per program: measured reality is needs-human in haben,
// needs-human + owner-decision in arbiter, and no waiting label in viafera (parked means stopped).
// An absent rule is therefore unknown, while a declared empty list is measured zero.
// The portfolio consumes the queue and git-link context already computed by deriveAll. Re-reading
// either here once gave one artifact two answers and doubled the most expensive repository walk.
export function derivePortfolio({ today, programs }) {
  const totals = { programs: programs.length, issues: 0, open: 0, closed: 0, blocked: 0, unknownRule: 0 }
  const summaries = [], blocked = [], moving = [], landing = []

  for (const program of programs) {
    const issues = program.issuesSnapshot.issues
    const open = issues.filter(isOpen), closed = issues.filter((it) => it.state === 'CLOSED')
    const taxonomyOpts = program.taxonomy || {}
    const queue = program.derived.queue
    const priorityAxis = queue.axes.find((a) => a.family === 'priority')
    const priorityOrder = taxonomyOpts.order && taxonomyOpts.order.priority
    const labelRuleDeclared = program.blockedBy !== undefined
    const blockedLabels = labelRuleDeclared ? (program.blockedBy.labels || []) : []
    const blockedLabelSet = new Set(blockedLabels)
    const dependencyState = (program.derived || {}).dependencies || { supported: false, complete: false, activeBlocked: [] }
    const dependencyBlocked = new Set(dependencyState.activeBlocked || [])
    const declared = labelRuleDeclared || (dependencyState.supported && dependencyState.complete)
    const complete = labelRuleDeclared && dependencyState.supported && dependencyState.complete
    const blockedIssues = open.filter((it) => (it.labels || []).some((label) => blockedLabelSet.has(label)) || dependencyBlocked.has(it.n))
    const blockedNumbers = new Set(blockedIssues.map((it) => it.n))
    const movingIssues = complete ? open.filter((it) => !blockedNumbers.has(it.n)) : []
    const movingNumbers = new Set(movingIssues.map((it) => it.n))
    const hasMap = Boolean(program.model && program.topo)
    const linked = program.deriveContext.linked
    const verdictByN = new Map((((program.derived || {}).health || { verdicts: [] }).verdicts || []).filter((verdict) => !verdict.stale).map((v) => [v.n, v]))
    const workPerNode = hasMap ? Object.fromEntries((program.model.nodes || []).map((node) => [node.id, 0])) : null
    const workPerNodeOpen = hasMap ? Object.fromEntries((program.model.nodes || []).map((node) => [node.id, 0])) : null

    // All linked history feeds the architecture view: haben's 6 open issues over 63 nodes made
    // an open-only chart nearly empty. Current work stays separate so neither question lies.
    if (workPerNode) {
      for (const issue of issues) {
        for (const node of linked.byIssue.get(issue.n) || []) if (node in workPerNode) {
          workPerNode[node]++
          if (isOpen(issue)) workPerNodeOpen[node]++
        }
      }
    }
    for (const issue of blockedIssues) {
      const verdict = verdictByN.get(issue.n)
      const dates = linked.datesByIssue.get(issue.n)
      const priority = priorityAxis ? valueFor(issue.labels || [], 'priority', taxonomyOpts.alias || {}) : null
      const declaredRank = priority === null || !priorityOrder ? null : priorityOrder.indexOf(priority)
      blocked.push({
        item: {
          program: program.id, n: issue.n, title: issue.title, labels: issue.labels || [], ms: issue.ms ?? null,
          verdict: verdict ? verdict.verdict : null, why: verdict ? verdict.why : null,
          evidence: verdict ? verdict.evidence : null,
          nodes: hasMap ? [...(linked.byIssue.get(issue.n) || [])].sort() : [],
          lastLanded: dates ? dates.last : null,
          // Git only says when work last landed: haben #498 landing yesterday means activity, not
          // one day waiting. "Waiting since" needs an issue creation date this snapshot omits.
          daysSinceLastLanding: dates ? daysBetween(dates.last, today) : null,
          priority,
        },
        // Population is not severity: arbiter measured P1=100, P2=91, P0=52. A declaration wins;
        // otherwise the measured P0/P1/P2 and p0/p1/p2/p3 conventions sort lexicographically.
        priorityRank: declaredRank === -1 ? priorityOrder.length : declaredRank,
      })
    }

    const months = new Map()
    // Git author dates are the history authority; gh only supplies the current issue snapshot.
    // Intersected with that snapshot, exactly as coverageOf does, because GitHub shares one number
    // space between issues and pull requests: an unfiltered `#N` from a squash-merge subject
    // ("fix(viewer): ... (#46)") counted a PR as a landed issue and inflated the month.
    const known = new Set(issues.map((it) => it.n))
    for (const [n, dates] of linked.datesByIssue) {
      if (!known.has(n)) continue
      const month = dates.last.slice(0, 7)
      months.set(month, (months.get(month) || 0) + 1)
    }
    let cumulative = 0
    landing.push({ program: program.id, months: [...months].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([month, landed]) => ({ month, landed, cumulative: cumulative += landed })) })
    moving.push({
      program: program.id,
      // Without a blocking rule Forma cannot know which open work is moving. Preserve the unknown
      // in the aggregate; queue/kanban still carry every issue independently.
      count: complete ? movingIssues.length : null,
      byCluster: complete ? queue.clusters.map((cluster) => ({ ...cluster, issues: cluster.issues.filter((n) => movingNumbers.has(n)) })).filter((cluster) => cluster.issues.length) : null,
    })
    summaries.push({
      id: program.id,
      ghRepo: program.ghRepo,
      hasMap,
      open: open.length,
      closed: closed.length,
      total: issues.length,
      // Three states, not two. A rule declared with no labels can never match anything, so calling
      // it "declared" alongside a real one let the audit panel report success over a rule that is
      // inert — and the two views then printed contradictory sentences about the same datum.
      blockedRule: { declared, inert: labelRuleDeclared && blockedLabels.length === 0 && !(dependencyState.supported && dependencyState.complete), labels: blockedLabels, dependencies: { supported: dependencyState.supported, complete: dependencyState.complete } },
      blocked: complete ? blockedIssues.length : null,
      snapshotAgeDays: daysBetween(program.issuesSnapshot.fetchedAt, today),
      milestones: deriveMilestones(program.issuesSnapshot),
      workPerNode,
      workPerNodeOpen,
      linkCoverage: hasMap ? coverageOf(linked.byIssue, issues.map((it) => it.n)) : null,
      commitDrift: hasMap ? deriveCommitDrift(program.repo, program.model.source && program.model.source.commit) : null,
      taxonomy: { axes: queue.axes, other: queue.other, clusterFamily: queue.clusterFamily },
    })
    totals.issues += issues.length
    totals.open += open.length
    totals.closed += closed.length
    totals.blocked += blockedIssues.length
    if (!complete) totals.unknownRule++
  }

  // A portfolio total is a claim about every programme. One absent rule makes the total unknown;
  // retaining the subtotal from only declared programmes would present a lower bound as a fact.
  if (totals.unknownRule) totals.blocked = null

  blocked.sort((a, b) => (a.item.priority === null) - (b.item.priority === null)
    || (a.priorityRank !== null && b.priorityRank !== null ? a.priorityRank - b.priorityRank : 0)
    || (a.item.priority < b.item.priority ? -1 : a.item.priority > b.item.priority ? 1 : 0)
    || (a.item.daysSinceLastLanding === null) - (b.item.daysSinceLastLanding === null)
    || (a.item.daysSinceLastLanding === null ? 0 : b.item.daysSinceLastLanding - a.item.daysSinceLastLanding)
    || (a.item.program < b.item.program ? -1 : a.item.program > b.item.program ? 1 : 0)
    || a.item.n - b.item.n)
  return { totals, programs: summaries, blocked: blocked.map((entry) => entry.item), moving, landing }
}
