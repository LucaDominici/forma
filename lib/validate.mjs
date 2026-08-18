// validate.mjs — hold the model to the schema it declares. Shared by `gen` and `check`.

// Zero deps (ADR-0001), so the engine is a hand-written walker over the ONLY keywords the
// shipped lib/schema/c4-model.schema.json uses:
//   type (object|array|string|integer|number|boolean|null), required, properties,
//   additionalProperties (false or a schema), items (single schema, no
//   tuple form), enum, minItems, minProperties, minimum, maximum, pattern, anyOf and local $ref.
// Annotation-only keywords are read and deliberately NOT enforced: $schema, $id, title,
// description, default, format — `format: "date-time"`/`"uri"` are not checked, exactly as ajv
// without ajv-formats treats them in draft-07.
// This is NOT a general JSON Schema engine. A third-party schema using oneOf/allOf/external $ref/
// patternProperties/tuple items/dependencies would be silently UNDER-validated: the unknown
// keyword is ignored, never an error. Widen this file before pointing it at another schema.
import { readFileSync } from 'node:fs'

const typeIsObject = (v) => v !== null && !Array.isArray(v) && typeof v === 'object'
const jsType = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
const typeOk = (value, type) => {
  if (type === 'object') return typeIsObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return true
}
const formatTypeError = (path, expected, value) => path + ': expected ' + expected + ', got ' + jsType(value)
const childPath = (path, key) => (path === '<root>' ? key : path + '.' + key)
const enumText = (set) => set.map((v) => typeof v === 'string' ? v : String(v)).join(', ')
const localRef = (root, ref) => {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null
  return ref.slice(2).split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((at, key) => at && at[key], root)
}
const validateAgainstSchema = (value, schema, path, errs, root) => {
  if (schema.$ref) {
    const resolved = localRef(root, schema.$ref)
    if (!resolved) errs.push(path + ': unresolved local schema reference ' + schema.$ref)
    else validateAgainstSchema(value, resolved, path, errs, root)
    return
  }
  const declared = schema.type || null
  if (declared && !typeOk(value, declared)) { errs.push(formatTypeError(path, declared, value)); return }
  if (schema.required && typeIsObject(value)) {
    for (const key of schema.required) if (!Object.prototype.hasOwnProperty.call(value, key)) errs.push(path + ': missing required property "' + key + '"')
  }
  if (schema.properties && typeIsObject(value)) {
    for (const [k, s] of Object.entries(schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue
      validateAgainstSchema(value[k], s, childPath(path, k), errs, root)
    }
  }
  if (schema.additionalProperties === false && typeIsObject(value)) {
    for (const key of Object.keys(value)) if (!schema.properties || !Object.prototype.hasOwnProperty.call(schema.properties, key)) errs.push(path + ': unexpected property "' + key + '" (additionalProperties: false)')
  }
  if (typeIsObject(schema.additionalProperties) && typeIsObject(value)) {
    for (const [key, child] of Object.entries(value)) if (!schema.properties || !Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      validateAgainstSchema(child, schema.additionalProperties, childPath(path, key), errs, root)
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, i) => validateAgainstSchema(item, schema.items, path + '[' + i + ']', errs, root))
  }
  // outside the items branch on purpose: minItems constrains the array, not its element schema
  if (schema.minItems != null && Array.isArray(value) && value.length < schema.minItems) errs.push(path + ': expected at least ' + schema.minItems + ' item, got ' + value.length)
  if (schema.minProperties != null && typeIsObject(value) && Object.keys(value).length < schema.minProperties) errs.push(path + ': expected at least ' + schema.minProperties + ' property, got ' + Object.keys(value).length)
  if (schema.anyOf && !schema.anyOf.some((branch) => {
    const branchErrs = []
    validateAgainstSchema(value, branch, path, branchErrs, root)
    return branchErrs.length === 0
  })) errs.push(path + ': does not satisfy any allowed schema shape')
  if (schema.enum && schema.enum.includes(value) === false) {
    const expected = enumText(schema.enum)
    errs.push(path + ': ' + JSON.stringify(value) + ' is not one of [' + expected + ']')
  }
  if (schema.minimum != null && typeof value === 'number' && value < schema.minimum) errs.push(path + ': ' + value + ' is less than the minimum ' + schema.minimum)
  if (schema.maximum != null && typeof value === 'number' && value > schema.maximum) errs.push(path + ': ' + value + ' is greater than the maximum ' + schema.maximum)
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(path + ': ' + JSON.stringify(value) + ' does not match ' + schema.pattern)
}

