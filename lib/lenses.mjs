// lenses.mjs — the declared lens partition of the Control Room, and the analyzer that proves the
// viewer honours it (I20). ADR-0008 named a portfolio and six lenses, one question each, and said
// the partition "is only real if it is enforced, so the one-home rule becomes an invariant with a
// tamper test when the lenses land, not a convention in this document". This is that landing.
//
// The five-view IA it replaces was enforced by one line in scripts/room-presentable.mjs comparing
// the tab list to a hard-coded array. That check could not see the thing that actually went wrong:
// `derived.commitDrift` was rendered on two views, `derived.kpis` on two, `derived.rtm` on three —
// and the code SAID so, in a comment reading "the same fact `tech` reports, on the surface that
// shows it". A comment is not a mechanism. Meanwhile `derived.criticalPath`, `derived.milestonePath`
// and `derived.milestoneReconciliation` were computed, gated, and rendered nowhere at all: the
// opposite failure, invisible for the same reason.
//
// So both directions are checked, against the shipped viewer:
//
//   declared here  ==  measured out of lib/viewer/control-room.html
//
// The viewer is partitioned by `/*lens:<id>*/` marker comments. Every `derived.<surface>` read
// belongs to whichever region encloses it, regions may repeat (the rule is about which lens owns a
// function, not about file order), and the shared-primitive region may read nothing derived at all.
// Moving a panel between lenses therefore means moving its code across a marker — visible in the
// diff, and refused if it leaves the surface with two homes or none.

/** Every key deriveAll returns. Pinned here so a new derivation cannot be added without deciding, in
 *  the same diff, which lens renders it — or saying out loud that nothing does and why. */
export const DERIVED_KEYS = [
  'blocks', 'brief', 'briefDelta', 'capabilities', 'checkpoints', 'commitDrift', 'criticalPath',
  'dependencies', 'documentGate', 'findings', 'health', 'history', 'kanban', 'kanbanHumanDeclared',
  'kpis', 'lenses', 'link', 'milestonePath', 'milestoneReconciliation', 'milestones', 'queue', 'rtm',
]

/** The shell owns routing, the nav and the inclusion drawer — no lens's question, so it holds only
 *  the publication map it mounts routes from. */
export const SHELL_OWNS = ['lenses']

/** Computed and deliberately rendered by no lens. An entry here is a claim a reader can check, not
 *  an exemption: each names what consumes the surface instead. */
export const UNRENDERED = [
  {
    key: 'dependencies',
    why: 'the raw GitHub dependency snapshot. Three surfaces are derived FROM it — criticalPath, blocks and the capability ledger — and each carries its own completeness flag, so rendering the snapshot again would be the same fact wearing a fourth face.',
  },
  {
    key: 'queue',
    why: 'an intermediate: deriveBlocks and derivePortfolio both consume it, and what a reader is shown is the blocks it produces. Rendering the queue as well would put one clustering on screen twice.',
  },
]

const has = (v) => v !== null && v !== undefined
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : has(v))
const signalsDeclared = (program) => {
  const signals = (program.issuesSnapshot || {}).signals || {}
  const workflows = Object.keys(signals.workflows || {})
  const release = signals.release || {}
  return workflows.length > 0 || release.listState === 'present'
}
const docsPresent = (program) => {
  const docs = program.docs || {}
  return nonEmpty(docs.embedded) || nonEmpty(docs.listed)
}
const openIssues = (program) => ((program.issuesSnapshot || {}).issues || []).some((it) => it.state === 'OPEN')

/**
 * Portfolio + six lenses, one question each (owner decision 5).
 *
 * `publishes` is the per-lens publication predicate that replaces the five-view route table. A lens
 * publishes when its backing artifacts exist and is honestly ABSENT when they do not — never a
 * reserved empty panel (I7, UX finding F1). This is the whole fix for the flagship demo reading
 * "0 things need you out of 0 open across 1 programmes" beside a flat-line chart and three panels
 * saying "No data available.": on that programme, four of the six lenses simply do not exist.
 */
export const LENSES = [
  {
    id: 'portfolio',
    route: '/',
    question: 'Which programme needs me now?',
    // Reads ROOM.portfolio, which derivePortfolio computes ACROSS programmes; nothing per-programme.
    // The cross-programme capability ledger and "cumulative code landings" panels that used to sit
    // here answered a different question and gave two surfaces a second home — they are now the
    // traceability and verdict lenses' alone.
    owns: [],
    publishes: () => true,
  },
  {
    id: 'verdict',
    route: 'verdict',
    question: 'Can I trust this programme\'s claims today?',
    owns: ['brief', 'briefDelta', 'findings', 'health', 'history', 'kpis'],
    // There is always a verdict, including "everything is closed and nothing is claimed".
    publishes: () => true,
  },
  {
    id: 'plan',
    route: 'plan',
    question: 'What happens when, and what blocks the date?',
    owns: ['blocks', 'criticalPath', 'kanban', 'kanbanHumanDeclared', 'milestonePath', 'milestoneReconciliation', 'milestones'],
    publishes: (program) => {
      const d = program.derived || {}
      return openIssues(program) || nonEmpty(d.milestones) || has(d.milestonePath)
    },
  },
  {
    id: 'architecture',
    route: 'architecture',
    question: 'What is the system, and how complete is our picture of it?',
    owns: ['checkpoints', 'commitDrift', 'link'],
    publishes: (program) => program.hasMap === true,
  },
  {
    id: 'traceability',
    route: 'traceability',
    question: 'Is what we promised built, and proven?',
    owns: ['capabilities', 'rtm'],
    publishes: (program) => has((program.derived || {}).rtm) || has((program.derived || {}).capabilities),
  },
  {
    id: 'operations',
    route: 'operations',
    question: 'Can we run it, and survive it failing?',
    // No derived surface yet: what this lens renders today is the repository's own CI and release
    // signals, which live on the snapshot. Runbook-to-invariant coverage and tabletop hotwashes are
    // the wave-8 additions, and they land here.
    owns: [],
    publishes: signalsDeclared,
  },
  {
    id: 'provenance',
    route: 'provenance',
    question: 'Why is it this way, and on whose authority?',
    owns: ['documentGate'],
    publishes: (program) => docsPresent(program) || has((program.derived || {}).documentGate),
  },
]

