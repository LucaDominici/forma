// roomderive.mjs — the ONLY place Control Room aggregates are computed. Imported by both
// `room.mjs` (which writes the numbers into window.__ROOM__.derived) and `check.mjs` (which
// recomputes them from the same raw inputs and compares against what room wrote). If they ever
// disagreed the gate would prove nothing — see ADR-0004 and PLAN.md's roomderive contract.
// Pure functions only: no fs, no network, no Date.now() (determinism anchor is manifest.today).
import { execFileSync } from 'node:child_process'
import { detectFamilies, valueFor } from './taxonomy.mjs'
import { linkIssuesToNodes, coverageOf } from './link.mjs'
import { deriveRtm } from './rtm.mjs'
import { rtmFor } from './roomload.mjs'

const NEEDS_HUMAN = 'needs-human'
const isOpen = (it) => it.state === 'OPEN'
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000)

// KPI line for `exec` — every number here must be ri-derivabile: no field here is ever a
// declaration, only a count over raw facts.
export function deriveKpis(issuesSnapshot, linkedCoverage, manifest) {
  const open = issuesSnapshot.issues.filter(isOpen)
  const needsHuman = open.filter((it) => it.labels.includes(NEEDS_HUMAN)).length
  const staleMilestones = issuesSnapshot.milestones.filter((m) => m.due && m.open > 0 && daysBetween(m.due, manifest.today) > 0)
  const noMilestone = open.filter((it) => !it.ms)
  return {
    openCount: open.length,
    needsHumanCount: needsHuman,
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
  // The window starts when the first issue was opened, not a fixed number of months back: padding
  // the left edge with months in which the programme did not yet exist draws a long flat run that
  // reads as stagnation. Capped so a decade-old repository stays a chart and not a hairline.
  const earliest = dated.reduce((min, it) => (it.createdAt < min ? it.createdAt : min), dated[0].createdAt)
  const first = new Date(earliest + 'T00:00:00Z'), last = new Date(today + 'T00:00:00Z')
  const span = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + (last.getUTCMonth() - first.getUTCMonth()) + 1
  const months = Math.max(2, Math.min(maxPoints, span))
  // A CLOSED issue with no closedAt cannot be placed in time. Counting it as closed-forever would
  // bend the curve down at the left edge; counting it as open would bend it up. It is excluded and
  // named instead (I9).
  const unplaceable = issues.filter((it) => it.state === 'CLOSED' && it.createdAt && !it.closedAt).length
  const end = new Date(today + 'T00:00:00Z')
  const points = []
  for (let back = months - 1; back >= 0; back--) {
    const at = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - back + 1, 0))
    const day = at > end ? today : at.toISOString().slice(0, 10)
    let open = 0, closed = 0, created = 0
    for (const it of dated) {
      if (it.createdAt > day) continue
      created++
      if (it.closedAt && it.closedAt <= day) closed++; else open++
    }
    points.push({ at: day, open, closed, created })
  }
  return { points, unplaceable, counted: dated.length, total: issues.length }
}