export const validateModel = (model, schemaPath = new URL('./schema/c4-model.schema.json', import.meta.url)) => {
  let schema
  try { schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) } catch (e) { return ['<root>: unable to read schema - ' + String((e && e.message) || e)] }
  const errs = []
  validateAgainstSchema(model, schema, '<root>', errs, schema)
  return errs
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k)
const clone = (v) => JSON.parse(JSON.stringify(v))
const plain = (v) => v !== null && !Array.isArray(v) && typeof v === 'object'
const edgeKey = (e) => [e.from, e.to, e.label || '', e.kind || ''].join('\u0000')
const NODE_SET_FIELDS = new Set([
  'name', 'drill', 'tech', 'description', 'status', 'link', 'evidence', 'meta', 'category',
  'status2', 'completion', 'statusWord', 'current', 'issues', 'verify', 'func', 'descSource',
  'descInputHash',
])
const EDGE_SET_FIELDS = new Set(['from', 'to', 'label', 'kind', 'status', 'evidence', 'estatus'])

function timelinePatchShape(checkpoint, at, errs) {
  const patch = checkpoint.patch || {}
  if (!plain(patch)) { errs.push(`${at}.patch: expected object`); return null }
  for (const k of Object.keys(patch)) if (!['nodes', 'edges'].includes(k)) errs.push(`${at}.patch: unexpected property "${k}"`)
  const nodes = patch.nodes || {}, edges = patch.edges || {}
  if (!plain(nodes)) errs.push(`${at}.patch.nodes: expected object`)
  if (!plain(edges)) errs.push(`${at}.patch.edges: expected object`)
  if (!plain(nodes) || !plain(edges)) return null
  for (const k of Object.keys(nodes)) if (!['add', 'update', 'remove'].includes(k)) errs.push(`${at}.patch.nodes: unexpected property "${k}"`)
  for (const k of Object.keys(edges)) if (!['add', 'rewire', 'remove'].includes(k)) errs.push(`${at}.patch.edges: unexpected property "${k}"`)
  const arrays = {
    nodeAdd: nodes.add || [], nodeUpdate: nodes.update || [], nodeRemove: nodes.remove || [],
    edgeAdd: edges.add || [], edgeRewire: edges.rewire || [], edgeRemove: edges.remove || [],
  }
  for (const [k, v] of Object.entries(arrays)) if (!Array.isArray(v)) errs.push(`${at}.${k}: expected array`)
  return Object.values(arrays).every(Array.isArray) ? arrays : null
}

function matchEdges(edges, match) {
  if (!plain(match)) return []
  return edges.map((edge, index) => ({ edge, index })).filter(({ edge }) =>
    edge.from === match.from && edge.to === match.to &&
    (!own(match, 'label') || (edge.label || '') === match.label) &&
    (!own(match, 'kind') || (edge.kind || '') === match.kind))
}

