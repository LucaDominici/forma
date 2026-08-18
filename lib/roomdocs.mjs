// roomdocs.mjs — the documents a briefing carries, selected from what git tracks and bounded by a
// declared byte budget. Separate from rtm.mjs on purpose: that module reads tables to derive a
// matrix, this one carries prose so a reader never has to leave the briefing to check a claim.
//
// Two rules, both from measurement rather than taste. A naive walk of a real repository found 8899
// files and 70 MB because 8544 of them were agent working copies, so selection is over `git
// ls-files` and nothing else. And the generated artifact was already 975,986 bytes for three
// programmes before any prose went in, so the budget is a REFUSAL, not a truncation: a document
// that does not fit is listed with its reason and its link, never silently cut in half (D8, I9).
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveEvidencePath } from './audit.mjs'

export const DEFAULT_MAX_BYTES = 400000

function gitFiles(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return null }
}

// One glob level, deliberately: `docs/*.md`, `docs/**/*.md`, `docs/adr/*.md`. A full glob engine
// would be a dependency or a parser, and nothing measured needs more than this.
export function globToRegExp(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++ }
      else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

export function trackedDocs(repo, includes) {
  const listed = gitFiles(repo)
  if (!listed) return []
  const patterns = (includes || []).map(globToRegExp)
  return listed.filter((path) => patterns.some((re) => re.test(path))).sort()
}