// Kanban buckets. Precedence is a hard fact first, then an audited verdict, then a status label,
// never guessed: CLOSED state > c4-health verdict > needs-human label > unaudited.
// bucket vocabulary is a DECLARED mapping (docs/SCOPE-room.md §5.3), not invented per issue:
//   sane=ok  a-meta=warn  premessa-falsa=bad  aspettano-umano=needs-human label  chiuse=CLOSED
export function deriveKanban(issuesSnapshot, healthVerdicts) {
  const verdictByN = new Map((healthVerdicts || []).map((v) => [v.n, v]))
  const buckets = { chiuse: [], sane: [], 'a-meta': [], 'premessa-falsa': [], 'aspettano-umano': [], 'non-auditate': [] }
  for (const it of issuesSnapshot.issues) {
    if (it.state === 'CLOSED') { buckets.chiuse.push(it.n); continue }
    const v = verdictByN.get(it.n)
    if (v) { buckets[{ ok: 'sane', warn: 'a-meta', bad: 'premessa-falsa' }[v.verdict]].push(it.n); continue }
    if (it.labels.includes(NEEDS_HUMAN)) { buckets['aspettano-umano'].push(it.n); continue }
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
export function deriveAll({ repo, model, topo, issuesSnapshot, healthVerdicts, manifest }) {
  const hasMap = Boolean(model && topo)
  const linked = deriveLink(repo, hasMap ? model : { nodes: [] }, hasMap ? topo : null, manifest)
  const coverage = hasMap ? coverageOf(linked.byIssue, issuesSnapshot.issues.map((it) => it.n)) : null
  return {
    kpis: deriveKpis(issuesSnapshot, coverage, manifest),
    milestones: deriveMilestones(issuesSnapshot),
    history: deriveHistory(issuesSnapshot, manifest.today),
    kanban: deriveKanban(issuesSnapshot, healthVerdicts),
    queue: deriveQueue(issuesSnapshot, manifest.taxonomy || {}),
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
// `linkMaxFiles` is a manifest-level rule, so it has to reach this layer too: reading it only in
// deriveAll gave one artifact two sweep thresholds — the per-programme numbers cut at the declared
// value, every portfolio aggregate at the default 50 — and only the first pair was gated.
export function derivePortfolio({ today, programs, linkMaxFiles }) {
  const totals = { programs: programs.length, issues: 0, open: 0, closed: 0, blocked: 0, unknownRule: 0 }
  const summaries = [], blocked = [], moving = [], landing = []

  for (const program of programs) {
    const issues = program.issuesSnapshot.issues
    const open = issues.filter(isOpen), closed = issues.filter((it) => it.state === 'CLOSED')
    const taxonomyOpts = program.taxonomy || {}
    const queue = deriveQueue(program.issuesSnapshot, taxonomyOpts)
    const priorityAxis = queue.axes.find((a) => a.family === 'priority')
    const priorityOrder = taxonomyOpts.order && taxonomyOpts.order.priority
    const declared = program.blockedBy !== undefined
    const blockedLabels = declared ? (program.blockedBy.labels || []) : []
    const blockedLabelSet = new Set(blockedLabels)
    const blockedIssues = declared ? open.filter((it) => (it.labels || []).some((label) => blockedLabelSet.has(label))) : []
    const blockedNumbers = new Set(blockedIssues.map((it) => it.n))
    const movingIssues = declared ? open.filter((it) => !blockedNumbers.has(it.n)) : []
    const movingNumbers = new Set(movingIssues.map((it) => it.n))
    const hasMap = Boolean(program.model && program.topo)
    const linked = deriveLink(program.repo, hasMap ? program.model : { nodes: [] }, hasMap ? program.topo : null, { linkMaxFiles })
    const verdictByN = new Map(((program.health || { verdicts: [] }).verdicts || []).map((v) => [v.n, v]))
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
      count: movingIssues.length,
      byCluster: queue.clusters.map((cluster) => ({ ...cluster, issues: cluster.issues.filter((n) => movingNumbers.has(n)) })).filter((cluster) => cluster.issues.length),
    })
    summaries.push({
      id: program.id,
      ghRepo: program.ghRepo,
      hasMap,
      open: open.length,
      closed: closed.length,
      total: issues.length,
      blockedRule: { declared, labels: blockedLabels },
      blocked: blockedIssues.length,
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
    if (!declared) totals.unknownRule++
  }

  blocked.sort((a, b) => (a.item.priority === null) - (b.item.priority === null)
    || (a.priorityRank !== null && b.priorityRank !== null ? a.priorityRank - b.priorityRank : 0)
    || (a.item.priority < b.item.priority ? -1 : a.item.priority > b.item.priority ? 1 : 0)
    || (a.item.daysSinceLastLanding === null) - (b.item.daysSinceLastLanding === null)
    || (a.item.daysSinceLastLanding === null ? 0 : b.item.daysSinceLastLanding - a.item.daysSinceLastLanding)
    || (a.item.program < b.item.program ? -1 : a.item.program > b.item.program ? 1 : 0)
    || a.item.n - b.item.n)
  return { totals, programs: summaries, blocked: blocked.map((entry) => entry.item), moving, landing }
}
