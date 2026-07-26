#!/usr/bin/env node
// describe.mjs — deterministic description resolver (§1a). Pure parsing, NO network.
// Fills a node's plain-language `func` from EXISTING docs (curated → docstring → README →
// arc42 → generated fallback), so boxes show MEANING, not a bare filename.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

const norm = (s) => String(s).toLowerCase().trim()
const PATH_TOKEN = /^[\w.\-]+(?:\/[\w.\-]+)*$/

// A leaf's path evidence is usually a file — but a Go package leaf IS a directory, and its README
// sits inside it, not one level up (dirname() would hand it the parent's README instead).
const ownDir = (p) => { try { return statSync(p).isDirectory() ? p : dirname(p) } catch { return dirname(p) } }

// A feature matrix is a markdown table whose rows name a capability AND the code that implements
// it. That second half is what makes it usable without guessing: the document itself states the
// mapping, so nothing here has to match a heading against a node name (the arc42 branch below does,
// and it can only ever fire on a heading literally called after a node).
// A row yields: every inline-code token that LOOKS like a path, and the leftmost cell that reads
// like a sentence — which skips the id column (`FM-001`: no space) and the status column (`DONE`).
// Pure: no filesystem, no repo knowledge. `init` does the on-disk qualification (see init.mjs).
export function parseFeatureDoc(text) {
  const rows = []
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.split('|')
    if (cells[0] === '') cells.shift()
    if (cells[cells.length - 1] === '') cells.pop()
    if (!cells.length) continue
    if (cells.every((c) => /^\s*[-:\s]*$/.test(c))) continue // markdown table divider row

    const paths = []
    const seen = new Set()
    for (const c of cells) {
      for (const m of c.matchAll(/`([^`]+)`/g)) {
        const token = String(m[1]).trim().replace(/\/$/, '')
        if (!token || /^\d+$/.test(token)) continue
        if (!PATH_TOKEN.test(token) || seen.has(token)) continue
        paths.push(token)
        seen.add(token)
      }
    }

    let desc = null
    for (const c of cells) {
      const plain = c.replace(/`[^`]*`/g, '').replace(/[*_`>]+/g, '').replace(/\s+/g, ' ').trim()
      if (!plain || plain.length < 12 || !plain.includes(' ')) continue
      desc = plain.slice(0, 240)
      break
    }
    if (!paths.length || !desc) continue
    // `raw` is the untouched row. The description is a clamped fragment; the status channel needs
    // what the row ACTUALLY says — a status word, an issue reference, a caveat in the note column.
    rows.push({ paths, desc, raw: line })
  }
  return rows
}

// First non-empty paragraph, markdown/whitespace stripped, capped to the viewer's ~2-line clamp.
// A leading YAML frontmatter block is not prose: without this, any governed README (title:, owner:,
// status: …) hands the box its own metadata header — measured on haben, whose root README put
// "--- title: 'haben — README' docversion: '2.1.0' status: active …" into two container boxes.
const firstPara = (text) => {
  let out = ''
  for (const line of String(text).replace(/\r\n/g, '\n').replace(/^\s*---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const l = line.trim()
    if (/^#{1,6}\s/.test(l)) continue // skip markdown headings
    if (!l) { if (out) break; else continue } // blank ends the paragraph (once started)
    out += (out ? ' ' : '') + l
  }
  out = out.replace(/[*_`>]+/g, '').replace(/\s+/g, ' ').trim()
  return out ? out.slice(0, 240) : null
}

// ponytail: leading-block heuristic, no AST — a docstring placed AFTER code is missed.
function moduleDocstring(absPath) {
  let src; try { src = readFileSync(absPath, 'utf-8') } catch { return null }
  const body = src.replace(/^﻿/, '').replace(/^#![^\n]*\n/, '')
  if (/\.py$/i.test(absPath)) {
    const m = body.match(/^\s*(?:#[^\n]*\n\s*)*(?:r|u|b)?("""|''')([\s\S]*?)\1/i)
    return m ? firstPara(m[2]) : null
  }
  if (/\.(mjs|cjs|js|jsx|ts|tsx|mts|cts)$/i.test(absPath)) {
    const block = body.match(/^\s*\/\*\*?([\s\S]*?)\*\//)
    if (block) return firstPara(block[1].replace(/^\s*\*\s?/gm, '').replace(/@\w+/g, ''))
    const cmt = []
    for (const l of body.replace(/^\s+/, '').split('\n')) { const t = l.trim(); if (t.startsWith('//')) cmt.push(t.replace(/^\/\/+\s?/, '')); else break }
    return cmt.length ? firstPara(cmt.join(' ')) : null
  }
  return null
}

function readmeFirstPara(dir, cache) {
  if (cache.has(dir)) return cache.get(dir)
  let out = null
  try { const p = join(dir, 'README.md'); if (existsSync(p)) out = firstPara(readFileSync(p, 'utf-8')) } catch {}
  cache.set(dir, out)
  return out
}

// Map(normalizedHeading → lead paragraph) from the mapped arc42 doc, read once. ponytail: exact
// normalized-heading match, no fuzzy mapping.
function buildArc42Index(repo, docPath) {
  const idx = new Map()
  if (!docPath) return idx
  let text; try { text = readFileSync(join(repo, docPath), 'utf-8') } catch { return idx }
  const parts = text.split(/^#{1,6}\s+(.+)$/m) // [pre, heading, body, heading, body, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const lead = firstPara(parts[i + 1] || '')
    if (parts[i] && lead) idx.set(norm(parts[i]), lead)
  }
  return idx
}

const featureRel = (rowPath, nodePath) => rowPath === nodePath || nodePath.startsWith(rowPath + '/') || rowPath.startsWith(nodePath + '/')
const firstSentence = (s) => (String(s).match(/^[^.!?]*[.!?]/) || [String(s)])[0].trim()

// The rows of the matrix that address this node, most specific first. Exported because the status
// channel (§WP-A7) shows an agent the SAME rows that described the box — a plan whose evidence is a
// different document from the one on screen is a plan nobody can check.
export function matchFeatureRows(node, featureRows, byId) {
  if (!featureRows || !featureRows.length) return [] // the common case: no featureDocs, skip the walk
  // A container's own evidence is a glob over its PARENT directory (`internal` for every one of
  // haben's 53 packages) — useless as an address. Its real addresses are its descendants' paths.
  const ownPaths = new Set()
  const own = (node.evidence || []).find((e) => e.type === 'path')
  if (own) ownPaths.add(own.ref)
  else {
    const q = [node.id]
    const seen = new Set()
    while (q.length) {
      const cur = q.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const child of byId.values()) {
        if (child.parent !== cur) continue
        for (const e of (child.evidence || [])) if (e.type === 'path' && e.ref) ownPaths.add(e.ref)
        q.push(child.id)
      }
    }
  }
  if (!ownPaths.size) return []

  const exact = []
  const related = []
  for (const row of featureRows) {
    let isExact = false
    let isRelated = false
    outer:
    for (const rowPath of row.paths) {
      for (const ownPath of ownPaths) {
        if (rowPath === ownPath) { isExact = true; break outer }
        if (featureRel(rowPath, ownPath)) isRelated = true
      }
    }
    if (isExact) exact.push(row)
    else if (isRelated) related.push(row)
  }
  return exact.length ? exact : related
}

const resolveFeatureMatrix = (node, featureRows, byId) => {
  const hit = matchFeatureRows(node, featureRows, byId)
  if (!hit.length) return null
  if (hit.length === 1) return hit[0].desc
  const txt = hit.slice(0, 3).map((r) => firstSentence(r.desc)).join(' ')
  return txt.length > 240 ? txt.slice(0, 239) + '…' : txt
}

function loadFeatureRows(repo, featureDocs) {
  const rows = []
  for (const rel of featureDocs || []) {
    try { rows.push(...parseFeatureDoc(readFileSync(join(repo, rel), 'utf-8'))) } catch {}
  }
  return rows
}

// Last resort for a node that HAS children: say what it measurably holds. Never the language —
// a box reading "TypeScript" states the one thing the reader can already see in the header.
function measuredFunc(node, ctx) {
  const kids = [...ctx.byId.values()].filter((k) => k.parent === node.id)
    .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0))
  if (!kids.length) return null
  const count = (k) => kids.filter((x) => x.kind === k).length
  const parts = [['container', count('container')], ['component', count('component')], ['file', count('leaf')]]
    .filter((p) => p[1]).map((p) => `${p[1]} ${p[0]}${p[1] === 1 ? '' : 's'}`)
  const names = kids.slice(0, 3).map((k) => k.name).join(', ')
  return `${parts.join(' + ')}: ${names}${kids.length > 3 ? ', …' : '.'}`.slice(0, 240)
}

export function makeDescribeCtx({ repo, byId, descriptions, docPath, containerOf, featureDocs }) {
  return {
    repo, byId, D: descriptions || {}, containerOf, featureRows: loadFeatureRows(repo, featureDocs || []),
    readmeCache: new Map(), arc42: buildArc42Index(repo, docPath),
  }
}

// First hit wins. descSource records provenance for §7 enrichment + debugging.
export function resolveDescription(node, ctx) {
  const cont = ctx.containerOf(node, ctx.byId)
  const stem = String(node.name).replace(/\.\w+$/, '').replace(/ .*/, '')
  const key = cont ? `${cont}/${stem}` : null
  // Resolved at TWO positions, never both: above the code for a container (a stakeholder asks what
  // the piece does for the user, not which docstring the first file inside carries) and below it
  // for a leaf (there, the code IS the closest documentation).
  const feature = () => resolveFeatureMatrix(node, ctx.featureRows || [], ctx.byId)
  if (key && ctx.D[key]) return { func: ctx.D[key], descSource: 'curated' }
  if (node.description) return { func: node.description, descSource: 'curated' }
  if (node.kind !== 'leaf') { const f = feature(); if (f) return { func: f, descSource: 'featurematrix' } }
  const pth = (node.evidence || []).find((e) => e.type === 'path')
  if (pth) {
    const abs = join(ctx.repo, pth.ref)
    const ds = moduleDocstring(abs)
    if (ds) return { func: ds, descSource: 'docstring' }
    const rd = readmeFirstPara(ownDir(abs), ctx.readmeCache)
    if (rd) return { func: rd, descSource: 'readme' }
  }
  // A container's evidence is a GLOB over its own directory, never a `path` — which is why the
  // README sitting in that very directory never reached it, and the box fell through to `tech`.
  const glb = (node.evidence || []).find((e) => e.type === 'glob')
  if (!pth && glb) {
    const rd = readmeFirstPara(join(ctx.repo, glb.ref), ctx.readmeCache)
    if (rd) return { func: rd, descSource: 'readme' }
  }
  if (node.kind === 'leaf') { const f = feature(); if (f) return { func: f, descSource: 'featurematrix' } }
  const a = ctx.arc42.get(norm(node.name)) || ctx.arc42.get(norm(node.id))
  if (a) return { func: a, descSource: 'arc42' }
  if (node.kind === 'leaf') {
    const cn = (ctx.byId.get(cont) || {}).name || cont || node.parent
    return { func: `Component of module ${cn}.`, descSource: 'fallback' }
  }
  return { func: node.description || measuredFunc(node, ctx) || '', descSource: 'fallback' }
}
