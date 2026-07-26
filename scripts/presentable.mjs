#!/usr/bin/env node
// presentable.mjs — the acceptance instrument for docs/SCOPE.md.
//
// `forma check` answers "is the model still true to the code?". This answers a different and
// narrower question: "would this model survive being projected in front of a stakeholder?".
// Five predicates, measured exactly as a reader sees them on screen. Zero-dep, read-only, no network.
// Four of them grade the SCENE — how many boxes, whether they carry prose, whether anything is
// related to anything. The fifth grades the CLAIM, and it was missing: a model reading 100% on
// every box that carried a number passed at full marks and went to Pages, because not one predicate
// read `completion`. A gate blind to the claim grades the frame, not the picture.
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

// A percentage whose only provenance is a repo document declaring itself finished is a
// DECLARATION, and `verify.derived` is the marker gen writes for exactly that (the same marker
// `check` keys off). A declaration read as a measurement is the one lie a status board cannot
// survive, and it is the badge a stakeholder reads first. `forma verify` marks a node done from a
// closed issue WITHOUT restamping its citation, so a node proven that way trips this too — and
// that complaint is correct: the board's provenance for that number still names a document.
// #43: the filter used to require `verify.derived === true`, which made this predicate grade a
// LABEL rather than a number — and a label is writable and erasable. A percentage with no citation
// at all sailed through, and `forma verify` writes exactly that shape (lib/verify.mjs: completion
// = 100, node.verify untouched). So the burden is inverted: a percentage is a declaration UNLESS
// its citation says, positively, that something measured it. Nothing in forma measures completion
// today — a doc row count is a declaration, a closed issue is a declaration — so today this
// blocks every percentage, and that is the correct answer rather than an oversight.
const measured = (n) => (n.verify || {}).measured === true
const declaimed = m.nodes.filter((n) => n.completion != null && !measured(n))

const predicates = [
  ['context carries at least one external actor besides the system',
    kids(null).length >= 2, `${kids(null).length} box(es) at context`],
  ['no drawn level exceeds 24 boxes',
    widest <= 24, `widest=${widest}`],
  ['every box carries prose, not a file count',
    bare.length === 0, `bare=${bare.length}`],
  ['every drawn level with more than one box draws at least one edge',
    drawn.every((d) => d > 0), `edges per screen=${drawn.join(',')}`],
  ['every percentage on screen is a measurement, not a declaration',
    declaimed.length === 0, declaimed.length
      ? `${declaimed.length} box(es) show a % their own citation calls declared: ${declaimed.slice(0, 5).map((n) => `${n.id}=${n.completion}% "${(n.verify || {}).source}"`).join('; ')}${declaimed.length > 5 ? ' …' : ''}`
      : `${m.nodes.filter((n) => n.completion != null).length} measured %, 0 declared`],
]

let ok = true
for (const [name, pass, note] of predicates) {
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}  (${note})`)
}
console.log(ok ? 'presentable: YES — now run `forma check` on the same commit' : 'presentable: NO')
process.exit(ok ? 0 : 1)
