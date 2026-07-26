#!/usr/bin/env node
// enrich.mjs — OPTIONAL LLM prose enrichment for description holes (§7). OFF by default.
// Contract: fills ONLY nodes whose deterministic descSource is 'fallback'; never structure, never
// the gate. Output is cached+committed in c4-model.json with descInputHash; `check` recomputes the
// hash (no network) and warns softly if stale. Providers hit their REST API via global fetch (zero-dep).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const DEFAULT_MODEL = { anthropic: 'claude-haiku-4-5', openai: 'gpt-4o-mini', ollama: 'llama3.2', echo: 'echo' }

// Sibling leaves of the same container — the "neighbors" context for a hole.
function siblingsOf(node, ctx) {
  const cont = ctx.containerOf ? ctx.containerOf(node, ctx.byId) : node.parent
  const out = []
  if (ctx.byId) for (const n of ctx.byId.values()) {
    if (n.id !== node.id && n.kind === 'leaf' && (ctx.containerOf ? ctx.containerOf(n, ctx.byId) : n.parent) === cont) out.push(String(n.name))
  }
  return { cont, siblings: out.sort() }
}

// Stable inputs that define a node's description → hash. Change them and cached prose is stale.
// Pure, no network — check.mjs imports THIS (not the providers) to flag staleness.
export function descInputHash(node, ctx) {
  const { cont, siblings } = siblingsOf(node, ctx)
  const contName = (ctx.byId && ctx.byId.get(cont) || {}).name || cont || ''
  const parts = [contName, node.name, node.kind, siblings.join(',')]
  // A component's description is composed from its CHILDREN's docs, so their prose is one of its
  // inputs. Without this, a child gaining a docstring leaves the hash unchanged: the cached LLM
  // sentence is restored over the fresh documentation, `--enrich` sees no hole and `check` stays
  // quiet — the box frozen with no way back short of hand-editing the model.
  if (node.kind === 'component' && ctx.byId) {
    parts.push([...ctx.byId.values()].filter((n) => n.parent === node.id).map((n) => String(n.func || '')).sort().join('|'))
  }
  return createHash('sha256').update(parts.join(' ')).digest('hex')
}

function promptFor(node, ctx, opts = {}) {
  const { cont, siblings } = siblingsOf(node, ctx)
  // A container is its OWN container: unguarded, the prompt tells the model that "auth" belongs to
  // the container "auth" and calls its own children its siblings. Its filesystem pointer is a glob
  // over its directory, not a path, so it also had nothing to read.
  const self = cont === node.id
  const contName = (ctx.byId && ctx.byId.get(cont) || {}).name || cont || 'the system'
  const path = (node.evidence || []).find((e) => e.type === 'path')
  const glob = !path && (node.evidence || []).find((e) => e.type === 'glob')
  return [
    `In ONE plain sentence (max 18 words), say what the software ${self ? 'module group' : 'module'} "${node.name}" does.`,
    self ? '' : `It belongs to the container "${contName}".`,
    siblings.length ? `${self ? 'The modules it holds' : 'Sibling modules'}: ${siblings.slice(0, 40).join(', ')}.` : '',
    // Only the agent enricher can act on this: a REST provider has no filesystem. That asymmetry
    // IS the point of the agent mode — the model driving forma can read the source it describes.
    (opts.canRead && path) ? `Read the file at ${path.ref} if you need certainty.` : '',
    (opts.canRead && glob) ? `Read the sources under ${glob.ref}/ if you need certainty.` : '',
    'Answer with the sentence only — no preamble, no quotes.',
  ].filter(Boolean).join('\n')
}