export const lensById = (id) => LENSES.find((lens) => lens.id === id) || null

/**
 * Which lenses this programme publishes. Computed in roomderive so `check` re-derives and compares
 * it like every other aggregate: a hand-edited briefing that mounts a route its artifacts do not
 * support fails the gate naming the lens.
 * @param {Record<string, unknown>} program
 * @returns {Record<string, boolean>}
 */
export function derivedLenses(program) {
  const out = {}
  for (const lens of LENSES) out[lens.id] = lens.publishes(program) === true
  return out
}

const MARKER = /\/\*lens:([a-z-]+)\*\//g
const READ = /(?:^|[^A-Za-z0-9_$])derived\.([A-Za-z_$][\w$]*)/g
const COMPUTED = /(?:^|[^A-Za-z0-9_$])derived\s*\[/

/**
 * Split the viewer on its `/*lens:<id>*​/` markers, from the first marker onward. Nothing before it
 * is analyzed, and nothing viewer-written lives there: OPENS_AT requires the first region to be the
 * first line of the script. What DOES live above it, in a composed briefing, is the injected data —
 * the room JSON, the locale tables, the embedded canon. That text is repository prose, and this
 * document's own I20 section quotes `derived.health` in it, so treating the head of the file as a
 * region would fail every artifact whose documents talk about the rule.
 * @param {string} html
 * @returns {Map<string, string>}
 */
export function scriptRegions(html) {
  const regions = new Map()
  const marks = [...html.matchAll(MARKER)]
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : html.length
    regions.set(mark[1], (regions.get(mark[1]) || '') + '\n' + html.slice(mark.index + mark[0].length, end))
  })
  return regions
}

/** The derived surfaces one region reads. @param {string} text @returns {Set<string>} */
export function derivedReads(text) {
  const found = new Set()
  for (const match of String(text || '').matchAll(READ)) found.add(match[1])
  return found
}

/** The viewer's script must open ON a region, so no viewer code can sit outside the partition. */
const OPENS_AT = /"use strict";\s*\/\*lens:/

/** Regions that may hold no derived read at all, with the reason each is barred. */
const BARRED = {
  shared: 'the shared-primitive region — a primitive that reaches into a derived surface gives that surface a home in every lens that calls it',
}

/** @param {Map<string, string>} regions @param {string[]} expected @returns {string[]} */
function structureViolations(html, regions, expected) {
  const out = []
  if (!OPENS_AT.test(html)) out.push('the viewer script does not open on a lens region, so code can sit outside the partition')
  for (const id of expected) if (!regions.has(id)) out.push(`the viewer declares no /*lens:${id}*/ region`)
  for (const id of regions.keys()) {
    if (!expected.includes(id)) out.push(`/*lens:${id}*/ names a region no lens declares`)
    if (COMPUTED.test(regions.get(id) || '')) out.push(`region "${id}" reaches a derived surface by computed key, which no ownership check can attribute`)
  }
  for (const [id, why] of Object.entries(BARRED)) {
    for (const key of derivedReads(regions.get(id) || '')) out.push(`derived.${key} is read in ${why}`)
  }
  return out
}

/** @param {Map<string, Set<string>>} byRegion @returns {string[]} */
function duplicateHomes(byRegion) {
  const homes = new Map()
  for (const [id, keys] of byRegion) for (const key of keys) homes.set(key, (homes.get(key) || []).concat(id))
  return [...homes]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => `derived.${key} is rendered by ${ids.length} lenses (${ids.join(', ')}) — I20 gives every surface exactly one home`)
}

/**
 * I20, measured: every derived surface has exactly one home lens, the viewer reads what the table
 * declares, and the table declares nothing the viewer does not read.
 * @param {string} html the viewer source
 * @param {string[]} derivedKeys every key deriveAll returns
 * @param {typeof LENSES} lenses
 * @returns {string[]} violations, empty when the partition holds
 */
export function ownershipViolations(html, derivedKeys, lenses = LENSES) {
  const declared = new Map(lenses.map((lens) => [lens.id, lens.owns]))
  declared.set('shell', SHELL_OWNS)
  const regions = scriptRegions(html)
  const out = structureViolations(html, regions, [...declared.keys(), 'shared'])

  const byRegion = new Map()
  for (const [id, owns] of declared) {
    const read = derivedReads(regions.get(id) || '')
    byRegion.set(id, read)
    for (const key of owns) if (!read.has(key)) out.push(`lens "${id}" declares derived.${key} and never reads it`)
    for (const key of read) if (!owns.includes(key)) out.push(`lens "${id}" reads derived.${key} without declaring it`)
  }
  out.push(...duplicateHomes(byRegion))

  const owned = new Set([...declared.values()].flat())
  for (const key of derivedKeys) {
    if (owned.has(key) || UNRENDERED.some((u) => u.key === key)) continue
    out.push(`derived.${key} is computed and rendered by no lens, and is not declared unrendered`)
  }
  return out
}
