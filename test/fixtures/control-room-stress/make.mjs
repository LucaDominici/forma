// Deterministic high-cardinality room data for browser/DOM acceptance tests.
// Usage: node test/fixtures/control-room-stress/make.mjs [total] [open]
//        node test/fixtures/control-room-stress/make.mjs --html <template> <out>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The IA comes from the one table the composer injects, never a copy of it — a fixture that
// restated the routes would go on measuring an IA the product had left behind.
import { LENSES, derivedLenses } from '../../../lib/lenses.mjs'

const LENS_SPEC = LENSES.map(({ id, route, question }) => ({ id, route, question }))
export function makeStressRoom(total = 2500, openCount = 250) {
  const issues = []
  for (let n = 1; n <= total; n++) issues.push({
    n,
    title: `Deterministic stress issue ${n}`,
    state: n <= openCount ? 'OPEN' : 'CLOSED',
    labels: n <= openCount && n % 7 === 0 ? ['priority:p1'] : [],
    ms: n <= openCount && n % 3 === 0 ? 'R1' : null,
    createdAt: '2026-01-01',
    closedAt: n <= openCount ? null : '2026-08-01',
  })
  const open = issues.slice(0, openCount).map((issue) => issue.n)
  const closed = issues.slice(openCount).map((issue) => issue.n)
  const clusters = []
  for (let i = 0; i < open.length; i += 50) clusters.push({ key: `priority ${i / 50 + 1}`, issues: open.slice(i, i + 50) })
  const summary = {
    id: 'stress', ghRepo: 'example/stress', hasMap: false, open: openCount,
    closed: total - openCount, total, blockedRule: { declared: true, inert: false, labels: ['needs-human'] },
    blocked: 0, snapshotAgeDays: 0, milestones: [], workPerNode: null,
    workPerNodeOpen: null, linkCoverage: null, commitDrift: null,
    taxonomy: { axes: [], other: [], clusterFamily: null },
  }
  return {
    meta: { title: 'Stress briefing', today: '2026-08-17', generatedFrom: 'stress/forma.room.json', excluded: [] },
    portfolio: {
      totals: { programs: 1, issues: total, open: openCount, closed: total - openCount, blocked: 0, unknownRule: 0 },
      programs: [summary], blocked: [], moving: [{ program: 'stress', count: openCount, byCluster: clusters }], landing: [{ program: 'stress', months: [] }],
    },
    programs: [{
      id: 'stress', ghRepo: 'example/stress', hasMap: false,
      issuesSnapshot: { fetchedAt: '2026-08-17T12:00:00Z', issues, milestones: [] },
      health: null, findings: null, docs: null, model: null,
      derived: {
        kpis: { openCount, needsHumanCount: 0, staleMilestones: [], noMilestoneCount: openCount, linkCoveragePct: null, snapshotAgeDays: 0 },
        milestones: [], history: null,
        kanban: { chiuse: closed, sane: [], 'a-meta': [], 'premessa-falsa': [], 'aspettano-umano': [], 'non-auditate': open },
        queue: { axes: [], other: [], clusterFamily: null, clusters },
        commitDrift: null, checkpoints: null, link: null, rtm: null,
        // Under the lens IA the routing mounts what a programme PUBLISHES (I20), so a fixture with
        // no `lenses` block composes a shell with no programme route at all — and every DOM,
        // paging, mobile and print measurement taken over it would be measuring an empty page.
        // This is the stress programme's honest set: 2,500 issues and nothing else declared.
        lenses: { portfolio: true, verdict: true, plan: true, architecture: false, traceability: false, operations: false, provenance: false },
      },
    }],
  }
}

/**
 * The fixture's declared publication set must be what derivedLenses would compute from its own
 * artifacts. A hand-kept copy desynchronises the first time a predicate changes, and then every
 * DOM, paging, mobile and print measurement taken over it is measuring an IA the product would
 * never produce — which is exactly how this fixture came to compose an empty shell.
 * @returns {string[]} mismatches, empty when the fixture is honest
 */
export function lensDrift(room = makeStressRoom()) {
  const program = room.programs[0]
  const fresh = derivedLenses(program)
  return Object.keys(fresh)
    .filter((id) => fresh[id] !== (program.derived.lenses || {})[id])
    .map((id) => `${id}: fixture declares ${String((program.derived.lenses || {})[id])}, artifacts say ${String(fresh[id])}`)
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--html') {
    const templatePath = process.argv[3], out = process.argv[4]
    if (!templatePath || !out) throw new Error('usage: make.mjs --html <template> <out>')
    const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
    const strings = {
      en: JSON.parse(readFileSync(join(root, 'lib/viewer/strings/en.json'), 'utf8')),
      it: JSON.parse(readFileSync(join(root, 'lib/viewer/strings/it.json'), 'utf8')),
    }
    const html = readFileSync(templatePath, 'utf8')
      .replace('/*__ROOM_JSON__*/null', JSON.stringify(makeStressRoom()).replace(/</g, '\\u003c'))
      .replace('/*__STRINGS__*/null', JSON.stringify(strings).replace(/</g, '\\u003c'))
      .replace('/*__LENSES__*/null', JSON.stringify(LENS_SPEC).replace(/</g, '\\u003c'))
      .replace('<!--__HOLO_SRC__-->', '')
    writeFileSync(out, html)
  } else process.stdout.write(JSON.stringify(makeStressRoom(Number(process.argv[2]) || 2500, Number(process.argv[3]) || 250)))
}
