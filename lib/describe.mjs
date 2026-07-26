#!/usr/bin/env node
// describe.mjs — deterministic description resolver (§1a). Pure parsing, NO network.
// Fills a node's plain-language `func` from EXISTING docs (curated → docstring → README → arc42),
// so boxes show MEANING, not a bare filename. A generated string is only the last resort.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { describingRows } from './docmap.mjs'

const norm = (s) => String(s).toLowerCase().trim()
// A leaf's path evidence is usually a file — but a Go package leaf IS a directory, and its README
// sits inside it, not one level up (dirname() would hand it the parent's README instead).
const ownDir = (p) => { try { return statSync(p).isDirectory() ? p : dirname(p) } catch { return dirname(p) } }

// First non-empty paragraph, markdown/whitespace stripped, capped to the viewer's ~2-line clamp.
// A leading YAML front-matter block is metadata, not prose: without this every governed repo whose
// READMEs open with `---\ntitle: …` put "--- title: 'haben — README' docversion: '2.1.0'" in a box.
const firstPara = (text) => {
  let out = ''
  const body = String(text).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '')
  for (const line of body.split('\n')) {
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

// Last resort for a node that HAS children: say what it measurably holds. Never the language —
// a box reading "TypeScript" states the one thing the reader can already see in the header.
function measuredFunc(node, ctx) {
  const kids = [...ctx.byId.values()].filter((k) => k.parent === node.id)
    .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0))
  // A node with no children still measures: its glob evidence carries the file count the drift gate
  // re-walks. Without this a Go package — one node, files as internal detail — fell through to an
  // EMPTY box, where the old duplicate leaf at least said "1 file".
  if (!kids.length) {
    const g = (node.evidence || []).find((e) => e.type === 'glob')
    return g && g.count ? `${g.count} source file${g.count === 1 ? '' : 's'}.` : null
  }
  const count = (k) => kids.filter((x) => x.kind === k).length
  const parts = [['container', count('container')], ['component', count('component')], ['file', count('leaf')]]
    .filter((p) => p[1]).map((p) => `${p[1]} ${p[0]}${p[1] === 1 ? '' : 's'}`)
  const names = kids.slice(0, 3).map((k) => k.name).join(', ')
  return `${parts.join(' + ')}: ${names}${kids.length > 3 ? ', …' : '.'}`.slice(0, 240)
}

export function makeDescribeCtx({ repo, byId, descriptions, docPath, containerOf, docIndex }) {
  return { repo, byId, D: descriptions || {}, containerOf, docIndex: docIndex || new Map(), readmeCache: new Map(), arc42: buildArc42Index(repo, docPath) }
}

// What the repo's own capability tables say about this node, quoted verbatim (§docmap).
const fromDocs = (node, ctx) => {
  const rows = describingRows(ctx.docIndex, node.id)
  if (!rows) return null
  return { func: rows.map((r) => r.text).join(' · ').slice(0, 240), descSource: 'docmap' }
}

// First hit wins. descSource records provenance for §7 enrichment + debugging.
//
// The chain is DOCUMENT-first above the leaf and CODE-first at the leaf, and that asymmetry is the
// point: a stakeholder looking at a container asks what that part of the product does for the user
// — a question the feature matrix answers and the docstring of the first file inside it does not.
// One level down, at a single file, the docstring IS the better answer.
export function resolveDescription(node, ctx) {
  const cont = ctx.containerOf(node, ctx.byId)
  const stem = String(node.name).replace(/\.\w+$/, '').replace(/ .*/, '')
  const key = cont ? `${cont}/${stem}` : null
  if (key && ctx.D[key]) return { func: ctx.D[key], descSource: 'curated' }
  if (node.description) return { func: node.description, descSource: 'curated' }
  if (node.kind !== 'leaf') { const d = fromDocs(node, ctx); if (d) return d }
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
  const d = fromDocs(node, ctx) // leaves reach it here: after their own code, before the fallback
  if (d) return d
  const a = ctx.arc42.get(norm(node.name)) || ctx.arc42.get(norm(node.id))
  if (a) return { func: a, descSource: 'arc42' }
  if (node.kind === 'leaf') {
    const cn = (ctx.byId.get(cont) || {}).name || cont || node.parent
    return { func: `Component of module ${cn}.`, descSource: 'fallback' }
  }
  return { func: node.description || measuredFunc(node, ctx) || '', descSource: 'fallback' }
}