async function callAnthropic(prompt, { model, apiKey }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 120, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`)
  const j = await r.json()
  return (j.content || []).map((c) => c.text || '').join('').trim()
}
async function callOpenAI(prompt, { model, apiKey }) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 120, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 160)}`)
  const j = await r.json()
  return (((j.choices || [])[0] || {}).message || {}).content?.trim() || ''
}
async function callOllama(prompt, { model }) {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434'
  const r = await fetch(`${host}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  })
  if (!r.ok) throw new Error(`ollama ${r.status}`)
  return String((await r.json()).response || '').trim()
}
async function callEcho() { return 'Auto-described (test enricher).' } // deterministic, no network — used by tests

const PROVIDERS = { anthropic: callAnthropic, openai: callOpenAI, ollama: callOllama, echo: callEcho }

// Cache: prior committed model → Map(id → node). mergeCache restores llm prose on unchanged inputs
// (runs ALWAYS, even without --enrich, so a plain regen doesn't destroy valid enrichment). Pure.
export function loadCache(priorModelPath) {
  try { return new Map((JSON.parse(readFileSync(priorModelPath, 'utf-8')).nodes || []).map((n) => [n.id, n])) } catch { return new Map() }
}
// Stale prose (inputs changed) is restored TOO, keeping its old hash: a network outage must never
// make a box worse than it was. `check` keeps warning about it and the next --enrich refills it
// (see the hole selection below, which admits llm nodes whose hash no longer matches).
export function mergeCache(nodes, cache) {
  let restored = 0
  for (const n of nodes) {
    if (n.descSource !== 'fallback') continue
    const prev = cache.get(n.id)
    if (prev && prev.descSource === 'llm' && prev.descInputHash && prev.func) {
      n.func = prev.func; n.descSource = 'llm'; n.descInputHash = prev.descInputHash; restored++
    }
  }
  return restored
}

// The holes an enricher would fill: never-described nodes, plus llm prose whose inputs moved.
// Containers count. They were excluded on the theory that the topology describes them — but on a
// repo with no curated topology (i.e. anything `forma init` seeded) they are exactly the boxes
// left on a measured fallback, and the biggest ones on screen.
export function holesIn(nodes, ctx) {
  return nodes.filter((n) => (n.kind === 'leaf' || n.kind === 'component' || n.kind === 'container') &&
    (n.descSource === 'fallback' || (n.descSource === 'llm' && n.descInputHash !== descInputHash(n, ctx))))
}

// --enricher agent: no network, no API key. When an AGENT drives forma the LLM is already in the
// room — asking it to call a REST API with a key it doesn't have is the one thing that made
// ollama look like a default. Emit the work instead, and let the agent write the prose.
export function agentPlan(nodes, ctx) {
  return holesIn(nodes, ctx).map((n) => ({ id: n.id, prompt: promptFor(n, ctx, { canRead: true }), descInputHash: descInputHash(n, ctx) }))
}

// §WP-A7) The STATE holes, counterpart of the prose ones above. A node is a hole when no overlay
// has ruled on it — `status2: unknown`, which since 0.6.0 is the honest default and therefore also
// the measure of how empty the board is.
//
// The entries carry EVIDENCE, never a verdict. Deriving the verdict here was tried and dropped: a
// feature matrix's status column read 40 DONE out of 51 rows on the repo this was measured against,
// while that repo's own audit records the matrix as missing eight shipped modules. Mapping that
// column onto completion:100 paints a board green out of a stale document — the invented 100% this
// tool exists to kill, with a provenance stamp on it. So the rows go into the plan verbatim and
// whoever fills it decides. Issue numbers are `issueCandidates` for the same reason: a note reading
// "Gimmick #5" is not a reference to issue 5, and `forma verify` would close a node on it.
export function statusPlan(nodes, rowsFor) {
  const out = []
  for (const n of nodes) {
    if (n.status2 && n.status2 !== 'unknown') continue // already ruled on
    const rows = (rowsFor ? rowsFor(n) : []) || []
    const cand = [...new Set(rows.flatMap((r) => String(r.raw || '').match(/#\d+/g) || []))]
    out.push({
      id: n.id, name: String(n.name), kind: n.kind, func: String(n.func || ''),
      ...(rows.length ? { documents: rows.slice(0, 5).map((r) => r.raw || r.desc) } : {}),
      ...(cand.length ? { issueCandidates: cand } : {}),
      prompt: [
        `What is the programme state of "${n.name}"?`,
        rows.length
          ? 'The rows under "documents" are what this repo says about it — quote them, do not improve on them.'
          : 'No document in this repo rules on it. If you cannot tell, leave it out of the fill: `unknown` is a true answer.',
        cand.length ? 'Under "issueCandidates" are #N tokens found in those rows — keep only the ones that really are issues.' : '',
        'Answer with the fields you can support: status2 (done|in-progress|next|planned|problem), completion (0-100),',
        'statusWord, current (what holds today), target (where it must land), issues (["#123"]).',
      ].filter(Boolean).join('\n'),
    })
  }
  return out
}

// Apply prose an agent (or a human) wrote for those holes. Enrichment NEVER overwrites a real
// document: a fill aimed at a curated/docstring/readme/arc42 node is an error, not a silent skip.
export function applyFills(nodes, ctx, fills) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let applied = 0
  for (const f of fills) {
    const n = byId.get(f && f.id)
    if (!n) throw new Error(`--enrich-apply: unknown node id "${f && f.id}"`)
    if (!f.func || !String(f.func).trim()) throw new Error(`--enrich-apply: "${f.id}" has no func text`)
    if (n.descSource !== 'fallback' && n.descSource !== 'llm') throw new Error(`--enrich-apply: "${f.id}" is described by its ${n.descSource} — enrichment never overwrites documentation`)
    n.func = String(f.func).trim(); n.descSource = 'llm'; n.descInputHash = descInputHash(n, ctx); applied++
  }
  return applied
}

// --enrich only: fill still-empty holes via the network. Best-effort: a provider error stops the
// pass (returns partial) rather than aborting gen — the caller keeps the deterministic fallback.
export async function enrich(nodes, ctx, opts = {}) {
  const provider = opts.provider || 'anthropic'
  const call = PROVIDERS[provider]
  if (!call) throw new Error(`unknown enricher "${provider}" (anthropic|openai|ollama)`)
  const model = opts.model || DEFAULT_MODEL[provider]
  const apiKey = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : provider === 'openai' ? process.env.OPENAI_API_KEY : ''
  if ((provider === 'anthropic' || provider === 'openai') && !apiKey) throw new Error(`--enrich: ${provider} needs ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} in the environment`)
  const holes = holesIn(nodes, ctx)
  let filled = 0
  for (const n of holes) {
    const text = await call(promptFor(n, ctx), { model, apiKey })
    if (text) { n.func = text; n.descSource = 'llm'; n.descInputHash = descInputHash(n, ctx); filled++ }
  }
  return { filled, holes: holes.length }
}
