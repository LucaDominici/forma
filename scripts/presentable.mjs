#!/usr/bin/env node
// presentable.mjs — the acceptance instrument for docs/SCOPE.md.
//
// `forma check` answers "is the model still true to the code?". This answers a different and
// narrower question: "would this model survive being projected in front of a stakeholder?".
// Four predicates, measured exactly as a reader sees them on screen. Zero-dep, read-only, no network.
//
//   node scripts/presentable.mjs <path/to/c4-model.json>
//
// Exit 0 = every predicate holds. This is deliberately NOT wired into `npm test` or the gate:
// it grades a *presentation*, not the code, and it is the scope contract's measuring stick.
// When docs/SCOPE.md closes, this either becomes a gate or it goes away — it does not linger
// as an ungoverned third check.
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) { console.error('usage: node scripts/presentable.mjs <c4-model.json>'); process.exit(2) }
const m = JSON.parse(readFileSync(path, 'utf-8'))

// "As a reader sees them" has to mean the SHIPPED viewer, not a second implementation of its rules
// that drifts the first time one of them changes. So the arrow rule is lifted out of our own
// tracked HTML and evaluated — the same seam `test/run.mjs` uses, and the input is never user data.
const viewer = readFileSync(new URL('../lib/viewer/c4-hologram.html', import.meta.url), 'utf-8')
const src = (viewer.match(/\nfunction rollEdges\(edges,vis,parent\)\{[\s\S]*?\n\}/) || [])[0]
if (!src) { console.error('presentable: rollEdges not found in lib/viewer/c4-hologram.html — did it move?'); process.exit(2) }
const rollEdges = new Function(src + '; return rollEdges')()

const parents = new Set(m.nodes.map((n) => n.parent).filter(Boolean))
const kids = (p) => m.nodes.filter((n) => (p == null ? !n.parent : n.parent === p))
// A "screen" is a level the viewer actually draws: the children of one parent. A screen with a
// single box has nothing to relate, so it is exempt from the edge predicate but not from the rest.
const screens = [null, ...parents].map(kids).filter((k) => k.length > 1)
const widest = Math.max(...screens.map((k) => k.length))
// A box whose text is "6 source files." is a box the code counted, not a box a document explains.
const bare = m.nodes.filter((n) => n.parent).filter((n) =>
  !/[a-z]{4}/.test(String(n.func || n.description || '')) ||
  /^\d+ (source file|file|component)/.test(String(n.func || '')))
// Counted as the viewer draws them: each endpoint climbs to the box on this screen that contains
// it, duplicates merge into one arrow, and an edge landing inside a single box is not an arrow the
// reader sees. The catalogue collapse is ignored on purpose — it only fires above 24 siblings, and
// predicate 2 has already failed that screen.
const parent = Object.fromEntries(m.nodes.map((n) => [n.id, n.parent || null]))
const drawn = screens.map((k) => rollEdges(m.edges, Object.fromEntries(k.map((n) => [n.id, n.id])), parent).length)

const predicates = [
  ['context carries at least one external actor besides the system',
    kids(null).length >= 2, `${kids(null).length} box(es) at context`],
  ['no drawn level exceeds 24 boxes',
    widest <= 24, `widest=${widest}`],
  ['every box carries prose, not a file count',
    bare.length === 0, `bare=${bare.length}`],
  ['every drawn level with more than one box draws at least one edge',
    drawn.every((d) => d > 0), `edges per screen=${drawn.join(',')}`],
]

let ok = true
for (const [name, pass, note] of predicates) {
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}  (${note})`)
}
console.log(ok ? 'presentable: YES — now run `forma check` on the same commit' : 'presentable: NO')
process.exit(ok ? 0 : 1)
