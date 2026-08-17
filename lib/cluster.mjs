#!/usr/bin/env node
// cluster.mjs — shared structural helpers for the C4 model. Pure, no side effects at import.
// containerOf: climb the parent chain to the enclosing CONTAINER. Leaves may be re-parented under
//   synthetic component nodes (§2), so "the container" is no longer simply node.parent.
// componentsFor: deterministic path/prefix-cluster synthesis for flat containers (§2).

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x'

// The id of the nearest container-kind ancestor (or self). byId = Map(id → node).
export function containerOf(node, byId) {
  let n = node, guard = 0
  while (n && n.kind !== 'container' && n.parent && guard++ < 64) n = byId.get(n.parent)
  return n ? n.id : null
}

// Prefer the first meaningful directory below the common source prefix (Java packages, feature
// folders); fall back to a common `foo<sep>*` name prefix for flat modules.
// Deterministic: sorted group keys.
// Returns { components: Node[], reparent: Map(leafId → componentId) }. Leftovers stay under the container.
export function componentsFor(container, leaves, opts = {}) {
  const groupMin = opts.groupMin || 3
  const paths = leaves.map((leaf) => {
    const ref = ((leaf.evidence || []).find((e) => e.type === 'path') || {}).ref
    return ref ? String(ref).replace(/\\/g, '/').split('/').slice(0, -1) : []
  })
  if (paths.length && paths.every((p) => p.length)) {
    let common = 0
    while (paths.every((p) => p[common] && p[common] === paths[0][common])) common++
    const byDir = new Map()
    for (let i = 0; i < leaves.length; i++) {
      const key = paths[i][common]
      if (key) byDir.set(key, [...(byDir.get(key) || []), i])
    }
    const pathGroups = []
    const split = (label, indexes, depth) => {
      const children = new Map()
      for (const i of indexes) if (paths[i][depth]) {
        const child = paths[i][depth]
        children.set(child, [...(children.get(child) || []), i])
      }
      const childKeys = [...children.keys()].filter((child) => children.get(child).length >= groupMin).sort()
      const childCoverage = childKeys.reduce((n, child) => n + children.get(child).length, 0)
      if (indexes.length > 200 && childKeys.length > 1 && childCoverage >= indexes.length / 2) {
        for (const child of childKeys) split(label + '/' + child, children.get(child), depth + 1)
      } else pathGroups.push([label, indexes.map((i) => leaves[i])])
    }
    for (const key of [...byDir.keys()].filter((k) => byDir.get(k).length >= groupMin).sort()) split(key, byDir.get(key), common + 1)
    if (pathGroups.length > 1) {
      const components = [], reparent = new Map()
      for (const [key, grouped] of pathGroups) {
        const cid = `${container.id}__grp__${slug(key)}`
        components.push({ id: cid, level: 'component', kind: 'component', parent: container.id, name: key,
          status: 'current', category: container.category || 'container' })
        for (const leaf of grouped) reparent.set(leaf.id, cid)
      }
      return { components, reparent }
    }
  }
  const groups = new Map()
  for (const l of leaves) {
    const base = String(l.name)
    const i = base.search(/[-_.]/)
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
