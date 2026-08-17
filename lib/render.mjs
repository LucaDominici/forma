#!/usr/bin/env node
// render.mjs — pure, side-effect-free renderers for the arc42 projection.
// Shared by `forma doc` (writer) and `forma check` (attach-mode freshness gate) so both render the
// governed block identically. NO writeFileSync / console / process at module scope.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { containerOf } from './cluster.mjs'
import { confinedSourceRoot } from './lang.mjs'

export const BEGIN = '<!-- forma:begin (generated — do not edit) -->'
export const END = '<!-- forma:end -->'

// The deterministic, model-derived parts (never the TODO judgment prose, never volatile fields).
export function renderParts(model, opts = {}) {
  const repo = opts.repo || process.cwd()
  const m = model
  const byId = new Map(m.nodes.map((n) => [n.id, n]))
  const sid = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_')
  const C4 = { person: 'Person', system: 'System', external: 'System_Ext', container: 'Container', component: 'Component', store: 'ContainerDb', boundary: 'Container_Boundary', leaf: 'Component' }
  const q = (s) => String(s == null ? '' : s).replace(/"/g, '')
  const el = (n) => `${C4[n.kind] || 'Container'}(${sid(n.id)}, "${q(n.name)}"${n.tech ? `, "${q(n.tech)}"` : ''})`
  const rels = (ids) => m.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => `  Rel(${sid(e.from)}, ${sid(e.to)}, "${(e.label || '').replace(/"/g, '')}")`).join('\n')

  const ctx = m.nodes.filter((n) => !n.parent)
  const ctxIds = new Set(ctx.map((n) => n.id))
  const contextDiagram = `\`\`\`mermaid\nC4Context\n  title System Context\n${ctx.map((n) => '  ' + el(n)).join('\n')}\n${rels(ctxIds)}\n\`\`\``

  const sys = ctx.find((n) => n.kind === 'system') || ctx[0]
  const containers = m.nodes.filter((n) => n.parent === (sys && sys.id))
  const contIds = new Set(containers.map((n) => n.id))
  const containerDiagram = containers.length ? `\`\`\`mermaid\nC4Container\n  title Container view — ${sys.name}\n${containers.map((n) => '  ' + el(n)).join('\n')}\n${rels(contIds)}\n\`\`\`` : '_No containers in the model yet._'
  const leafCount = (id) => m.nodes.filter((n) => n.kind === 'leaf' && containerOf(n, byId) === id).length
  const containerTable = containers.length
    ? ['| Container | Tech | Leaves | What it does |', '|---|---|---|---|', ...containers.map((n) => `| ${n.name} | ${n.tech || '—'} | ${leafCount(n.id)} | ${(n.func || n.description || 'TODO(forma): describe').replace(/\n/g, ' ')} |`)].join('\n')
    : '_No containers yet._'

  const adrDir = confinedSourceRoot(repo, join(repo, 'docs/adr'))
  let adrs = '_No `docs/adr/` found — record decisions as ADRs._'
  if (existsSync(adrDir)) {
    const files = readdirSync(adrDir).filter((f) => /\.md$/.test(f) && !/readme|template/i.test(f)).sort()
    if (files.length) adrs = files.map((f) => { const t = (readFileSync(confinedSourceRoot(repo, join(adrDir, f)), 'utf-8').match(/^#\s+(.+)/m) || [, f])[1]; return `- [${t}](../adr/${f})`; }).join('\n')
  }
  const stack = (m.meta && m.meta.stack) || (sys && sys.tech) || 'TODO'
  return { contextDiagram, containerTable, containerDiagram, adrs, stack, sys, containers }
}

// The governed region injected between the sentinel markers (deterministic subset only).
export function renderBlock(model, opts = {}) {
  const p = renderParts(model, opts)
  return [
    '### Context', '', p.contextDiagram, '',
    '### Building blocks', '', p.containerTable, '', p.containerDiagram, '',
    '### Architecture decisions', '', p.adrs,
  ].join('\n')
}

// Comparison normalizer: CRLF→LF, strip trailing whitespace, trim surrounding blank lines.
export const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')

// Inner content between markers, or null unless BOTH are present and ordered.
export function extractBetween(text) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END)
  if (b === -1 || e === -1 || e < b) return null
  return text.slice(b + BEGIN.length, e)
}

// Splice the block between markers; append at EOF (creating them) if absent; throw if exactly one present.
export function replaceBetween(text, block) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END)
  const body = `${BEGIN}\n\n${block}\n\n${END}`
  if (b !== -1 && e !== -1 && e > b) return text.slice(0, b) + body + text.slice(e + END.length)
  if (b !== -1 || e !== -1) throw new Error('malformed forma markers')
  const sep = text && !text.endsWith('\n') ? '\n\n' : (text ? '\n' : '')
  return text + sep + body + '\n'
}