function graphErrors(model, at) {
  const errs = []
  const ids = new Set()
  for (const n of model.nodes || []) {
    if (ids.has(n.id)) errs.push(`${at}: duplicate node id "${n.id}"`)
    ids.add(n.id)
  }
  for (const n of model.nodes || []) if (n.parent != null && !ids.has(n.parent)) errs.push(`${at}: node "${n.id}" has unknown parent "${n.parent}"`)
  for (const n of model.nodes || []) {
    const seen = new Set([n.id])
    let p = n.parent
    while (p != null) {
      if (seen.has(p)) { errs.push(`${at}: parent cycle reaches "${p}" from "${n.id}"`); break }
      seen.add(p)
      const parent = (model.nodes || []).find((x) => x.id === p)
      if (!parent) break
      p = parent.parent
    }
  }
  const edgeKeys = new Set()
  for (const e of model.edges || []) {
    if (!ids.has(e.from) || !ids.has(e.to)) errs.push(`${at}: edge "${e.from}" -> "${e.to}" has an unknown endpoint`)
    const key = edgeKey(e)
    if (edgeKeys.has(key)) errs.push(`${at}: duplicate edge "${e.from}" -> "${e.to}"${e.label ? ` (${e.label})` : ''}`)
    edgeKeys.add(key)
  }
  return errs
}

