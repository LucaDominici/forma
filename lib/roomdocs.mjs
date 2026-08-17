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

export const DEFAULT_MAX_BYTES = 400000

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
  let listed
  try {
    listed = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
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
function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return { body: text, title: null }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { body: text, title: null }
  const head = text.slice(4, end)
  const m = /^title:\s*['"]?(.*?)['"]?\s*$/m.exec(head)
  const after = text.indexOf('\n', end + 1)
  return { body: after < 0 ? '' : text.slice(after + 1).replace(/^\n+/, ''), title: m ? m[1] : null }
}

/**
 * @param canon paths embedded in full, in the order given. Everything else selected by the globs is
 *   listed with a link but not carried — "have the whole project in view" is worth a page of prose,
 *   not a copy of every repository.
 */
export function loadDocs(repo, { include, canon, maxBytes } = {}) {
  const limit = maxBytes || DEFAULT_MAX_BYTES
  const paths = trackedDocs(repo, include)
  if (!paths.length) return { embedded: [], listed: [], bytes: 0, maxBytes: limit }
  const canonSet = new Set(canon || [])
  // Canon order follows the declaration, so a reading order somebody chose survives into the page.
  const wanted = (canon || []).filter((p) => paths.includes(p))
  const rest = paths.filter((p) => !canonSet.has(p))
  const embedded = [], listed = []
  let bytes = 0
  for (const path of wanted) {
    let raw
    try { raw = readFileSync(join(repo, path), 'utf-8') } catch (e) { listed.push({ path, lines: null, why: String((e && e.message) || e) }); continue }
    const { body, title } = stripFrontmatter(raw)
    const size = Buffer.byteLength(body)
    // A reason CODE, not a sentence: the viewer speaks two languages and lib/ speaks none. A
    // backend string rendered straight into the page is a locale hole nobody notices until the
    // page is read in the other one.
    if (bytes + size > limit) { listed.push({ path, lines: body.split('\n').length, why: 'budget' }); continue }
    bytes += size
    embedded.push({ path, title: titleOf(body) || title, lines: body.split('\n').length, bytes: size, text: body })
  }
  for (const path of rest) {
    let lines = null
    try { lines = readFileSync(join(repo, path), 'utf-8').split('\n').length } catch { lines = null }
    listed.push({ path, lines, why: '' })
  }
  return { embedded, listed, bytes, maxBytes: limit }
}

export const docBytes = (repo, path) => { try { return statSync(join(repo, path)).size } catch { return null } }
