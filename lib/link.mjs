// link.mjs — issue -> commit citing it -> files touched -> C4 node. Pure, offline, no LLM.
// The only authority for "which part of the architecture did this issue touch" is git: a second,
// hand-curated map of the same fact is exactly the concurrent source of truth the Control Room
// forbids (ADR-0004). Reuses the same file->node containment `check.mjs` already walks for the
// leaf count (leaf evidence.path, container topo.leafSources) — no second mapping scheme.
import { execFileSync } from 'node:child_process'

// A `#N` immediately preceded by a word character is a CROSS-REPO citation (`viafera#3807`,
// `coach#434`), not this repo's own issue — attributing it would be exactly the kind of
// hallucinated link this module exists to prevent. Confirmed on real history (haben, 2026-08-09):
// `viafera#3807` does not resolve as a haben issue at all.
const numsIn = (subject) => [...String(subject || '').matchAll(/(?<![A-Za-z0-9_])#(\d+)/g)].map((m) => Number(m[1]))

function nodeIdsForFile(file, nodes, leafSources) {
  const ids = []
  for (const n of nodes || []) {
    if (n.kind !== 'leaf') continue
    for (const e of n.evidence || []) if (e.type === 'path' && e.ref === file) ids.push(n.id)
  }
  for (const spec of leafSources || []) {
    const dir = String(spec.dir || '').replace(/\/$/, '')
    if (dir && (file === dir || file.startsWith(dir + '/'))) ids.push(spec.parent)
  }
  return ids
}

// Reads `git log` once (no shell, execFileSync), walks it as %H<SOH>%ad<SOH>%s + --name-only blocks.
// A commit whose subject cites no #N contributes nothing. A commit touching more than
// `linkMaxFiles` files is a sweep, not a change: it attributes to no node, but is counted and
// named — never silently dropped (measured on real repos: 1-3% of commits, p99 64-101 files).
export function linkIssuesToNodes(repo, model, topo, opts = {}) {
  const maxFiles = opts.linkMaxFiles || 50
  let log
  try {
    log = execFileSync('git', ['-C', repo, 'log', '--pretty=@@@%H%x01%ad%x01%s', '--date=short', '--name-only'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 })
  } catch (e) {
    return { byIssue: new Map(), datesByIssue: new Map(), excludedSweeps: [], error: String((e && e.message) || e) }
  }
  const nodes = model.nodes || [], leafSources = (topo && topo.leafSources) || []
  const byIssue = new Map() // issue number -> Set(nodeId)
  const datesByIssue = new Map() // issue number -> { first, last, commits }
  const excludedSweeps = []
  let sha = null, date = null, subject = null, files = []
  const flush = () => {
    if (sha == null) return
    const nums = numsIn(subject)
    if (nums.length) {
      if (files.length > maxFiles) {
        excludedSweeps.push({ sha, subject, files: files.length })
      } else {
        const nodeIds = new Set()
        for (const f of files) for (const id of nodeIdsForFile(f, nodes, leafSources)) nodeIds.add(id)
        for (const n of new Set(nums)) {
          if (!byIssue.has(n)) byIssue.set(n, new Set())
          for (const id of nodeIds) byIssue.get(n).add(id)
          const dates = datesByIssue.get(n)
          if (dates) {
            if (date < dates.first) dates.first = date
            if (date > dates.last) dates.last = date
            dates.commits++
          } else {
            datesByIssue.set(n, { first: date, last: date, commits: 1 })
          }
        }
      }
    }
    sha = null; date = null; subject = null; files = []
  }
  for (const line of log.split('\n')) {
    if (line.startsWith('@@@')) {
      flush()
      const rest = line.slice(3), firstSep = rest.indexOf(''), secondSep = rest.indexOf('', firstSep + 1)
      sha = rest.slice(0, firstSep); date = rest.slice(firstSep + 1, secondSep); subject = rest.slice(secondSep + 1)
    } else if (line.trim()) files.push(line.trim())
  }
  flush()
  return { byIssue, datesByIssue, excludedSweeps }
}

// Coverage against a KNOWN population of issue numbers (the gh snapshot), not just the ones
// referenced by the model — "69% covered" is measured against every issue that exists.
export function coverageOf(byIssue, issueNumbers) {
  const total = issueNumbers.length
  const linked = issueNumbers.filter((n) => byIssue.has(n) && byIssue.get(n).size > 0).length
  return { linked, total, pct: total ? Math.round((100 * linked) / total) : 0 }
}
