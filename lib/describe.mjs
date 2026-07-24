#!/usr/bin/env node
// describe.mjs — deterministic description resolver (§1a). Pure parsing, NO network.
// Fills a node's plain-language `func` from EXISTING docs (curated → docstring → README → arc42),
// so boxes show MEANING, not a bare filename. A generated string is only the last resort.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const norm = (s) => String(s).toLowerCase().trim()

// First non-empty paragraph, markdown/whitespace stripped, capped to the viewer's ~2-line clamp.
const firstPara = (text) => {
  let out = ''
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
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

export function makeDescribeCtx({ repo, byId, descriptions, docPath, containerOf }) {
  return { repo, byId, D: descriptions || {}, containerOf, readmeCache: new Map(), arc42: buildArc42Index(repo, docPath) }
}

// First hit wins. descSource records provenance for §7 enrichment + debugging.
export function resolveDescription(node, ctx) {
  const cont = ctx.containerOf(node, ctx.byId)
  const stem = String(node.name).replace(/\.\w+$/, '').replace(/ .*/, '')
  const key = cont ? `${cont}/${stem}` : null
  if (key && ctx.D[key]) return { func: ctx.D[key], descSource: 'curated' }
  if (node.description) return { func: node.description, descSource: 'curated' }
  const pth = (node.evidence || []).find((e) => e.type === 'path')
  if (pth) {
    const abs = join(ctx.repo, pth.ref)
    const ds = moduleDocstring(abs)
    if (ds) return { func: ds, descSource: 'docstring' }
    const rd = readmeFirstPara(dirname(abs), ctx.readmeCache)
    if (rd) return { func: rd, descSource: 'readme' }
  }
  const a = ctx.arc42.get(norm(node.name)) || ctx.arc42.get(norm(node.id))
  if (a) return { func: a, descSource: 'arc42' }
  if (node.kind === 'leaf') {
    const cn = (ctx.byId.get(cont) || {}).name || cont || node.parent
    return { func: `Component of module ${cn}.`, descSource: 'fallback' }
  }
  if (node.kind === 'component') return { func: `Groups related files under ${node.name}.`, descSource: 'fallback' }
  return { func: node.description || '', descSource: 'fallback' }
}