// The first markdown heading, which is what a reader recognizes. Falls back to nothing rather than
// to the filename dressed up as a title.
const titleOf = (text) => {
  const m = /^#\s+(.+)$/m.exec(text)
  return m ? m[1].replace(/[*_`]+/g, '').trim() : null
}

// Frontmatter is addressed to the doc-set gates, not to a person reading the briefing. Carrying it
// puts eight lines of machine metadata above every document and pushes the first sentence off the
// first screen. The title is lifted out of it where the body has no H1; the block itself is not
// shown. Only a block that opens the file counts — `---` mid-document is a horizontal rule.
function documentParts(text) {
  const lines = text.split(/\r?\n/), metadata = []
  let bodyIndex = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      for (let i = 1; i < end; i++) {
        const match = /^([a-z][a-z0-9_-]*):\s*(.*?)\s*$/i.exec(lines[i])
        if (!match) continue
        const quoted = /^(['"])([\s\S]*)\1$/.exec(match[2])
        metadata.push({ key: match[1].toLowerCase(), value: quoted ? quoted[2] : match[2], line: i + 1, source: 'frontmatter' })
      }
      bodyIndex = end + 1
      while (lines[bodyIndex] === '') bodyIndex++
    }
  }
  let headings = 0
  for (let i = bodyIndex; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) { headings++; if (headings > 1) break }
    if (i > bodyIndex && /^---\s*$/.test(lines[i])) break
    const match = /^\s*\*\*(Status|Date):\*\*\s*(.*?)\s*$/i.exec(lines[i])
    if (match) metadata.push({ key: match[1].toLowerCase(), value: match[2], line: i + 1, source: 'field' })
  }
  const body = bodyIndex ? lines.slice(bodyIndex).join('\n') : text
  const title = metadata.find((entry) => entry.source === 'frontmatter' && entry.key.toLowerCase() === 'title')
  return { body, bodyStartLine: bodyIndex + 1, metadata, title: title ? title.value : null, lines }
}

function lastChanges(repo, paths) {
  const found = new Map()
  try {
    // One path per query is intentional: git's history simplification can give the same file a
    // different "last" commit when sibling pathspecs are added, flipping freshness at the limit.
    for (const path of paths) {
      const date = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI', '--', path], { encoding: 'utf-8' }).trim()
      if (date) found.set(path, date)
    }
  } catch { return { dates: found, error: 'git-log-unavailable' } }
  return { dates: found, error: null }
}

const codeTokens = (text) => [...new Set([...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]))]

function invariantRows(parts, specs, errors) {
  const headings = []
  for (let i = 0; i < parts.lines.length; i++) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(parts.lines[i])
    if (match) headings.push({ line: i + 1, level: match[1].length, heading: match[2] })
  }
  const out = []
  for (const spec of specs) {
    let pattern
    try { pattern = new RegExp(spec.idPattern) }
    catch (error) { errors.push({ path: spec.path, field: 'idPattern', reason: String((error && error.message) || error) }); continue }
    let found = 0
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i], match = pattern.exec(heading.heading)
      if (!match) continue
      found++
      const id = (match.groups && match.groups.id) || match[1] || match[0]
      const next = headings.slice(i + 1).find((candidate) => candidate.level <= heading.level)
      const end = next ? next.line - 1 : parts.lines.length
      const claims = []
      for (let line = heading.line + 1; line <= end; line++) {
        const claim = /^\s*(?:[-*]\s+)?\*\*(Enforced by|Enforcement|Verification):\*\*\s*(.*?)\s*$/i.exec(parts.lines[line - 1])
        if (!claim) continue
        claims.push({ kind: claim[1].toLowerCase().replace(/\s+/g, '-'), line, text: claim[2], tokens: codeTokens(claim[2]) })
      }
      out.push({ id, heading: heading.heading, line: heading.line, claims })
    }
    if (!found) errors.push({ path: spec.path, field: 'idPattern', reason: 'no-invariant-match' })
  }
  return out
}

function activeRegistryLines(lines, path) {
  const slashComments = /\.(?:[cm]?[jt]sx?|java|c|cc|cpp|cs|css|go|rs|swift|html?)$/.test(path)
  const hashComments = /\.(?:ya?ml|sh|py|rb)$/.test(path)
  const htmlComments = /\.(?:html?|md)$/.test(path)
  let close = null, quote = null
  const out = []
  for (const line of lines) {
    const text = line.text
    let active = '', escaped = false
    for (let i = 0; i < text.length;) {
      if (close) {
        if (text.startsWith(close, i)) { i += close.length; close = null } else i++
        continue
      }
      const char = text[i]
      if (quote) {
        active += char; i++
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; active += char; i++; continue }
      if (slashComments && text.startsWith('//', i)) break
      if (slashComments && text.startsWith('/*', i)) { close = '*/'; i += 2; continue }
      if (htmlComments && text.startsWith('<!--', i)) { close = '-->'; i += 4; continue }
      if (hashComments && char === '#' && (i === 0 || /\s/.test(text[i - 1]))) break
      active += char; i++
    }
    if (quote !== '`') quote = null
    if (active.trim()) out.push({ ...line, text: active })
  }
  return out
}

const pathResolves = (repo, path) => { try { resolveEvidencePath(repo, path); return true } catch { return false } }

function gateInputs(repo, gate, tracked) {
  const errors = [], trackedSet = tracked && new Set(tracked)
  const freshness = (gate.freshness || []).map((rule) => {
    const patterns = (rule.include || []).map(globToRegExp)
    return { id: rule.id, staleAfterDays: rule.staleAfterDays, paths: (tracked || []).filter((path) => patterns.some((re) => re.test(path))).sort() }
  })
  const invariantPaths = (gate.invariants || []).map((spec) => spec.path)
  const claimPaths = (gate.claims || []).map((spec) => spec.path)
  const documentPaths = [...new Set([...invariantPaths, ...freshness.flatMap((rule) => rule.paths)])].sort()
  const registryPaths = [...new Set(gate.registry || [])].sort()
  const changes = lastChanges(repo, [...documentPaths, ...registryPaths, ...claimPaths].filter((path) => trackedSet && trackedSet.has(path)))
  if (changes.error) errors.push({ path: null, field: 'lastChangedAt', reason: changes.error })
  const changed = changes.dates
  const documents = documentPaths.map((path) => {
    const trackedState = trackedSet === null ? null : trackedSet.has(path)
    const base = { path, tracked: trackedState, bodyStartLine: null, metadata: [], invariants: [], lastChangedAt: changed.get(path) || null, reason: null }
    if (trackedState !== true) return { ...base, reason: trackedState === null ? 'git-unavailable' : 'untracked' }
    let raw
    try { raw = readFileSync(join(repo, path), 'utf-8') } catch { return { ...base, reason: 'read-error' } }
    const parts = documentParts(raw)
    return {
      ...base,
      bodyStartLine: parts.bodyStartLine,
      metadata: parts.metadata,
      invariants: invariantRows(parts, (gate.invariants || []).filter((spec) => spec.path === path), errors),
    }
  })
  const invariantCounts = new Map()
  for (const document of documents) for (const invariant of document.invariants) invariantCounts.set(invariant.id, (invariantCounts.get(invariant.id) || 0) + 1)
  for (const [id, count] of invariantCounts) if (count > 1) errors.push({ path: null, field: 'invariant.id', reason: `duplicate-${id}` })
  const registries = registryPaths.map((path) => {
    const trackedState = trackedSet === null ? null : trackedSet.has(path)
    const base = { path, tracked: trackedState, lastChangedAt: changed.get(path) || null, lines: [], reason: null }
    if (trackedState !== true) return { ...base, reason: trackedState === null ? 'git-unavailable' : 'untracked' }
    try {
      return { ...base, lines: readFileSync(join(repo, path), 'utf-8').split(/\r?\n/).map((text, i) => ({ line: i + 1, text })) }
    } catch { return { ...base, reason: 'read-error' } }
  })
  const wiring = (gate.wiring || []).map((spec) => {
    const base = { invariant: spec.invariant, registry: spec.registry, line: null, resolved: false, reason: null }
    if (invariantCounts.get(spec.invariant) !== 1) {
      errors.push({ path: null, field: 'wiring.invariant', reason: invariantCounts.has(spec.invariant) ? `ambiguous-${spec.invariant}` : `unknown-${spec.invariant}` })
      return { ...base, reason: invariantCounts.has(spec.invariant) ? 'invariant-ambiguous' : 'invariant-not-found' }
    }
    const registry = registries.find((entry) => entry.path === spec.registry)
    if (!registry || registry.reason) return { ...base, reason: registry ? registry.reason : 'registry-not-declared' }
    let pattern
    try { pattern = new RegExp(spec.pattern) } catch (error) { errors.push({ path: spec.registry, field: 'wiring.pattern', reason: String((error && error.message) || error) }); return { ...base, reason: 'pattern-invalid' } }
    const matches = activeRegistryLines(registry.lines, registry.path).filter((line) => pattern.test(line.text))
    return matches.length === 1 ? { ...base, line: matches[0].line, resolved: true } : { ...base, reason: matches.length ? 'ambiguous' : 'not-found' }
  })
  const claims = (gate.claims || []).map((spec) => {
    const base = { id: spec.id, path: spec.path, line: null, type: spec.type, value: null, measured: null, resolved: false, reason: null }
    if (trackedSet === null) return { ...base, reason: 'git-unavailable' }
    if (!trackedSet.has(spec.path)) return { ...base, reason: 'source-untracked' }
    let pattern
    try { pattern = new RegExp(spec.pattern) } catch (error) { errors.push({ path: spec.path, field: 'pattern', reason: String((error && error.message) || error) }); return { ...base, reason: 'pattern-invalid' } }
    let lines
    try { lines = readFileSync(join(repo, spec.path), 'utf-8').split(/\r?\n/) } catch { return { ...base, reason: 'read-error' } }
    const matches = []
    for (let i = 0; i < lines.length; i++) {
      const match = pattern.exec(lines[i])
      if (match) matches.push({ line: i + 1, match })
    }
    if (matches.length !== 1) return { ...base, reason: matches.length ? 'ambiguous' : 'not-found' }
    const captured = matches[0].match[spec.capture ?? 1]
    if (captured === undefined) return { ...base, line: matches[0].line, reason: 'capture-unresolved' }
    const match = matches[0], value = String(captured).trim(), line = match.line
    if (spec.type === 'path') {
      const measured = value.replace(/:\d+$/, '')
      const resolved = trackedSet.has(measured) && pathResolves(repo, measured)
      return { ...base, line, value, measured, resolved, reason: resolved ? null : 'target-unresolved' }
    }
    if (spec.type === 'tracked-count') {
      const patterns = (spec.include || []).map(globToRegExp), measured = (tracked || []).filter((path) => patterns.some((pattern) => pattern.test(path)) && pathResolves(repo, path)).length
      const resolved = Number(value) === measured
      return { ...base, line, value, measured, resolved, reason: resolved ? null : 'mismatch' }
    }
    if (spec.type === 'json') {
      if (!spec.target || !trackedSet.has(spec.target)) return { ...base, line, value, reason: 'target-unresolved' }
      let measured
      try {
        measured = JSON.parse(readFileSync(join(repo, spec.target), 'utf-8'))
        for (const encoded of spec.pointer.split('/').slice(1)) {
          const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
          if (measured === null || typeof measured !== 'object' || !Object.prototype.hasOwnProperty.call(measured, part)) return { ...base, line, value, reason: 'pointer-unresolved' }
          measured = measured[part]
        }
      } catch { return { ...base, line, value, reason: 'target-unreadable' } }
      if (measured !== null && typeof measured === 'object') return { ...base, line, value, measured: null, reason: 'target-non-scalar' }
      const resolved = String(measured) === value
      return { ...base, line, value, measured, resolved, reason: resolved ? null : 'mismatch' }
    }
    return { ...base, line, value, reason: 'type-unsupported' }
  })
  return { documents, registries, wiring, claims, freshness, errors, trackedPaths: tracked || null }
}

/**
 * @param canon paths embedded in full, in the order given. Everything else selected by the globs is
 *   listed with a link but not carried — "have the whole project in view" is worth a page of prose,
 *   not a copy of every repository.
 */
export function loadDocs(repo, { include, canon, maxBytes, gate } = {}) {
  const limit = maxBytes ?? DEFAULT_MAX_BYTES
  const tracked = gitFiles(repo)
  const patterns = (include || []).map(globToRegExp)
  const paths = (tracked || []).filter((path) => patterns.some((re) => re.test(path))).sort()
  const canonSet = new Set(canon || [])
  // Canon order follows the declaration, so a reading order somebody chose survives into the page.
  const wanted = (canon || []).filter((p) => paths.includes(p))
  const rest = paths.filter((p) => !canonSet.has(p))
  const embedded = [], listed = []
  let bytes = 0
  for (const path of wanted) {
    let raw
    try { raw = readFileSync(join(repo, path), 'utf-8') } catch (e) { listed.push({ path, lines: null, why: String((e && e.message) || e) }); continue }
    const { body, bodyStartLine, title } = documentParts(raw)
    const size = Buffer.byteLength(body)
    // A reason CODE, not a sentence: the viewer speaks two languages and lib/ speaks none. A
    // backend string rendered straight into the page is a locale hole nobody notices until the
    // page is read in the other one.
    if (bytes + size > limit) { listed.push({ path, lines: body.split('\n').length, why: 'budget' }); continue }
    bytes += size
    embedded.push({ path, title: titleOf(body) || title, lines: body.split('\n').length, bodyStartLine, bytes: size, text: body })
  }
  for (const path of rest) {
    let lines = null
    try { lines = readFileSync(join(repo, path), 'utf-8').split('\n').length } catch { lines = null }
    listed.push({ path, lines, why: '' })
  }
  const out = { embedded, listed, bytes, maxBytes: limit }
  return gate ? { ...out, gateInputs: gateInputs(repo, gate, tracked) } : out
}

export const docBytes = (repo, path) => { try { return statSync(join(repo, path)).size } catch { return null } }
