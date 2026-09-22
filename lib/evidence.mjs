// evidence.mjs — evidence hashing, evidence-path/record resolution and staleness classification.
// Split out of audit.mjs (#140 S3, F7): these are the primitives every caller of a c4-health /
// c4-findings / c4-brief overlay needs to ask "does this evidence still resolve, and has it moved
// since it was written" — audit.mjs's plan/apply/counter flow is ONE such caller, not the only one.
// room.mjs (via roomderive.mjs), check.mjs, verify.mjs, roomdocs.mjs and scripts/room-presentable.mjs
// all import from here directly instead of reaching into audit.mjs for functions that have nothing
// to do with planning or applying an audit fill. Pure/read-only: no fs writes, no network.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key)
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

// Unicode scalar (codepoint) order, never String.prototype's locale-aware compare: ICU collation
// is locale-dependent (F2 — `sv_SE` sorts diacritics after `z`, `en_US`/`C` do not), so a room
// composed on one machine could fail `check` on another, or reorder silently. Shared here because
// roomderive.mjs, verify.mjs and audit.mjs all need Unicode-correct ordering, not just this module.
// Iterating the strings (not indexing) is load-bearing: plain `<`/`>` compares UTF-16 CODE UNITS,
// which puts every astral character (a surrogate pair, U+10000 and above) before U+E000..U+FFFF —
// backwards from scalar order. `for...of` yields one string per Unicode scalar value, surrogate
// pairs included, so `codePointAt(0)` reads the true scalar value on each step.
export const codepointCompare = (a, b) => {
  const ai = a[Symbol.iterator](), bi = b[Symbol.iterator]()
  for (;;) {
    const an = ai.next(), bn = bi.next()
    if (an.done && bn.done) return 0
    if (an.done) return -1
    if (bn.done) return 1
    const ac = an.value.codePointAt(0), bc = bn.value.codePointAt(0)
    if (ac !== bc) return ac < bc ? -1 : 1
  }
}

export const issueRecords = (snapshot) => new Map(((snapshot && snapshot.issues) || (Array.isArray(snapshot) ? snapshot : [])).map((issue) => [issue.n, issue]))
export const validDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
export const auditDay = (today, label = 'audit apply') => {
  if (!validDay(today)) throw new Error(`${label}: today must be a real YYYY-MM-DD determinism anchor`)
  return today
}
export const evidenceIssueNumber = (e) => {
  const match = /^#?(\d+)$/.exec(String(e.ref))
  return match ? Number(match[1]) : null
}

// A whole workflow-run / release record, or a whole milestone record: like `issue`, the hash covers
// the record, so a new run (new headSha/createdAt) or a moved milestone marks the evidence changed.
// `conclusion` alone would read "success" for months — an anchor that never expires is no anchor.
export const signalRecord = (snapshot, ref) => {
  const signals = (snapshot && snapshot.signals) || {}
  const match = /^workflows\/([^/]+)$/.exec(String(ref))
  const record = match ? (signals.workflows || {})[match[1]] : (ref === 'release' ? signals.release : null)
  if (!record) throw new Error(`signal is not in the snapshot: ${ref}`)
  if ((match ? record.state : record.listState) !== 'present') throw new Error(`signal is unknown in the snapshot: ${ref}`)
  return record
}
export const milestoneRecord = (snapshot, ref) => {
  const record = ((snapshot && snapshot.milestones) || []).find((m) => m.title === String(ref))
  if (!record) throw new Error(`milestone is not in the snapshot: ${ref}`)
  return record
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

// Every call site used to wrap `hashEvidence` in its own `try { ... } catch {}` — one copy of the
// same "evidence does not resolve yet" tolerance repeated at every caller. Shared here so a caller
// asks once, instead of re-deciding whether to swallow the error each time it hashes evidence.
export const evidenceHashOrNull = (...args) => { try { return hashEvidence(...args) } catch { return null } }

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

// A claim's staleness: its subject issue moved (issue-changed), its evidence moved
// (evidence-changed), it aged out (expired), or its subject left the snapshot (issue-missing).
export function classifyClaimStaleness(claim, issuesSnapshot, { today, staleAfterDays, evidenceHash } = {}) {
  const subject = claim.about && Number.isInteger(claim.about.issue) ? issueRecords(issuesSnapshot).get(claim.about.issue) : null
  if (claim.about && Number.isInteger(claim.about.issue) && !subject) return 'issue-missing'
  return classifyVerdictStaleness({ auditedAt: claim.writtenAt, evidenceHash: claim.evidenceHash }, subject, { today, staleAfterDays: claim.staleAfterDays || staleAfterDays, evidenceHash })
}

// A finding's staleness has no issue subject: it expires by evidence and by age only.
export function classifyFindingStaleness(finding, { today, staleAfterDays, evidenceHash } = {}) {
  if (!own(finding, 'auditedAt') && !own(finding, 'evidenceHash')) return 'derived'
  return classifyVerdictStaleness(finding, null, { today, staleAfterDays, evidenceHash })
}

// Whether the counter-verifier's verdict still counts: a `holds` no older than the claim's own
// window, given after the claim was last written. Anything else is "not verified". A `holds` only
// COLOURS the claim when it came from a different engine than the one that wrote it (#123): same
// engine, or either side unknown, is recorded (the raw verdict stays on the claim) but rendered
// `self-held` — the reader sees a claim nobody adversarial has actually held.
export function classifyVerification(claim, { today, staleAfterDays } = {}) {
  const v = claim.verified
  if (!v) return 'unverified'
  if (!validDay(v.at) || v.at < claim.writtenAt) return 'unverified'
  const window = claim.staleAfterDays || staleAfterDays || 14
  const age = (Date.parse(`${auditDay(today, 'brief verification')}T00:00:00Z`) - Date.parse(`${v.at}T00:00:00Z`)) / 86400000
  if (age > window) return 'unverified'
  if (v.verdict === 'holds') {
    const authorEngine = claim.author && claim.author.engine
    if (!authorEngine || !v.engine || authorEngine === v.engine) return 'self-held'
  }
  return v.verdict
}
