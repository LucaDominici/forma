#!/usr/bin/env node
// cluster.mjs — shared structural helpers for the C4 model. Pure, no side effects at import.
// containerOf: climb the parent chain to the enclosing CONTAINER. Leaves may be re-parented under
//   synthetic component nodes (§2), so "the container" is no longer simply node.parent.
// componentsFor: deterministic prefix-cluster synthesis for flat containers (§2).

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x'

// The id of the nearest container-kind ancestor (or self). byId = Map(id → node).
export function containerOf(node, byId) {
  let n = node, guard = 0
  while (n && n.kind !== 'container' && n.parent && guard++ < 64) n = byId.get(n.parent)
  return n ? n.id : null
}

// Group a flat container's leaves by common `foo_*` prefix. Deterministic: sorted group keys.
// Returns { components: Node[], reparent: Map(leafId → componentId) }. Leftovers stay under the container.
export function componentsFor(container, leaves, opts = {}) {
  const groupMin = opts.groupMin || 3
  const groups = new Map()
  for (const l of leaves) {
    const base = String(l.name)
    const i = base.indexOf('_')
    if (i <= 0) continue // no prefix (e.g. "health", "version") → stays flat
    const prefix = base.slice(0, i)
    if (!groups.has(prefix)) groups.set(prefix, [])
    groups.get(prefix).push(l)
  }
  const keys = [...groups.keys()].filter((k) => groups.get(k).length >= groupMin).sort()
  if (keys.length === 0) return { components: [], reparent: new Map() }
  // no structural gain if a single surviving group swallows every leaf
  const covered = keys.reduce((s, k) => s + groups.get(k).length, 0)
  if (keys.length === 1 && covered === leaves.length) return { components: [], reparent: new Map() }
  const components = [], reparent = new Map()
  for (const k of keys) {
    const cid = `${container.id}__grp__${slug(k)}`
    components.push({
      id: cid, level: 'component', kind: 'component', parent: container.id, name: k,
      status: 'current', category: container.category || 'container',
    })
    for (const l of groups.get(k)) reparent.set(l.id, cid)
  }
  return { components, reparent }
}