// Apply an optional timeline without ever replacing the generated baseline with a second graph.
// The return value carries one materialized state per checkpoint plus the local patch metadata the
// viewer needs to accent ONLY the change from the immediately preceding checkpoint.
export function materializeTimeline(model, options = {}) {
  const timeline = model && model.timeline
  if (!timeline) return { errors: [], states: [] }
  const errs = []
  if (!plain(timeline)) return { errors: ['timeline: expected object'], states: [] }
  if (typeof timeline.source !== 'string' || !timeline.source.trim()) errs.push('timeline.source: expected a non-empty repo-relative path')
  else if (/^(?:[a-z]:[\\/]|[\\/])/i.test(timeline.source) || timeline.source.split(/[\\/]/).includes('..')) errs.push(`timeline.source: expected a path inside the repository, got ${timeline.source}`)
  else if (options.sourceExists && !options.sourceExists(timeline.source)) errs.push(`timeline.source: file missing: ${timeline.source}`)
  if (!Array.isArray(timeline.checkpoints) || !timeline.checkpoints.length) errs.push('timeline.checkpoints: expected at least one checkpoint')
  if (errs.length) return { errors: errs, states: [] }

  const reserved = new Set(['as-is']), states = []
  let current = { ...clone(model), nodes: clone(model.nodes || []), edges: clone(model.edges || []) }
  const baseSchemaErrors = validateModel(current)
  for (const e of baseSchemaErrors) errs.push(`timeline baseline schema: ${e}`)
  for (let ci = 0; ci < timeline.checkpoints.length; ci++) {
    const cp = timeline.checkpoints[ci], at = `timeline.checkpoints[${ci}]`
    if (!plain(cp)) { errs.push(`${at}: expected object`); continue }
    if (typeof cp.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(cp.id)) errs.push(`${at}.id: expected lowercase [a-z0-9._-] identifier`)
    else if (reserved.has(cp.id)) errs.push(`${at}.id: duplicate or reserved checkpoint "${cp.id}"`)
    else reserved.add(cp.id)
    if (typeof cp.label !== 'string' || !cp.label.trim()) errs.push(`${at}.label: expected a non-empty string`)
    if (own(cp, 'badge') && typeof cp.badge !== 'string') errs.push(`${at}.badge: expected string`)
    for (const k of Object.keys(cp)) if (!['id', 'label', 'badge', 'patch'].includes(k)) errs.push(`${at}: unexpected property "${k}"`)
    const ops = timelinePatchShape(cp, at, errs)
    if (!ops) continue

    const next = { ...current, nodes: clone(current.nodes), edges: clone(current.edges) }
    const touchedNodes = new Set(), removedNodes = new Set(), touchedEdges = new WeakSet()
    const delta = { nodes: [], edges: [], removedNodes: [], removedEdges: [], counts: { add: 0, update: 0, rewire: 0, remove: 0 } }
    const byId = () => new Map(next.nodes.map((n) => [n.id, n]))

    // Nodes are added parent-first so a typo cannot hide behind a later cumulative checkpoint.
    for (let i = 0; i < ops.nodeAdd.length; i++) {
      const op = ops.nodeAdd[i], p = `${at}.patch.nodes.add[${i}]`
      if (!plain(op) || !plain(op.node)) { errs.push(`${p}: expected {node, change}`); continue }
      for (const k of Object.keys(op)) if (!['node', 'change'].includes(k)) errs.push(`${p}: unexpected property "${k}"`)
      if (typeof op.change !== 'string' || !op.change.trim()) errs.push(`${p}.change: expected a non-empty string`)
      const n = op.node
      if (own(n, 'target')) errs.push(`${p}.node.target: forbidden in timeline patches; the last checkpoint is the target`)
      if (!n.id || byId().has(n.id) || touchedNodes.has(n.id)) { errs.push(`${p}: node id "${n.id || ''}" already exists or is touched twice`); continue }
      if (n.parent != null && !byId().has(n.parent)) { errs.push(`${p}: parent "${n.parent}" must exist before child "${n.id}"`); continue }
      next.nodes.push(clone(n)); touchedNodes.add(n.id)
      delta.nodes.push({ id: n.id, type: 'ADD', change: op.change }); delta.counts.add++
    }

    for (let i = 0; i < ops.nodeUpdate.length; i++) {
      const op = ops.nodeUpdate[i], p = `${at}.patch.nodes.update[${i}]`
      if (!plain(op) || !plain(op.set)) { errs.push(`${p}: expected {id, set, change}`); continue }
      for (const k of Object.keys(op)) if (!['id', 'set', 'change'].includes(k)) errs.push(`${p}: unexpected property "${k}"`)
      if (typeof op.change !== 'string' || !op.change.trim()) errs.push(`${p}.change: expected a non-empty string`)
      const target = byId().get(op.id)
      if (!target || touchedNodes.has(op.id)) { errs.push(`${p}: node "${op.id}" is unknown or touched twice`); continue }
      const bad = Object.keys(op.set).filter((k) => !NODE_SET_FIELDS.has(k))
      if (bad.length) errs.push(`${p}.set: forbidden field(s) ${bad.join(', ')}; id/parent/level/kind/target require a structural patch`)
      if (!Object.keys(op.set).length) errs.push(`${p}.set: expected at least one field`)
      if (bad.length || !Object.keys(op.set).length) continue
      Object.assign(target, clone(op.set)); touchedNodes.add(op.id)
      delta.nodes.push({ id: op.id, type: 'UPDATE', change: op.change }); delta.counts.update++
    }

    // Remove/rewire existing relations before adding new ones or deleting their endpoints.
    for (let i = 0; i < ops.edgeRemove.length; i++) {
      const op = ops.edgeRemove[i], p = `${at}.patch.edges.remove[${i}]`
      if (!plain(op) || !plain(op.match)) { errs.push(`${p}: expected {match, change}`); continue }
      for (const k of Object.keys(op)) if (!['match', 'change'].includes(k)) errs.push(`${p}: unexpected property "${k}"`)
      if (typeof op.change !== 'string' || !op.change.trim()) errs.push(`${p}.change: expected a non-empty string`)
      const found = matchEdges(next.edges, op.match)
      if (found.length !== 1 || touchedEdges.has(found[0] && found[0].edge)) { errs.push(`${p}: selector must resolve exactly one untouched edge, got ${found.length}`); continue }
      const gone = next.edges.splice(found[0].index, 1)[0]; touchedEdges.add(gone)
      delta.removedEdges.push({ ...clone(gone), type: 'REMOVE', change: op.change }); delta.counts.remove++
    }

    for (let i = 0; i < ops.edgeRewire.length; i++) {
      const op = ops.edgeRewire[i], p = `${at}.patch.edges.rewire[${i}]`
      if (!plain(op) || !plain(op.match) || !plain(op.set)) { errs.push(`${p}: expected {match, set, change}`); continue }
      for (const k of Object.keys(op)) if (!['match', 'set', 'change'].includes(k)) errs.push(`${p}: unexpected property "${k}"`)
      if (typeof op.change !== 'string' || !op.change.trim()) errs.push(`${p}.change: expected a non-empty string`)
      const bad = Object.keys(op.set).filter((k) => !EDGE_SET_FIELDS.has(k))
      if (bad.length) errs.push(`${p}.set: unexpected field(s) ${bad.join(', ')}`)
      if (!own(op.set, 'from') && !own(op.set, 'to')) errs.push(`${p}.set: a rewire must change from and/or to`)
      const found = matchEdges(next.edges, op.match)
      if (found.length !== 1 || touchedEdges.has(found[0] && found[0].edge) || bad.length || (!own(op.set, 'from') && !own(op.set, 'to'))) {
        if (found.length !== 1 || touchedEdges.has(found[0] && found[0].edge)) errs.push(`${p}: selector must resolve exactly one untouched edge, got ${found.length}`)
        continue
      }
      const edge = next.edges[found[0].index], before = clone(edge)
      Object.assign(edge, clone(op.set)); touchedEdges.add(edge)
      delta.edges.push({ ...clone(edge), type: 'REWIRE', change: op.change, before }); delta.counts.rewire++
    }

    for (let i = 0; i < ops.edgeAdd.length; i++) {
      const op = ops.edgeAdd[i], p = `${at}.patch.edges.add[${i}]`
      if (!plain(op) || !plain(op.edge)) { errs.push(`${p}: expected {edge, change}`); continue }
      for (const k of Object.keys(op)) if (!['edge', 'change'].includes(k)) errs.push(`${p}: unexpected property "${k}"`)
      if (typeof op.change !== 'string' || !op.change.trim()) errs.push(`${p}.change: expected a non-empty string`)
      const e = op.edge
      if (!e.from || !e.to || !byId().has(e.from) || !byId().has(e.to)) { errs.push(`${p}: edge endpoints must exist in this checkpoint`); continue }
      if (next.edges.some((x) => edgeKey(x) === edgeKey(e))) { errs.push(`${p}: duplicate edge "${e.from}" -> "${e.to}"`); continue }
      next.edges.push(clone(e)); delta.edges.push({ ...clone(e), type: 'ADD', change: op.change }); delta.counts.add++
    }

    for (let i = 0; i < ops.nodeRemove.length; i++) {
      const op = ops.nodeRemove[i], p = `${at}.patch.nodes.remove[${i}]`
      if (!plain(op)) { errs.push(`${p}: expected {id, change}`); continue }
      for (const k of Object.keys(op)) if (!['id', 'change'].includes(k)) errs.push(`${p}: unexpected property "${k}"`)
      if (typeof op.change !== 'string' || !op.change.trim()) errs.push(`${p}.change: expected a non-empty string`)
      const target = byId().get(op.id)
      if (!target || touchedNodes.has(op.id) || removedNodes.has(op.id)) { errs.push(`${p}: node "${op.id}" is unknown or touched twice`); continue }
      const liveChild = next.nodes.find((n) => n.parent === op.id && !removedNodes.has(n.id))
      const incident = next.edges.find((e) => e.from === op.id || e.to === op.id)
      if (liveChild) { errs.push(`${p}: remove child "${liveChild.id}" before parent "${op.id}"`); continue }
      if (incident) { errs.push(`${p}: remove or rewire incident edges before node "${op.id}"`); continue }
      next.nodes = next.nodes.filter((n) => n.id !== op.id); removedNodes.add(op.id)
      delta.removedNodes.push({ id: op.id, name: target.name, type: 'REMOVE', change: op.change }); delta.counts.remove++
    }

    for (const e of graphErrors(next, `${at} (${cp.id})`)) errs.push(e)
    const projected = clone(next); delete projected.timeline
    for (const e of validateModel(projected)) errs.push(`${at} (${cp.id}) schema: ${e}`)
    states.push({ id: cp.id, label: cp.label, badge: cp.badge || '', model: next, delta })
    current = next
  }
  return { errors: errs, states }
}
