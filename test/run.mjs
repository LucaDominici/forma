#!/usr/bin/env node
// Fixture tests: init → gen → check across fixtures, plus §1a/§2/§1b/§7/§3. Deterministic, no deps.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, statSync, existsSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeTimeline, validateModel } from '../lib/validate.mjs'
import { indexByNode, statusFor, loadDocRows } from '../lib/docmap.mjs'
import { daysBetween, documentGate, deriveBlocks, deriveCapabilities, deriveDependencies, deriveHistory, deriveKanban, deriveKpis, deriveQueue } from '../lib/roomderive.mjs'
import { loadDocs } from '../lib/roomdocs.mjs'
import { deriveRtm } from '../lib/rtm.mjs'
import { componentsFor } from '../lib/cluster.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'forma.mjs')
const FIX = (n) => join(HERE, 'fixtures', n)
const tmp = mkdtempSync(join(tmpdir(), 'forma-test-'))
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' })
const die = (m, r) => { console.error('FAIL: ' + m + (r ? '\n' + (r.stdout || '') + (r.stderr || '') : '')); process.exit(1) }
const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'))
// strip the volatile fields so two gen runs on the same tree can be compared byte-for-byte
const stripVolatile = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.generatedAt; if (c.source) { delete c.source.commit; delete c.source.branch } return JSON.stringify(c) }
// every JSON path where two objects differ (R2: gen x2 must diverge on exactly one)
const diffPaths = (a, b, at = '') => {
  if (a === b) return []
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return [at || '<root>']
  const out = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diffPaths(a[k], b[k], at ? at + '.' + k : k))
  return out
}

// 1) mini: init → gen → check, basic counts + derived edge (unchanged behavior; no clustering) + determinism
{
  const REPO = FIX('mini'), topo = join(tmp, 'topo.json'), model = join(tmp, 'model.json'), model2 = join(tmp, 'model2.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('init exit ' + r.status, r)
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('check exit ' + r.status, r)
  const m = readJson(model)
  const containers = m.nodes.filter((n) => n.kind === 'container').length
  const leaves = m.nodes.filter((n) => n.kind === 'leaf').length
  const derived = m.edges.filter((e) => e.kind === 'import').length
  if (containers < 2) die(`expected >=2 containers, got ${containers}`)
  if (leaves < 3) die(`expected >=3 leaves, got ${leaves}`)
  if (derived < 1) die(`expected >=1 derived edge (core→util), got ${derived}`)
  // derived edges carry a relationship verb (not a bare count), a numeric weight the viewer rolls
  // up, and an `inferred` status — so an executive reads the relationship and sees which arrows are
  // measured (curated, active) vs guessed from name references (inferred).
  const d = m.edges.find((e) => e.kind === 'import' && e.estatus === 'inferred')
  if (!d) die(`expected an inferred derived edge, got estatus set: ${[...new Set(m.edges.filter((e) => e.kind === 'import').map((e) => e.estatus))].join(',')}`)
  if (!/^(imports|drives|reads|references)$/.test(d.label)) die(`derived edge label should be a verb, got "${d.label}"`)
  if (!(d.weight > 0)) die(`derived edge should carry a numeric weight, got ${JSON.stringify(d.weight)}`)
  if (m.edges.some((e) => e.kind === 'import' && /\d×$/.test(String(e.label)))) die('a derived edge still carries a bare N× label — the verb refactor regressed')
  // determinism: a second gen on the same tree is byte-identical excluding timestamps/commit
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model2]); if (r.status !== 0) die('gen(2) exit ' + r.status, r)
  if (stripVolatile(m) !== stripVolatile(readJson(model2))) die('determinism: gen output differs across runs (excl. volatile fields)')
  // R2: exactly ONE volatile path — same tree, same commit ⇒ only generatedAt may differ
  const vol = diffPaths(m, readJson(model2))
  if (vol.join() !== 'generatedAt') die('R2: gen x2 should differ on generatedAt only, got [' + vol.join(', ') + ']')
  // R3, lowering the bar: the 2-file report_* group is below the default groupMin and only
  // clusters when the user asks for it — the direction that matters on a real repo.
  if (m.nodes.some((n) => n.kind === 'component')) die('R3: default thresholds should leave mini unclustered')
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model2, '--cluster-min', '1', '--group-min', '2'])
  if (r.status !== 0) die('R3 --cluster-min 1 --group-min 2 exit ' + r.status, r)
  if (!readJson(model2).nodes.some((n) => n.kind === 'component' && n.name === 'report')) die('R3: lowering the thresholds did not surface the 2-file report_* group')
  console.log(`  ok mini — ${containers} containers, ${leaves} leaves, ${derived} derived edge(s); one volatile field (generatedAt)`)
}

// 2) flat-python: §2 prefix clustering + §1a docstring/README resolution
{
  const REPO = FIX('flat-python'), topo = join(tmp, 'fp-topo.json'), model = join(tmp, 'fp-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('fp init exit ' + r.status, r)
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('fp gen exit ' + r.status, r)
  // check exit 0 PROVES the containerOf fix landed everywhere (clustered leaves still counted under the container)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('fp check exit ' + r.status + ' (containerOf fix?)', r)
  const m = readJson(model)
  const compNames = m.nodes.filter((n) => n.kind === 'component').map((n) => n.name).sort()
  if (compNames.length < 3) die(`§2: expected >=3 components, got ${compNames.length}`)
  if (!['order', 'payment', 'user'].every((x) => compNames.includes(x))) die('§2: expected order/payment/user components, got ' + compNames)
  const flat = m.nodes.filter((n) => n.kind === 'leaf' && n.parent === 'services').map((n) => n.name).sort()
  if (!(flat.includes('health') && flat.includes('version'))) die('§2: no-prefix leaves should stay flat, got ' + flat)
  if (!m.nodes.some((n) => n.name === 'user_service' && n.descSource === 'docstring')) die('§1a: user_service func not from docstring')
  if (!m.nodes.some((n) => n.name === 'health' && n.descSource === 'readme')) die('§1a: health func not from dir README')
  // R4: a synthesized component describes itself from its children's docs, not "Groups related files under X."
  const userComp = m.nodes.find((n) => n.kind === 'component' && n.name === 'user')
  if (!userComp || /^Groups related files under/.test(userComp.func)) die('R4: component "user" still on the bare fallback: ' + (userComp && userComp.func))
  if (!/user/i.test(userComp.func)) die('R4: component func not composed from its children docstrings: ' + userComp.func)
  // R3, raising the bar: this fixture's groups are 3 files each, so --group-min 4 (or a
  // --cluster-min above the leaf count) must dissolve the component layer entirely
  const m2 = join(tmp, 'fp-model-thresholds.json')
  const compsOf = (p) => readJson(p).nodes.filter((n) => n.kind === 'component').length
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', m2, '--group-min', '4']); if (r.status !== 0) die('R3 --group-min 4 exit ' + r.status, r)
  if (compsOf(m2) !== 0) die('R3: --group-min was ignored (3-file groups still clustered at min 4)')
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', m2, '--cluster-min', '99']); if (r.status !== 0) die('R3 --cluster-min 99 exit ' + r.status, r)
  if (compsOf(m2) !== 0) die('R3: --cluster-min was ignored (container clustered below the new floor)')
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', m2, '--group-min', 'abc'])
  if (r.status === 0) die('R3: a non-integer --group-min must fail loud, not silently disable clustering')
  console.log(`  ok flat-python — ${compNames.length} components (${compNames}); §1a docstring+readme; R3 flags; R4 composed component prose`)
}

// 3) data-noise: §3 init skips data/fixture dirs and records why
{
  const REPO = FIX('data-noise'), topo = join(tmp, 'dn-topo.json')
  const r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('dn init exit ' + r.status, r)
  const t = readJson(topo)
  if (!t.nodes.some((n) => n.name === 'api')) die('§3: expected api container')
  if (t.nodes.some((n) => ['demo', 'fixtures'].includes(n.name))) die('§3: a data dir was seeded as a container')
  if (!(t._skipped || []).some((s) => /demo|fixtures/.test(s.dir))) die('§3: skipped data dirs not recorded in _skipped')
  // language detection must ignore the same dirs: src/fixtures/*.py outnumbers src/api/*.js here,
  // and counting it would detect Python and then find no container at all (init exits 1).
  if (t.meta.stack !== 'JavaScript') die('§3: data-dir files hijacked language detection, got ' + t.meta.stack)
  console.log('  ok data-noise — api seeded; demo/fixtures skipped, and ignored by language detection')
}

// 3b) virgin-kebab: the repo forma actually lands on. kebab-case (the dominant JS/TS convention),
// zero docstrings, zero directory READMEs, zero curated status overlay — none of the gifts the
// other fixtures happen to hand it. Every defect that hides behind snake_case names, module docs
// or a hand-written overlay surfaces here, which is why this fixture had to exist.
{
  const REPO = FIX('virgin-kebab'), topo = join(tmp, 'vk-topo.json'), model = join(tmp, 'vk-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('vk init exit ' + r.status, r)
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('vk gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('vk check exit ' + r.status, r)
  const m = readJson(model)

  // F6 — a kebab name must still derive an edge (the auto-edge regex used to DELETE the hyphen,
  // producing \bsessionstore\b, which matches nothing: every kebab repo rendered edges=0).
  const derived = m.edges.filter((e) => e.kind === 'import')
  if (!derived.length) die('F6: kebab-case cross-container references derived 0 edges — the graph is empty')
  if (!derived.some((e) => e.from === 'api' && e.to === 'core')) die('F6: expected the api→core edge, got ' + JSON.stringify(derived))
  if (derived.some((e) => e.from === 'core' && e.to === 'api')) die('F6: edge direction inverted — core never references api')

  // F7 — the component level must exist for kebab/camel/dot repos, not only for snake_case ones.
  const comps = m.nodes.filter((n) => n.kind === 'component').map((n) => n.name).sort()
  if (!comps.length) die('F7: 9 kebab leaves in one container produced 0 components — no component level at all')
  if (!(comps.includes('session') && comps.includes('rate'))) die('F7: expected session/rate components, got ' + comps)

  // the fixture must STAY virgin: one stray leading comment would give a leaf a docstring and the
  // assertions below would start passing for a reason that has nothing to do with the fix.
  if (m.nodes.some((n) => n.kind === 'leaf' && n.descSource !== 'fallback')) die('F5: a leaf grew a docstring or a directory README — the fixture is no longer virgin')

  // F3 — no box may be described by the name of its programming language.
  for (const n of m.nodes) {
    if (!String(n.func || '').trim()) die(`F3: node ${n.id} (${n.kind}) has no description — the box falls back to its language`)
    if (n.tech && String(n.func).trim() === String(n.tech).trim()) die(`F3: node ${n.id} is described by its language ("${n.tech}")`)
  }

  // F4 — with no curated overlay the programme state is UNKNOWN, and it must say so.
  const invented = m.nodes.filter((n) => n.completion != null)
  if (invented.length) die(`F4: ${invented.length}/${m.nodes.length} node(s) carry an invented completion with no status overlay (e.g. ${invented[0].id}=${invented[0].completion})`)
  const states = [...new Set(m.nodes.map((n) => n.status2))].sort()
  if (states.join() !== 'unknown') die('F4: undecorated nodes must be status2=unknown, got [' + states + ']')

  // F1 — `--enrich` must never reach for an API key by default; the keyless path must still work.
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', join(tmp, 'vk-bad.json'), '--enrich'])
  if (r.status === 0) die('F1: `--enrich` with no explicit --enricher must fail loud instead of defaulting to the API-key provider')
  if (!/--enricher/.test((r.stderr || '') + (r.stdout || ''))) die('F1: the blocking message never names --enricher')
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model, '--enrich', '--enricher', 'agent'])
  if (r.status !== 0) die('F1: the keyless agent enricher must still work', r)

  // the viewer half of F3/F4: the box chain must not reach the language, and an unknown state
  // needs a sixth, neutral rendering — otherwise the model is honest and the screen still lies.
  const vhtml = readFileSync(join(HERE, '..', 'lib', 'viewer', 'c4-hologram.html'), 'utf-8')
  if (/\|\|\s*[nm]\.tech/.test(vhtml)) die('F3: the viewer still falls back to `tech` when a box has no description')
  const badgeLine = (vhtml.match(/\n\s*var badge=[^\n]*/) || [''])[0]
  if (!badgeLine) die('viewer: the badge expression was not found — did it move?')
  if (/tech/.test(badgeLine)) die('F3: the badge still falls back to the language: ' + badgeLine.trim())
  if (/\?"plan":"done"/.test(vhtml)) die('F4: a node with no status2 still defaults to done (green by default)')
  const STMAP = new Function((vhtml.match(/\nvar STMAP=\{[^\n]*/) || [''])[0].replace(/;\s*$/, '') + '; return STMAP')()
  if (!STMAP.unknown) die('F4: STMAP has no neutral sixth state — an unknown node renders as done')
  if (!new RegExp('\\.s-' + STMAP.unknown + '\\b').test(vhtml)) die('F4: the neutral state has no CSS class .s-' + STMAP.unknown)
  const ordLit = (vhtml.match(/ord=\[[^\]]*\]/) || [''])[0]
  if (!ordLit.includes('"' + STMAP.unknown + '"')) die('F4: the per-level tally cannot count unknown nodes — the pill renders empty')
  console.log(`  ok virgin-kebab — ${derived.length} derived edge(s), ${comps.length} component(s) (${comps}), every box described, state unknown until curated`)
}

// 3c) go-nested: a language that DECLARES its architecture. In Go the unit is the package (any
// dir holding non-test *.go) and the dependency is the `import` block — both were ignored, so a
// real Go repo came out as `internal` (one box for thirty packages), file leaves, `_test.go`
// nodes and edges=0. The fixture reproduces the exact trap: the only .go file sitting directly in
// internal/ is a test, which is what stopped the seeder there.
{
  const REPO = FIX('go-nested'), topo = join(tmp, 'go-topo.json'), model = join(tmp, 'go-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('go init exit ' + r.status, r)
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('go gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('go check exit ' + r.status, r)
  const m = readJson(model)
  const conts = m.nodes.filter((n) => n.kind === 'container')
  const cnames = conts.map((n) => n.name).sort()

  // G1 — the package is the unit of architecture: two packages nested under a common directory
  // are two containers, and the directory that merely holds them is not one.
  for (const want of ['internal/store', 'internal/server', 'cmd/app']) if (!cnames.includes(want)) die(`G1: package ${want} is not a container, got [${cnames}]`)
  if (cnames.includes('internal')) die('G1: `internal` is still one container swallowing its packages, got [' + cnames + ']')

  // G2 — a test file is not architecture. Nothing in the model may come from a *_test.go.
  const testish = m.nodes.filter((n) => /_test$/.test(String(n.name)) || (n.evidence || []).some((e) => /_test\.go$/.test(e.ref)))
  if (testish.length) die('G2: _test.go files became nodes: ' + testish.map((n) => n.id))

  // G3 — the package is ONE node. It used to be two: a container AND a leaf pointing at that very
  // same directory, so drilling into a package showed the package again — 53 of 53 on a real Go
  // repo, a level drawn twice. The files inside stay internal detail (#17): they are a COUNT on the
  // container, which is what the drift gate re-walks, not boxes.
  const leaves = m.nodes.filter((n) => n.kind === 'leaf')
  if (leaves.length) die(`G3: a package is one node — got ${leaves.length} redundant leaf/leaves: ${leaves.map((n) => n.id)}`)
  for (const c of conts) {
    const g = (c.evidence || []).find((e) => e.type === 'glob')
    if (!g) die('G3: container ' + c.id + ' carries no glob evidence — nothing for the gate to re-count')
    if (g.ref !== c.name) die(`G3: container ${c.id} anchors on "${g.ref}", not its own package dir "${c.name}"`)
    if (!statSync(join(REPO, g.ref)).isDirectory()) die(`G3: container ${c.id} evidence is not a directory: ${g.ref}`)
  }
  // G3b — the count is the package's real non-test file count. Both halves matter: a count that is
  // always 1 is how the Go gate passed while a .go file was added or deleted.
  const storeC = conts.find((c) => c.name === 'internal/store')
  const storeN = ((storeC.evidence || []).find((e) => e.type === 'glob') || {}).count
  if (storeN !== 2) die(`G3b: internal/store must count its 2 non-test files (store.go, query.go), got ${storeN}`)

  // G4 — edges derived from the `import` block: deterministic, and the direction is right by
  // construction (the importer depends on the imported, never the reverse).
  const derived = m.edges.filter((e) => e.kind === 'import')
  const idOf = (name) => (conts.find((c) => c.name === name) || {}).id
  const store = idOf('internal/store'), server = idOf('internal/server'), app = idOf('cmd/app')
  const has = (from, to) => derived.some((e) => e.from === from && e.to === to)
  if (!has(server, store)) die('G4: `import "example.com/nested/internal/store"` derived no server→store edge, got ' + JSON.stringify(derived))
  if (has(store, server)) die('G4: edge direction inverted — store never imports server')
  if (!has(app, server)) die('G4: the single-line `import "…/internal/server"` form derived no cmd/app→internal/server edge')
  if (derived.length !== 2) die(`G4: expected exactly the 2 declared imports (stdlib "fmt" is outside the module), got ${derived.length}: ${JSON.stringify(derived)}`)
  console.log(`  ok go-nested — ${conts.length} package containers (${cnames}), ${leaves.length} package leaves, ${derived.length} import edge(s), zero test nodes`)
}


// 3d) go-grouped: the curation a 53-box wall forces, and the two things it used to cost in silence.
// Grouping packages into domains is the ONLY cure for a level no projector can show — and the
// grouped level drew zero arrows and tallied the domains instead of the packages, so the one screen
// a stakeholder is shown was the one screen with no relationships and a made-up denominator.
// The fixture is shaped so none of the three assertions can pass by accident: two platform packages
// import into money (so the rolled count is a real SUM, not a 1), and each domain holds an internal
// import (so the self-loop drop is exercised on both screens).
{
  const REPO = FIX('go-grouped'), topo = join(tmp, 'gg-topo.json'), model = join(tmp, 'gg-model.json')
  const status = join(tmp, 'gg-status.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('gg init exit ' + r.status, r)
  const t = readJson(topo)
  const DOM = { money: ['internal/account', 'internal/ledger'], platform: ['cmd/app', 'internal/server', 'internal/worker'] }
  const domainOf = new Map(Object.entries(DOM).flatMap(([d, ps]) => ps.map((p) => [p, d])))
  const sys = t.nodes[0].id
  // THE curation, exactly as a human must write it: level and parent move, `kind` does NOT.
  for (const n of t.nodes) { if (!domainOf.has(n.name)) continue; n.level = 'component'; n.parent = domainOf.get(n.name) }
  t.nodes.push(
    { id: 'money', level: 'container', kind: 'container', parent: sys, name: 'Money', tech: 'Go', description: 'What a customer owns and what moved.' },
    { id: 'platform', level: 'container', kind: 'container', parent: sys, name: 'Platform', tech: 'Go', description: 'The service that exposes the money domain.' })
  writeFileSync(topo, JSON.stringify(t, null, 2) + '\n')
  // a verdict on the PACKAGES only — the domains stay unruled, which is the whole point of the tally
  writeFileSync(status, JSON.stringify({ nodes: {
    internal_account: { status2: 'done', completion: 100 }, internal_ledger: { status2: 'done', completion: 100 },
    internal_server: { status2: 'in-progress', completion: 40 } } }, null, 2))
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model, '--status', status])
  if (r.status !== 0) die('gg gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('gg check exit ' + r.status, r)
  const m = readJson(model)

  // P0 — the premise: keeping kind:"container" preserves every import edge across the regrouping.
  if (m.edges.filter((e) => e.kind === 'import').length !== 5) die('gg precondition: grouping cost import edges, got ' + JSON.stringify(m.edges))

  const html = readFileSync(join(HERE, '..', 'lib', 'viewer', 'c4-hologram.html'), 'utf-8')
  const rfn = (html.match(/\nfunction rollEdges\(edges,vis,parent\)\{[\s\S]*?\n\}/) || [])[0]
  if (!rfn) die('viewer: rollEdges not found — did the roll-up move back inline?')
  const rollEdges = new Function(rfn + '; return rollEdges')()
  const parent = Object.fromEntries(m.nodes.map((n) => [n.id, n.parent || null]))
  const screen = (ids) => rollEdges(m.edges, Object.fromEntries(ids.map((i) => [i, i])), parent)

  // P1 — the domain level draws its children's relationships, with the count SUMMED. Three model
  // edges (server→account 2×, server→ledger 1×, worker→account 1×) become ONE arrow reading 4×.
  const dom = screen(['money', 'platform'])
  if (dom.length !== 1) die(`P1: the grouped level drew ${dom.length} arrow(s), want exactly platform→money: ` + JSON.stringify(dom))
  if (!(dom[0].from === 'platform' && dom[0].to === 'money')) die('P1: arrow direction inverted — money never imports platform: ' + JSON.stringify(dom[0]))
  if (dom[0].n !== 4) die(`P1: the rolled count is ${dom[0].n}, not the sum 2+1+1=4 — the arrow under-reports what it stands for`)
  if (!/^4/.test(String(dom[0].label))) die('P1: the summed count never reached the label: ' + dom[0].label)

  // P2 — an edge whose ends sit inside the SAME box is not an arrow: account→ledger and
  // app→server are internal detail at the domain level, and both are drawn one level down.
  if (screen(['money', 'platform']).some((e) => e.from === e.to)) die('P2: a box drew an arrow to itself')
  const insideMoney = screen(['internal_account', 'internal_ledger'])
  if (!(insideMoney.length === 1 && insideMoney[0].from === 'internal_account')) die('P2: drilling into a domain lost its internal arrow: ' + JSON.stringify(insideMoney))
  // a single contributing edge keeps its label verbatim (the verb, not a synthesized count) and
  // carries its weight in .n — the roll-up only synthesizes "n×" when it merges ≥2 edges.
  const srcInternal = m.edges.find((e) => e.from === 'internal_account' && e.to === 'internal_ledger')
  if (!srcInternal) die('P2: fixture lost the account→ledger internal edge')
  if (String(insideMoney[0].label) !== String(srcInternal.label)) die('P2: a single contributing edge must keep its label verbatim, got ' + insideMoney[0].label + ' (source ' + srcInternal.label + ')')
  if (insideMoney[0].n !== (srcInternal.weight > 0 ? srcInternal.weight : 1)) die('P2: a single edge must carry its weight in .n, got ' + insideMoney[0].n)
  if (!screen(['cmd_app', 'internal_server', 'internal_worker']).length) die('P2: the platform screen lost its internal arrow')

  // P2b — a derived edge labelled with a verb (no number in the label) still counts: its `weight`
  // field feeds the roll-up, so the arrow reports the summed count without parsing the label.
  // Regression guard for the verb refactor (label = relationship, weight = count).
  const vis = Object.fromEntries(['money', 'platform'].map((i) => [i, i]))
  const wm = rollEdges([...m.edges, { from: 'platform', to: 'money', label: 'imports', weight: 3, kind: 'import', estatus: 'inferred' }], vis, parent)
    .find((e) => e.from === 'platform' && e.to === 'money')
  if (!wm || wm.n !== 7) die('P2b: a verb-labelled edge with weight did not add its weight to the roll (want 7=4+3): ' + JSON.stringify(wm))

  // P3 — the tally reports the PACKAGES, not the domains. 3 of 5 packages carry a verdict; the two
  // domain boxes carry none. Before the roll-up this level read 0/2 and the 3 verdicts vanished.
  const tfn2 = (html.match(/\nfunction tallyOf\(kids,kidsOf\)\{[\s\S]*?\n\}/) || [])[0]
  const tallyOf2 = new Function('var STMAP={done:"done","in-progress":"prog",next:"next",planned:"plan",problem:"prob",unknown:"unk"};' + tfn2 + '; return tallyOf')()
  const kidsOf = (id) => m.nodes.filter((n) => n.parent === id)
  const T = tallyOf2(m.nodes.filter((n) => n.parent === sys), kidsOf)
  if (!(T.ruled === 3 && T.tot === 5)) die(`P3: the grouped level tallies ${T.ruled}/${T.tot}, want 3/5 — the packages' verdicts do not reach the box that groups them`)
  if (T.mean !== 80) die(`P3: mean over the ruled packages is ${T.mean}, want 80 ((100+100+40)/3)`)
  if ((T.cnt.done || 0) !== 2 || (T.cnt.unk || 0) !== 2) die('P3: the status dots count boxes, not units: ' + JSON.stringify(T.cnt))

  // P4 — the curation that WOULD cost the graph must say so. `kind: "component"` is the intuitive
  // thing to write and it takes 189 edges to 13 on a real repo, silently.
  const badTopo = join(tmp, 'gg-topo-bad.json'), badModel = join(tmp, 'gg-model-bad.json')
  const bad = readJson(topo)
  for (const n of bad.nodes) if (domainOf.has(n.name)) n.kind = 'component'
  writeFileSync(badTopo, JSON.stringify(bad, null, 2) + '\n')
  r = run(['gen', '--repo', REPO, '--topology', badTopo, '--out', badModel, '--status', status])
  if (r.status !== 0) die('P4 gen exit ' + r.status, r)
  if (readJson(badModel).edges.filter((e) => e.kind === 'import').length) die('P4 precondition: kind:"component" no longer drops the edges — retune this assertion')
  if (!/WARNING/.test(r.stderr || '')) die('P4: gen dropped every import edge without a word on stderr:\n' + (r.stderr || '<empty>'))
  if (!/\b5 node\(s\)/.test(r.stderr || '')) die('P4: the warning does not carry the count: ' + (r.stderr || ''))
  if (!/kind/.test(r.stderr || '')) die('P4: the warning never names the field that caused it: ' + (r.stderr || ''))
  console.log(`  ok go-grouped — a grouping box draws its children's arrows (platform→money ${dom[0].label}, self-loops dropped), tallies their verdicts (${T.ruled}/${T.tot}), and a curation that would lose edges warns loud`)
}

// 3d) §33 the first screen. `init` seeded ONE context node — a dashed box with a generated sentence
// in it — and told nobody that curating it was mandatory rather than nice. Slide one of any
// architecture talk is *who touches this*; the assertions below are that the roles are there, that
// they are impossible to mistake for curation, and that nothing lets them stay anonymous quietly.
{
  const REPO = FIX('mini'), topo = join(tmp, 'ctx-topo.json'), model = join(tmp, 'ctx-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('ctx init exit ' + r.status, r)
  const t = readJson(topo)
  const ctx = t.nodes.filter((n) => !n.parent)
  const sys = ctx.find((n) => n.kind === 'system')
  const actors = ctx.filter((n) => n.kind !== 'system')

  // C1 — a person and an external system, not just the product
  for (const k of ['person', 'external']) if (!ctx.some((n) => n.kind === k)) die(`C1: init seeded no "${k}" in the context, got [${ctx.map((n) => n.kind)}]`)
  // C2 — with an arrow each. Boxes and no arrows is a bulleted list in rectangles (predicate 4).
  for (const a of actors) if (!t.edges.some((e) => (e.from === a.id && e.to === sys.id) || (e.to === a.id && e.from === sys.id))) die('C2: context actor ' + a.id + ' carries no edge to the system')
  // C3 — a plausible invented actor ("End user") would be indistinguishable from curated truth
  for (const a of actors) if (!/^TODO:/.test(a.name)) die('C3: a seeded placeholder is not marked as one: ' + a.name)
  // C4 — the closing line leads with the context instead of burying it as one of three chores
  const last = (r.stdout || '').trim().split('\n').pop()
  if (!/NEXT/.test(last)) die('C4: init printed no NEXT line: ' + last)
  if (!/TODO:/.test(last) || last.indexOf('TODO:') > last.indexOf('curate')) die('C4: the NEXT line does not put the context first: ' + last)

  // C5 — while they are anonymous `gen` says so, in ONE line, naming them, and does not fail
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('C5: gen must not fail over unnamed placeholders', r)
  const note = (r.stderr || '').split('\n').filter((l) => /still unnamed/.test(l))
  if (note.length !== 1) die(`C5: expected exactly one reminder line on stderr, got ${note.length}:\n${r.stderr}`)
  for (const a of actors) if (!note[0].includes(a.name)) die('C5: the reminder never names ' + a.name + ': ' + note[0])

  // C6 — predicates 1 and 4 of scripts/presentable.mjs, measured on the model the way it measures
  const m = readJson(model)
  const roots = m.nodes.filter((n) => !n.parent)
  if (roots.length < 2) die(`C6: predicate 1 still fails on a freshly initialised repo (${roots.length} box(es) at context)`)
  const ids = new Set(roots.map((n) => n.id))
  if (!m.edges.some((e) => ids.has(e.from) && ids.has(e.to))) die('C6: the context screen draws no edge — predicate 4 fails where it used to pass')
  if (m.nodes.some((n) => n.parent && !String(n.func || '').trim())) die('C6: predicate 3 regressed — a box below the context lost its prose')

  // C7 — the reminder keys on the NAME, not on the seeded ids: rename them and it must fall silent,
  // or every curated repo carries a nag forever and the signal stops meaning anything.
  const named = readJson(topo)
  for (const n of named.nodes) if (/^TODO:/.test(n.name)) n.name = 'The family'
  const namedTopo = join(tmp, 'ctx-topo-named.json')
  writeFileSync(namedTopo, JSON.stringify(named, null, 2))
  r = run(['gen', '--repo', REPO, '--topology', namedTopo, '--out', join(tmp, 'ctx-model-named.json')])
  if (r.status !== 0) die('C7: gen on a curated context exit ' + r.status, r)
  if (/still unnamed/.test(r.stderr || '')) die('C7: the reminder survived the rename: ' + r.stderr)
  // C8 — `init` is best-effort and must never fail on a strange repo: a directory with no recognised
  // source at all still has a true context to write, and exiting 1 left the caller with no file.
  const bare = mkdtempSync(join(tmpdir(), 'forma-bare-'))
  writeFileSync(join(bare, 'README.md'), '# nothing but prose\n')
  const bareTopo = join(tmp, 'bare-topo.json'), bareModel = join(tmp, 'bare-model.json')
  r = run(['init', '--repo', bare, '--out', bareTopo, '--force'])
  if (r.status !== 0) die('C8: init must not exit ' + r.status + ' on a repo with no recognised source', r)
  const b = readJson(bareTopo)
  if (b.leafSources.length) die('C8: a source-less repo seeded containers: ' + JSON.stringify(b.leafSources))
  if (b.nodes.filter((n) => !n.parent).length !== 3) die('C8: the context was not written anyway: ' + JSON.stringify(b.nodes.map((n) => n.kind)))
  r = run(['gen', '--repo', bare, '--topology', bareTopo, '--out', bareModel])
  if (r.status !== 0) die('C8: the context-only topology does not gen', r)
  console.log(`  ok context-seed — §33 ${actors.length} placeholder actor(s) + ${t.edges.length} edge(s), gen names them once and stops after the rename; a source-less repo still gets a context`)
}

// 3e) two-stack: a product that is Go AND TypeScript. Both stacks must be modelled by the first init;
// a passing check over only the dominant one is the vacuous green this fixture prevents.
{
  const REPO = FIX('two-stack'), topo = join(tmp, '2s-topo.json'), model = join(tmp, '2s-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('two-stack init exit ' + r.status, r)
  const t = readJson(topo)

  if (t.meta.stack !== 'Go + TypeScript' || (t.meta.stacks || []).join() !== 'Go,TypeScript') die('S1: both stacks are not declared: ' + JSON.stringify(t.meta))
  const techs = new Set(t.nodes.filter((n) => n.kind === 'container').map((n) => n.tech))
  if (!techs.has('Go') || !techs.has('TypeScript')) die('S1: both stacks are not seeded: ' + JSON.stringify([...techs]))
  if ((t._unseeded || []).length) die('S2: init left an ungoverned stack: ' + JSON.stringify(t._unseeded))
  const tsSources = t.leafSources.filter((s) => (t.nodes.find((n) => n.id === s.parent) || {}).tech === 'TypeScript')
  if (!tsSources.length || !tsSources.some((s) => new RegExp(s.match).test('view.tsx'))) die('S3: TypeScript source roots miss *.tsx: ' + JSON.stringify(tsSources))
  // S3c — a *.tsx-dominant repo must seed the *.ts half of the same language too, not report it
  const react = mkdtempSync(join(tmpdir(), 'forma-react-'))
  mkdirSync(join(react, 'src', 'ui'), { recursive: true })
  for (const f of ['a.tsx', 'b.tsx', 'c.tsx', 'helpers.ts', 'types.ts']) writeFileSync(join(react, 'src', 'ui', f), 'export const x = 1\n')
  const rTopo = join(tmp, 'react-topo.json'), rModel = join(tmp, 'react-model.json')
  r = run(['init', '--repo', react, '--out', rTopo, '--force']); if (r.status !== 0) die('S3c react init exit ' + r.status, r)
  const rt = readJson(rTopo)
  r = run(['gen', '--repo', react, '--topology', rTopo, '--out', rModel]); if (r.status !== 0) die('S3c react gen exit ' + r.status, r)
  const rl = readJson(rModel).nodes.filter((n) => n.kind === 'leaf').map((n) => n.name).sort()
  if (rl.length !== 5) die(`S3c: one match per LANGUAGE — expected all 5 *.ts/*.tsx files, got ${rl.length}: ${rl}`)

  // Direct first-run: no paste or generated-file editing between init and gen/check.
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('S4: multi-stack topology does not gen directly', r)
  const m = readJson(model)
  if (!m.nodes.some((n) => n.kind === 'container' && n.tech === 'TypeScript')) die('S4: generated model has no TypeScript container')
  if (!m.nodes.some((n) => n.kind === 'leaf' && n.name === 'view')) die('S4: the *.tsx file never became a leaf — the match under-covers the language')
  if (m.edges.filter((e) => e.kind === 'import' && e.estatus === 'inferred').length < 2) die('S4: composing stack adapters lost the declared Go imports: ' + JSON.stringify(m.edges))
  const pathLeaves = ['billing/A.java', 'billing/B.java', 'billing/C.java', 'orders/D.java', 'orders/E.java', 'orders/F.java'].map((path, i) => ({ id: 'j' + i, name: 'Class' + i, evidence: [{ type: 'path', ref: 'src/main/java/com/acme/' + path }] }))
  const pathComponents = componentsFor({ id: 'java', category: 'container' }, pathLeaves).components.map((c) => c.name).join()
  if (pathComponents !== 'billing,orders') die('S4: package paths did not become usable Java components: ' + pathComponents)
  const twoById = new Map(m.nodes.map((n) => [n.id, n]))
  if (m.edges.some((e) => e.label === 'imports' && (twoById.get(e.from) || {}).tech === 'TypeScript')) die('S4: Go adapter attributed a Go import to the co-located TypeScript container: ' + JSON.stringify(m.edges))
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('S4: direct multi-stack model fails check', r)

  const nestedGo = join(tmp, 'go-nested-module'), nestedTopo = join(tmp, 'go-nested-module-topo.json'), nestedModel = join(tmp, 'go-nested-module-model.json')
  mkdirSync(join(nestedGo, 'service', 'a'), { recursive: true }); mkdirSync(join(nestedGo, 'service', 'b'), { recursive: true })
  writeFileSync(join(nestedGo, 'service', 'go.mod'), 'module example.com/service\n\ngo 1.22\n')
  writeFileSync(join(nestedGo, 'service', 'a', 'a.go'), 'package a\nimport "example.com/service/b"\nfunc A() string { return b.B() }\n')
  writeFileSync(join(nestedGo, 'service', 'b', 'b.go'), 'package b\nfunc B() string { return "b" }\n')
  r = run(['init', '--repo', nestedGo, '--out', nestedTopo, '--force']); if (r.status !== 0) die('S4: nested Go module init failed', r)
  r = run(['gen', '--repo', nestedGo, '--topology', nestedTopo, '--out', nestedModel]); if (r.status !== 0) die('S4: nested Go module gen failed', r)
  if (!readJson(nestedModel).edges.some((e) => e.label === 'imports')) die('S4: nested Go module lost its declared import edge')
  r = run(['check', '--repo', nestedGo, '--model', nestedModel, '--topology', nestedTopo]); if (r.status !== 0) die('S4: nested Go module check failed', r)

  const testsTopo = join(tmp, '2s-topo-tests.json'), testsModel = join(tmp, '2s-model-tests.json')
  r = run(['init', '--repo', REPO, '--topology', testsTopo, '--out', testsTopo, '--force', '--include-tests']); if (r.status !== 0) die('S4: Go include-tests init failed', r)
  const withTests = readJson(testsTopo), goParents = new Set(withTests.nodes.filter((n) => n.tech === 'Go').map((n) => n.id))
  if (withTests.leafSources.filter((s) => goParents.has(s.parent)).some((s) => s.exclude)) die('S4: Go --include-tests kept the _test.go exclusion')
  r = run(['gen', '--repo', REPO, '--topology', testsTopo, '--out', testsModel]); if (r.status !== 0) die('S4: Go include-tests gen failed', r)
  r = run(['check', '--repo', REPO, '--model', testsModel, '--topology', testsTopo]); if (r.status !== 0) die('S4: Go include-tests check failed', r)

  // Removing one whole stack must make check red even though every remaining leafSource recounts.
  const bad = readJson(topo), badTopo = join(tmp, '2s-topo-missing-ts.json')
  const tsParents = new Set(bad.nodes.filter((n) => n.tech === 'TypeScript').map((n) => n.id))
  bad.leafSources = bad.leafSources.filter((s) => !tsParents.has(s.parent))
  writeFileSync(badTopo, JSON.stringify(bad, null, 2))
  r = run(['check', '--repo', REPO, '--model', model, '--topology', badTopo])
  if (r.status === 0 || !/SOURCE COVERAGE TypeScript/.test(r.stderr || '')) die('S5: removing TypeScript coverage did not fail closed', r)
  const bypass = readJson(topo), bypassTopo = join(tmp, '2s-topo-no-coverage.json')
  delete bypass.sourceCoverage
  bypass.leafSources = bypass.leafSources.filter((s) => !tsParents.has(s.parent))
  writeFileSync(bypassTopo, JSON.stringify(bypass, null, 2))
  r = run(['check', '--repo', REPO, '--model', model, '--topology', bypassTopo])
  if (r.status === 0 || !/missing sourceCoverage/.test(r.stderr || '')) die('S5: deleting the coverage contract made the omitted stack pass', r)
  console.log('  ok two-stack — Go + TypeScript seeded, generated and checked directly; removing one stack fails coverage')

}

// 3f) production cold start: nested workspace roots, valid root-relative doc refs, dead candidate
// tables and every common test shape. The generated topology must be usable without hand editing.
{
  const REPO = FIX('cold-start-closure'), topo = join(tmp, 'cs-topo.json'), model = join(tmp, 'cs-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('cold-start init exit ' + r.status, r)
  const t = readJson(topo), sources = JSON.stringify(t.leafSources), exclusions = (t.sourceCoverage || {}).exclusions || []
  for (const stack of ['Java', 'TypeScript']) if (!(t.meta.stacks || []).includes(stack)) die('cold-start: production stack not detected: ' + stack)
  if ((t.meta.stacks || []).some((stack) => stack === 'C#' || stack === 'Swift')) die('cold-start: test-only stack entered the production topology: ' + t.meta.stacks)
  if (!t.docSources.some((s) => (typeof s === 'string' ? s : s.path) === 'docs/FEATURES.md')) die('cold-start: valid rooted docSource not adopted')
  if (t.docSources.some((s) => (typeof s === 'string' ? s : s.path) === 'docs/BROKEN.md')) die('cold-start: dead docSource adopted and will break gen')
  for (const unsafe of ['docs/MISSING_REF.md', 'docs/ESCAPE.md']) if (t.docSources.some((s) => (typeof s === 'string' ? s : s.path) === unsafe)) die('cold-start: non-atomic or escaping docSource adopted: ' + unsafe)
  const symlinkRepo = join(tmp, 'doc-symlink'), outside = join(tmp, 'outside.js')
  mkdirSync(join(symlinkRepo, 'src'), { recursive: true }); mkdirSync(join(symlinkRepo, 'docs'), { recursive: true })
  writeFileSync(outside, 'export const outside = true\n'); symlinkSync(outside, join(symlinkRepo, 'src', 'external.js'))
  writeFileSync(join(symlinkRepo, 'docs', 'FEATURES.md'), '| capability | status | code_ref |\n|---|---|---|\n| Escape | DONE | `src/external.js` |\n')
  if (!loadDocRows(symlinkRepo, ['docs/FEATURES.md'], true).some((row) => row.dead.length)) die('cold-start: a symlink escaped the doc evidence trust boundary')
  if (!/frontend/.test(sources) || !/backend/.test(sources)) die('cold-start: backend/frontend roots not seeded')
  for (const part of ['androidTest', 'testFixtures', 'uiTests']) if (!exclusions.some((x) => String(x.dir || '').includes(part) && x.reason)) die('cold-start: missing reasoned exclusion for ' + part)
  if (!exclusions.some((x) => x.match && x.reason)) die('cold-start: co-located test files have no reasoned exclusion')
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('cold-start gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('cold-start check exit ' + r.status, r)
  const refs = readJson(model).nodes.flatMap((n) => n.evidence || []).map((e) => e.ref || '').join('\n')
  if (/(?:^|\/)(?:test|tests|androidTest|testFixtures|uiTests)(?:\/|$)|(?:Test|Tests|\.test|\.spec)\.[^.]+$/m.test(refs)) die('cold-start: test source entered the production model: ' + refs)

  const allTopo = join(tmp, 'cs-all-topo.json'), allModel = join(tmp, 'cs-all-model.json')
  r = run(['init', '--repo', REPO, '--out', allTopo, '--force', '--include-tests']); if (r.status !== 0) die('cold-start include-tests init exit ' + r.status, r)
  const all = readJson(allTopo)
  if (!(all.meta.stacks || []).includes('C#') || (all.sourceCoverage.exclusions || []).some((x) => /test source/.test(x.reason))) die('cold-start: --include-tests did not restore every test stack')
  r = run(['gen', '--repo', REPO, '--topology', allTopo, '--out', allModel]); if (r.status !== 0) die('cold-start include-tests gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', allModel, '--topology', allTopo]); if (r.status !== 0) die('cold-start include-tests check exit ' + r.status, r)
  console.log('  ok cold-start-closure — multiroot/multistack, atomic docs, reasoned test exclusions and include-tests all close')
}

// 4) §1b attach-mode + check freshness, end-to-end on a copy of the self-repo
{
  const repo = join(tmp, 'selfrepo')
  // The copy stands in for a fresh checkout, so it must not carry what a checkout does not have.
  // control-room.html is generated (verify -> gen -> room) and gitignored; copying it in would make
  // this block fail for a true reason in a false situation — the git-derived halves of the briefing
  // (commit drift, the issue-to-code link) cannot re-derive equal inside a tree with no .git.
  cpSync(join(HERE, '..'), repo, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) && !/control-room\.html$/.test(s) })
  // this test regenerates a synthetic topology over the self-repo copy; the repo's REAL programme
  // overlay refers to the curated topology's ids, so drop it or gen fails loud (correctly) on it
  rmSync(join(repo, 'docs/architecture/c4-status.json'), { force: true })
  const topo = join(tmp, 's-topo.json'), model = join(tmp, 's-model.json')
  let r = run(['init', '--repo', repo, '--out', topo, '--force']); if (r.status !== 0) die('attach init exit ' + r.status, r)
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('attach gen exit ' + r.status, r)
  const docFile = join(repo, 'docs/architecture/ARCHITECTURE.md') // == model.source.docPath
  mkdirSync(dirname(docFile), { recursive: true })
  writeFileSync(docFile, '# Arch\n\nHuman intro prose.\n\n<!-- forma:begin (generated — do not edit) -->\nSTALE\n<!-- forma:end -->\n\nHuman footer prose.\n')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status === 0) die('§1b: check should FAIL on a stale doc block')
  r = run(['doc', '--repo', repo, '--model', model, '--attach', docFile]); if (r.status !== 0) die('§1b: doc --attach exit ' + r.status, r)
  const d = readFileSync(docFile, 'utf-8')
  if (!(d.includes('Human intro prose.') && d.includes('Human footer prose.'))) die('§1b: attach clobbered human prose')
  if (!d.includes('C4Context')) die('§1b: attach did not inject the generated block')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('§1b: check should PASS after regen', r)

  // R1: a block attached to a file that is NOT source.docPath must be governed too — otherwise
  // `forma doc --attach any.md` produces a generated block no gate ever checks (false green).
  const other = join(repo, 'docs/architecture/NOTES.md')
  writeFileSync(other, '# Notes\n\nHuman notes.\n')
  r = run(['doc', '--repo', repo, '--model', model, '--attach', other]); if (r.status !== 0) die('R1: doc --attach NOTES.md exit ' + r.status, r)
  if (!(readJson(model).source.attachedDocs || []).includes('docs/architecture/NOTES.md')) die('R1: --attach did not register the target in source.attachedDocs')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('R1: check should PASS right after attach', r)
  // the registry must survive a plain regen, or the gate silently stops governing the file
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('R1 regen exit ' + r.status, r)
  if (!(readJson(model).source.attachedDocs || []).includes('docs/architecture/NOTES.md')) die('R1: gen dropped source.attachedDocs — the attached doc is un-governed again')
  writeFileSync(other, readFileSync(other, 'utf-8').replace('C4Context', 'C4Tampered'))
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (r.status === 0) die('R1: check stayed green on a tampered block in an attached doc (false green)')
  if (!/NOTES\.md/.test((r.stdout || '') + (r.stderr || ''))) die('R1: check failed but did not name the offending file')
  r = run(['doc', '--repo', repo, '--model', model, '--attach', other]); if (r.status !== 0) die('R1: re-attach exit ' + r.status, r)
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('R1: check should PASS after re-attach', r)
  // deleting BOTH markers must not un-govern the doc: registry membership proves a block was
  // injected, and the now-frozen text keeps shipping to readers as if it were still generated
  writeFileSync(other, readFileSync(other, 'utf-8').replace(/<!-- forma:(begin[^>]*|end) -->/g, ''))
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (r.status === 0) die('R1: check went green after the forma markers were deleted from a registered doc')
  rmSync(other)
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (r.status === 0) die('R1: check went green after a registered doc was deleted')
  console.log('  ok attach-doc — §1b inject preserves prose; R1 gate governs attached docs ≠ docPath, survives regen')
}

// 5) §7 enrichment via the offline 'echo' enricher (no network): fills only holes, caches, sticky across plain regen
{
  const REPO = FIX('mini'), topo = join(tmp, 'en-topo.json'), model = join(tmp, 'en-model.json')
  run(['init', '--repo', REPO, '--out', topo, '--force'])
  run(['gen', '--repo', REPO, '--topology', topo, '--out', model])
  const holes = readJson(model).nodes.filter((n) => n.descSource === 'fallback' && n.kind === 'leaf')
  if (!holes.length) die('§7 precondition: mini has no fallback leaf holes to enrich')
  let r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model, '--enrich', '--enricher', 'echo'])
  if (r.status !== 0) die('§7 enrich gen exit ' + r.status, r)
  const enr = readJson(model)
  const hole = enr.nodes.find((n) => n.id === holes[0].id)
  if (!(hole.descSource === 'llm' && hole.descInputHash && hole.func === 'Auto-described (test enricher).')) die('§7: hole not enriched (want llm + hash + func)')
  if (enr.nodes.some((n) => n.func === 'Auto-described (test enricher).' && n.descSource !== 'llm')) die('§7: enricher wrote to a non-hole node')
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('§7: check after enrich (no network expected)', r)
  // sticky: a plain regen (no --enrich) preserves the cached llm prose on unchanged inputs
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('§7 regen exit ' + r.status, r)
  if (readJson(model).nodes.find((n) => n.id === holes[0].id).descSource !== 'llm') die('§7: cache-merge did not preserve enrichment across a plain regen')

  // R5: stale prose survives a failed refill — a network outage must never make a box worse.
  const corrupt = readJson(model)
  corrupt.nodes.find((n) => n.id === holes[0].id).descInputHash = 'stale'
  writeFileSync(model, JSON.stringify(corrupt, null, 2) + '\n')
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('R5 regen exit ' + r.status, r)
  let n5 = readJson(model).nodes.find((n) => n.id === holes[0].id)
  if (!(n5.descSource === 'llm' && n5.func === 'Auto-described (test enricher).')) die('R5: stale llm prose dropped on a plain regen')
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo])
  if (r.status !== 0) die('R5: stale enrichment must stay advisory, not a gate failure', r)
  if (!/enrichment stale/.test(r.stderr || '')) die('R5: check did not warn about the stale enrichment')
  // enricher unreachable (unknown provider ⇒ same code path, zero network): prose still stands
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model, '--enrich', '--enricher', 'nope'])
  if (r.status !== 0) die('R5: a failing enricher must not abort gen', r)
  n5 = readJson(model).nodes.find((n) => n.id === holes[0].id)
  if (n5.func !== 'Auto-described (test enricher).') die('R5: prose lost when the enricher was unreachable')
  // ...and a working enricher DOES refresh it (stale entries must stay refillable)
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model, '--enrich', '--enricher', 'echo'])
  if (r.status !== 0) die('R5 refill exit ' + r.status, r)
  n5 = readJson(model).nodes.find((n) => n.id === holes[0].id)
  if (n5.descInputHash === 'stale') die('R5: a stale hash was never refreshed — the node is stuck stale forever')
  console.log(`  ok enrich — §7 filled ${holes.length} hole(s) offline; cache-merge sticky; R5 stale prose survives + refills`)
}

// 6) scaffold regression: default `forma doc` (no --attach) still writes the arc42 scaffold unchanged
{
  const REPO = FIX('mini'), topo = join(tmp, 'sc-topo.json'), model = join(tmp, 'sc-model.json'), out = join(tmp, 'ARCH.scaffold.md')
  run(['init', '--repo', REPO, '--out', topo, '--force'])
  run(['gen', '--repo', REPO, '--topology', topo, '--out', model])
  const r = run(['doc', '--repo', REPO, '--model', model, '--out', out]); if (r.status !== 0) die('scaffold doc exit ' + r.status, r)
  const s = readFileSync(out, 'utf-8')
  if (!(s.includes('C4Context') && s.includes('| Container | Tech | Leaves') && s.includes('TODO(forma)'))) die('scaffold-regression: missing expected sections')
  for (const key of ['title', 'doc_version', 'status', 'last_review', 'owner', 'canonical_id', 'tags', 'related']) {
    if (!new RegExp('^' + key + ':', 'm').test(s)) die('scaffold-regression: generated frontmatter is missing ' + key)
  }
  console.log('  ok scaffold — default forma doc unchanged')
}

// 7) WP-A1 status overlay: curated programme state decorates nodes by id, form-validated only
{
  const repo = join(tmp, 'overlay-repo')
  cpSync(FIX('mini'), repo, { recursive: true })
  const topo = join(tmp, 'ov-topo.json'), model = join(tmp, 'ov-model.json')
  let r = run(['init', '--repo', repo, '--out', topo, '--force']); if (r.status !== 0) die('overlay init exit ' + r.status, r)
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('overlay gen exit ' + r.status, r)
  const target = readJson(model).nodes.find((n) => n.kind === 'container')
  const ovFile = join(repo, 'docs/architecture/c4-status.json')
  mkdirSync(dirname(ovFile), { recursive: true })
  const overlay = (patch) => writeFileSync(ovFile, JSON.stringify({ nodes: { [target.id]: patch } }, null, 2))
  // the default path is picked up with no flag at all
  overlay({ status2: 'in-progress', completion: 60, statusWord: 'v2 in corso', current: 'Live on ACA.', target: 'Multi-surface.', verify: { source: 'ADR-040' }, issues: ['#534'] })
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('overlay gen (decorated) exit ' + r.status, r)
  const dec = readJson(model).nodes.find((n) => n.id === target.id)
  if (!(dec.status2 === 'in-progress' && dec.completion === 60 && dec.statusWord === 'v2 in corso' && dec.current === 'Live on ACA.')) die('WP-A1: overlay did not decorate the node: ' + JSON.stringify(dec))
  if (dec.func !== target.func) die('WP-A1: overlay must not touch func (docs own it)')
  if (readJson(model).source.statusPath !== 'docs/architecture/c4-status.json') die('WP-A1: statusPath not recorded in the model')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('WP-A1: check should PASS with a valid overlay', r)
  // `current` is no longer stuffed with "Exists: <path>" — undecorated nodes leave it to func
  if (readJson(model).nodes.some((n) => /^Exists: /.test(n.current || ''))) die('WP-A1: the "Exists: <path>" filler is back in current')
  // form errors fail LOUD at gen: forbidden field, bad enum, malformed issue, unknown id
  for (const [label, patch] of [['func', { func: 'nope' }], ['status2', { status2: 'almost' }],
                                ['completion', { completion: 140 }], ['issues', { issues: ['bug-12'] }]]) {
    overlay(patch)
    r = run(['gen', '--repo', repo, '--topology', topo, '--out', join(tmp, 'ov-bad.json')])
    if (r.status === 0) die(`WP-A1: an invalid ${label} in the overlay must fail gen`)
  }
  writeFileSync(ovFile, JSON.stringify({ nodes: { ghost__node: { statusWord: 'x' } } }, null, 2))
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', join(tmp, 'ov-bad.json')])
  if (r.status === 0) die('WP-A1: an unknown node id in the overlay must fail gen')
  // and the gate catches it even without a regen (the model still points at the overlay)
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (r.status === 0) die('WP-A1: check stayed green on an overlay decorating a node that does not exist')
  console.log('  ok status-overlay — WP-A1 decorates by id, refuses func/bad enums/orphan ids; gate catches a stale overlay')
}

// 7a) WP-A7 --status-apply: the writer the overlay never had. It merges into the CURATED file that
// the overlay pass validates and `check` governs, so a patch that pass would reject must be refused
// BEFORE anything reaches disk — otherwise an apply corrupts a committed file and the next `gen`
// is the one that finds out.
{
  const repo = join(tmp, 'sa-repo')
  cpSync(FIX('mini'), repo, { recursive: true })
  const topo = join(tmp, 'sa-topo.json'), model = join(tmp, 'sa-model.json')
  const ovFile = join(repo, 'docs/architecture/c4-status.json')
  const fill = join(tmp, 'sa-fill.json')
  let r = run(['init', '--repo', repo, '--out', topo, '--force']); if (r.status !== 0) die('A7 init exit ' + r.status, r)
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('A7 gen exit ' + r.status, r)
  const cont = readJson(model).nodes.find((n) => n.kind === 'container'); if (!cont) die('A7: no container in the model')
  if (cont.status2 !== 'unknown') die('A7 precondition: mini should have no verdict before the apply, got ' + cont.status2)

  // mini has no docs/architecture/ at all: the FIRST apply is the one that creates the overlay
  writeFileSync(fill, JSON.stringify({ nodes: { [cont.id]: { status2: 'in-progress', completion: 40, current: 'Two of five modules landed.' } } }))
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model, '--status-apply', fill])
  if (r.status !== 0) die('A7 apply exit ' + r.status, r)
  const dec = readJson(model).nodes.find((n) => n.id === cont.id)
  if (!(dec.status2 === 'in-progress' && dec.completion === 40)) die('A7: applied state did not reach the model: ' + JSON.stringify(dec))
  if (!readJson(ovFile).nodes[cont.id]) die('A7: --status-apply did not write the curated overlay file')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('A7: check must pass on an applied overlay', r)

  // merge, not overwrite: a second apply touching another field keeps the first
  writeFileSync(fill, JSON.stringify({ nodes: { [cont.id]: { statusWord: '40%' } } }))
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model, '--status-apply', fill]); if (r.status !== 0) die('A7 merge exit ' + r.status, r)
  const merged = readJson(ovFile).nodes[cont.id]
  if (!(merged.statusWord === '40%' && merged.status2 === 'in-progress')) die('A7: the second apply overwrote the first instead of merging: ' + JSON.stringify(merged))

  // every refusal must leave the committed overlay byte-identical
  const before = readFileSync(ovFile, 'utf-8')
  for (const [label, patch] of [['a bad enum', { status2: 'almost' }], ['an out-of-range completion', { completion: 140 }],
                                ['func', { func: 'nope' }], ['a malformed issue', { issues: ['bug-12'] }],
                                ['a non-object patch', 'done']]) {
    writeFileSync(fill, JSON.stringify({ nodes: { [cont.id]: patch } }))
    r = run(['gen', '--repo', repo, '--topology', topo, '--out', join(tmp, 'sa-bad.json'), '--status-apply', fill])
    if (r.status === 0) die(`A7: --status-apply accepted ${label}`)
    if (readFileSync(ovFile, 'utf-8') !== before) die(`A7: --status-apply wrote to the overlay before rejecting ${label} — a committed file was corrupted`)
  }
  writeFileSync(fill, JSON.stringify({ nodes: { ghost__node: { statusWord: 'x' } } }))
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', join(tmp, 'sa-bad.json'), '--status-apply', fill])
  if (r.status === 0) die('A7: --status-apply accepted an id the model does not have')
  if (readFileSync(ovFile, 'utf-8') !== before) die('A7: --status-apply wrote to the overlay before rejecting an unknown id')

  // and the two other holes this branch closes. `sa-repo` is a plain copy with no git remote, so
  // it must carry NO ghRepo — a fabricated one would send `forma verify` at the wrong repository.
  if ('ghRepo' in readJson(topo).meta) die('A7: init invented a ghRepo for a directory with no git remote: ' + JSON.stringify(readJson(topo).meta.ghRepo))
  const selfTopo = join(tmp, 'sa-self-topo.json')
  r = run(['init', '--repo', join(HERE, '..'), '--out', selfTopo, '--force']); if (r.status !== 0) die('A7 self init exit ' + r.status, r)
  if (!/^[\w.-]+\/[\w.-]+$/.test(readJson(selfTopo).meta.ghRepo || '')) die('A7: init did not seed meta.ghRepo from the git remote, got ' + JSON.stringify(readJson(selfTopo).meta.ghRepo))
  const cats = [...new Set(readJson(model).nodes.filter((n) => n.kind === 'leaf').map((n) => n.category))]
  if (cats.includes('container')) die('A7: leaf category is still the parent\'s KIND — the viewer collapses every leaf into one box: ' + JSON.stringify(cats))
  console.log(`  ok status-apply — WP-A7 fill → curated overlay; merges, refuses without writing; init seeds ghRepo; leaf categories ${JSON.stringify(cats)}`)
}

// 7b) a synthesized component composes its box from its CHILDREN's docs, so their prose is one of
// its description inputs: a child gaining a docstring must mark the component's cached LLM text
// stale, or the box freezes with no way back (regen restores it, --enrich sees no hole).
{
  const repo = join(tmp, 'comp-hash')
  cpSync(FIX('flat-python'), repo, { recursive: true })
  const topo = join(tmp, 'ch-topo.json'), model = join(tmp, 'ch-model.json')
  run(['init', '--repo', repo, '--out', topo, '--force'])
  let r = run(['gen', '--repo', repo, '--topology', topo, '--out', model, '--enrich', '--enricher', 'echo'])
  if (r.status !== 0) die('comp-hash enrich exit ' + r.status, r)
  const comp = readJson(model).nodes.find((n) => n.kind === 'component' && n.name === 'user')
  if (!comp || comp.descSource !== 'llm') die('comp-hash precondition: the component was not enriched')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (/enrichment stale/.test(r.stderr || '')) die('comp-hash: freshly enriched component reported stale')
  // a child's documentation changes → the component's composed description would change with it
  const kid = join(repo, 'src/services/user_service.py')
  const q3 = '"'.repeat(3)
  writeFileSync(kid, q3 + 'Rewritten: registers, authenticates and deletes user accounts.' + q3 + '\n')
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('comp-hash regen exit ' + r.status, r)
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (r.status !== 0) die('comp-hash: check must stay green (staleness is advisory)', r)
  if (!new RegExp('enrichment stale for ' + comp.id).test(r.stderr || '')) die('comp-hash: a child gaining docs left the component prose frozen and unflagged')
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model, '--enrich', '--enricher', 'echo'])
  if (!/filled 1\/1/.test(r.stdout || '')) die('comp-hash: --enrich could not re-admit the component as a hole: ' + (r.stdout || ''))
  console.log('  ok component-hash — a child gaining documentation marks the component prose stale and refillable')
}

// 8) WP-A5 `forma verify`: live issue state, offline in the test via a gh stub
{
  const repo = join(tmp, 'verify-repo')
  cpSync(FIX('mini'), repo, { recursive: true })
  const topo = join(tmp, 'vf-topo.json'), model = join(tmp, 'vf-model.json')
  let r = run(['init', '--repo', repo, '--out', topo, '--force']); if (r.status !== 0) die('verify init exit ' + r.status, r)
  // the overlay is how issues reach the model (WP-A1): one node on a closed issue, one on an open one
  const t = readJson(topo)
  const [c1, c2] = t.nodes.filter((n) => n.kind === 'container')
  mkdirSync(join(repo, 'docs/architecture'), { recursive: true })
  writeFileSync(join(repo, 'docs/architecture/c4-status.json'), JSON.stringify({
    nodes: { [c1.id]: { issues: ['#7'], current: 'Was in progress.', statusWord: 'NEXT' }, [c2.id]: { issues: ['#8'], current: 'Still open.', statusWord: 'NEXT' } },
  }, null, 2))
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('verify gen exit ' + r.status, r)
  const GH = process.execPath + ' ' + join(HERE, 'stub-gh.mjs') + ' multi'
  const SIGNALS = ['--workflow', 'ci=.github/workflows/ci.yml', '--release']
  const openBefore = JSON.stringify(readJson(model).nodes.find((n) => n.id === c2.id))
  r = run(['verify', '--repo', repo, '--model', model, '--gh-repo', 'acme/thing', '--gh-cmd', GH, ...SIGNALS])
  if (r.status !== 0) die('WP-A5: verify exit ' + r.status, r)
  let v = readJson(model)
  const snapshot = readJson(join(repo, 'docs/architecture/c4-issues.json'))
  const done = v.nodes.find((n) => n.id === c1.id), open = v.nodes.find((n) => n.id === c2.id)
  if (snapshot.issues.map((it) => it.n).join() !== '7,8,9' || snapshot.collection.pagination !== 'gh api graphql --paginate --slurp') die('verify: GraphQL pagination did not publish both pages')
  if (!Array.isArray(snapshot.milestones) || snapshot.milestones.map((milestone) => milestone.title).join() !== 'v1' || snapshot.collection.milestonesComplete !== false || !/zero issues/.test(snapshot.collection.milestonesReason)) die('verify: issue-derived milestones were changed or presented as complete')
  const issueSchema = new URL('../lib/schema/c4-issues.schema.json', import.meta.url)
  for (const field of ['milestonesComplete', 'milestonesReason']) {
    const incomplete = JSON.parse(JSON.stringify(snapshot)); delete incomplete.collection[field]
    if (!validateModel(incomplete, issueSchema).some((error) => error.includes(field))) die('verify schema: missing collection.' + field + ' was accepted')
  }
  const native = snapshot.dependencies.edges.find((edge) => edge.source === 'native' && edge.from.number === 8 && edge.to.number === 7)
  const prose = snapshot.dependencies.edges.find((edge) => edge.source === 'prose' && edge.from.number === 9 && edge.to.number === 8)
  if (!snapshot.dependencies.complete || !native || native.from.repo !== 'acme/thing' || !native.from.url || native.to.state !== 'CLOSED' || !prose || !prose.fingerprint || !/Depends on #8/.test(prose.quote)) die('verify: native dependency or prose candidate missing: ' + JSON.stringify(snapshot.dependencies))
  if (snapshot.dependencies.edges.some((edge) => edge.from.number === 7 && edge.to.number === 8)) die('verify: naked "Related #8" became a dependency')
  const { applyDependencyConfirmations } = await import(join(HERE, '..', 'lib/audit.mjs'))
  const confirmed = applyDependencyConfirmations(repo, [], [{ fingerprint: prose.fingerprint, evidence: [{ type: 'issue', ref: '9' }] }], snapshot, { today: '2026-08-10' }).dependencyConfirmations
  const confirmedDependencies = deriveDependencies(repo, snapshot, { dependencyConfirmations: confirmed })
  if (!confirmedDependencies.edges.some((edge) => edge.source === 'prose' && edge.from.number === 9) || !confirmedDependencies.activeBlocked.includes(9)) die('verify: an evidence-gated prose confirmation did not activate its candidate')
  const changedCandidate = JSON.parse(JSON.stringify(snapshot)); changedCandidate.dependencies.edges.find((edge) => edge.source === 'prose').fingerprint = '0'.repeat(64)
  const staleDependencies = deriveDependencies(repo, changedCandidate, { dependencyConfirmations: confirmed })
  if (staleDependencies.edges.some((edge) => edge.source === 'prose') || !staleDependencies.staleConfirmations.includes(prose.fingerprint)) die('verify: changed prose candidate kept an old confirmation active')
  const ci = snapshot.signals.workflows.ci
  if (!ci || ci.state !== 'present' || ci.headBranch !== 'main' || ci.event !== 'push') die('verify: workflow branch/event signal was not retained')
  if (snapshot.signals.release.listState !== 'present' || !snapshot.signals.release.resolvableTag.sha) die('verify: resolvable release signal missing')
  // #43: this used to assert completion === 100, which encoded the defect rather than preventing
  // it — a closed issue justifies a VERDICT, never a percentage, and the number it wrote carried
  // no citation, so the publication gate read it as a measurement.
  if (done.status2 !== 'done') die('WP-A5: node on a CLOSED issue not marked done')
  if (done.completion != null) die('WP-A5: a closed issue produced a percentage (' + done.completion + '%) — nothing here measured anything')
  // the badge renders statusWord over the verdict, so a curated word must not outlive it
  if (done.statusWord != null) die('WP-A5: badge still reads "' + done.statusWord + '" on a node verified done')
  if (!/^Closed with evidence \(#7 CLOSED, gh .*\)\. Was in progress\.$/.test(done.current)) die('WP-A5: evidence prefix missing/malformed: ' + done.current)
  if (JSON.stringify(open) !== openBefore) die('WP-A5: node on an OPEN issue was modified: ' + JSON.stringify(open))
  if (!(v.meta.verifiedAt && v.meta.verifyMethod === 'gh live')) die('WP-A5: fact base not stamped')
  // structure is untouched and the gate is unaffected, before and after
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('WP-A5: check must stay green after verify', r)
  // idempotent: a second run must not stack evidence prefixes
  r = run(['verify', '--repo', repo, '--model', model, '--gh-repo', 'acme/thing', '--gh-cmd', GH, ...SIGNALS])
  if (r.status !== 0) die('WP-A5: second verify exit ' + r.status, r)
  v = readJson(model)
  if ((String(v.nodes.find((n) => n.id === c1.id).current).match(/Closed with evidence/g) || []).length !== 1) die('WP-A5: evidence prefix stacked on re-run')
  // gh missing → loud failure, model byte-identical
  const before = readFileSync(model, 'utf-8')
  r = run(['verify', '--repo', repo, '--model', model, '--gh-repo', 'acme/thing', '--gh-cmd', 'forma-no-such-gh-binary'])
  if (r.status === 0) die('WP-A5: a missing gh must fail loud')
  if (readFileSync(model, 'utf-8') !== before) die('WP-A5: model was modified despite the gh failure')

  // Optional repository signals degrade independently: issue pagination still succeeds and the
  // snapshot remains usable, with an explicit unknown reason for each failed channel.
  const signalRepo = join(tmp, 'verify-signals'), signalIssues = join(signalRepo, 'issues.json')
  mkdirSync(signalRepo, { recursive: true })
  r = run(['verify', '--repo', signalRepo, '--issues', signalIssues, '--gh-repo', 'acme/thing', '--gh-cmd', process.execPath + ' ' + join(HERE, 'stub-gh.mjs') + ' fail-signals', ...SIGNALS])
  if (r.status !== 0 || !existsSync(signalIssues)) die('verify: a signal failure aborted the complete issue snapshot', r)
  const degraded = readJson(signalIssues)
  if (degraded.signals.workflows.ci.state !== 'unknown' || degraded.signals.release.listState !== 'unknown' || degraded.collection.signalsUnknown !== 2) die('verify: failed signals did not degrade to explicit unknowns')

  // A relation count larger than its fetched nodes, and an API with no dependency fields, both
  // mean unknown completeness — neither may collapse to "zero blockers".
  for (const mode of ['truncated', 'unsupported']) {
    const depRepo = join(tmp, 'verify-' + mode), depIssues = join(depRepo, 'issues.json')
    mkdirSync(depRepo, { recursive: true })
    r = run(['verify', '--repo', depRepo, '--issues', depIssues, '--gh-repo', 'acme/thing', '--gh-cmd', process.execPath + ' ' + join(HERE, 'stub-gh.mjs') + ' ' + mode])
    if (r.status !== 0) die('verify: ' + mode + ' dependency channel aborted the issue snapshot', r)
    const depSnapshot = readJson(depIssues)
    if (depSnapshot.dependencies.complete !== false) die('verify: ' + mode + ' dependencies were presented as complete')
    if (mode === 'truncated' && (!depSnapshot.dependencies.supported || depSnapshot.collection.truncatedRelations !== 1)) die('verify: relation totalCount truncation was not disclosed')
    if (mode === 'unsupported' && (depSnapshot.dependencies.supported || !depSnapshot.dependencies.reason)) die('verify: unsupported dependency API was presented as an empty supported result')
  }

  // R4-1: the issue fact base is useful without a C4 map. Auto-detect absence instead of making a
  // caller know a second flag, and prove the update orchestrator no longer skips that programme.
  const mapless = join(tmp, 'verify-mapless'), maplessIssues = join(mapless, 'issues.json')
  mkdirSync(mapless, { recursive: true })
  r = run(['verify', '--repo', mapless, '--issues', maplessIssues, '--gh-repo', 'acme/thing', '--gh-cmd', GH])
  if (r.status !== 0) die('WP-A5: model-less verify exit ' + r.status, r)
  if (readJson(maplessIssues).issues.map((it) => it.n).join() !== '7,8,9') die('WP-A5: model-less verify did not write the complete stub snapshot')
  if (existsSync(join(mapless, 'docs/architecture/c4-model.json'))) die('WP-A5: model-less verify invented a model')

  const maplessManifest = join(mapless, 'forma.room.json'), maplessRoom = join(mapless, 'room.html')
  writeFileSync(maplessManifest, JSON.stringify({ today: '2026-08-17', programs: [{ id: 'mapless', ghRepo: 'acme/thing', repo: '.', issues: 'issues.json' }] }, null, 2))
  rmSync(maplessIssues)
  r = run(['room', 'update', '--manifest', maplessManifest, '--out', maplessRoom, '--gh-cmd', GH])
  if (r.status !== 0) die('WP-A5: room update skipped or failed its map-less programme', r)
  if (!existsSync(maplessIssues) || !existsSync(maplessRoom)) die('WP-A5: room update did not refresh then compose the map-less programme')
  if (/left as-is|snapshot refresh needs/.test((r.stdout || '') + (r.stderr || ''))) die('WP-A5: room update still reports the map-less programme as skipped')
  const roomBeforeFailedUpdate = readFileSync(maplessRoom, 'utf-8')
  r = run(['room', 'update', '--manifest', maplessManifest, '--out', maplessRoom, '--gh-cmd', 'forma-no-such-gh-binary'])
  if (r.status === 0 || readFileSync(maplessRoom, 'utf-8') !== roomBeforeFailedUpdate) die('WP-A5: room update published after verify failed', r)
  console.log('  ok verify — WP-A5 closed→done with dated evidence, open untouched, idempotent, gh failure leaves the model intact')
}

// 9) WP-A6 enricher `agent`: no network, no API key — the agent driving forma writes the prose
{
  // mini has both: undocumented leaves (real holes, with a source path to offer the agent) and
  // leaves carrying a leading comment (descSource docstring — must be refused by --enrich-apply)
  const REPO = FIX('mini'), topo = join(tmp, 'ag-topo.json'), model = join(tmp, 'ag-model.json')
  run(['init', '--repo', REPO, '--out', topo, '--force'])
  let r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model, '--enrich', '--enricher', 'agent'])
  if (r.status !== 0) die('WP-A6: agent plan gen exit ' + r.status, r)
  const plan = readJson(join(tmp, 'enrich-plan.json'))
  if (!plan.entries.length) die('WP-A6: the plan has no entries (fixture has no holes?)')
  // F2: holes are leaves, components AND containers. Containers were excluded on the theory that
  // the topology describes them; on an init-seeded repo they are the boxes still on a fallback.
  const holeIds = readJson(model).nodes.filter((n) => n.descSource === 'fallback' && (n.kind === 'leaf' || n.kind === 'component' || n.kind === 'container')).map((n) => n.id).sort()
  if (!holeIds.some((id) => readJson(model).nodes.find((n) => n.id === id).kind === 'container')) die('F2: precondition — this fixture has no undescribed container to plan for')
  if (JSON.stringify(plan.entries.map((e) => e.id).sort()) !== JSON.stringify(holeIds)) die('WP-A6: plan entries do not match the model holes')
  if (!plan.entries.every((e) => e.prompt && e.descInputHash)) die('WP-A6: plan entry missing prompt/descInputHash')
  if (!plan.entries.some((e) => /Read the file at .+ if you need certainty\./.test(e.prompt))) die('WP-A6: the agent prompt never offers the source path (that is the point of agent mode)')
  // F2: a container's prompt must not be self-referential — containerOf(container) is itself, so
  // unguarded it says "auth belongs to the container auth" and calls its own children siblings.
  const cHole = readJson(model).nodes.find((n) => n.kind === 'container' && holeIds.includes(n.id))
  const cPrompt = plan.entries.find((e) => e.id === cHole.id).prompt
  if (new RegExp('belongs to the container "' + cHole.name + '"').test(cPrompt)) die('F2: the container prompt says it belongs to itself:\n' + cPrompt)
  if (/Sibling modules/.test(cPrompt)) die('F2: the container prompt calls its own children siblings:\n' + cPrompt)
  if (!/Read the sources under .+\/ if you need certainty\./.test(cPrompt)) die('F2: the container prompt has no filesystem pointer (its evidence is a glob, not a path):\n' + cPrompt)
  // the model is still written with its deterministic fallbacks — the plan is additive
  if (!holeIds.length) die('WP-A6: gen must still write the model when planning')

  const fill = join(tmp, 'enrich-fill.json')
  writeFileSync(fill, JSON.stringify({ fills: [{ id: holeIds[0], func: 'Written by the agent, not a REST call.' }] }))
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model, '--enrich-apply', fill])
  if (r.status !== 0) die('WP-A6: --enrich-apply exit ' + r.status, r)
  let applied = readJson(model).nodes.find((n) => n.id === holeIds[0])
  if (!(applied.func === 'Written by the agent, not a REST call.' && applied.descSource === 'llm' && applied.descInputHash)) die('WP-A6: fill not applied with provenance: ' + JSON.stringify(applied))
  // sticky across a plain regen, like any other enrichment
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('WP-A6 regen exit ' + r.status, r)
  if (readJson(model).nodes.find((n) => n.id === holeIds[0]).descSource !== 'llm') die('WP-A6: applied prose lost on regen')
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('WP-A6: check after agent enrichment', r)
  // a fill aimed at a documented node is an error, never a silent overwrite
  const documented = readJson(model).nodes.find((n) => n.descSource === 'docstring')
  writeFileSync(fill, JSON.stringify({ fills: [{ id: documented.id, func: 'should be refused' }] }))
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', join(tmp, 'ag-bad.json'), '--enrich-apply', fill])
  if (r.status === 0) die('WP-A6: --enrich-apply overwrote a docstring-described node')
  writeFileSync(fill, JSON.stringify({ fills: [{ id: 'no__such__node', func: 'x' }] }))
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', join(tmp, 'ag-bad.json'), '--enrich-apply', fill])
  if (r.status === 0) die('WP-A6: --enrich-apply accepted an unknown node id')
  console.log(`  ok enrich-agent — WP-A6 plan (${plan.entries.length} holes) → fill → apply, offline; refuses documented nodes and unknown ids`)
}

// 10) WP-A4 layout hints: curated coordinates ride from topology to model, and the viewer's
// seeder pins them without ever letting an unhinted node land on top of a pinned one.
{
  const REPO = FIX('mini'), topo = join(tmp, 'ly-topo.json'), model = join(tmp, 'ly-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('layout init exit ' + r.status, r)
  const t = readJson(topo)
  const layout = { root: { [t.nodes[0].id]: { x: 40, y: 190, w: 190, h: 82 } } }
  writeFileSync(topo, JSON.stringify({ ...t, layout }, null, 2))
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('layout gen exit ' + r.status, r)
  if (JSON.stringify(readJson(model).meta.layout) !== JSON.stringify(layout)) die('WP-A4: topology layout did not reach meta.layout verbatim')

  const html = readFileSync(join(HERE, '..', 'lib', 'viewer', 'c4-hologram.html'), 'utf-8')
  const src = (html.match(/\nvar NW=[\s\S]*?(?=\nfunction layoutFor\()/) || [])[0]
  if (!src) die('WP-A4: seedLayout/autoLayout not found in the viewer')
  const seedLayout = new Function(src + '; return seedLayout')()
  const kids = [{ id: 'pinned', kind: 'container' }, { id: 'free1', kind: 'container' }, { id: 'free2', kind: 'container' }]
  const hint = { pinned: { x: 40, y: 190, w: 190, h: 82 } }
  const lay = seedLayout(kids, hint)
  const p = lay.pos.pinned
  if (!(p.x === 40 && p.y === 190 && p.w === 190 && p.h === 82)) die('WP-A4: hinted node not placed at its coordinates: ' + JSON.stringify(p))
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  for (const id of ['free1', 'free2']) {
    if (!lay.pos[id]) die('WP-A4: unhinted node lost its slot: ' + id)
    if (hits(p, lay.pos[id])) die(`WP-A4: unhinted ${id} overlaps the pinned node`)
    if (lay.pos[id].x + lay.pos[id].w > lay.W || lay.pos[id].y + lay.pos[id].h > lay.H) die('WP-A4: viewBox does not cover the auto-placed nodes')
  }
  if (JSON.stringify(seedLayout(kids, null)) !== JSON.stringify(seedLayout(kids))) die('WP-A4: no-hint path changed shape')

  // LEGIBILITY FLOOR. The owner's complaint about a real 53-container repo — "you cannot read
  // anything" — stated as a number. The stage is full-width by 74vh and the viewBox is
  // fit-to-content with xMidYMid meet, so the on-screen font is the model font times
  // min(stageW/W, stageH/H). A title under ~9px is not readable on a projector; the shipped
  // 4-column cap put it at 3.24px for 53 siblings, and at less than 9px for 44 of the 60 counts.
  const autoLayout = new Function(src + '; return autoLayout')()
  const TITLE_PX = 11.5, FLOOR = 9, STAGE_W = 1884, STAGE_H = 799
  let worst = { px: Infinity, n: 0 }
  for (let n = 1; n <= 60; n++) {
    const l = autoLayout([...Array(n)].map((_, i) => ({ id: 'k' + i, kind: 'container' })))
    const px = TITLE_PX * Math.min(STAGE_W / l.W, STAGE_H / l.H)
    if (px < worst.px) worst = { px, n }
  }
  if (worst.px < FLOOR) die(`viewer legibility: a title renders at ${worst.px.toFixed(2)}px with ${worst.n} siblings — under the ${FLOOR}px floor, nobody can read the board`)
  console.log(`  ok layout-hints — WP-A4 layout verbatim, pinned coords honoured; legibility floor holds to 60 siblings (worst ${worst.px.toFixed(1)}px)`)
}

// 10) viewer contract: the parts that are pure logic (no DOM) — arrow-label anchor + i18n parity.
// The viewer is a single HTML file with no test seam, and the repo ships zero dependencies (no
// jsdom), so the checkable parts are lifted out of our OWN tracked file and evaluated. Input is
// lib/viewer/c4-hologram.html, never user data.
{
  const html = readFileSync(join(HERE, '..', 'lib', 'viewer', 'c4-hologram.html'), 'utf-8')
  // the label anchor must sit ON the curve: evaluate the shipped edgePath and compare against the
  // quadratic Bezier at t=0.5, recomputed from the control point in the path string it returned.
  const fn = (html.match(/\nfunction edgePath\(a,b\)\{[\s\S]*?\n\}/) || [])[0]
  if (!fn) die('viewer: edgePath not found — did the signature change?')
  const edgePath = new Function(fn + '; return edgePath')()
  for (const [a, b] of [[{ x: 0, y: 0, w: 228, h: 118 }, { x: 600, y: 400, w: 228, h: 118 }],
                        [{ x: 500, y: 40, w: 228, h: 118 }, { x: 60, y: 500, w: 228, h: 118 }]]) {
    const r = edgePath(a, b)
    const m = String(r.d).match(/^M([-\d.]+),([-\d.]+) Q([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)$/)
    if (!m) die('viewer: unexpected edge path shape ' + r.d)
    const [x1, y1, cx, cy, x2, y2] = m.slice(1).map(Number)
    const at = (p0, p1, p2) => 0.25 * p0 + 0.5 * p1 + 0.25 * p2 // Bezier at t=0.5
    if (Math.abs(r.mx - at(x1, cx, x2)) > 1e-9 || Math.abs(r.my - at(y1, cy, y2)) > 1e-9) {
      die(`viewer: label anchor (${r.mx},${r.my}) is off the curve (want ${at(x1, cx, x2)},${at(y1, cy, y2)})`)
    }
    if (Math.abs(r.mx - cx) < 1e-9 && Math.abs(r.my - cy) < 1e-9) die('viewer: label anchored on the control point, not the curve')
  }
  // wrapDesc must never return a line wider than the box: an unbreakable token (long class name,
  // URL) would paint outside the rounded rect, and there is no clip-path on the node.
  const wfn = (html.match(/\nfunction wrapDesc\(desc,cpl,max\)\{[\s\S]*?\n\}/) || [])[0]
  if (!wfn) die('viewer: wrapDesc not found')
  const wrapDesc = new Function(wfn + '; return wrapDesc')()
  const cpl = 37
  for (const [desc, max, why] of [
    ['Configures EmailNotificationDispatcherFactoryProvider.', 3, 'long token on a line that fits'],
    ['a '.repeat(80), 2, 'plain overflow'],
    ['short one', 3, 'no truncation'],
    ['https://example.com/a/very/long/path/that/never/breaks/at/all', 1, 'unbreakable url'],
  ]) {
    const out = wrapDesc(desc, cpl, max)
    if (out.length > max) die(`viewer wrapDesc: ${why} → ${out.length} lines, max ${max}`)
    for (const l of out) if (l.length > cpl) die(`viewer wrapDesc: ${why} → line of ${l.length} chars exceeds ${cpl}: ${JSON.stringify(l)}`)
  }
  if (wrapDesc('anything at all', 37, 0).length) die('viewer wrapDesc: a box with no room must render no description')
  if (wrapDesc('short one', 37, 3).join('|') !== 'short one') die('viewer wrapDesc: text that fits must not be altered')

  // a box that groups others borrows their verdicts — but the mean alone would be the invented
  // green (14 of 14 ruled done says nothing about the other 8), so the coverage is half the claim
  const rfn = (html.match(/\nfunction rollStatus\(node,kidsOf\)\{[\s\S]*?\n\}/) || [])[0]
  if (!rfn) die('viewer: rollStatus not found')
  const rollStatus = new Function(rfn + '; return rollStatus')()
  const tree = { dom: [{ id: 'a', status2: 'done', completion: 100 }, { id: 'b', status2: 'done', completion: 100 }, { id: 'c', status2: 'unknown' }] }
  const kidsOf = (id) => tree[id] || []
  const r = rollStatus({ id: 'dom' }, kidsOf)
  if (!r || r.mean !== 100 || r.ruled !== 2 || r.total !== 3) die('rollStatus: a grouping box must report its children\'s mean AND how many were ruled, got ' + JSON.stringify(r))
  // worst-of, and `unknown` outranks `done` on purpose (the same rank the catalogue collapse uses):
  // a domain holding one package nobody ruled on is not a green domain, however green the rest is
  if (r.status2 !== 'unknown') die('rollStatus: an unruled child was averaged away into green, got ' + r.status2)
  const twoDone = (id) => (id === 'dom' ? tree.dom.slice(0, 2) : [])
  if (rollStatus({ id: 'dom' }, twoDone).status2 !== 'done') die('rollStatus: all children ruled done must give done')
  // worst-of wins, so one broken child cannot hide behind two green ones
  tree.dom[2] = { id: 'c', status2: 'problem', completion: 10 }
  if (rollStatus({ id: 'dom' }, kidsOf).status2 !== 'problem') die('rollStatus: a problem child was averaged away')
  // a box that speaks for itself is left alone, and a box with nothing ruled below it stays silent
  if (rollStatus({ id: 'dom', completion: 40 }, kidsOf)) die('rollStatus: overrode a box that carries its own verdict')
  if (rollStatus({ id: 'x' }, () => [])) die('rollStatus: invented a roll-up for a box with no children')
  if (rollStatus({ id: 'dom' }, () => [{ id: 'q', status2: 'unknown' }])) die('rollStatus: reported a mean where nobody ruled on anything')
  // …and a VERDICT is not a percentage. A document declares; it does not measure, so its nodes
  // carry `done` with no completion. Keying the roll-up on the number alone put `?` on a domain
  // holding nine packages a document calls finished — the same silence #42 closed, one cause later.
  const declared = (id) => (id === 'dom' ? [{ id: 'a', status2: 'done' }, { id: 'b', status2: 'done' }, { id: 'c', status2: 'unknown' }] : [])
  const rd = rollStatus({ id: 'dom' }, declared)
  if (!rd) die('rollStatus: a box whose children are ruled WITHOUT a percentage went silent')
  if (rd.ruled !== 2 || rd.total !== 3) die('rollStatus: ruled/total must count verdicts, not percentages — got ' + JSON.stringify(rd))
  if (rd.mean != null) die('rollStatus: invented a mean where no child carries one — got ' + rd.mean)

  // The badge is the first number a stakeholder reads, so it is a function like the rest.
  const bfn = (html.match(/\nfunction badgeOf\(n,roll\)\{[\s\S]*?\n\}/) || [])[0]
  if (!bfn) die('viewer: badgeOf not found — the badge must be liftable to be measurable')
  const badgeOf = new Function('var STR={stUnk:"?"};' + bfn + '; return badgeOf')()
  const decl = { status2: 'done', verify: { source: 'FEATURES.md (2/2 declared done)', derived: true } }
  if (badgeOf({ status2: 'unknown' }, null) !== '?') die('viewer badge: a box nobody ruled on must still read "?"')
  if (badgeOf(decl, null) === '?') die('viewer badge: a box declared done read "?" — the badge contradicts its own colour')
  if (/%/.test(badgeOf(decl, null))) die('viewer badge: a declaration was printed as a percentage — ' + badgeOf(decl, null))
  if (badgeOf({ status2: 'unknown' }, { mean: null, ruled: 9, total: 14 }) !== '9/14') die('viewer badge: a roll-up with no percentage must still report its coverage, got ' + JSON.stringify(badgeOf({ status2: 'unknown' }, { mean: null, ruled: 9, total: 14 })))
  if (badgeOf({ status2: 'done' }, { mean: 100, ruled: 9, total: 14 }) !== '100% 9/14') die('viewer badge: the mean lost its coverage')
  if (badgeOf({ completion: 40, statusWord: 'v2 in corso' }, null) !== 'v2 in corso') die('viewer badge: a curated word must still own the badge')
  if (badgeOf({ status2: 'in-progress', completion: 40 }, null) !== '40%') die('viewer badge: a real measurement must still print')

  // "nobody ruled on it" must stop wearing the clothes of "not built yet": legHint teaches the
  // reader that a dashed box is `da costruire`, and .s-unk was dashed. That is complaint 2.
  const unkCss = (html.match(/\n\.s-unk rect\{[^}]*\}/) || [])[0]
  if (!unkCss) die('viewer: the .s-unk rect rule moved')
  if (/stroke-dasharray/.test(unkCss)) die('viewer: unknown is drawn with the dash the legend defines as "to build" — ' + unkCss.trim())
  if (!/stroke-dasharray/.test((html.match(/\n\.s-plan rect\{[^}]*\}/) || [''])[0])) die('viewer: planned lost the dash that makes legHint true')
  // the legend has promised a HOLLOW green for a done nobody proved since #38; the canvas never drew one
  if (!/\.s-done\.decl rect\{/.test(html)) die('viewer: the legend promises "DONE (declared)" but no .s-done.decl rule draws it')
  const clsLine = (html.match(/\n *var isCat=[^\n]*cls="nd s-"[^\n]*/) || [])[0]
  if (!clsLine) die('viewer: the class-assembly line moved')
  if (!/decl/.test(clsLine)) die('viewer: a done DERIVED from a document is painted exactly like a proven one — ' + clsLine.trim())

  // a derived number must disclose how much of the module its citation reaches — "3 of 3 rows
  // declared done" and "this module is done" are different sentences when the module holds 22 files
  const cfn = (html.match(/\nfunction coverText\(n\)\{[\s\S]*?\n\}/) || [])[0]
  if (!cfn) die('viewer: coverText not found')
  const coverText = new Function('var STR={coverWhole:"WHOLE",coverPart:"{n}/{t}"};' + cfn + '; return coverText')()
  if (coverText({ verify: { coverage: { named: 3, total: 22 } } }) !== '3/22') die('viewer coverage: a partially-covered box must report its reach')
  if (coverText({ verify: { coverage: { named: 8, total: 8, whole: true } } }) !== 'WHOLE') die('viewer coverage: a whole-module row must say so, not print a fraction')
  for (const n of [{}, { verify: {} }, { verify: { source: 'ADR-040' } }]) {
    if (coverText(n)) die('viewer coverage: a curated or gh-verified state has no document reach to report: ' + JSON.stringify(n))
  }

  // a description that only restates the title is ink, not information — but a real sentence that
  // happens to contain the name must survive, or the box goes blank on its best content
  const efn = (html.match(/\nvar DESC_NOISE=[\s\S]*?\n\}/) || [])[0]
  if (!efn) die('viewer: echoesName not found')
  const echoesName = new Function(efn + '; return echoesName')()
  for (const [d, n] of [['1 file: advisor.', 'internal/advisor'], ['3 packages: a, b, c.', 'a b c'], ['Component of module haben.', 'haben']]) {
    if (!echoesName(d, n)) die(`viewer echoesName: "${d}" restates "${n}" and should be dropped`)
  }
  for (const [d, n] of [['Account domain: bank/broker kinds, free-cash, IBAN.', 'internal/account'],
                        ['Derives progress from the feature matrix.', 'docmap'], ['', 'x']]) {
    if (echoesName(d, n)) die(`viewer echoesName: dropped real prose "${d}" for node "${n}"`)
  }

  // the headline percentage must never claim more coverage than it has. This is the flagship
  // promise ("mai un 100% inventato") and it lives in the one number read first.
  const tfn = (html.match(/\nfunction tallyOf\(kids,kidsOf\)\{[\s\S]*?\n\}/) || [])[0]
  if (!tfn) die('viewer: tallyOf not found — did the tally move back inline?')
  const tallyOf = new Function('var STMAP={done:"done","in-progress":"prog",next:"next",planned:"plan",problem:"prob",unknown:"unk"};' + tfn + '; return tallyOf')()
  const flat = () => [] // a board of childless boxes: every kid IS its own unit
  // the shape that produced "progress 100%" on a board where half the containers had no verdict
  const half = [...Array(25)].map((_, i) => ({ id: 'd' + i, status2: 'done', completion: 100 })).concat([...Array(28)].map((_, i) => ({ id: 'u' + i, status2: 'unknown' })))
  const t = tallyOf(half, flat)
  if (t.mean !== 100) die('viewer tally: the mean over the ruled nodes should stay 100, got ' + t.mean)
  if (t.ruled !== 25 || t.tot !== 53) die(`viewer tally: coverage should be 25/53, got ${t.ruled}/${t.tot}`)
  if (t.ruled === t.tot) die('viewer tally: a partially-ruled board must not report full coverage')
  // a node with no verdict is not 0% done — the mean must not be dragged toward zero either
  if (tallyOf([{ status2: 'done', completion: 100 }, { status2: 'unknown' }], flat).mean !== 100) die('viewer tally: an unruled node was counted as 0%')
  // nothing ruled at all ⇒ no percentage to print
  if (tallyOf([{ status2: 'unknown' }, { status2: 'unknown' }], flat).mean !== null) die('viewer tally: a board nobody ruled on must print no percentage')
  // …and grouping those same 53 under 6 domain boxes must not change one digit of that line: the
  // domains are drawn, the packages are counted. Anything else means curating the wall away
  // silently deletes verdicts, which is how `2/7` came to stand for 25/53.
  const domains = [...Array(6)].map((_, i) => ({ id: 'dom' + i }))
  const grouped = tallyOf(domains, (id) => half.filter((_, i) => 'dom' + (i % 6) === id))
  if (!(grouped.ruled === t.ruled && grouped.tot === t.tot && grouped.mean === t.mean)) {
    die(`viewer tally: grouping changed the board — flat ${t.ruled}/${t.tot} @${t.mean}% became ${grouped.ruled}/${grouped.tot} @${grouped.mean}%`)
  }
  // …and the mirror mistake: descending into children NOBODY ruled on invents grey where a human
  // wrote an answer. This repo's own board is exactly that shape — a verdict per container, none on
  // the files inside — and descending unconditionally took it from `4/4 100%` to `0/19`, no
  // percentage at all. A box speaks for itself when the finer answer does not exist.
  const box = { id: 'lib', status2: 'done', completion: 100 }
  const files = [...Array(13)].map((_, i) => ({ id: 'f' + i, status2: 'unknown' }))
  const kept = tallyOf([box], (id) => (id === 'lib' ? files : []))
  if (!(kept.ruled === 1 && kept.tot === 1 && kept.mean === 100)) {
    die(`viewer tally: a curated verdict was discarded for ${files.length} children nobody ruled on — got ${kept.ruled}/${kept.tot} @${kept.mean}%`)
  }
  // but one ruled child IS a finer answer, and then the children are what the box stands for
  const oneRuled = files.slice(0, 12).concat([{ id: 'f12', status2: 'done', completion: 100 }])
  const dropped = tallyOf([box], (id) => (id === 'lib' ? oneRuled : []))
  if (!(dropped.ruled === 1 && dropped.tot === 13)) die(`viewer tally: a ruled child did not outrank the box's own verdict — got ${dropped.ruled}/${dropped.tot}`)
  // and the third mistake, the worst of the three: when NOBODY has ruled — not the box, not one
  // child — the box may not stand in for its subtree. Nine unknowns collapsing to one unknown
  // shrinks the denominator, and 25/53 would print as 25/45: coverage reading better than it is.
  const silent = tallyOf([{ id: 'dom', status2: 'unknown' }], (id) => (id === 'dom' ? files.slice(0, 9) : []))
  if (silent.tot !== 9) die(`viewer tally: ${silent.tot} unit(s) for 9 packages nobody ruled on — the denominator shrank, so the coverage reads better than it is`)

  // every UI string must exist in BOTH locales (repo rule: en is default, it must keep up)
  const lit = (html.match(/\nvar STRINGS=\{[\s\S]*?\n\};/) || [])[0]
  if (!lit) die('viewer: STRINGS literal not found')
  const S = new Function(lit.replace(/;$/, '') + '; return STRINGS')()
  const missing = Object.keys(S.en).filter((k) => !(k in S.it))
  if (missing.length) die('viewer i18n: keys missing from `it`: ' + missing.join(', '))
  if (!/labels:/.test(lit)) die('viewer i18n: the LABELS toggle string is not in STRINGS')
  console.log(`  ok viewer — edge label anchored on the curve; i18n parity (${Object.keys(S.en).length} keys, en/it)`)
}

// 11) schema contract: `lib/schema/c4-model.schema.json` is the declared contract, so both writers
// of the model must be held to it. Driven through the CLI on purpose — the assertion is that the
// COMMANDS reject a non-conforming model, not that some helper returns an array.
{
  const REPO = FIX('mini'), topo = join(tmp, 'schema-topo.json'), model = join(tmp, 'schema-model.json')
  const badTopo = join(tmp, 'schema-topo-bad.json'), badModel = join(tmp, 'schema-model-bad.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('schema init exit ' + r.status, r)
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('schema gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('schema check exit ' + r.status, r)
  const conforming = readJson(model)
  // a required field removed by hand: check must fail AND name the field, or the report is useless
  const missingKind = readJson(model)
  delete missingKind.nodes[0].kind
  writeFileSync(model, JSON.stringify(missingKind, null, 2) + '\n')
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo])
  const missOut = (r.stdout || '') + (r.stderr || '')
  if (r.status === 0 || !(/kind/.test(missOut) && /SCHEMA/.test(missOut))) die('schema: check accepted a node with no "kind" (or never named the field)', r)
  // topo.nodes are copied verbatim into the model, so a curated kind outside the enum is the one
  // way a plain `gen` can emit a non-conforming model — it must refuse instead of writing it.
  const topoBad = readJson(topo)
  topoBad.nodes[0].kind = 'widget'
  writeFileSync(badTopo, JSON.stringify(topoBad, null, 2) + '\n')
  r = run(['gen', '--repo', REPO, '--topology', badTopo, '--out', badModel])
  const badGenOut = (r.stdout || '') + (r.stderr || '')
  if (r.status === 0 || !/kind/.test(badGenOut)) die('schema: gen wrote a model whose node kind is outside the schema enum', r)
  // the dogfood: forma's own committed model is the one every reader of the Pages demo sees
  const committed = validateModel(readJson(join(HERE, '..', 'docs/architecture/c4-model.json')))
  if (committed.length) die('schema: this repo\'s committed c4-model.json does not validate:\n - ' + committed.join('\n - '))
  const oldMinor = validateModel({ ...conforming, schemaVersion: '1.0.0' })
  const nextMajor = validateModel({ ...conforming, schemaVersion: '2.0.0' })
  if (oldMinor.length || !nextMajor.some((e) => /schemaVersion/.test(e))) die('schema freeze: compatible 1.x must load and unsupported major 2 must fail')
  r = run(['--version'])
  if (r.status !== 0 || r.stdout.trim() !== '1.0.0') die('release: CLI version is not frozen at 1.0.0', r)
  console.log('  ok schema — 1.x contract frozen; incompatible major rejected; package 1.0.0')
}

// 12) Optional architecture timeline: AS-IS stays generated from code; checkpoints are compact,
// typed patches applied cumulatively. Board prose may label a checkpoint but can never become an
// architecture mutation by implication.
{
  const repo = join(tmp, 'timeline-repo')
  cpSync(FIX('mini'), repo, { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'roadmap.md'), '# Governed future architecture\n')
  const topo = join(tmp, 'timeline-topo.json'), model = join(tmp, 'timeline-model.json')
  let r = run(['init', '--repo', repo, '--out', topo, '--force']); if (r.status !== 0) die('timeline init exit ' + r.status, r)
  const t = readJson(topo)
  const system = t.nodes.find((n) => n.kind === 'system')
  if (!system) die('timeline precondition: init produced no system')
  t.timeline = {
    source: 'docs/roadmap.md',
    checkpoints: [
      { id: 'g0', label: 'G0 · readiness', badge: '35 board · 2 P0' },
      {
        id: 'g1', label: 'G1 · new surface', badge: '9 board · 1 P0',
        patch: {
          nodes: {
            add: [
              { node: { id: 'future_api', level: 'container', parent: system.id, kind: 'container', name: 'Future API', status: 'planned', status2: 'planned', func: 'A governed future surface.' }, change: 'Add the future API.' },
              { node: { id: 'future_legacy', level: 'leaf', parent: 'future_api', kind: 'leaf', name: 'Temporary adapter', status: 'planned', status2: 'planned', func: 'A transition-only adapter.' }, change: 'Add the transition adapter.' },
            ],
            update: [{ id: 'core', set: { current: 'Core also serves the future API.' }, change: 'Extend the core responsibility.' }],
          },
          edges: {
            add: [{ edge: { from: 'core', to: 'future_api', label: 'serves', kind: 'runtime', status: 'planned', estatus: 'to-build' }, change: 'Connect core to the future API.' }],
          },
        },
      },
      {
        id: 'g2', label: 'G2 · direct utility',
        patch: {
          nodes: {
            update: [{ id: 'future_api', set: { status2: 'next', current: 'Future API reads utility directly.' }, change: 'Promote the surface to the next checkpoint.' }],
            remove: [{ id: 'future_legacy', change: 'Remove the transition adapter.' }],
          },
          edges: {
            rewire: [{ match: { from: 'core', to: 'future_api', label: 'serves' }, set: { from: 'util', label: 'serves directly' }, change: 'Route the surface through utility.' }],
          },
        },
      },
    ],
  }
  writeFileSync(topo, JSON.stringify(t, null, 2) + '\n')
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('timeline gen exit ' + r.status, r)
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('timeline check exit ' + r.status, r)
  const base = readJson(model)
  if (base.schemaVersion !== '1.6.0') die('timeline: schema version is ' + base.schemaVersion)
  if (base.nodes.some((n) => n.id === 'future_api')) die('timeline: future node leaked into the AS-IS baseline')
  const built = materializeTimeline(base, { sourceExists: (rel) => existsSync(join(repo, rel)) })
  if (built.errors.length) die('timeline materializer rejected valid fixture:\n - ' + built.errors.join('\n - '))
  if (built.states.length !== 3) die('timeline: expected 3 checkpoints, got ' + built.states.length)
  const g0 = built.states[0], g1 = built.states[1], g2 = built.states[2]
  if (JSON.stringify(g0.model.nodes) !== JSON.stringify(base.nodes) || JSON.stringify(g0.model.edges) !== JSON.stringify(base.edges)) {
    die('timeline honesty: a display-only board badge generated architecture operations')
  }
  if (g0.badge !== '35 board · 2 P0') die('timeline honesty: checkpoint badge was interpreted or rewritten: ' + g0.badge)
  if (!g1.model.nodes.some((n) => n.id === 'future_api') || !g1.model.nodes.some((n) => n.id === 'future_legacy')) die('timeline G1: additions missing')
  if (!g1.model.nodes.find((n) => n.id === 'core').current.includes('future API')) die('timeline G1: baseline update missing')
  if (!g2.model.nodes.some((n) => n.id === 'future_api') || g2.model.nodes.some((n) => n.id === 'future_legacy')) die('timeline G2: cumulative add/remove wrong')
  if (!g2.model.nodes.find((n) => n.id === 'core').current.includes('future API')) die('timeline G2: G1 update did not survive cumulatively')
  if (!g2.model.edges.some((e) => e.from === 'util' && e.to === 'future_api' && e.label === 'serves directly')) die('timeline G2: rewire missing')
  if (g2.model.edges.some((e) => e.from === 'core' && e.to === 'future_api' && e.label === 'serves')) die('timeline G2: pre-rewire edge survived')
  if (g2.delta.nodes.length !== 1 || g2.delta.nodes[0].id !== 'future_api' || g2.delta.edges.length !== 1 || g2.delta.edges[0].type !== 'REWIRE') {
    die('timeline G2: local delta includes changes from earlier checkpoints: ' + JSON.stringify(g2.delta))
  }
  if (g2.delta.removedNodes.length !== 1 || g2.delta.removedNodes[0].id !== 'future_legacy') die('timeline G2: removal not reported in local summary')

  // The ES5 viewer owns a deliberately small mirror of the validated materializer. Drive the same
  // fixture through it so the browser cannot silently diverge from gen/check.
  const html = readFileSync(join(HERE, '..', 'lib', 'viewer', 'c4-hologram.html'), 'utf-8')
  const tlBlock = (html.match(/function jsonCopy\([\s\S]*?(?=\nvar BASE=)/) || [])[0]
  if (!tlBlock) die('timeline viewer: pure materializer block not found')
  const viewer = new Function(tlBlock + '\nreturn {timelineStates:timelineStates,timelineSummary:timelineSummary}')()
  const viewerStates = viewer.timelineStates(base)
  const vg2 = viewerStates.states[2]
  if (!vg2 || JSON.stringify(vg2.model.nodes) !== JSON.stringify(g2.model.nodes) || JSON.stringify(vg2.model.edges) !== JSON.stringify(g2.model.edges)) {
    die('timeline viewer: cumulative graph differs from the engine materializer')
  }
  const emptySummary = viewer.timelineSummary('g0', g0.delta)
  const asIsSummary = viewer.timelineSummary('as-is', { counts: {} })
  const changedSummary = viewer.timelineSummary('g2', g2.delta)
  if (!emptySummary.empty || emptySummary.parts.length || asIsSummary.empty ||
      changedSummary.empty || changedSummary.parts.map((x) => x.key).join(',') !== 'deltaUpdate,deltaRewire,deltaRemove') {
    die('timeline viewer: AS-IS, empty checkpoint and typed local summary are not distinguished: ' +
      JSON.stringify({ asIsSummary, emptySummary, changedSummary }))
  }
  if (!/id="legacytime"/.test(html) || !/id="timeline"/.test(html) || !/BASE&&BASE\.timeline/.test(html)) {
    die('timeline viewer: legacy/timeline mutual-exclusion wiring missing')
  }
  if (/BASE&&BASE\.timeline&&BASE\.timeline\.source\)\|\|/.test(html) ||
      !/nodeProjected\(n\.id\)&&BASE&&BASE\.timeline/.test(html) ||
      !/function nodeProjected\(id\)/.test(html) ||
      !/preserveLegacyMode&&\(!BASE\|\|!BASE\.timeline\)&&mode==="target"/.test(html)) {
    die('timeline viewer: checkpoint provenance leaked onto unchanged nodes or legacy RE-VERIFY lost TARGET mode')
  }
  if (/checkpoint-changes|class="cpchange"/.test(html) ||
      !/summary\.empty\?'<b>'\+esc\(STR\.noArchChanges\)/.test(html) ||
      !/if\(err\)st2\.appendChild\(err\)/.test(html) ||
      !/BASE=candidate;M=jsonCopy\(candidate\)/.test(html)) {
    die('timeline viewer: persistent change register survived, empty checkpoint is silent, or RE-VERIFY lost its live error overlay/atomic model swap')
  }
  const detailStateBlock = (html.match(/\nfunction detailState\([\s\S]*?\n\}/) || [])[0]
  if (!detailStateBlock) die('timeline viewer: detailState not found')
  const detailState = new Function(detailStateBlock + '\nreturn detailState')()
  if (detailState({ func: 'What it does', description: 'What it does' }, true) !== '' ||
      detailState({ func: 'What it does', current: 'Projected state' }, true) !== 'Projected state' ||
      detailState({ func: 'What it does' }, false) !== 'What it does') {
    die('timeline viewer: unchanged function prose is duplicated as checkpoint state, or legacy detail lost its fallback')
  }

  const structurallyBad = JSON.parse(JSON.stringify(base))
  structurallyBad.timeline.checkpoints[1].patch.nodes.add[0].node = {}
  structurallyBad.timeline.checkpoints[1].patch.nodes.update[0].set = { parent: 'nonsense' }
  structurallyBad.timeline.checkpoints[1].patch.edges.add[0].edge = {}
  structurallyBad.timeline.checkpoints[2].patch.edges.rewire[0].set = { label: 'not a rewire' }
  const structuralErrors = validateModel(structurallyBad)
  if (!structuralErrors.some((e) => /missing required property "id"/.test(e)) ||
      !structuralErrors.some((e) => /unexpected property "parent"/.test(e)) ||
      !structuralErrors.some((e) => /missing required property "from"/.test(e)) ||
      !structuralErrors.some((e) => /does not satisfy any allowed schema shape/.test(e))) {
    die('timeline schema: typed node/edge add and update/rewire set shapes are not structurally governed:\n - ' + structuralErrors.join('\n - '))
  }

  // Bad projections are rejected BEFORE the output is touched.
  const invalid = [
    ['duplicate checkpoint', (x) => { x.timeline.checkpoints[2].id = 'g1' }],
    ['missing source', (x) => { x.timeline.source = 'docs/no-such-roadmap.md' }],
    ['unknown update', (x) => { x.timeline.checkpoints[1].patch.nodes.update[0].id = 'ghost' }],
    ['orphan add', (x) => { x.timeline.checkpoints[1].patch.nodes.add[0].node.parent = 'ghost' }],
    ['forbidden target', (x) => { x.timeline.checkpoints[1].patch.nodes.add[0].node.target = 'a second target' }],
    ['live child on remove', (x) => { x.timeline.checkpoints[2].patch.nodes.remove = [{ id: 'future_api', change: 'unsafe parent removal' }] }],
    ['ambiguous rewire', (x) => {
      x.timeline.checkpoints[1].patch.edges.add.push({ edge: { from: 'core', to: 'future_api', label: 'second route', kind: 'runtime' }, change: 'Second route.' })
      delete x.timeline.checkpoints[2].patch.edges.rewire[0].match.label
    }],
  ]
  for (let i = 0; i < invalid.length; i++) {
    const badTopo = join(tmp, `timeline-bad-${i}.json`), badModel = join(tmp, `timeline-bad-${i}-model.json`)
    const bad = JSON.parse(JSON.stringify(t)); invalid[i][1](bad)
    writeFileSync(badTopo, JSON.stringify(bad, null, 2) + '\n')
    writeFileSync(badModel, 'KEEP\n')
    r = run(['gen', '--repo', repo, '--topology', badTopo, '--out', badModel])
    if (r.status === 0) die('timeline invalid accepted: ' + invalid[i][0])
    if (readFileSync(badModel, 'utf-8') !== 'KEEP\n') die('timeline invalid overwrote output before rejection: ' + invalid[i][0])
  }

  const tampered = readJson(model)
  tampered.timeline.checkpoints[0].badge = 'invented after generation'
  writeFileSync(model, JSON.stringify(tampered, null, 2) + '\n')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (r.status === 0 || !/TIMELINE DRIFT/.test((r.stdout || '') + (r.stderr || ''))) die('timeline: check accepted a model-only timeline edit', r)
  console.log('  ok timeline — legacy baseline + 3 cumulative checkpoints; local delta; board badge inert; invalid patches fail before write')
}

// 16) docmap: the documentary source of the chain (§17-1) and the only deterministic producer of
// programme state (§17-2). The fixture is shaped so that every rule has to hold at once — a
// container the matrix describes, one it merely touches, one it never names, and a leaf whose own
// code outranks it.
{
  const REPO = FIX('docmap'), topo = join(tmp, 'dm-topo.json'), model = join(tmp, 'dm-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('dm init exit ' + r.status, r)
  const t = readJson(topo)
  // auto-detection: the inventory is adopted, the refactor PLAN (Feature|File, no status column)
  // is not — auto-adopting one would put "C1 move the helper" in a stakeholder's box.
  if (!(t.docSources || []).includes('docs/FEATURES.md')) die('docmap: init did not detect docs/FEATURES.md, got ' + JSON.stringify(t.docSources))
  if ((t.docSources || []).some((d) => /plan\.md/.test(d))) die('docmap: init adopted a change plan as a capability table — ' + JSON.stringify(t.docSources))

  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model]); if (r.status !== 0) die('dm gen exit ' + r.status, r)
  r = run(['check', '--repo', REPO, '--model', model, '--topology', topo]); if (r.status !== 0) die('dm check exit ' + r.status, r)
  const at = (id) => readJson(model).nodes.find((n) => n.id === id) || die('docmap: no node ' + id)
  const m = readJson(model)

  // DoD 1/2 — a CONTAINER's box quotes the capability table, verbatim, ahead of any code.
  const billing = at('billing')
  if (billing.descSource !== 'docmap') die('docmap: container billing descSource=' + billing.descSource + ' (want docmap)')
  if (!/Bill a customer/.test(billing.func) || !/Chase an invoice/.test(billing.func)) die('docmap: billing box does not quote its two rows: ' + billing.func)
  // DoD 3 — progress the DOCUMENT states: 1 of billing's 2 capabilities is DONE.
  if (billing.status2 !== 'in-progress' || billing.completion !== 50) die(`docmap: billing state ${billing.status2}/${billing.completion} (want in-progress/50)`)
  if (!/FEATURES\.md/.test((billing.verify || {}).source || '')) die('docmap: no provenance on a derived state: ' + JSON.stringify(billing.verify))
  const reporting = at('reporting')
  if (reporting.status2 !== 'done' || reporting.completion !== 100) die(`docmap: reporting ${reporting.status2}/${reporting.completion} (want done/100)`)

  // The cap — `core` is referenced by all four rows, so the matrix does not DESCRIBE it. Stitching
  // four capabilities into one sentence would invent a claim; falling through is the honest answer.
  const core = at('core')
  if (core.descSource === 'docmap') die('docmap: a node touched by 4 rows was described anyway: ' + core.func)
  // #43: the cap used to withhold the VERDICT too, so the more rows named a module the less it was
  // judged — `internal_budget` on the real demo, named by four DONE rows, rendered as unassessed.
  // The two halves part company: the verdict is still something the document says; a percentage
  // over a reach nobody can state is not.
  //
  // This IS the #43 guard, and it lives here rather than against a live checkout of the demo's
  // source repository. statusFor never branches on MAX_ROWS to compute status2 — the cap reaches
  // only `completion` — so an over-cap node whose rows are all DONE runs this same path; asserting
  // it twice bought nothing, and asserting it against an uncommitted working copy meant the fixture
  // could change under the test, which is exactly what happened.
  if (core.status2 !== 'in-progress') die(`docmap: over-cap node lost its verdict: ${core.status2}`)
  if (core.completion != null) die(`docmap: over-cap node got a percentage over an unstatable reach: ${core.completion}`)

  // DoD 4 — a container the matrix never names stays honestly blank. This is the 0.6.0 guarantee.
  const plumbing = at('plumbing')
  if (plumbing.descSource !== 'fallback' || plumbing.status2 !== 'unknown') die(`docmap: undocumented container reads ${plumbing.descSource}/${plumbing.status2} — the honest default broke`)

  // The chain is document-first ABOVE the leaf and code-first AT it: invoice.js has a docstring and
  // must keep it; dunning.js has none and reaches the matrix row instead of "Component of module".
  if (at('billing__invoice_js').descSource !== 'docstring') die('docmap: a leaf with a docstring lost it to the matrix')
  if (at('billing__dunning_js').descSource !== 'docmap') die('docmap: an undocumented leaf did not reach the matrix row')

  // Precedence — the hand-curated overlay is still the authority over anything derived.
  const status = join(tmp, 'dm-status.json'), model2 = join(tmp, 'dm-model2.json')
  writeFileSync(status, JSON.stringify({ nodes: { billing: { status2: 'problem', completion: 10 } } }, null, 2))
  r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model2, '--status', status]); if (r.status !== 0) die('dm gen --status exit ' + r.status, r)
  const over = readJson(model2).nodes.find((n) => n.id === 'billing')
  if (over.status2 !== 'problem' || over.completion !== 10) die(`docmap: the curated overlay lost to the derived state (${over.status2}/${over.completion})`)
  r = run(['check', '--repo', REPO, '--model', model2, '--topology', topo])
  if (r.status !== 0) die('docmap: check flagged an overlay-owned field as doc drift', r)

  // The gate — a derived percentage nobody re-derives is a false green. Tamper with the committed
  // model and `check` must recompute the truth from the document, exactly as it does for src/.
  const stale = join(tmp, 'dm-stale.json')
  const tampered = readJson(model)
  Object.assign(tampered.nodes.find((n) => n.id === 'reporting'), { status2: 'done', completion: 100 })
  Object.assign(tampered.nodes.find((n) => n.id === 'billing'), { status2: 'done', completion: 100 })
  writeFileSync(stale, JSON.stringify(tampered, null, 2) + '\n')
  r = run(['check', '--repo', REPO, '--model', stale, '--topology', topo])
  if (r.status === 0) die('docmap: check passed a model claiming 100% where the document says 50%')
  if (!/DOC DRIFT: billing/.test((r.stdout || '') + (r.stderr || ''))) die('docmap: drift reported without naming the node', r)

  const described = m.nodes.filter((n) => n.descSource === 'docmap').length
  console.log(`  ok docmap — §17 ${described} node(s) described from docs/FEATURES.md; billing 50% derived, core over-cap, plumbing honest; overlay wins; drift gated`)
}

// 16b) a declaration is not a measurement. Two ways a document produced a percentage it never
// measured — both live on the public demo, which reads 100% on every box that carries a number.
{
  // (a) a status column that never says "not done" is an INVENTORY. `done/rows.length` is then
  // pinned to 1 by arithmetic: haben's feature matrix is 39 rows, 39 DONE, and every one of the
  // 27 nodes it reaches came out at exactly 100. A constant is not a measure.
  const repo = join(tmp, 'decl-repo')
  cpSync(FIX('docmap'), repo, { recursive: true })
  const doc = join(repo, 'docs', 'FEATURES.md')
  writeFileSync(doc, readFileSync(doc, 'utf-8').replace('| BACKLOG |', '| DONE |'))
  const topo = join(tmp, 'decl-topo.json'), model = join(tmp, 'decl-model.json')
  let r = run(['init', '--repo', repo, '--out', topo, '--force']); if (r.status !== 0) die('decl init exit ' + r.status, r)
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('decl gen exit ' + r.status, r)
  const billing = readJson(model).nodes.find((n) => n.id === 'billing')
  if (billing.completion != null) die(`decl: a document whose status column never says "not done" measured nothing, yet billing reads ${billing.completion}%`)
  // what the document DID say survives — the declaration, its citation and its reach. Dropping
  // those with the number would trade a false percentage for a missing provenance.
  if (billing.status2 !== 'done') die('decl: the declaration itself was thrown out with the number, got ' + billing.status2)
  if (!/FEATURES\.md/.test((billing.verify || {}).source || '')) die('decl: the citation went with the number: ' + JSON.stringify(billing.verify))
  if (!(billing.verify || {}).coverage) die('decl: the coverage went with the number: ' + JSON.stringify(billing.verify))
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo])
  if (r.status !== 0) die('decl: check re-derives from the same document and must agree with gen', r)

  // (b) rows that name NO unit of the node still ruled on it. On the demo the two domains with no
  // evidence of their own — `fisco`, `accesso` — read done/100 with coverage {named:0}: a verdict
  // borrowed from children, on a box whose own reach the document never touches.
  const rows = [{ text: 'x', refs: ['src/a/one.js'], dead: [], done: true, from: 'FEATURES.md' }]
  const idx = indexByNode(rows, [{ id: 'dom', kind: 'container' },
    { id: 'a', parent: 'dom', kind: 'container', evidence: [{ type: 'path', ref: 'src/a' }] }])
  const dom = statusFor(idx, 'dom')
  if (dom) die('decl: a box the document names no unit of got a verdict anyway — ' + JSON.stringify(dom))
  const own = statusFor(idx, 'a')
  if (!own || own.status2 !== 'done') die('decl: the guard also silenced the node the row actually names — ' + JSON.stringify(own))
  console.log('  ok declaration — an all-DONE inventory yields a verdict with no percentage, citation intact; a zero-reach box yields nothing')
}

// 13b) the three ways a document-derived number goes green without anyone lying on purpose.
// Every one of these passed the gate before: the derivation fell SILENT and silence read as
// "no drift", so a committed green box kept shipping with a citation nothing backed any more.
{
  const repo = join(tmp, 'dd-repo')
  cpSync(FIX('docmap'), repo, { recursive: true })
  const topo = join(tmp, 'dd-topo.json'), model = join(tmp, 'dd-model.json'), bad = join(tmp, 'dd-bad.json')
  const doc = join(repo, 'docs', 'FEATURES.md')
  let r = run(['init', '--repo', repo, '--out', topo, '--force']); if (r.status !== 0) die('dd init exit ' + r.status, r)
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', model]); if (r.status !== 0) die('dd gen exit ' + r.status, r)
  const pristine = readFileSync(doc, 'utf-8')
  const gate = () => run(['check', '--repo', repo, '--model', model, '--topology', topo])
  const out = (x) => (x.stdout || '') + (x.stderr || '')
  if (gate().status !== 0) die('dd precondition: the untouched fixture must pass')

  // the whole-product box: every row touches the system node, so its denominator is "the rows
  // somebody wrote", never "the repo" — and a container the document never names sits below it
  const sys = readJson(model).nodes.find((n) => n.kind === 'system')
  if (!readJson(model).nodes.some((n) => n.kind === 'container' && n.status2 === 'unknown')) die('dd precondition: the fixture must hold a container the document never names')
  if (sys.completion != null || sys.status2 !== 'unknown') die(`dd/system: the whole product reads ${sys.status2}/${sys.completion} "${(sys.verify || {}).source}" — a handful of rows became a verdict on a repo they do not cover`)

  // (a) a renamed code_ref: the row stops touching its node, so the unfinished capability leaves
  // the denominator and billing goes from in-progress/50 to a freshly derived done/100
  writeFileSync(doc, pristine.replace('`src/billing/dunning.js`', '`src/billing/dunning_v2.js`'))
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', bad])
  if (r.status === 0) die(`dd/(a): gen accepted a row whose code_ref does not exist — billing silently reads ${(readJson(bad).nodes.find((n) => n.id === 'billing') || {}).completion}% instead of 50%`)
  // …and a glob stem is a legitimate ref that must NOT be flagged
  writeFileSync(doc, pristine.replace('`src/billing/dunning.js`', '`src/billing/dunn*.js`'))
  r = run(['gen', '--repo', repo, '--topology', topo, '--out', join(tmp, 'dd-glob.json')])
  if (r.status !== 0) die('dd/(a): a glob code_ref (`src/billing/dunn*.js`) was rejected as dead', r)

  // (b) the cited document is gone: the model keeps quoting it and citing "(N/N done)"
  writeFileSync(doc, pristine)
  const gone = doc + '.gone'
  renameSync(doc, gone)
  r = gate()
  if (r.status === 0) die('dd/(b): check passed with the cited document deleted, model still quoting it')
  if (!/FEATURES\.md/.test(out(r))) die('dd/(b): the failure did not name the missing document', r)
  renameSync(gone, doc)

  // (c) the row's sentence was rewritten: the box still quotes the old one, vouched by descSource
  writeFileSync(doc, pristine.replace('Hand the accountant the month as a spreadsheet', 'WITHDRAWN — export was cut, see ADR-9'))
  if (gate().status === 0) die('dd/(c): check passed a docmap box quoting a sentence the document no longer contains')
  writeFileSync(doc, pristine)
  if (gate().status !== 0) die('dd: the gate did not go green again once the document was restored')
  console.log('  ok doc-drift — a dead code_ref fails gen; a deleted document, a rewritten row and a silent derivation all fail check; the system box stays unknown')
}

// 18) the publication gate must be able to fail on the defect it shipped. Four predicates graded
// the GEOMETRY of the scene — box counts, actors, prose, arrows — and not one of them read
// `completion`. A board reading 100% on every box that carries a number passed at full marks, and
// that is the model that went to Pages. A gate blind to the claim grades the frame, not the picture.
{
  const gate = (m) => { const p = join(tmp, 'pres-' + Math.random().toString(36).slice(2) + '.json'); writeFileSync(p, JSON.stringify(m)); return spawnSync(process.execPath, [join(HERE, '..', 'scripts', 'presentable.mjs'), p], { encoding: 'utf-8' }) }
  const demo = readJson(join(HERE, '..', 'docs/demo/c4-model.json'))
  const clean = JSON.parse(JSON.stringify(demo))
  for (const n of clean.nodes) delete n.completion
  let r = gate(clean)
  if (r.status !== 0) die('presentable: the demo without invented percentages must still pass every other predicate\n' + r.stdout + r.stderr)
  const lying = JSON.parse(JSON.stringify(clean))
  const victim = lying.nodes.find((n) => (n.verify || {}).derived === true) || die('presentable: the demo carries no document-derived node to drive the gate with')
  victim.completion = 100
  r = gate(lying)
  if (r.status === 0) die('presentable: a box showing a percentage its own citation calls a declaration passed the gate\n' + r.stdout)
  if (!new RegExp(victim.id).test(r.stdout || '')) die('presentable: the failure did not name the offending box\n' + r.stdout)
  console.log('  ok presentable — a percentage no source measured fails the publication gate, by node id')
}

// --- #43: the three defects the adversarial review found, none of them declared -------------
// The gate keys off a provenance LABEL, and a label is writable and erasable. The badge glues a
// mean over one child to a coverage over twenty-five. And the suite grades a copy of the shipped
// artifact instead of the artifact.
{
  const gate = (m) => { const p = join(tmp, 'pres3-' + Math.random().toString(36).slice(2) + '.json'); writeFileSync(p, JSON.stringify(m)); return spawnSync(process.execPath, [join(HERE, '..', 'scripts', 'presentable.mjs'), p], { encoding: 'utf-8' }) }
  const demo = readJson(join(HERE, '..', 'docs/demo/c4-model.json'))

  // (1) A percentage with NO citation at all is the easiest lie to tell, and it was the one the
  // gate waved through: the filter required verify.derived === true. `forma verify` writes
  // completion = 100 and never touches node.verify (lib/verify.mjs), so a first-class command
  // puts the complaint back on the page through a supported path.
  const noCitation = JSON.parse(JSON.stringify(demo))
  for (const n of noCitation.nodes) { delete n.completion; delete n.verify }
  noCitation.nodes[0].completion = 100
  let r = gate(noCitation)
  if (r.status === 0) die('presentable: a percentage with no citation at all passed — the gate grades the label, not the number\n' + r.stdout)

  // (2) The same number with the label flipped to a value nobody writes must not buy a pass.
  const flipped = JSON.parse(JSON.stringify(demo))
  for (const n of flipped.nodes) delete n.completion
  flipped.nodes[0].completion = 100
  flipped.nodes[0].verify = { source: 'inventata', derived: false }
  r = gate(flipped)
  if (r.status === 0) die('presentable: derived:false is a label anyone can write — it must not certify a number as measured\n' + r.stdout)

  console.log('  ok presentable — a percentage is a declaration unless its citation proves otherwise')
}

// The badge must never glue a mean over N children to a coverage over M. Before the fix rollStatus
// counted verdicts in `ruled` and averaged over `completion` only, so one measured child among
// twenty-five ruled ones printed "100% 25/53" — the owner's complaint, verbatim, from one node.
{
  const html = readFileSync(join(HERE, '..', 'lib', 'viewer', 'c4-hologram.html'), 'utf-8')
  const lift = (name) => {
    const m = html.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm'))
    if (!m) die('viewer: ' + name + ' not liftable — it must be measurable')
    return m[0]
  }
  const STR = { stUnk: '?' }
  const STMAP = { done: 'done', 'in-progress': 'wip', planned: 'plan', next: 'next', problem: 'prob' }
  const fn = new Function('STR', 'STMAP', lift('rollStatus') + '\n' + lift('badgeOf') + '\n' + lift('tallyOf') + '\nreturn {rollStatus:rollStatus,badgeOf:badgeOf,tallyOf:tallyOf}')(STR, STMAP)

  // One child carries a number; twenty-four are ruled without one.
  const kids = []
  kids.push({ id: 'k0', status2: 'done', completion: 100 })
  for (let i = 1; i < 25; i++) kids.push({ id: 'k' + i, status2: 'done' })
  for (let i = 25; i < 53; i++) kids.push({ id: 'k' + i, status2: 'unknown' })
  const parent = { id: 'p' }
  const kidsOf = (id) => (id === 'p' ? kids : [])

  const roll = fn.rollStatus(parent, kidsOf)
  if (roll && roll.mean != null && roll.ruled !== 1) {
    die('viewer: the badge averages over ' + 1 + ' child but claims coverage of ' + roll.ruled +
        ' — mean and coverage must share a denominator, got ' + JSON.stringify(roll))
  }
  const badge = fn.badgeOf(parent, roll)
  if (/^100% 25\//.test(badge)) die('viewer: the badge reads "' + badge + '" from a single measured child — the complaint, verbatim')

  const tally = fn.tallyOf(kids, kidsOf)
  if (tally && tally.mean != null && tally.ruled !== 1) {
    die('viewer: tallyOf mixes denominators too — ' + JSON.stringify(tally))
  }
  console.log('  ok viewer — a mean and a coverage never share a badge unless they share a denominator')
}

// The suite must grade the artifact that ships, not a copy of it with the offending field removed.
{
  const r = spawnSync(process.execPath, [join(HERE, '..', 'scripts', 'presentable.mjs'), join(HERE, '..', 'docs/demo/c4-model.json')], { encoding: 'utf-8' })
  if (r.status !== 0) die('presentable: the SHIPPED demo model does not pass its own publication gate\n' + r.stdout + r.stderr)
  console.log('  ok presentable — the shipped artifact itself passes, not a cleaned copy of it')
}

// The #43 guard ("a box many rows name is judged by all of them, not silenced by the prose cap")
// used to be asserted a second time here, against a live checkout of the demo's private source
// repository. It was removed rather than repaired, for two reasons that are the same reason:
//   - it read `docs/FEATURE_MATRIX.md` from a path outside this repository, so two people running
//     `npm test` did not get the same verdict — and it silently SKIPPED when that path was absent,
//     which is every CI run. Green by absence on CI, red on one machine, is the false green this
//     project exists to kill;
//   - the rows it pinned have since been re-declared not-done upstream, so its expectation was
//     simply wrong: `planned` was the correct answer and the assertion was the stale party.
// The property itself is asserted on the committed `docmap` fixture, on the `core` node — see the
// #43 comment there for why one assertion covers both shapes.

// The Control Room, end to end: compose it, gate it, and prove the gate can fail. Until this block
// existed nothing in the suite touched room.mjs, roomderive.mjs, link.mjs or taxonomy.mjs — and
// both gates over them were broken in ways a single run would have caught. The fixture carries no
// .git (a nested repository cannot be committed), so the history the link layer reads is built here
// with pinned author dates: the month buckets are asserted below and must not drift with the clock.
{
  const R = join(tmp, 'room'), alpha = join(R, 'alpha'), beta = join(R, 'beta')
  cpSync(FIX('room'), R, { recursive: true })
  const git = (repo, args, date) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env })
    if (r.status !== 0) die('room fixture: git ' + args.join(' ') + '\n' + (r.stdout || '') + (r.stderr || ''))
  }
  const born = (repo) => {
    git(repo, ['init', '-q', '.'], '2026-01-01T00:00:00')
    git(repo, ['config', 'user.email', 'test@example.invalid'], '2026-01-01T00:00:00')
    git(repo, ['config', 'user.name', 'Forma Test'], '2026-01-01T00:00:00')
  }
  const commit = (repo, message, date) => { git(repo, ['add', '-A'], date); git(repo, ['commit', '-q', '-m', message], date) }
  const touch = (file) => writeFileSync(file, readFileSync(file, 'utf-8') + '\n// touched\n')

  const claimsDoc = join(alpha, 'docs/GATE-CLAIMS.md')
  const claimTarget = join(alpha, 'claim-target.txt')
  writeFileSync(claimsDoc, '# Measured claims\n\nPath claim: src/core/engine.js:1\nDisposable path: claim-target.txt:1\nTracked sources: 3\nJSON mode: strict\nJSON missing: absent\nJSON object: object\n\n# INV-COMMENT\n\n**Enforced by:** `scripts/check.mjs`\n\n# INV-DUP first\n\n# INV-DUP second\n')
  writeFileSync(claimTarget, 'tracked evidence\n')
  writeFileSync(join(alpha, 'docs/gate-registry.js'), '/*\nnode scripts/check.mjs\n*/\nconst x=1; // fake-proof\nconst proof = "fake-proof"\n')
  writeFileSync(join(alpha, 'docs/gate-registry.yml'), '# node scripts/check.mjs\nstep: noop # fake-proof\n')
  writeFileSync(join(alpha, 'gate-target.json'), JSON.stringify({ mode: 'strict', nested: { value: 'strict' } }))
  born(alpha)
  commit(alpha, 'chore: scaffold', '2026-06-15T10:00:00')
  touch(join(alpha, 'src/core/engine.js'))
  commit(alpha, 'feat(core): the engine (#1)', '2026-07-10T10:00:00')
  touch(join(alpha, 'src/core/parser.js'))
  commit(alpha, 'fix(core): parser (#99)', '2026-07-20T10:00:00')
  for (const f of ['src/core/engine.js', 'src/core/parser.js', 'src/util/log.js']) touch(join(alpha, f))
  commit(alpha, 'chore: sweep three files (#2)', '2026-08-01T10:00:00')
  born(beta)
  commit(beta, 'feat: beta (#5)', '2026-07-05T10:00:00')

  const topo = join(alpha, 'topology.json'), model = join(alpha, 'model.json'), manifest = join(R, 'manifest.json')
  const roomHtml = join(R, 'control-room.html'), roomHtml2 = join(R, 'second.html')
  const claimsManifest = readJson(manifest)
  claimsManifest.programs[0].docs.gate.claims = [
    { id: 'path-ok', path: 'docs/GATE-CLAIMS.md', pattern: '^Path claim: (\\S+)$', type: 'path' },
    { id: 'path-delete', path: 'docs/GATE-CLAIMS.md', pattern: '^Disposable path: (\\S+)$', type: 'path' },
    { id: 'count-ok', path: 'docs/GATE-CLAIMS.md', pattern: '^Tracked sources: (\\d+)$', type: 'tracked-count', include: ['src/**/*.js'] },
    { id: 'json-ok', path: 'docs/GATE-CLAIMS.md', pattern: '^JSON mode: (\\S+)$', type: 'json', target: 'gate-target.json', pointer: '/mode' },
  ]
  const roomSchema = new URL('../lib/schema/forma.room.schema.json', import.meta.url)
  if (validateModel(claimsManifest, roomSchema).length) die('document claims schema: the complete typed claim fixture is invalid')
  for (const [id, field] of [['count-ok', 'include'], ['json-ok', 'target'], ['json-ok', 'pointer']]) {
    const malformed = JSON.parse(JSON.stringify(claimsManifest))
    delete malformed.programs[0].docs.gate.claims.find((claim) => claim.id === id)[field]
    if (!validateModel(malformed, roomSchema).length) die('document claims schema: ' + id + ' without ' + field + ' was accepted')
  }
  writeFileSync(manifest, JSON.stringify(claimsManifest, null, 2))
  let r = run(['init', '--repo', alpha, '--out', topo, '--force']); if (r.status !== 0) die('room: init exit ' + r.status, r)
  // A governed future, so the checkpoint stepper has something to be measured against. Curated
  // after init because that is how a real timeline arrives: init seeds structure, a human writes
  // where it is going.
  const seeded = readJson(topo)
  seeded.timeline = {
    source: 'docs/DESIGN.md',
    checkpoints: [
      { id: 'normalize', label: 'Input normalized in one place', patch: { nodes: { update: [{ id: 'core', set: { status2: 'in-progress' }, change: 'core takes over normalization' }] } } },
      { id: 'one-logger', label: 'Every message through one helper', patch: { nodes: { update: [{ id: 'util', set: { status2: 'done' }, change: 'util owns all output' }] } } },
    ],
  }
  writeFileSync(topo, JSON.stringify(seeded, null, 2))
  r = run(['gen', '--repo', alpha, '--topology', topo, '--out', model]); if (r.status !== 0) die('room: gen exit ' + r.status, r)
  r = run(['room', '--manifest', manifest, '--out', roomHtml]); if (r.status !== 0) die('room: exit ' + r.status, r)

  // Determinism (I12): the only clock is manifest.today, so two renders of unchanged inputs are
  // byte-identical. This is also the property scripts/room-presentable.mjs re-checks independently.
  r = run(['room', '--manifest', manifest, '--out', roomHtml2]); if (r.status !== 0) die('room: second render exit ' + r.status, r)
  if (readFileSync(roomHtml, 'utf-8') !== readFileSync(roomHtml2, 'utf-8')) die('room: two renders of the same manifest are not byte-identical')

  const roomOf = (file) => {
    const m = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(readFileSync(file, 'utf-8'))
    if (!m) die('room: __ROOM__ seam not found in ' + file)
    return JSON.parse(m[1])
  }
  const ROOM = roomOf(roomHtml)
  const progOf = (id) => { const p = (ROOM.programs || []).find((x) => x.id === id); if (!p) die('room: programme ' + id + ' is missing from the artifact'); return p }
  const A = progOf('alpha'), B = progOf('beta')

  // Work blocks are a projection of the open queue: commands name exactly their issue set, while
  // a declared human blocker disables automation. Closed #3 must never leak into either shape.
  const blockIssues = A.derived.blocks.flatMap((block) => block.iss.map((issue) => issue[0])).sort((a, b) => a - b)
  if (blockIssues.join() !== '1,2') die('room: work blocks must contain open issues only, got ' + blockIssues)
  const autoBlock = A.derived.blocks.find((block) => block.iss.some((issue) => issue[0] === 1))
  const manualBlock = A.derived.blocks.find((block) => block.iss.some((issue) => issue[0] === 2))
  if (!autoBlock || autoBlock.cmd !== 'gh issue view 1' || autoBlock.auto !== true) die('room: auto block command drifted from its exact issue set: ' + JSON.stringify(autoBlock))
  if (!manualBlock || manualBlock.auto !== false || manualBlock.cmd !== null || manualBlock.note.labelled.join() !== '2' || manualBlock.note.external.join() !== '2' || !manualBlock.why.some((why) => why.from.repo === 'acme/alpha' && why.to.repo === 'acme/platform' && why.to.number === 90)) die('room: structured declared-label/external blocker facts did not disable automation: ' + JSON.stringify(manualBlock))

  // Human-waiting labels are programme vocabulary, never engine vocabulary. Declaring only
  // owner-decision must count/bucket that label and leave a coincidental needs-human unaudited;
  // omitting blockedBy makes the KPI unknown rather than reviving an implicit default.
  const labelSnapshot = {
    fetchedAt: '2026-08-10T00:00:00Z', milestones: [],
    issues: [
      { n: 1, state: 'OPEN', labels: ['owner-decision'], ms: null },
      { n: 2, state: 'OPEN', labels: ['needs-human'], ms: null },
    ],
  }
  const ownerManifest = { today: '2026-08-10', blockedBy: { labels: ['owner-decision'] } }
  const ownerKanban = deriveKanban(labelSnapshot, [], ownerManifest.blockedBy.labels)
  if (deriveKpis(labelSnapshot, null, ownerManifest).needsHumanCount !== 1 || ownerKanban['aspettano-umano'].join() !== '1' || ownerKanban['non-auditate'].join() !== '2') die('room labels: owner-decision declaration leaked implicit needs-human semantics')
  const undeclaredKanban = deriveKanban(labelSnapshot, [], [])
  if (deriveKpis(labelSnapshot, null, { today: '2026-08-10' }).needsHumanCount !== null || undeclaredKanban['aspettano-umano'].length || undeclaredKanban['non-auditate'].join() !== '1,2') die('room labels: absent blockedBy was treated as an implicit needs-human rule')

  // Endpoint identity is repo + number. An unrelated repository's #1 must not attach itself to
  // alpha #1 merely because both counters happen to match — neither the capability nor its work
  // block may inherit that foreign dependency.
  const alphaSnapshot = readJson(join(alpha, 'issues.json')), alphaConfig = readJson(manifest).programs[0]

  // Gate extraction is an evidence path, not part of the briefing byte budget. Even when no
  // document can be embedded, the tracked source, its body line and its git date remain available
  // to the pure document gate.
  const cappedGateDocs = loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 1 })
  const fullGateDocs = loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 200000 })
  if (cappedGateDocs.embedded.length || !cappedGateDocs.gateInputs) die('document gate: maxBytes suppressed the gate input or embedded an over-budget document')
  if (JSON.stringify(cappedGateDocs.gateInputs) !== JSON.stringify(fullGateDocs.gateInputs)) die('document gate: gateInputs changed with the presentation byte cap')
  const designGateInput = cappedGateDocs.gateInputs.documents.find((document) => document.path === 'docs/DESIGN.md')
  if (!designGateInput || designGateInput.bodyStartLine !== 1 || designGateInput.invariants.length !== 1 || designGateInput.invariants[0].id !== 'How' || designGateInput.invariants[0].line !== 1) die('document gate: DESIGN heading/body source lines were not preserved: ' + JSON.stringify(designGateInput))
  if (!/^2026-06-15T10:00:00(?:Z|[+-]\d\d:\d\d)$/.test(designGateInput.lastChangedAt || '')) die('document gate: tracked DESIGN has no deterministic git change date: ' + JSON.stringify(designGateInput && designGateInput.lastChangedAt))
  const designAlone = loadDocs(alpha, { gate: { invariants: [{ path: 'docs/DESIGN.md', idPattern: '^(How)\\b' }] } }).gateInputs.documents.find((document) => document.path === 'docs/DESIGN.md')
  const designWithSibling = loadDocs(alpha, { gate: { invariants: [{ path: 'docs/DESIGN.md', idPattern: '^(How)\\b' }, { path: 'docs/GATE-CLAIMS.md', idPattern: '^(INV-COMMENT)$' }] } }).gateInputs.documents.find((document) => document.path === 'docs/DESIGN.md')
  if (!designAlone || !designWithSibling || designAlone.lastChangedAt !== designWithSibling.lastChangedAt) die('document gate: a file lastChangedAt changed when an unrelated sibling joined the path set')

  // One invariant, one finding. An invariant-specific registry match is measured; a declared
  // match that did not resolve is contradicted; and no mapping is explicitly unknown.
  const pureGateInputs = {
    trackedPaths: ['docs/GATE.md', 'scripts/check.mjs'], errors: [], claims: [], freshness: [],
    documents: [{
      path: 'docs/GATE.md', tracked: true, bodyStartLine: 1, metadata: [], lastChangedAt: '2026-08-01T00:00:00Z', reason: null,
      invariants: [
        { id: 'WIRED', heading: 'Wired check', line: 1, claims: [{ kind: 'command', line: 2, text: 'scripts/check.mjs', tokens: ['scripts/check.mjs'] }] },
        { id: 'LOOSE', heading: 'Loose check', line: 3, claims: [{ kind: 'command', line: 4, text: 'scripts/missing.mjs', tokens: ['scripts/missing.mjs'] }] },
      ],
    }],
    registries: [{ path: 'package.json', tracked: true, lastChangedAt: '2026-08-01T00:00:00Z', reason: null, lines: [{ line: 1, text: 'node scripts/check.mjs' }] }],
    wiring: [
      { invariant: 'WIRED', registry: 'package.json', line: 1, resolved: true, reason: null },
      { invariant: 'LOOSE', registry: 'package.json', line: null, resolved: false, reason: 'not-found' },
    ],
  }
  const pureGate = documentGate(pureGateInputs, '2026-08-10')
  const wired = pureGate.rows.find((row) => row.invariant === 'WIRED'), unregistered = pureGate.rows.find((row) => row.invariant === 'LOOSE')
  if (!wired || wired.severity !== 'ok' || wired.reason !== 'wired') die('document gate: declared registry evidence did not produce wired/ok: ' + JSON.stringify(wired))
  if (!unregistered || unregistered.severity !== 'bad' || unregistered.reason !== 'wiring-missing') die('document gate: missing registry evidence did not produce wiring-missing/bad: ' + JSON.stringify(unregistered))
  if (pureGate.rows.length !== 2 || pureGate.findings.length !== pureGate.rows.length || pureGate.rows.some((row, i) => pureGate.findings[i].id !== row.id)) die('document gate: invariant rows and c4 findings are not one-to-one')
  const findingErrors = validateModel({ findings: pureGate.findings }, new URL('../lib/schema/c4-findings.schema.json', import.meta.url))
  if (findingErrors.length) die('document gate: emitted findings violate c4-findings.schema.json: ' + findingErrors.join('; '))
  const findingKeys = new Set(['id', 'severity', 'text', 'evidence', 'trace'])
  if (pureGate.findings.some((finding) => Object.keys(finding).some((key) => !findingKeys.has(key)))) die('document gate: a finding leaked fields outside the c4-findings contract: ' + JSON.stringify(pureGate.findings))
  const noRegistry = documentGate({ ...pureGateInputs, registries: [], wiring: [] }, '2026-08-10')
  if (noRegistry.rows.some((row) => row.severity !== 'warn' || row.reason !== 'registry-not-mapped')) die('document gate: no invariant-to-registry mapping did not remain an explicit warning: ' + JSON.stringify(noRegistry.rows))
  const inputErrorGate = documentGate({ ...pureGateInputs, errors: [{ path: 'docs/GATE.md', field: 'pattern', reason: 'invalid' }] }, '2026-08-10')
  if (inputErrorGate.errors.length !== 1 || inputErrorGate.summary.bad !== pureGate.summary.bad + 1) die('document gate: input errors were dropped or omitted from the bad summary: ' + JSON.stringify(inputErrorGate))

  const commentGateInputs = loadDocs(alpha, { maxBytes: 1, gate: {
    invariants: [{ path: 'docs/GATE-CLAIMS.md', idPattern: '^(INV-COMMENT)$' }],
    registry: ['docs/gate-registry.js', 'docs/gate-registry.yml'],
    wiring: [
      { invariant: 'INV-COMMENT', registry: 'docs/gate-registry.js', pattern: 'scripts/check\\.mjs' },
      { invariant: 'INV-COMMENT', registry: 'docs/gate-registry.yml', pattern: 'scripts/check\\.mjs' },
    ],
  } }).gateInputs
  const commentGate = documentGate(commentGateInputs, '2026-08-10')
  if (commentGateInputs.wiring.length !== 2 || commentGateInputs.wiring.some((entry) => entry.resolved || entry.reason !== 'not-found') || commentGate.rows[0].reason !== 'wiring-missing' || commentGate.rows[0].severity !== 'bad') die('document gate: a line/hash/block comment was accepted as wiring: ' + JSON.stringify({ wiring: commentGateInputs.wiring, row: commentGate.rows[0] }))
  const inlineGateInputs = loadDocs(alpha, { maxBytes: 1, gate: {
    invariants: [{ path: 'docs/GATE-CLAIMS.md', idPattern: '^(INV-COMMENT)$' }],
    registry: ['docs/gate-registry.js', 'docs/gate-registry.yml'],
    wiring: [
      { invariant: 'INV-COMMENT', registry: 'docs/gate-registry.js', pattern: 'fake-proof' },
      { invariant: 'INV-COMMENT', registry: 'docs/gate-registry.yml', pattern: 'fake-proof' },
    ],
  } }).gateInputs
  const jsInline = inlineGateInputs.wiring.find((entry) => entry.registry === 'docs/gate-registry.js'), yamlInline = inlineGateInputs.wiring.find((entry) => entry.registry === 'docs/gate-registry.yml')
  if (!jsInline || !jsInline.resolved || jsInline.line !== 5 || !yamlInline || yamlInline.resolved || yamlInline.reason !== 'not-found') die('document gate: inline comments supplied proof or the same text inside a JS quote was truncated: ' + JSON.stringify(inlineGateInputs.wiring))
  const htmlCommentInputs = loadDocs(join(HERE, '..'), { maxBytes: 1, gate: {
    invariants: [{ path: 'docs/GLOBAL_INVARIANTS.md', idPattern: '^(I1)\\.' }],
    registry: ['lib/viewer/control-room.html'],
    wiring: [{ invariant: 'I1', registry: 'lib/viewer/control-room.html', pattern: 'measured tokens belong' }],
  } }).gateInputs
  if (!htmlCommentInputs.wiring[0] || htmlCommentInputs.wiring[0].resolved || htmlCommentInputs.wiring[0].reason !== 'not-found') die('document gate: a real /* */ comment in control-room.html supplied wiring proof: ' + JSON.stringify(htmlCommentInputs.wiring[0]))

  const noMatchInputs = loadDocs(alpha, { maxBytes: 1, gate: { invariants: [{ path: 'docs/GATE-CLAIMS.md', idPattern: '^NEVER-MATCHES$' }] } }).gateInputs
  if (!noMatchInputs.errors.some((error) => error.field === 'idPattern' && error.reason === 'no-invariant-match') || documentGate(noMatchInputs, '2026-08-10').summary.bad < 1) die('document gate: an idPattern matching zero headings did not become a gated input error')
  const danglingInputs = loadDocs(alpha, { maxBytes: 1, gate: {
    invariants: [{ path: 'docs/GATE-CLAIMS.md', idPattern: '^(INV-COMMENT)$' }],
    registry: ['docs/gate-registry.js'],
    wiring: [{ invariant: 'INV-MISSING', registry: 'docs/gate-registry.js', pattern: 'node' }],
  } }).gateInputs
  if (!danglingInputs.errors.some((error) => error.field === 'wiring.invariant' && /unknown-INV-MISSING/.test(error.reason)) || danglingInputs.wiring[0].reason !== 'invariant-not-found' || documentGate(danglingInputs, '2026-08-10').summary.bad < 1) die('document gate: dangling invariant wiring did not become a gated input error: ' + JSON.stringify(danglingInputs))
  const duplicateInputs = loadDocs(alpha, { maxBytes: 1, gate: { invariants: [{ path: 'docs/GATE-CLAIMS.md', idPattern: '^(INV-DUP)' }] } }).gateInputs
  if (!duplicateInputs.errors.some((error) => error.field === 'invariant.id' && error.reason === 'duplicate-INV-DUP') || documentGate(duplicateInputs, '2026-08-10').summary.bad < 1) die('document gate: duplicate invariant ids did not become a gated input error: ' + JSON.stringify(duplicateInputs.errors))

  const freshnessGate = documentGate({
    trackedPaths: ['docs/stale.md', 'docs/invalid.md', 'docs/future.md', 'docs/status.md'], registries: [], wiring: [], claims: [], errors: [],
    documents: [
      { path: 'docs/stale.md', tracked: true, reason: null, invariants: [], lastChangedAt: null, metadata: [{ key: 'last_review', value: '2026-01-01', line: 2, source: 'frontmatter' }] },
      { path: 'docs/invalid.md', tracked: true, reason: null, invariants: [], lastChangedAt: null, metadata: [{ key: 'last_review', value: 'not-a-date', line: 2, source: 'frontmatter' }] },
      { path: 'docs/future.md', tracked: true, reason: null, invariants: [], lastChangedAt: null, metadata: [{ key: 'last_review', value: '2026-09-01', line: 2, source: 'frontmatter' }] },
      { path: 'docs/status.md', tracked: true, reason: null, invariants: [], lastChangedAt: null, metadata: [{ key: 'status', value: 'Accepted (2026-01-02)', line: 3, source: 'frontmatter' }] },
    ],
    freshness: [
      { id: 'stale', staleAfterDays: 30, paths: ['docs/stale.md'] },
      { id: 'invalid', staleAfterDays: 30, paths: ['docs/invalid.md'] },
      { id: 'future', staleAfterDays: 30, paths: ['docs/future.md'] },
      { id: 'status', staleAfterDays: 30, paths: ['docs/status.md'] },
    ],
  }, '2026-08-10')
  const freshnessReasons = Object.fromEntries(freshnessGate.freshness.map((entry) => [entry.id, entry.reason]))
  const statusFreshness = freshnessGate.freshness.find((entry) => entry.id === 'status')
  if (freshnessReasons.stale !== 'stale' || freshnessReasons.invalid !== 'date-invalid' || freshnessReasons.future !== 'date-future' || !statusFreshness || statusFreshness.at !== '2026-01-02' || statusFreshness.reason !== 'stale' || freshnessGate.freshness.some((entry) => entry.verdict !== 'warn') || freshnessGate.summary.stale !== 4) die('document gate: stale/invalid/future/status dates are not advisory warnings: ' + JSON.stringify(freshnessGate.freshness))

  if (!A.derived.documentGate || A.derived.documentGate.rows.length !== 1 || A.derived.documentGate.findings.length !== 1 || A.derived.documentGate.rows[0].reason !== 'no-enforcement-claim') die('room: the document gate was not embedded from the programme docs: ' + JSON.stringify(A.derived.documentGate))
  const typedClaims = Object.fromEntries(A.derived.documentGate.claims.map((claim) => [claim.id, claim]))
  if (!typedClaims['path-ok'] || typedClaims['path-ok'].type !== 'path' || typedClaims['path-ok'].measured !== 'src/core/engine.js' || typedClaims['path-ok'].verdict !== 'ok') die('document claims: tracked path was not measured: ' + JSON.stringify(typedClaims['path-ok']))
  if (!typedClaims['path-delete'] || typedClaims['path-delete'].measured !== 'claim-target.txt' || typedClaims['path-delete'].verdict !== 'ok') die('document claims: disposable tracked path was not measured before deletion: ' + JSON.stringify(typedClaims['path-delete']))
  if (!typedClaims['count-ok'] || typedClaims['count-ok'].type !== 'tracked-count' || typedClaims['count-ok'].measured !== 3 || typedClaims['count-ok'].verdict !== 'ok') die('document claims: tracked file count was not measured: ' + JSON.stringify(typedClaims['count-ok']))
  if (!typedClaims['json-ok'] || typedClaims['json-ok'].type !== 'json' || typedClaims['json-ok'].measured !== 'strict' || typedClaims['json-ok'].verdict !== 'ok') die('document claims: JSON pointer was not measured: ' + JSON.stringify(typedClaims['json-ok']))
  if (A.docs.gateInputs !== undefined) die('room: raw gateInputs leaked into the reader-facing document corpus')
  const numberCollision = { edges: [{ active: true, source: 'native', from: { repo: 'acme/foreign', number: 1 }, to: { repo: 'acme/upstream', number: 90 } }] }
  const collisionBlocks = deriveBlocks(alphaSnapshot, deriveQueue(alphaSnapshot, alphaConfig.taxonomy), numberCollision, alphaConfig)
  const collisionBlock = collisionBlocks.find((block) => block.iss.some((issue) => issue[0] === 1))
  const collisionCapabilities = deriveCapabilities(alpha, alphaConfig.capabilities, alphaSnapshot, numberCollision)
  const collisionCapability = collisionCapabilities.rows.find((row) => row.id === 'F-1')
  if (!collisionBlock || !collisionBlock.auto || collisionBlock.why.length || !collisionCapability || collisionCapability.blockers.length) die('room dependencies: a foreign repo edge with local number #1 blocked alpha #1')

  // Capability state stays the document's vocabulary plus its explicit mapping; issue, RTM and
  // release evidence are joined to the same row rather than persisted in another overlay.
  const capabilities = A.derived.capabilities && A.derived.capabilities.rows
  const f1 = capabilities && capabilities.find((row) => row.id === 'F-1')
  const f2 = capabilities && capabilities.find((row) => row.id === 'F-2')
  if (!f1 || f1.originalStatus !== 'In delivery' || f1.status !== 'in-progress' || f1.openIssues.join() !== '1' || f1.release !== 'v1') die('room: F-1 capability lost its mapped status, issue or release: ' + JSON.stringify(f1))
  if (!f2 || f2.originalStatus !== 'Released' || f2.status !== 'done' || f2.openIssues.length || f2.release !== 'v1') die('room: F-2 capability lost its closed issue or release: ' + JSON.stringify(f2))
  if (f1.verification.length !== 1 || f1.verification[0].verdict !== 'PASS' || f1.verification[0].requirement !== 'R-1') die('room: capability did not join its RTM verdict: ' + JSON.stringify(f1.verification))
  if (f1.useCases.join() !== 'UC-1' || f1.verification[0].useCaseIds.join() !== 'UC-1') die('room: feature did not inherit RTM evidence through its declared use case: ' + JSON.stringify(f1))

  // A commit touching more files than linkMaxFiles is a sweep: excluded from attribution, but
  // counted and named rather than silently dropped (I9). The manifest declares 2; the sweep is 3.
  if (A.derived.link.excludedSweeps.length !== 1) die('room: expected 1 excluded sweep at linkMaxFiles=2, got ' + JSON.stringify(A.derived.link.excludedSweeps))

  // One assertion covering two regressions at once. #1 landed in 2026-07 and is a real issue; #99
  // landed in 2026-07 too but is a PULL REQUEST number, absent from the snapshot; #2's only commit
  // is the August sweep. So: exactly one month, exactly one landing.
  //  - if the snapshot intersection were dropped, #99 would make 2026-07 read `landed: 2`;
  //  - if linkMaxFiles stopped reaching the portfolio path, the sweep would add a 2026-08 bucket.
  const landing = (ROOM.portfolio.landing || []).find((l) => l.program === 'alpha')
  if (!landing || landing.months.length !== 1 || landing.months[0].month !== '2026-07' || landing.months[0].landed !== 1) {
    die('room: alpha landing should be exactly [{2026-07, landed 1}], got ' + JSON.stringify(landing && landing.months))
  }

  // A programme with no map still derives everything its issues can answer. It used to derive
  // nothing at all, so the gate had nothing per-programme to re-derive for it.
  if (B.derived === null) die('room: beta derived nothing — a programme without a map must still derive from its issues')
  if (B.derived.link !== null || B.derived.commitDrift !== null) die('room: beta has no map, so link and commitDrift must be null, got ' + JSON.stringify({ link: B.derived.link, commitDrift: B.derived.commitDrift }))
  if (B.derived.kpis.linkCoveragePct !== null) die('room: beta was never asked the issue-to-code question; coverage must be null, not ' + B.derived.kpis.linkCoveragePct)
  if (!B.derived.kanban || B.derived.kanban.chiuse.join() !== '6') die('room: beta kanban should still bucket its own issues, got ' + JSON.stringify(B.derived.kanban))
  if (ROOM.portfolio.totals.unknownRule !== 1) die('room: beta declares no blocking rule, so unknownRule must be 1 (absent is not empty, I7), got ' + ROOM.portfolio.totals.unknownRule)
  if (ROOM.portfolio.totals.blocked !== null) die('room: one unknown blocking rule makes the portfolio blocked total unknown, got ' + ROOM.portfolio.totals.blocked)
  const betaSummary = ROOM.portfolio.programs.find((p) => p.id === 'beta'), betaMoving = ROOM.portfolio.moving.find((p) => p.program === 'beta')
  if (!betaSummary || betaSummary.blocked !== null) die('room: beta unknown blocking state collapsed to a number: ' + JSON.stringify(betaSummary))
  if (!betaMoving || betaMoving.count !== null || betaMoving.byCluster !== null) die('room: beta moving claim collapsed unknown into an empty queue: ' + JSON.stringify(betaMoving))
  if (A.derived.kpis.snapshotAgeDays !== 1 || betaSummary.snapshotAgeDays !== 1) die('room: snapshot civil age was not derived consistently')
  if (daysBetween('2026-08-17T23:59:59Z', '2026-08-17') !== 0 || daysBetween('not-a-date', '2026-08-17') !== null) die('room: civil date comparison regressed to timestamp rounding')
  const incompleteHistory = deriveHistory({ issues: [
    { n: 1, state: 'OPEN', createdAt: '2026-01-01' },
    { n: 2, state: 'CLOSED', createdAt: '2026-01-15' },
  ] }, '2026-02-01')
  if (!incompleteHistory || incompleteHistory.unplaceable !== 1 || incompleteHistory.points.some((point) => point.open !== 1 || point.closed !== 0 || point.created !== 1)) die('room history: CLOSED without closedAt entered the series instead of being named unplaceable')

  const presentable = (file) => spawnSync(process.execPath, [join(HERE, '..', 'scripts', 'room-presentable.mjs'), '--room', file, '--manifest', manifest], { encoding: 'utf-8' })
  r = presentable(roomHtml)
  if (r.status !== 0) die('room-presentable: the generated briefing does not pass its own publication gate\n' + (r.stdout || '') + (r.stderr || ''))

  const checkRoom = (file, mf) => run(['check', '--repo', alpha, '--model', model, '--topology', topo, '--room', file, '--manifest', mf || manifest])
  r = checkRoom(roomHtml)
  if (r.status !== 0) die('room: check fails on an untouched briefing\n' + (r.stdout || '') + (r.stderr || ''))

  // A typed claim is a live comparison, not decorative metadata. Changing the written count
  // makes the pure result bad and the shared room/check gate must refuse the stale artifact.
  const pristineClaims = readFileSync(claimsDoc, 'utf-8')
  writeFileSync(claimsDoc, pristineClaims.replace('Tracked sources: 3', 'Tracked sources: 99'))
  const mismatchedClaimInputs = loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 1 }).gateInputs
  const mismatchedClaimGate = documentGate(mismatchedClaimInputs, '2026-08-10')
  const mismatchedCount = mismatchedClaimGate.claims.find((claim) => claim.id === 'count-ok')
  if (!mismatchedCount || mismatchedCount.reason !== 'mismatch' || mismatchedCount.verdict !== 'bad' || mismatchedCount.measured !== 3) die('document claims: a false tracked count did not derive mismatch/bad: ' + JSON.stringify(mismatchedCount))
  r = checkRoom(roomHtml)
  if (r.status === 0 || !/DOCUMENT CLAIM alpha: count-ok/.test(r.stderr || '')) die('room: check did not reject and name a mismatched typed document claim', r)
  writeFileSync(claimsDoc, pristineClaims)
  r = checkRoom(roomHtml)
  if (r.status !== 0) die('room: restoring a typed claim did not restore the green gate', r)

  const missingJsonConfig = JSON.parse(JSON.stringify(alphaConfig.docs))
  missingJsonConfig.gate.claims.push(
    { id: 'json-missing', path: 'docs/GATE-CLAIMS.md', pattern: '^JSON missing: (\\S+)$', type: 'json', target: 'gate-target.json', pointer: '/absent' },
    { id: 'json-object', path: 'docs/GATE-CLAIMS.md', pattern: '^JSON object: (\\S+)$', type: 'json', target: 'gate-target.json', pointer: '/nested' },
  )
  const jsonEdgeGate = documentGate(loadDocs(alpha, { ...missingJsonConfig, maxBytes: 1 }).gateInputs, '2026-08-10')
  const jsonMissing = jsonEdgeGate.claims.find((claim) => claim.id === 'json-missing'), jsonObject = jsonEdgeGate.claims.find((claim) => claim.id === 'json-object')
  if (!jsonMissing || jsonMissing.reason !== 'pointer-unresolved' || jsonMissing.verdict !== 'bad' || !jsonObject || jsonObject.reason !== 'target-non-scalar' || jsonObject.verdict !== 'bad') die('document claims: missing/non-scalar JSON pointers were not bad: ' + JSON.stringify({ jsonMissing, jsonObject }))
  const captureConfig = JSON.parse(JSON.stringify(alphaConfig.docs))
  captureConfig.gate.claims = [{ id: 'capture-missing', path: 'docs/GATE-CLAIMS.md', pattern: '^Path claim: (\\S+)$', capture: 99, type: 'path' }]
  const captureGate = documentGate(loadDocs(alpha, { ...captureConfig, maxBytes: 1 }).gateInputs, '2026-08-10')
  const captureMissing = captureGate.claims.find((claim) => claim.id === 'capture-missing')
  if (!captureMissing || captureMissing.reason !== 'capture-unresolved' || captureMissing.verdict !== 'bad') die('document claims: an explicit capture outside the regex groups did not become capture-unresolved/bad: ' + JSON.stringify(captureMissing))

  const claimTargetText = readFileSync(claimTarget, 'utf-8')
  rmSync(claimTarget)
  const deletedPathGate = documentGate(loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 1 }).gateInputs, '2026-08-10')
  const deletedPath = deletedPathGate.claims.find((claim) => claim.id === 'path-delete')
  if (!deletedPath || deletedPath.reason !== 'target-unresolved' || deletedPath.verdict !== 'bad') die('document claims: a tracked but deleted target path remained good: ' + JSON.stringify(deletedPath))
  writeFileSync(claimTarget, claimTargetText)

  const deletedCountTarget = join(alpha, 'src/util/log.js'), deletedCountText = readFileSync(deletedCountTarget, 'utf-8')
  rmSync(deletedCountTarget)
  const deletedCountGate = documentGate(loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 1 }).gateInputs, '2026-08-10')
  const deletedCount = deletedCountGate.claims.find((claim) => claim.id === 'count-ok')
  if (!deletedCount || deletedCount.measured !== 2 || deletedCount.reason !== 'mismatch' || deletedCount.verdict !== 'bad') die('document claims: tracked-count included a tracked file deleted from the worktree: ' + JSON.stringify(deletedCount))
  writeFileSync(deletedCountTarget, deletedCountText)

  const duplicateDesignDoc = join(alpha, 'docs/DESIGN.md'), pristineDesign = readFileSync(duplicateDesignDoc, 'utf-8')
  writeFileSync(duplicateDesignDoc, pristineDesign + '\n# How duplicate\n')
  r = checkRoom(roomHtml)
  if (r.status === 0 || !/invariant\.id duplicate-How/.test(r.stderr || '')) die('room: duplicate invariant ids were not rejected and named by check', r)
  writeFileSync(duplicateDesignDoc, pristineDesign)

  // The gate must FAIL on a hand-altered aggregate, or its green proves nothing. Both directions:
  // the mapped programme and the map-less one, which was ungated entirely before.
  const tamper = (from, to, find, replace) => {
    const src = readFileSync(from, 'utf-8'), out = src.replace(find, replace)
    if (out === src) die('room: tamper pattern did not apply — ' + find)
    writeFileSync(to, out)
  }
  const tamperedA = join(R, 'tampered-alpha.html'), tamperedB = join(R, 'tampered-beta.html'), tamperedBlock = join(R, 'tampered-block.html'), tamperedDocumentGate = join(R, 'tampered-document-gate.html')
  tamper(roomHtml, tamperedA, '"openCount":2', '"openCount":7')
  r = checkRoom(tamperedA)
  if (r.status === 0) die('room: check passed a briefing whose Executive KPIs were altered by hand')
  if (!/alpha — Executive KPIs/.test(r.stderr || '')) die('room: check failed but did not name the programme and the field, got: ' + (r.stderr || ''))
  const betaAt = readFileSync(roomHtml, 'utf-8').indexOf('"id":"beta"')
  tamper(roomHtml, tamperedB, /"noMilestoneCount":1/g, '"noMilestoneCount":0')
  if (betaAt < 0) die('room: beta is not present in the artifact at all')
  r = checkRoom(tamperedB)
  if (r.status === 0) die('room: check passed an altered aggregate on the programme with no map — the map-less path is ungated')
  tamper(roomHtml, tamperedBlock, '"cmd":"gh issue view 1"', '"cmd":"gh issue view 99"')
  r = checkRoom(tamperedBlock)
  if (r.status === 0) die('room: check passed a hand-altered derived work block')
  const alteredDocumentGate = JSON.parse(JSON.stringify(A.derived.documentGate))
  alteredDocumentGate.summary.warn += 1
  tamper(roomHtml, tamperedDocumentGate, JSON.stringify(A.derived.documentGate), JSON.stringify(alteredDocumentGate))
  r = checkRoom(tamperedDocumentGate)
  if (r.status === 0 || !/document gate/.test(r.stderr || '')) die('room: check did not reject and name a hand-altered document gate', r)

  // A manifest and an artifact that disagree about which programmes exist is drift, not a detail.
  const manifestGamma = join(R, 'manifest-gamma.json')
  const mf = readJson(manifest)
  mf.programs.push({ id: 'gamma', ghRepo: 'acme/gamma', repo: 'beta', issues: 'beta/issues.json' })
  writeFileSync(manifestGamma, JSON.stringify(mf, null, 2))
  r = checkRoom(roomHtml, manifestGamma)
  if (r.status === 0) die('room: check passed a manifest declaring a programme the artifact does not render')

  const manifestWorkflow = join(R, 'manifest-workflow.json')
  const mw = readJson(manifest); mw.programs[0].workflows = [{ id: 'ci', path: '.github/workflows/ci.yml' }]
  writeFileSync(manifestWorkflow, JSON.stringify(mw, null, 2))
  const mismatchedRoom = run(['room', '--manifest', manifestWorkflow, '--out', join(R, 'never-workflow.html')])
  const mismatchedCheck = checkRoom(roomHtml, manifestWorkflow)
  if (mismatchedRoom.status === 0 || mismatchedCheck.status === 0 || !/workflow signals/.test((mismatchedRoom.stderr || '') + (mismatchedCheck.stderr || ''))) die('room: an extra manifest workflow was silently absent from its snapshot')

  // A truncated snapshot cannot support counts or proportions: refuse rather than degrade (D8).
  const truncated = join(R, 'truncated.json')
  const snap = readJson(join(alpha, 'issues.json')); snap.truncated = true
  writeFileSync(truncated, JSON.stringify(snap))
  const mfTrunc = join(R, 'manifest-truncated.json')
  const mt = readJson(manifest); mt.programs[0].issues = 'truncated.json'
  writeFileSync(mfTrunc, JSON.stringify(mt, null, 2))
  r = run(['room', '--manifest', mfTrunc, '--out', join(R, 'never.html')])
  if (r.status === 0) die('room: composed a briefing from a snapshot flagged truncated')

  // The traceability chain. alpha declares two documents: docs/PRD.md carries R-* requirements,
  // docs/DESIGN.md carries D-* decisions that satisfy them and land on issues. Together the last
  // two assertions are what makes "the GitHub issues ARE the WBS" falsifiable rather than a wish:
  // nothing planned may be unaccounted for, and nothing open may be unplanned.
  const matrix = A.derived.rtm
  if (!matrix) die('rtm: alpha declares an rtm block and derived no matrix')
  if (matrix.coverage.requirements !== 5 || matrix.coverage.withIssues !== 3) die('rtm: expected 5 requirements, 3 landing on issues, got ' + JSON.stringify(matrix.coverage))
  if (matrix.progress['D-3'].pct !== 100) die('rtm: D-3 cites only the closed issue #3, so it reads 100%, got ' + JSON.stringify(matrix.progress['D-3']))
  if (matrix.progress['R-1'].pct !== null) die('rtm: R-1 cites no issue at all, so it has no percentage rather than a zero (I6), got ' + JSON.stringify(matrix.progress['R-1']))
  for (const hole of ['duplicateIds', 'danglingRefs', 'uncovered', 'orphanIssues']) {
    if (matrix.orphans[hole].length) die(`rtm: the fixture matrix is complete, but ${hole} is not empty: ` + JSON.stringify(matrix.orphans[hole]))
  }
  if (B.derived.rtm !== null) die('rtm: beta declares no rtm block, so it must derive null — opt-in by presence (I11)')

  // Each hole, one at a time, edited into the document rather than into the artifact: this is the
  // chain failing at its source, which is where a reader has to fix it.
  const rtmBreaks = [
    ['a duplicate id', (s) => s.replace('\n\n| id | capability', '\n| D-1 | A second row answering to D-1 | `R-2` | `#2` |\n\n| id | capability'), /id "D-1" is declared twice/],
    ['a reference to a requirement that does not exist', (s) => s.replace('`R-2` | `#2`', '`R-9` | `#2`'), /cites satisfies R-9, which does not exist/],
    ['a decision that lands on no work', (s) => s.replace('| `R-1` | `#3` |', '| `R-1` | |'), /requirement "D-3" lands on no issue and names no verification/],
    ['open work no requirement claims', (s) => s.replace('`R-2` | `#2`', '`R-2` | `#1`'), /open issue #2 .* is cited by no requirement/],
  ]
  // The document is restored BEFORE the assertions, not after the loop: a die() mid-loop would
  // otherwise leave the fixture edited, and the next block's failure would point at the wrong thing.
  const designDoc = join(alpha, 'docs/DESIGN.md'), designSrc = readFileSync(designDoc, 'utf-8')
  for (const [what, edit, expected] of rtmBreaks) {
    const broken = edit(designSrc)
    if (broken === designSrc) die(`rtm: the edit for "${what}" changed nothing — the fixture document drifted`)
    writeFileSync(designDoc, broken)
    const rebuilt = join(R, 'rtm-broken.html')
    const composed = run(['room', '--manifest', manifest, '--out', rebuilt])
    const graded = composed.status === 0 ? checkRoom(rebuilt) : null
    writeFileSync(designDoc, designSrc)
    if (!graded) die(`rtm: room refused to compose with ${what}; the matrix is graded by check, not by the composer`, composed)
    if (graded.status === 0) die(`rtm: check passed a matrix with ${what}`)
    if (!expected.test(graded.stderr || '')) die(`rtm: check failed on ${what} but did not say so — got: ` + (graded.stderr || '').slice(0, 400))
  }

  // A document that contributes nothing is named. Untracked is the case that matters: the matrix
  // must not depend on what happens to be lying in a working tree.
  const extra = join(alpha, 'docs/EXTRA.md')
  writeFileSync(extra, '| id | requirement | issues |\n|---|---|---|\n| R-7 | Never entered git | `#1` |\n')
  const mfExtra = join(R, 'manifest-extra.json')
  const withExtra = readJson(manifest)
  withExtra.programs[0].rtm.docs.push({ path: 'docs/EXTRA.md', idPattern: '^R-\\d+$', role: 'requirement' })
  writeFileSync(mfExtra, JSON.stringify(withExtra, null, 2))
  r = run(['room', '--manifest', mfExtra, '--out', join(R, 'rtm-extra.html')])
  if (r.status !== 0) die('rtm: room refused an untracked rtm document', r)
  r = checkRoom(join(R, 'rtm-extra.html'), mfExtra)
  if (r.status === 0) die('rtm: check passed a matrix built from a document git does not track')
  if (!/docs\/EXTRA\.md contributed no rows \(not tracked by git\)/.test(r.stderr || '')) die('rtm: an untracked document was skipped without being named — got: ' + (r.stderr || '').slice(0, 300))
  rmSync(extra)

  // Where we were. The whole series comes out of ONE snapshot, from createdAt/closedAt, so there is
  // no register to keep and no second fetch — and the clock stays manifest.today.
  const history = A.derived.history
  if (!history) die('room: alpha carries issue dates, so history must derive')
  const firstPoint = history.points[0], lastPoint = history.points[history.points.length - 1]
  if (lastPoint.at !== '2026-08-10') die('room: the history series must end on manifest.today, got ' + lastPoint.at)
  if (lastPoint.open !== 2 || lastPoint.closed !== 1) die('room: today reads 2 open / 1 closed, got ' + JSON.stringify(lastPoint))
  if (firstPoint.at.slice(0, 7) !== '2026-04') die('room: the series must start at the first issue, not a fixed window back, got ' + firstPoint.at)
  const june = history.points.filter(function (p) { return p.at.slice(0, 7) === '2026-06' })[0]
  if (!june || june.open !== 3 || june.closed !== 0) die('room: on 2026-06-30 all three issues were open and none closed, got ' + JSON.stringify(june))
  if (B.derived.history === null) die('room: beta also carries dates, so it too must derive history')
  // A snapshot written before the fields existed must say so rather than draw a flat line.
  const dateless = join(R, 'dateless.json')
  const stripped = readJson(join(alpha, 'issues.json'))
  for (const it of stripped.issues) { delete it.createdAt; delete it.closedAt }
  writeFileSync(dateless, JSON.stringify(stripped))
  const mfDateless = join(R, 'manifest-dateless.json')
  const md = readJson(manifest); md.programs[0].issues = 'dateless.json'
  writeFileSync(mfDateless, JSON.stringify(md, null, 2))
  r = run(['room', '--manifest', mfDateless, '--out', join(R, 'dateless.html')])
  if (r.status !== 0) die('room: a snapshot without issue dates must still compose', r)
  if (roomOf(join(R, 'dateless.html')).programs[0].derived.history !== null) die('room: a snapshot with no dates must derive null history, not an empty or flat series')

  // The checkpoint stepper, given a completion it can be held to. `normalize` patches `core`, and
  // issue #1 landed on core, so it reads 0 of 1 closed. `one-logger` patches `util`, which no
  // surviving link reaches, so it reads null — never 0%, which would look like measured failure.
  const cps = A.derived.checkpoints
  if (!cps || cps.length !== 2) die('room: alpha declares two checkpoints, got ' + JSON.stringify(cps && cps.length))
  const normalize = cps[0]
  if (normalize.nodes.join() !== 'core') die('room: the normalize checkpoint patches core, got ' + JSON.stringify(normalize.nodes))
  if (normalize.total !== 1 || normalize.closed !== 0 || normalize.pct !== 0) die('room: normalize should read 0 of 1 closed, got ' + JSON.stringify(normalize))
  if (cps[1].total !== 0 || cps[1].pct !== null) die('room: a checkpoint no issue reaches reports null, not 0% — got ' + JSON.stringify(cps[1]))

  // Documents: the canon in full, in declared order, within the budget.
  if (!A.docs) die('room: alpha declares docs.include and carried none')
  if (A.docs.embedded.map(function (d) { return d.path }).join() !== 'docs/PRD.md,docs/DESIGN.md') die('room: the canon must be carried in declared order, got ' + JSON.stringify(A.docs.embedded.map(function (d) { return d.path })))
  if (!/R-1/.test(A.docs.embedded[0].text)) die('room: a canon document was carried without its text')
  if (A.docs.bytes > A.docs.maxBytes) die('room: the carried corpus exceeded its own budget')
  if (B.docs !== null) die('room: beta declares no docs, so it carries null rather than an empty corpus')
  // The budget refuses, it never truncates: a document that does not fit is listed with its reason.
  const mfTiny = join(R, 'manifest-tiny.json')
  const tiny = readJson(manifest); tiny.docs = { maxBytes: 1 }
  writeFileSync(mfTiny, JSON.stringify(tiny, null, 2))
  r = run(['room', '--manifest', mfTiny, '--out', join(R, 'tiny.html')])
  if (r.status !== 0) die('room: a byte budget nothing fits inside must still compose', r)
  const tinyDocs = roomOf(join(R, 'tiny.html')).programs[0].docs
  if (tinyDocs.embedded.length) die('room: a document was embedded past the byte budget')
  if (!tinyDocs.listed.some(function (d) { return /budget/.test(d.why) })) die('room: a document dropped for size must be listed with that as its reason, got ' + JSON.stringify(tinyDocs.listed))

  // A programme turned off is excluded and NAMED. Absent and deliberately excluded differ (I7).
  if (ROOM.programs.some(function (p) { return p.id === 'gamma' })) die('room: a programme with enabled:false was composed anyway')
  if (!(ROOM.meta.excluded || []).some(function (p) { return p.id === 'gamma' })) die('room: a programme was excluded without being named in the Options view')

  // The shell: every route is a real element, the pre-tab anchors still resolve, and printing
  // un-hides all of them — an artifact that replaces a deck has to come out of a printer whole.
  const shell = readFileSync(roomHtml, 'utf-8')
  for (const filled of ['window.__ROOM__ = {', 'window.__STRINGS__ = {', 'id="holo-src"']) {
    if (shell.indexOf(filled) < 0) die('room: the generated file is missing ' + filled + ' — a template seam went unfilled')
  }
  if (shell.indexOf('__STRINGS__*/null') >= 0) die('room: the strings seam was left unfilled, so the page would render with no words at all')
  if (!/@media print[\s\S]*\.view\[hidden\]\{display:block!important\}/.test(shell)) die('room: printing does not un-hide the inactive views, so a printed briefing is one page of seven')
  for (const legacy of ['verdict', 'now', 'moving', 'mismatch']) {
    if (shell.indexOf('"' + legacy + '"') < 0) die('room: the pre-tab anchor #' + legacy + ' is no longer a section id, so an existing link breaks')
  }

  console.log('  ok room — the briefing composes deterministically, both gates fire, and both refuse a hand-altered aggregate')
  console.log('  ok rtm — requirements trace to issues, and check names each of the four holes at its source line')
  console.log('  ok views — history from one snapshot, checkpoints with measured completion, a canon within budget, and a programme deliberately left out')
}

// `forma scan` and `forma room --serve`: the two halves of "autodetect, with checkboxes". The
// second exists because static HTML cannot write a file, and the first exists so the answer to
// "which programmes are there" is not typed by hand. Both are graded on the same thing: a decision
// a human made must survive the tool running again.
{
  const root = join(tmp, 'scan-root'), mf = join(root, 'forma.room.json')
  const git = (repo, args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' } })
    if (r.status !== 0) die('scan fixture: git ' + args.join(' ') + '\n' + (r.stdout || '') + (r.stderr || ''))
  }
  for (const name of ['one', 'two']) {
    const dir = join(root, name)
    mkdirSync(join(dir, 'docs/architecture'), { recursive: true })
    writeFileSync(join(dir, 'docs/architecture/c4-issues.json'), '{}')
    git(dir, ['init', '-q', '.'])
    git(dir, ['remote', 'add', 'origin', `git@github.com:acme/${name}.git`])
    git(dir, ['config', 'user.email', 'test@example.invalid'])
    git(dir, ['config', 'user.name', 'Forma Test'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'init'])
  }
  writeFileSync(join(root, 'one/docs/architecture/c4-model.json'), '{}')
  writeFileSync(join(root, 'one/docs/architecture/c4-topology.json'), '{}')
  mkdirSync(join(root, 'one/docs/PRODUCT'), { recursive: true })
  writeFileSync(join(root, 'one/docs/PRODUCT/REQUIREMENTS_MATRIX.md'), readFileSync(FIX('truth-room/REQUIREMENTS_MATRIX.md'), 'utf-8'))
  git(join(root, 'one'), ['add', 'docs/PRODUCT/REQUIREMENTS_MATRIX.md'])
  git(join(root, 'one'), ['commit', '-qm', 'docs: add requirements'])
  // R5-1: R4 made the model optional, so a GitHub checkout with neither generated input must still
  // be onboarded. A local checkout with no resolvable ghRepo cannot produce the required snapshot.
  const mapless = join(root, 'three')
  mkdirSync(mapless, { recursive: true })
  git(mapless, ['init', '-q', '.'])
  git(mapless, ['remote', 'add', 'origin', 'git@github.com:acme/three.git'])
  // A directory that is not a checkout and a checkout with no origin are both skipped.
  mkdirSync(join(root, 'not-a-checkout'), { recursive: true })
  const stranger = join(root, 'stranger')
  mkdirSync(stranger, { recursive: true })
  git(stranger, ['init', '-q', '.'])
  const worktree = join(root, 'one.worktrees', 'topic')
  mkdirSync(worktree, { recursive: true })
  git(worktree, ['init', '-q', '.'])
  git(worktree, ['remote', 'add', 'origin', 'git@github.com:acme/one.git'])

  let r = run(['scan', '--root', root, '--manifest', mf])
  if (r.status !== 0) die('scan: exit ' + r.status, r)
  let found = readJson(mf)
  if (found.programs.map(function (p) { return p.id }).join() !== 'one,three,two') die('scan: expected the map-less GitHub checkout too — got ' + JSON.stringify(found.programs.map(function (p) { return p.id })))
  if (found.programs[0].ghRepo !== 'acme/one') die('scan: ghRepo was not read from the git remote, got ' + found.programs[0].ghRepo)
  if (!found.programs[0].model || found.programs[1].model || found.programs[2].model) die('scan: model/topology must be named only for the checkout that has both')
  if (found.today !== null) die('scan: today is the determinism anchor and must never be invented, got ' + JSON.stringify(found.today))

  // The rule that matters on the second run.
  found.today = '2026-08-10'
  found.programs[0].enabled = false
  found.programs[0].taxonomy = { minPopulation: 1 }
  writeFileSync(mf, JSON.stringify(found, null, 2))
  r = run(['scan', '--root', root, '--manifest', mf])
  if (r.status !== 0) die('scan: second run exit ' + r.status, r)
  const again = readJson(mf)
  if (again.programs[0].enabled !== false) die('scan: re-running silently switched a programme back on — the decision to exclude it was lost')
  if (!again.programs[0].taxonomy) die('scan: re-running discarded a hand-curated field')
  if (again.today !== '2026-08-10') die('scan: re-running overwrote the determinism anchor')

  // R4-2: room init is the supported seed/merge surface over the lower-level scanner. Seed one
  // repo, preserve decisions on a second pass, and never erase a known ghRepo just because origin
  // is temporarily unavailable.
  const initManifest = join(root, 'init-room.json')
  r = run(['room', 'init', '--repo', join(root, 'one'), '--manifest', initManifest, '--today', '2026-08-17'])
  if (r.status !== 0) die('room init: seed exit ' + r.status, r)
  let initialized = readJson(initManifest)
  if (initialized.today !== '2026-08-17' || initialized.programs.length !== 1 || initialized.programs[0].ghRepo !== 'acme/one') die('room init: seed did not derive today/repo: ' + JSON.stringify(initialized))
  if (!initialized.programs[0].docs || initialized.programs[0].docs.include.join() !== 'docs/**/*.md') die('room init: tracked docs corpus was not discovered safely: ' + JSON.stringify(initialized.programs[0].docs))
  if (!initialized.programs[0].rtm || initialized.programs[0].rtm.docs.length !== 1 || initialized.programs[0].rtm.docs[0].path !== 'docs/PRODUCT/REQUIREMENTS_MATRIX.md') die('room init: parser-confirmed requirements matrix was not discovered: ' + JSON.stringify(initialized.programs[0].rtm))
  const observedRtm = deriveRtm({ repo: join(root, 'one'), rtm: initialized.programs[0].rtm, issuesSnapshot: { issues: [{ n: 99, title: 'Observed but not claimed', state: 'OPEN' }] } })
  if (observedRtm.scopeComplete || observedRtm.orphans.orphanIssues.length) die('room init: auto-discovered RTM silently claimed to be the complete WBS: ' + JSON.stringify(observedRtm))
  const strictRtm = deriveRtm({ repo: join(root, 'one'), rtm: { ...initialized.programs[0].rtm, requireIssuesFrom: ['docs/PRODUCT/REQUIREMENTS_MATRIX.md'] }, issuesSnapshot: { issues: [{ n: 99, title: 'Strictly orphaned', state: 'OPEN' }] } })
  if (!strictRtm.scopeComplete || strictRtm.orphans.orphanIssues.length !== 1) die('rtm: explicit WBS completeness stopped gating uncited open issues: ' + JSON.stringify(strictRtm))
  initialized.programs[0].enabled = false
  initialized.programs[0].taxonomy = { minPopulation: 1 }
  writeFileSync(initManifest, JSON.stringify(initialized, null, 2) + '\n')
  git(join(root, 'one'), ['remote', 'remove', 'origin'])
  r = run(['room', 'init', '--repo', join(root, 'one'), '--manifest', initManifest])
  if (r.status !== 0) die('room init: merge exit ' + r.status, r)
  initialized = readJson(initManifest)
  if (initialized.programs[0].enabled !== false || !initialized.programs[0].taxonomy) die('room init: merge clobbered a decision')
  if (initialized.programs[0].ghRepo !== 'acme/one') die('room init: transient missing origin erased the known ghRepo')
  if (!initialized.programs[0].docs || !initialized.programs[0].rtm) die('room init: rediscovery erased safe docs/RTM inputs')

  const scannedManifest = join(root, 'init-scan-room.json')
  r = run(['room', 'init', '--scan', '--root', root, '--manifest', scannedManifest, '--today', '2026-08-17'])
  if (r.status !== 0) die('room init --scan: exit ' + r.status, r)
  const initializedScan = readJson(scannedManifest)
  if (initializedScan.today !== '2026-08-17' || initializedScan.programs.map((p) => p.id).join() !== 'three,two') die('room init --scan: did not stamp today over the valid discovered set: ' + JSON.stringify(initializedScan))
  r = run(['room', 'init', '--repo', join(root, 'one'), '--manifest', join(root, 'bad-today.json'), '--today', '17-08-2026'])
  if (r.status === 0 || existsSync(join(root, 'bad-today.json'))) die('room init: invalid today wrote a manifest')

  // Serve mode binds loopback and nothing else. --port 0 asks the OS for a free one, so the test
  // cannot collide with whatever is already running on this machine.
  const served = spawnSync(process.execPath, [join(HERE, '..', 'lib', 'room.mjs'), '--manifest', join(tmp, 'room', 'manifest.json'), '--out', join(tmp, 'served.html'), '--port', '0', '--serve'], { encoding: 'utf-8', timeout: 3000 })
  const spoke = (served.stdout || '') + (served.stderr || '')
  if (!/serving http:\/\/127\.0\.0\.1:\d+/.test(spoke)) die('room --serve did not bind loopback: ' + spoke)
  if (/0\.0\.0\.0|::/.test(spoke)) die('room --serve bound something wider than loopback: ' + spoke)
  console.log('  ok scan+serve — discovery merges instead of replacing, an excluded programme stays excluded, and serve binds loopback only')
}

// I14 on a surface that did not exist before: the briefing now RENDERS markdown out of a
// repository's own documents, and a link target read from that prose is attacker-adjacent input.
// Assigning it to .href unchecked makes `[read me](javascript:...)` live XSS in a document written
// by somebody else. The renderer is lifted out of the shipped template and driven directly, the
// same trick this suite already uses for the viewer's pure functions.
{
  const src = readFileSync(join(HERE, '..', 'lib/viewer/control-room.html'), 'utf-8')
  const inlineFn = /function inline\(target,text,program\)\{[\s\S]*?\n\}/.exec(src)
  const elFn = /function el\(t,c,x\)\{[^\n]*\n/.exec(src)
  const markFn = /function statusMark\(v\)\{[^\n]*\n/.exec(src)
  const pillFn = /function pill\(p,n,t,endpoint\)\{[\s\S]*?\n\}/.exec(src)
  const mdFn = /function renderMarkdown\(src,program\)\{[\s\S]*?\n\}\n/.exec(src)
  const mdhFn = /function mdHeading\(level\)\{[^\n]*\n/.exec(src)
  if (!inlineFn) die('markdown: inline() not found in control-room.html — the renderer moved')
  if (!elFn) die('markdown: el() not found in control-room.html')
  if (!markFn || !pillFn) die('markdown: shared issue pill primitives not found in control-room.html')
  if (!mdFn) die('markdown: renderMarkdown() not found in control-room.html — the renderer moved')
  if (!mdhFn) die('markdown: mdHeading() not found in control-room.html')
  const stub = `
    var STR = {statusOk: 'OK', statusWarn: 'Warning', statusBad: 'Bad', closed: 'Closed', stateStale: 'Stale', notAudited: 'Not audited'};
    var document = {
      createElement: function (t) { return { nodeType: 1, tagName: t.toUpperCase(), attrs: {}, children: [], className: '', textContent: '', setAttribute: function (k, v) { this.attrs[k] = v }, appendChild: function (c) { this.children.push(c); return c }, get lastChild() { return this.children[this.children.length - 1] } } },
      createTextNode: function (t) { return { nodeType: 3, text: String(t) } },
    };
    ${elFn[0]}
    ${markFn[0]}
    ${pillFn[0]}
    ${inlineFn[0]}
    ${mdhFn[0]}
    ${mdFn[0]}
    return {inline: inline, pill: pill, renderMarkdown: renderMarkdown};`
  // new Function over text lifted from a TRACKED first-party file, which is the same no-jsdom trick
  // this suite already uses to test the viewer's pure functions. The interpolated strings are our
  // own source at a reviewed commit, never input; the thing being tested is precisely that the
  // renderer refuses input.
  const lifted = new Function(stub)()
  const inline = lifted.inline
  const anchorsFor = (md) => {
    const target = { children: [], appendChild(c) { this.children.push(c) } }
    inline(target, md)
    return target.children.filter((c) => c.tagName === 'A')
  }
  // `//host/x` is a network-path reference — same scheme, different HOST. It is not a relative path,
  // and an allow-list that lets it through is letting a document link off-site while looking local.
  for (const hostile of ['[go](javascript:alert(1))', '[go](JaVaScRiPt:alert(1))', '[go](  javascript:alert(1))', '[go](data:text/html,<script>alert(1)</script>)', '[go](vbscript:msgbox)', '[go](//evil.example/phish)', '[go](\\/\\/evil.example)']) {
    const a = anchorsFor(hostile)
    if (a.length) die(`markdown: ${hostile} produced a live anchor with href ${a[0].href} — a document can inject a scheme`)
  }
  for (const safe of ['[go](https://example.com/x)', '[go](./docs/PRD.md)', '[go](/docs/PRD.md)', '[go](#section)', '[go](mailto:a@b.c)']) {
    if (!anchorsFor(safe).length) die(`markdown: ${safe} should be a link and was rendered as text`)
  }
  // The rejected link is shown, not swallowed: a link that will not be followed should say so.
  const rejected = { children: [], appendChild(c) { this.children.push(c) } }
  inline(rejected, '[go](javascript:alert(1))')
  if (!rejected.children.some((c) => c.text && c.text.indexOf('javascript:') > -1)) die('markdown: a refused link was dropped silently instead of being shown as text (I9)')

  // A prose `#n` is an issue reference only when the programme snapshot knows it. Unknown hashes
  // remain literal repository prose; known references use the same health-aware pill as every
  // operational projection, including stale and CLOSED precedence.
  const programme = {
    ghRepo: 'acme/thing',
    issuesSnapshot: { issues: [{ n: 7, state: 'OPEN' }, { n: 8, state: 'CLOSED' }] },
    derived: { health: { verdicts: [{ n: 7, verdict: 'bad', why: 'Anchored failure.', stale: false }, { n: 8, verdict: 'bad', why: 'Superseded by closure.', stale: true }] } },
  }
  const issueDoc = lifted.renderMarkdown('Known #7, closed #8, unknown #99.', programme)
  const issueAnchors = []
  const textOf = (node) => String(node.text || node.textContent || '') + (node.children || []).map(textOf).join('')
  ;(function walk(n) { for (const child of n.children || []) { if (child.tagName === 'A') issueAnchors.push(child); walk(child) } })(issueDoc)
  if (issueAnchors.map((a) => a.href).join() !== 'https://github.com/acme/thing/issues/7,https://github.com/acme/thing/issues/8') die('markdown: known issue references did not become exactly two pills: ' + issueAnchors.map((a) => a.href))
  if (!textOf(issueDoc).includes('#99')) die('markdown: an unknown issue reference was swallowed instead of staying literal')
  const badPill = issueAnchors[0], closedPill = issueAnchors[1]
  if (badPill.attrs['data-tip'] !== 'Anchored failure.' || !/Bad/.test(badPill.attrs['aria-label'])) die('room-pill: a current health verdict lost its anchored reason or word')
  if (!/\bclosed\b/.test(closedPill.className) || closedPill.attrs['data-tip'] !== 'Closed' || !/Closed/.test(closedPill.attrs['aria-label'])) die('room-pill: CLOSED did not override an older stale health verdict')
  programme.derived.health.verdicts[0].stale = true
  const stalePill = lifted.pill(programme, 7)
  if (stalePill.attrs['data-tip'] !== 'Anchored failure.' || !/Stale/.test(stalePill.attrs['aria-label']) || /\bclosed\b/.test(stalePill.className)) die('room-pill: stale evidence did not become a neutral stale pill with its reason')

  // Structure, not the appearance of structure. The renderer emitted `div.md-h` and `div.md-li`,
  // which looked like nine headings and ten list items and exposed NONE of them: the accessibility
  // tree for a 111-line document held zero headings and zero lists, so a screen-reader reader got
  // one undifferentiated run of paragraphs with nothing to navigate by. Ordered lists were worse
  // than invisible — `1.` was not matched at all, so PRD.md §2, this product's own definition of
  // itself, was joined into a single run-on sentence on screen AND on paper.
  const { renderMarkdown } = lifted
  const tags = (node) => { const out = []; (function walk(n) { for (const c of n.children || []) { if (c.tagName) out.push(c.tagName); walk(c) } })(node); return out }
  const find = (node, tag) => { let hit = null; (function walk(n) { for (const c of n.children || []) { if (!hit && c.tagName === tag) hit = c; walk(c) } })(node); return hit }
  const doc = renderMarkdown('# Title\n\n## Section\n\nProse.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n')
  const t = tags(doc)
  // Demoted by two: the reader panel is already an h2, so the document\'s `#` is an h3.
  if (t.indexOf('H3') < 0 || t.indexOf('H4') < 0) die('markdown: `#`/`##` did not become real headings — got ' + t.join(','))
  // The old renderer emitted div.md-h and div.md-li. A DIV anywhere in the output means it is back.
  if (t.indexOf('DIV') > -1) die('markdown: the renderer emitted a <div> — headings and list items are divs again, which look like structure and expose none')
  if (!find(doc, 'UL') || !find(doc, 'OL')) die('markdown: a bullet list and a numbered list must be <ul> and <ol> — got ' + t.join(','))
  if (find(doc, 'UL').children.filter((c) => c.tagName === 'LI').length !== 2) die('markdown: a two-item bullet list did not produce two <li>')
  const ol = find(doc, 'OL')
  if (ol.children.filter((c) => c.tagName === 'LI').length !== 2) die('markdown: `1.`/`2.` did not produce two <li> — numbered lists are being joined into a paragraph')
  if (!find(doc, 'BLOCKQUOTE')) die('markdown: `>` did not become a <blockquote>')
  // A list that starts at 3 renders as 3, 4 — silently renumbering somebody else\'s document is a
  // lie about what it says.
  const off = renderMarkdown('3. third\n4. fourth\n')
  if (find(off, 'OL').attrs.start !== '3') die('markdown: a list starting at 3 was silently renumbered from 1')
  // ...but a paragraph opening with a year is prose, not the two-thousand-and-twenty-sixth item.
  if (find(renderMarkdown('2026. The year the manifest was frozen.\n'), 'OL')) die('markdown: a sentence beginning with a year was turned into a list')
  // Once a list IS running, a four-digit item is an item. Dropping it into the paragraph buffer is
  // a silent structural loss (I9), which is worse than rendering it plainly.
  if (find(renderMarkdown('10. ten\n100. hundred\n1000. thousand\n'), 'OL').children.filter((c) => c.tagName === 'LI').length !== 3) {
    die('markdown: an item numbered past 999 was dropped out of its own list')
  }
  // Nested lists (Audit #13): a deeper indent is a list under the previous item, not a flat row.
  // The renderer ingests arbitrary client documents, so a nested list that flattens is a structural
  // lie about what the document says — and the corpus has none today, which is exactly when it rots.
  const nested = renderMarkdown('- parent\n  - child one\n  - child two\n- sibling\n')
  const ul = find(nested, 'UL')
  if (!ul) die('markdown: a bullet list did not produce a <ul>')
  const lis = ul.children.filter((c) => c.tagName === 'LI')
  if (lis.length !== 2) die(`markdown: nested list flattened — expected 2 top-level <li>, got ${lis.length}`)
  const childUl = lis[0].children.filter((c) => c.tagName === 'UL')
  if (childUl.length !== 1) die('markdown: a deeper indent did not become a nested <ul> under its parent item')
  if (childUl[0].children.filter((c) => c.tagName === 'LI').length !== 2) die('markdown: the nested list lost its items')
  // cross-type nesting: an ordered list under a bullet item
  const mixed = renderMarkdown('- parent\n  1. first\n  2. second\n')
  const muls = find(mixed, 'UL')
  if (!muls || !muls.children.filter((c) => c.tagName === 'LI')[0].children.some((c) => c.tagName === 'OL')) {
    die('markdown: an ordered list under a bullet item was not nested')
  }
  // a lone CR, U+2028 or U+2029 inside a document HUNG THE BROWSER: `.` and `$` exclude all three
  // in JavaScript, so the unanchored list detector matched a line the anchored consumer could not,
  // the index never advanced, and the loop appended empty <ul>s until the heap died. Repository
  // text reaches this renderer unfiltered, so it was a hang triggered by somebody else's bytes.
  // These cases run in-process: a regression hangs the suite, which is the honest failure — a test
  // for a non-terminating loop cannot both prove termination and return.
  for (const [why, input, want] of [
    ['a lone CR inside a bullet', '- item\rmore\n', 'UL'],
    ['a lone CR inside a numbered item', '1. item\rmore\n', 'OL'],
    ['U+2028 inside a bullet', '- item\u2028more\n', 'UL'],
    ['U+2029 inside a bullet', '- item\u2029more\n', 'UL'],
  ]) {
    if (!find(renderMarkdown(input), want)) die(`markdown: ${why} did not produce a <${want.toLowerCase()}> — the line terminator was not normalised`)
  }
  // Same mismatch, silent instead of fatal: the heading was rendered as a paragraph, hash included.
  if (!find(renderMarkdown('# Title\u2028more\n'), 'H3')) die('markdown: a heading followed by U+2028 rendered as a paragraph with its hash still in it')
  console.log('  ok markdown — a document cannot inject a scheme through a link, a refused link is shown rather than dropped, and headings, bullet lists, numbered lists and quotes are real elements')
}

// Locale parity, now that the tables are files rather than a literal buried in the template. I15
// claimed this was enforced for the Control Room; it was only ever true of the single-lens viewer.
{
  const en = readJson(join(HERE, '..', 'lib/viewer/strings/en.json'))
  const it = readJson(join(HERE, '..', 'lib/viewer/strings/it.json'))
  const missing = Object.keys(en).filter(function (k) { return !(k in it) })
  const extra = Object.keys(it).filter(function (k) { return !(k in en) })
  if (missing.length) die('strings: keys present in en and missing from it: ' + missing.join(', '))
  if (extra.length) die('strings: keys present in it and missing from en: ' + extra.join(', '))
  // A key the template never reads is dead weight a translator still has to carry.
  const template = readFileSync(join(HERE, '..', 'lib/viewer/control-room.html'), 'utf-8')
  const unused = Object.keys(en).filter(function (k) { return template.indexOf('STR.' + k) < 0 })
  if (unused.length) die('strings: declared but never read by the template: ' + unused.join(', '))
  // A string carrying a {placeholder} has to reach the reader through fmt(). Appending one raw puts
  // a literal `{closed}` on the page — which is what shipped for the length of one screenshot, in
  // the sentence written to stop the first screen reading as broken.
  const raw = Object.keys(en).filter(function (k) {
    if (!/\{[a-zA-Z]\w*\}/.test(en[k])) return false
    return !new RegExp('(?:fmt|plural)\\([^)]*STR\\.' + k + '\\b').test(template)
  })
  if (raw.length) die('strings: carries a {placeholder} but never reaches fmt(), so it renders literally: ' + raw.join(', '))
  console.log(`  ok strings — ${Object.keys(en).length} keys at en/it parity, every one read by the template`)
}

// Queue and Kanban are supporting technical evidence, not two undocumented top-level products.
// They stay complete through lazy, bounded disclosure inside Tech; legacy hashes remain valid.
{
  const template = readFileSync(join(HERE, '..', 'lib/viewer/control-room.html'), 'utf-8')
  const viewerFn = (name) => (new RegExp('function ' + name + '\\([^]*?\\n}\\n').exec(template) || [])[0] || ''
  const tabsSource = (/var TABS=([\s\S]*?);\s*var BUILD=/.exec(template) || [])[1] || ''
  const tabs = [...tabsSource.matchAll(/\["([^"]+)",function/g)].map((m) => m[1])
  if (tabs.join() !== 'exec,tech,map,wbs,docs') die('room-ia: programme views drifted from the five-view contract: ' + tabs)
  if (/var BUILD=\{[^}]*\b(?:auto|kanban):/.test(template)) die('room-ia: removed queue/Kanban routes still exist in BUILD')
  if (!/\^\\\/\(\[\^\/\]\+\)\\\/\(auto\|kanban\)\$/.test(template) || !/return key\(old\[1\],"tech"\)/.test(template)) die('room-ia: legacy /auto and /kanban hashes do not redirect to Tech')
  if (!/function workflow\(/.test(template) || !/d\.open&&!d\.getAttribute\("data-filled"\)/.test(template)) die('room-tech: supporting workflows are not lazy')
  const pageSize = Number((/var ISSUE_PAGE_SIZE=(\d+)/.exec(template) || [])[1])
  if (!(pageSize > 0 && pageSize <= 40) || !/function pagedList\(/.test(template)) die('room-dom: issue rendering has no bounded pager')
  for (const fn of ['renderQueue', 'renderKanban']) {
    const body = viewerFn(fn)
    if (!(fn === 'renderQueue' ? /filteredList\(/ : /pagedList\(/).test(body)) die('room-dom: ' + fn + ' bypasses the bounded pager')
  }
  const filter = viewerFn('filteredList'), queue = viewerFn('renderQueue'), kanban = viewerFn('renderKanban')
  if (!/item\.search/.test(filter) || !/input\.addEventListener\("input",draw\)/.test(filter)) die('room-search: the bounded shared list filter no longer searches on input')
  if (!/filteredList\(lane\.body,items/.test(queue) || !/block\.auto&&block\.cmd\?commandLine\(block\.cmd\):el\("span","state-chip",STR\.human\)/.test(queue)) die('room-queue: blocks lost search or the exact auto/manual command boundary')
  if (!/input\.type="search"/.test(kanban) || !/source\.filter/.test(kanban) || !/names\.concat\(\[\["chiuse"/.test(kanban)) die('room-kanban: search or the CLOSED archive lane is missing')
  const tech = viewerFn('viewTech')
  if (!/names\[i\]\[0\]!=="aspettano-umano"\|\|program\.derived\.kanbanHumanDeclared/.test(tech) || !/key!=="aspettano-umano"\|\|program\.derived\.kanbanHumanDeclared/.test(kanban)) die('room-kanban: an undeclared human-label rule is rendered as a measured empty bucket')
  const milestones = viewerFn('milestonePanel'), wbs = viewerFn('viewWbs')
  if (!/milestonesComplete/.test(milestones) || !/markState\(p,"unknown",STR\.milestoneIncomplete\)/.test(milestones)) die('room-milestones: an issue-derived milestone panel does not disclose incomplete collection')
  if (!/milestonePanel\(program\)/.test(wbs)) die('room-milestones: milestone evidence is not nested under the existing WBS view')
  if (!/documentGatePanel\(program\)/.test(viewerFn('viewDocs'))) die('room-docs: the document gate is not nested under the existing Docs view')
  const documentPanel = viewerFn('documentGatePanel')
  if (!/chips\(f\.matched\)/.test(documentPanel) || !/gate\.claims\|\|\[\]/.test(documentPanel)) die('room-docs: the document gate panel hides measured wiring or typed claims')
  if (!/gate\.errors\.length/.test(documentPanel) || !/gate\.errors\[i\]/.test(documentPanel)) die('room-docs: non-empty document gate input errors are not disclosed')
  if (!/id="mobile-program"/.test(template) || !/id="mobile-view"/.test(template)) die('room-mobile: native route controls are absent')
  if (!/\.screen-list,\.workflow\{display:none!important\}/.test(template) || /details:not\(\[open\]\)/.test(template)) die('room-print: interactive archives can expand into print')
  if (!/execHeadlineUnknown/.test(template) || !/techHeadlineUnknown/.test(template) || !/thesisUnknown/.test(template)) die('room-truth: unknown claims have no explicit headline path')
  if (!/\.pager button\{min-height:44px/.test(template)) die('room-mobile: pager target is below 44px')
  if (!/\.skip\{[^}]*min-height:44px/.test(template)) die('room-mobile: skip target is below 44px')
  if (!/\.prov\{overflow:visible;text-overflow:clip;white-space:normal/.test(template)) die('room-mobile: provenance is truncated without a disclosure')
  const composer = readFileSync(join(HERE, '..', 'lib/room.mjs'), 'utf-8')
  if (!/theme: manifest\.theme \|\| 'light'/.test(composer)) die('room-theme: a fresh client briefing does not default to light')
  console.log('  ok room-workflow — five-view IA, searchable blocks/Kanban, honest milestones, bounded lazy evidence, mobile and print contracts')
}

// The shipped Claude adapter is executable guidance, not brochure copy: its init→update sequence
// must work on a fresh map-less checkout and tell the agent to link the artifact it produced (#73).
{
  const repo = join(tmp, 'skill-target'), manifest = join(repo, 'forma.room.json')
  const out = join(repo, 'docs/architecture/control-room.html')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/main.js'), 'export const ready = true\n')
  const git = (args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); if (r.status !== 0) die('skill target git: ' + args.join(' '), r) }
  git(['init', '-q', '.']); git(['remote', 'add', 'origin', 'git@github.com:acme/thing.git'])
  let r = run(['room', 'init', '--repo', repo, '--manifest', manifest, '--today', '2026-08-17'])
  if (r.status !== 0) die('claude skill: room init exit ' + r.status, r)
  const gh = process.execPath + ' ' + join(HERE, 'stub-gh.mjs')
  r = run(['room', 'update', '--manifest', manifest, '--out', out, '--gh-cmd', gh])
  if (r.status !== 0 || !existsSync(out)) die('claude skill: room update did not produce the linked artifact', r)
  const skill = readFileSync(join(HERE, '..', 'adapters/claude/SKILL.md'), 'utf-8')
  const initAt = skill.indexOf('room init'), updateAt = skill.indexOf('room update')
  if (initAt < 0 || updateAt < initAt) die('claude skill: init→update order is not documented')
  if (!/room update[^\n]*--out/.test(skill) || !/Markdown link/i.test(skill)) die('claude skill: the adapter does not link the generated output')
  console.log('  ok claude-skill — init→update runs on a fresh target and the adapter links the artifact')
}

// Publishing must follow the same chain for every future release: conventional commits become a
// reviewable Release Please PR, and only a matching immutable tag reaches npm through the existing
// OIDC publisher. This is intentionally static: it protects the CI contract without publishing.
{
  const release = readFileSync(join(HERE, '..', '.github/workflows/release.yml'), 'utf-8')
  if (!/branches:\s*\[main\]/.test(release) || !/tags:\s*\["v\*"\]/.test(release) || !/workflow_dispatch:/.test(release)) die('release: main, tag and recovery triggers must remain explicit')
  if (!/googleapis\/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7/.test(release) || !/release-type:\s*node/.test(release)) die('release: conventional versioning is not pinned to Release Please')
  if (!/git tag --list 'v1\.\*'/.test(release)) die('release: automated bumps must wait for the deliberate 1.0 bootstrap tag')
  if (!/release_created/.test(release) || !/id-token:\s*write/.test(release)) die('release: automatic publication is not gated by a created release and npm OIDC')
  if (/npm@latest/.test(release) || !/npm@11\.16\.0/.test(release)) die('release: the npm publishing CLI must be an explicit supported version, never latest')
  if (!/package-manager-cache:\s*false/.test(release)) die('release: release builds must not reuse a package-manager cache')
  console.log('  ok release — conventional commits create reviewable version bumps and OIDC publishes only matching releases')
}

// One issue primitive keeps every view honest: colour only from validated health, the same anchored
// why on hover, a word plus glyph, and closed work visibly closed. No plain issueLink may bypass it (#63).
{
  const template = readFileSync(join(HERE, '..', 'lib/viewer/control-room.html'), 'utf-8')
  const pill = (template.match(/function pill\([^]*?\n}/) || [])[0]
  if (!pill) die('room-pill: the shared pill() primitive is missing')
  if (!/p\.derived&&p\.derived\.health&&p\.derived\.health\.verdicts/.test(pill)) die('room-pill: colour is not sourced from the derived, staleness-aware health overlay')
  if (!/data-tip/.test(pill)) die('room-pill: the anchored why is not exposed on the issue reference')
  if (!/statusMark/.test(pill)) die('room-pill: the verdict has no shared glyph + word encoding')
  if (!/state==="CLOSED"/.test(pill)) die('room-pill: closed issues are not encoded')
  if (!/\.issue-pill \.issue-text\{[^}]*min-width:0/.test(template)) die('room-pill: long issue titles escape their pill on a narrow board lane')
  if (!/mark\.lastChild\.textContent/.test(pill)) die('room-pill: the accessible name omits the verdict word')
  if (/\bissueLink\(/.test(template)) die('room-pill: a plain issue link bypasses pill()')
  console.log('  ok room-pill — every issue reference shares current/stale/closed state, anchored reason, glyph and word')
}

// The map already embeds Forma's full explorer. Keep one drill surface: prove the iframe carries the
// explicit [+] control, stack navigation and C4 level breadcrumb, then pin the owner decision (#64).
{
  const room = readFileSync(join(HERE, '..', 'lib/viewer/control-room.html'), 'utf-8')
  const holo = readFileSync(join(HERE, '..', 'lib/viewer/c4-hologram.html'), 'utf-8')
  const decisions = readFileSync(join(HERE, '..', 'DECISION_REGISTRY.md'), 'utf-8')
  if (!/srcdoc=frameDoc\(program\)/.test(room)) die('room-c4-drill: the map no longer embeds the hologram')
  if (!/data-drill="1"/.test(holo) || !/stack\.push\(id\)/.test(holo)) die('room-c4-drill: the embedded hologram cannot drill into children')
  if (!/tabindex="0" focusable="true" role="button" aria-label=/.test(holo) || !/stage\.addEventListener\("keydown"/.test(holo) || !/ev\.key!=="Enter"&&ev\.key!==" "/.test(holo)) die('room-c4-drill: SVG nodes are not keyboard controls')
  if (!/class="detaildrill"/.test(holo) || !/drillTo\(n\.id,true\)/.test(holo)) die('room-c4-drill: touch inspection has no 44px drill action')
  if (!/@media\(max-width:600px\)\{#stage\{overflow:auto/.test(holo) || !/liveSvg\.style\.width=Math\.ceil\(vw\)/.test(holo)) die('room-c4-drill: mobile still shrinks the entire map instead of panning at readable scale')
  if (!/crumbLevel\+"-L"/.test(holo)) die('room-c4-drill: the embedded hologram does not expose its C4 level')
  if (!/\| D-07 \|[^\n]*embedded hologram[^\n]*sufficient/i.test(decisions)) die('room-c4-drill: the delegated owner decision is not recorded')
  console.log('  ok room-c4-drill — the embedded map is the ratified L1→L4 drill surface')
}

// The dogfood. A traceability convention that cannot read the document THIS repository writes is a
// convention for other people's repositories. docs/PRD.md §6 is a real table, edited by hand for
// prose reasons, and the parser has to find it without being told anything but the id pattern.
// The full chain (issues, and therefore the four gate assertions) additionally needs a committed
// `gh` snapshot; that is a disclosure decision docs/SCOPE-room.md §6 leaves open, so what is
// asserted here is what can be asserted offline: the rows parse, and they parse as themselves.
{
  const { parseRequirements, trackedFiles } = await import(join(HERE, '..', 'lib', 'rtm.mjs'))
  const repo = join(HERE, '..')
  const tracked = trackedFiles(repo)
  if (!tracked) die('rtm-dogfood: forma is not a readable git checkout, so the tracked-files rule cannot be exercised')
  if (!tracked.has('docs/PRD.md')) die('rtm-dogfood: docs/PRD.md is not tracked by git')
  const { rows, skipped } = parseRequirements(repo, [{ path: 'docs/PRD.md', idPattern: '^R-\\d+$', role: 'requirement' }], tracked)
  if (skipped.length) die('rtm-dogfood: forma\'s own PRD contributed nothing — ' + JSON.stringify(skipped))
  if (rows.length < 9) die(`rtm-dogfood: expected at least 9 R-* rows in docs/PRD.md, got ${rows.length}`)
  const ids = rows.map((row) => row.id)
  if (new Set(ids).size !== ids.length) die('rtm-dogfood: forma\'s own PRD declares a duplicate id: ' + ids.join(', '))
  for (const row of rows) {
    if (!row.text) die(`rtm-dogfood: ${row.id} parsed with no text`)
    if (!row.verified.length) die(`rtm-dogfood: ${row.id} has no "verified by" entry — the column exists precisely so this cannot happen`)
    if (!(row.line > 0)) die(`rtm-dogfood: ${row.id} carries no source line, so nothing could link back to the row`)
  }
  // Determinism across the compose→check gap rests on the file list being sorted and git-tracked.
  // Parsing twice must give the identical answer, or `check` false-reds on an untouched tree.
  const again = parseRequirements(repo, [{ path: 'docs/PRD.md', idPattern: '^R-\\d+$', role: 'requirement' }], tracked)
  if (JSON.stringify(again.rows) !== JSON.stringify(rows)) die('rtm-dogfood: two parses of the same document disagree — check would false-red on an untouched tree')
  console.log(`  ok rtm-dogfood — forma's own PRD parses as ${rows.length} traceable requirements, every one carrying its verification and its line`)
}

// A public repository's required CI must be runnable by a fork with its default token. Depending
// on a private sibling is a permanent red, not a documentation verdict (#55 / D-7).
{
  const ci = readFileSync(join(HERE, '..', '.github/workflows/ci.yml'), 'utf-8')
  if (/LucaDominici\/arbiter|ARBITER_TOKEN|\.arbiter-gates/.test(ci)) die('ci-public: required CI still depends on private arbiter access')
  if (!/needs:\s*\[test\]/.test(ci)) die('ci-public: ci-required is not reduced to the self-contained test job')
  console.log('  ok ci-public — required CI has no private repository or credential dependency')
}

// The Control Room is validated by dogfood over real local work, not by publishing forma's quiet
// self-portrait as a second Pages demo (#56). The architecture explorer remains the public demo.
{
  const pages = readFileSync(join(HERE, '..', '.github/workflows/pages.yml'), 'utf-8')
  const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf-8')
  if (/_site\/room|room-presentable|bin\/forma\.mjs room|bin\/forma\.mjs verify/.test(pages)) die('dogfood: Pages still builds or publishes a Control Room')
  if (/github\.io\/forma\/room\//.test(readme)) die('dogfood: README still advertises the retired public Control Room')
  console.log('  ok dogfood — Pages publishes the explorer only; the Control Room stays local')
}

// The audit channel is the producer for both evidence overlays: plan offline, let an agent fill
// the JSON contract, then validate everything before either file is replaced (#65).
{
  const repo = join(tmp, 'audit-repo'), plan = join(tmp, 'audit-plan.json'), plan2 = join(tmp, 'audit-plan-2.json')
  const issues = join(repo, 'issues.json'), health = join(repo, 'health.json'), findings = join(repo, 'findings.json')
  const topology = join(repo, 'topology.json'), model = join(repo, 'model.json')
  cpSync(FIX('room/alpha'), repo, { recursive: true })
  let r = run(['init', '--repo', repo, '--out', topology, '--force']); if (r.status !== 0) die('audit: init exit ' + r.status, r)
  r = run(['gen', '--repo', repo, '--topology', topology, '--out', model]); if (r.status !== 0) die('audit: gen exit ' + r.status, r)
  const auditModel = readJson(model)
  const doneNode = auditModel.nodes.find((node) => node.evidence && node.evidence.some((e) => e.type === 'path'))
  mkdirSync(join(repo, 'docs/architecture'), { recursive: true })
  writeFileSync(join(repo, 'docs/architecture/c4-status.json'), JSON.stringify({ nodes: { [doneNode.id]: { status2: 'done', current: 'Audited fixture claim.', verify: { source: 'test fixture' } } } }, null, 2))
  r = run(['gen', '--repo', repo, '--topology', topology, '--out', model]); if (r.status !== 0) die('audit: decorated gen exit ' + r.status, r)
  const planArgs = ['audit', '--repo', repo, '--issues', issues, '--model', model, '--topology', topology, '--health', health, '--findings', findings, '--today', '2026-08-10', '--blocked-labels', '["needs-human"]', '--plan']
  const applyArgs = ['audit', '--repo', repo, '--issues', issues, '--model', model, '--topology', topology, '--health', health, '--findings', findings, '--today', '2026-08-10', '--blocked-labels', '["needs-human"]']
  r = run([...planArgs, plan])
  if (r.status !== 0) die('audit: plan exit ' + r.status, r)
  r = run([...planArgs, plan2])
  if (r.status !== 0) die('audit: second plan exit ' + r.status, r)
  if (readFileSync(plan, 'utf-8') !== readFileSync(plan2, 'utf-8')) die('audit: unchanged inputs produced different plans')
  const work = readJson(plan)
  if (JSON.stringify(work.issues.map((x) => x.n)) !== '[3]') die('audit: plan did not exclude already-audited issues: ' + JSON.stringify(work.issues))
  if (!work.issues[0].prompt.includes('issue #3') || work.output.planHash !== work.planHash || !Array.isArray(work.output.verdicts) || !Array.isArray(work.output.findings)) die('audit: plan does not carry the agent fill contract')
  const claimKinds = new Set(work.claims.map((claim) => claim.kind))
  for (const kind of ['done-node', 'health-verdict', 'milestone-rate', 'waiting-human']) if (!claimKinds.has(kind)) die('audit: counter-verification plan has no ' + kind + ' claim')
  if (work.claims.some((claim) => !claim.id || !claim.claim || !claim.where.length)) die('audit: a counter-verification claim lacks its name or inspection targets: ' + JSON.stringify(work.claims))
  const milestoneClaim = work.claims.find((claim) => claim.kind === 'milestone-rate')
  if (!/33% \(1 closed of 3\)/.test(milestoneClaim.claim) || !milestoneClaim.where.some((at) => at.type === 'gh')) die('audit: milestone claim does not name its derivation and gh source: ' + JSON.stringify(milestoneClaim))

  const { auditPlan, applyCounterResults, counterPlan, validateCounterResults, classifyVerdictStaleness, hashEvidence, resolveEvidencePath, validateEvidence } = await import(join(HERE, '..', 'lib/audit.mjs'))
  const labelClaims = counterPlan(null, {
    ghRepo: 'acme/labels', milestones: [],
    issues: [{ n: 1, state: 'OPEN', labels: ['owner-decision'] }, { n: 2, state: 'OPEN', labels: ['needs-human'] }],
  }, { verdicts: [] }, 'model.json', ['owner-decision']).filter((claim) => claim.kind === 'waiting-human')
  if (labelClaims.map((claim) => claim.id).join() !== 'issue:waiting-human:1' || /needs-human/.test(labelClaims[0].claim)) die('audit labels: counter plan inferred needs-human outside the declared owner-decision vocabulary')
  const evidence = [{ type: 'path', ref: 'src/core/engine.js' }], issueSnapshot = readJson(issues)
  const evidenceHash = hashEvidence(repo, evidence, issueSnapshot)
  const anchored = validateEvidence(repo, { type: 'path', ref: 'src/core/engine.js:1' }, 'line anchor')
  if (anchored.ref !== 'src/core/engine.js:1' || anchored.line !== 1 || resolveEvidencePath(repo, anchored.ref).ref !== anchored.ref) die('audit evidence: a valid path:line anchor did not resolve canonically')
  for (const [ref, expected] of [['src/core/engine.js:999999', /line does not resolve/], ['../outside:1', /path does not exist in repo/]]) {
    let rejected = null
    try { validateEvidence(repo, { type: 'path', ref }, 'line anchor') } catch (error) { rejected = error }
    if (!rejected || !expected.test(rejected.message)) die('audit evidence: unsafe or invalid anchor was not rejected clearly: ' + ref)
  }
  const lineOneHash = hashEvidence(repo, [{ type: 'path', ref: 'src/core/engine.js:1' }], issueSnapshot)
  const lineTwoHash = hashEvidence(repo, [{ type: 'path', ref: 'src/core/engine.js:2' }], issueSnapshot)
  if (lineOneHash !== hashEvidence(repo, [{ type: 'path', ref: 'src/core/engine.js:1' }], issueSnapshot) || lineOneHash === lineTwoHash) die('audit evidence: path:line hashes are not deterministic and anchor-sensitive')
  const staleVerdict = { auditedAt: '2026-08-10', evidenceHash }
  const unchangedIssue = { updatedAt: '2026-08-10T23:59:59Z', closedAt: null }
  const classify = (issue, today, currentHash = evidenceHash) => classifyVerdictStaleness(staleVerdict, issue, { today, staleAfterDays: 14, evidenceHash: currentHash })
  if (classify(unchangedIssue, '2026-08-17') !== 'fresh') die('audit stale: unchanged issue and evidence did not stay fresh')
  if (classify({ ...unchangedIssue, updatedAt: '2026-08-11T00:00:00Z' }, '2026-08-17') !== 'issue-changed') die('audit stale: issue update after audit was ignored')
  if (classify(unchangedIssue, '2026-08-17', '0'.repeat(64)) !== 'evidence-changed') die('audit stale: changed evidence hash was ignored')
  if (classify(unchangedIssue, '2026-08-25') !== 'expired') die('audit stale: verdict age limit was ignored')
  if (classify(unchangedIssue, '2026-08-09') !== 'future') die('audit stale: a verdict from the future stayed green')
  const unrelated = JSON.parse(JSON.stringify(issueSnapshot)); unrelated.issues.find((it) => it.n === 2).title = 'Unrelated snapshot change'
  if (hashEvidence(repo, evidence, unrelated) !== evidenceHash) die('audit stale: unrelated snapshot data leaked into a path evidence hash')
  const expiredPrompts = auditPlan(issueSnapshot, { byIssue: new Map() }, readJson(health).verdicts, { repo, today: '2026-08-25', staleAfterDays: 14 })
  if (expiredPrompts.map((entry) => entry.n).join() !== '1,2,3') die('audit stale: expired verdicts were not queued for re-audit: ' + JSON.stringify(expiredPrompts))
  const { stubAuditAgent } = await import(join(HERE, 'stub-audit-agent.mjs'))
  const result = validateCounterResults(work, stubAuditAgent(work))
  const heldResult = { planHash: work.planHash, results: JSON.parse(JSON.stringify(result.results)) }
  heldResult.results.find((entry) => entry.claimId === 'health:1').verdict = 'holds'
  const renewed = applyCounterResults(repo, issueSnapshot, issues, readJson(health), readJson(findings).findings, work, heldResult, { today: '2026-08-11' })
  if (renewed.health.verdicts.find((v) => v.n === 1).auditedAt !== '2026-08-11') die('audit: a counter hold did not renew auditedAt')
  if (result.results.length !== work.claims.length || result.results.some((entry, i) => entry.claimId !== work.claims[i].id)) die('audit: runner result does not cover the plan one-for-one')
  if (!['holds', 'contradicted', 'unsupported'].every((verdict) => result.results.some((entry) => entry.verdict === verdict))) die('audit: offline agent did not exercise every counter-verdict')
  if (result.results.some((entry) => !entry.reason || !entry.evidence || !entry.evidence.type || !entry.evidence.ref)) die('audit: runner accepted an unanchored reason')
  // A partial result is not a rejected result: the claims the verifier did not answer are named as
  // `unanswered` and simply get no fresh verdict — nobody looked, and the room says so.
  const partial = validateCounterResults(work, stubAuditAgent(work, true))
  if (!partial.unanswered.length || partial.results.length + partial.unanswered.length !== work.claims.length) die('audit: a partial counter result was not split into results + unanswered')
  try { validateCounterResults(work, { planHash: work.planHash, results: [{ claimId: 'not:in:plan', verdict: 'holds', reason: 'x', evidence: { type: 'file', ref: 'src/util/log.js' } }] }); die('audit: counter contract accepted a claim the plan does not contain') } catch (e) { if (!/does not contain/.test(e.message)) throw e }
  // `today` is carried in the plan but stays out of its identity: a new day must not invalidate a
  // fill the agent already wrote (and with it every counter-verdict).
  r = run([...planArgs.map((a) => (a === '2026-08-10' ? '2026-08-12' : a)), plan2]); if (r.status !== 0) die('audit: plan on another day exit ' + r.status, r)
  if (readJson(plan2).planHash !== work.planHash || readJson(plan2).today !== '2026-08-12') die('audit: the calendar day leaked into the plan identity')
  r = run(['audit', '--repo', repo, '--run', plan])
  if (r.status === 0 || !/unknown option: --run/.test(r.stderr || '')) die('audit: the offline engine grew an agent/network runner', r)
  const auditSource = readFileSync(join(HERE, '..', 'lib/audit.mjs'), 'utf-8')
  if (/codex exec|--agent-cmd/.test(auditSource)) die('audit: the external Codex adapter leaked into the offline engine')
  const codexSkill = readFileSync(join(HERE, '..', 'adapters/codex/forma-counterverify/SKILL.md'), 'utf-8')
  const decisions = readFileSync(join(HERE, '..', 'DECISION_REGISTRY.md'), 'utf-8')
  if (!/name: forma-counterverify/.test(codexSkill) || !/holds\|contradicted\|unsupported/.test(codexSkill) || !/planHash/.test(codexSkill) || !/--today/.test(codexSkill)) die('audit: the default Codex adapter does not declare the current counter-verification contract')
  if (!/\| D-08 \| Codex is the default counter-verification adapter, but runs outside Forma \|/.test(decisions)) die('audit: the delegated Codex CLI decision is not recorded')

  // Agent results enter through the same validated apply boundary. A contradicted issue claim is
  // both a durable finding and a bad health verdict, so the shared pill turns red with this reason.
  const counter = join(tmp, 'audit-counter.json')
  writeFileSync(counter, JSON.stringify(result))
  const beforeToctouHealth = readFileSync(health, 'utf-8'), beforeToctouFindings = readFileSync(findings, 'utf-8'), beforeToctouIssues = readFileSync(issues, 'utf-8')
  const changedDuringAudit = readJson(issues); changedDuringAudit.issues.find((issue) => issue.n === 3).title = 'Changed after the plan'
  writeFileSync(issues, JSON.stringify(changedDuringAudit, null, 2) + '\n')
  r = run([...applyArgs, '--apply', counter, '--counter-plan', plan])
  writeFileSync(issues, beforeToctouIssues)
  if (r.status === 0 || !/plan is stale/.test(r.stderr || '') || readFileSync(health, 'utf-8') !== beforeToctouHealth || readFileSync(findings, 'utf-8') !== beforeToctouFindings) die('audit: apply accepted a result after its plan inputs changed', r)
  r = run([...applyArgs, '--apply', counter, '--counter-plan', plan])
  if (r.status !== 0) die('audit: counter apply exit ' + r.status, r)
  const contradicted = result.results.find((entry) => entry.claimId === 'health:1')
  const counterHealth = readJson(health).verdicts.find((v) => v.n === 1)
  if (!contradicted || contradicted.verdict !== 'contradicted' || !counterHealth || counterHealth.verdict !== 'bad' || counterHealth.why !== contradicted.reason) die('audit: contradicted health claim did not become the pill\'s bad verdict and why')
  if (!readJson(findings).findings.some((f) => f.id === 'counter:health:1' && f.severity === 'bad' && f.text === contradicted.reason)) die('audit: contradicted claim did not become a durable finding')
  if (!readJson(findings).findings.some((f) => f.id === 'counter:health:2' && f.severity === 'warn')) die('audit: unsupported claim disappeared instead of becoming a warning')

  const manifest = join(repo, 'forma.room.json'), roomHtml = join(repo, 'control-room.html')
  writeFileSync(manifest, JSON.stringify({ today: '2026-08-10', programs: [{ id: 'audit', ghRepo: 'acme/alpha', repo: '.', issues: 'issues.json', model: 'model.json', topology: 'topology.json', health: 'health.json', findings: 'findings.json', blockedBy: { labels: ['needs-human'] } }] }, null, 2))
  r = run(['room', '--manifest', manifest, '--out', roomHtml]); if (r.status !== 0) die('audit: room after counter apply exit ' + r.status, r)
  r = run(['check', '--repo', repo, '--model', model, '--topology', topology, '--issues', issues, '--health', health, '--findings', findings, '--room', roomHtml, '--manifest', manifest])
  if (r.status !== 0) die('audit: re-derivation disagrees after counter apply', r)
  const goodHealth = readFileSync(health, 'utf-8')
  const brokenHealth = readJson(health)
  brokenHealth.verdicts.find((v) => v.n === 1).evidence = [{ type: 'path', ref: 'missing-counter-proof.js' }]
  writeFileSync(health, JSON.stringify(brokenHealth, null, 2) + '\n')
  const staleRoom = join(repo, 'stale-room.html')
  r = run(['room', '--manifest', manifest, '--out', staleRoom]); if (r.status !== 0) die('audit stale: unresolved old verdict stopped composition', r)
  const staleSeam = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(readFileSync(staleRoom, 'utf-8'))
  if (!staleSeam) die('audit stale: generated room has no __ROOM__ seam')
  const staleProgram = JSON.parse(staleSeam[1]).programs[0], staleHealth = staleProgram.derived.health
  const stale = staleHealth.verdicts.find((v) => v.n === 1)
  if (!stale || !stale.stale || stale.staleReason !== 'evidence-changed' || staleHealth.staleCount < 1) die('audit stale: missing evidence was not derived as stale: ' + JSON.stringify(staleHealth))
  if (!staleProgram.derived.kanban['non-auditate'].includes(1) || staleProgram.derived.kanban['premessa-falsa'].includes(1)) die('audit stale: stale verdict still colored the Kanban')
  r = run(['check', '--repo', repo, '--model', model, '--topology', topology, '--issues', issues, '--health', health, '--findings', findings, '--room', staleRoom, '--manifest', manifest])
  if (r.status !== 0) die('audit stale: check rejected a correctly disclosed stale verdict', r)
  writeFileSync(health, goodHealth)

  const beforeCounterHealth = readFileSync(health, 'utf-8'), beforeCounterFindings = readFileSync(findings, 'utf-8')
  r = run([...planArgs, plan]); if (r.status !== 0) die('audit: fresh plan before rejected counter exit ' + r.status, r)
  const badCounter = stubAuditAgent(readJson(plan))
  badCounter.results.find((entry) => entry.claimId === 'health:1').evidence = { type: 'file', ref: 'missing-agent-proof.js' }
  writeFileSync(counter, JSON.stringify(badCounter))
  r = run([...applyArgs, '--apply', counter, '--counter-plan', plan])
  // Item-by-item: the entry with the unresolved anchor is refused and NAMED in lastApply.rejected;
  // the other entries land. An abort that leaves no trace is what the reference dashboard had.
  if (r.status !== 0 || !/rejected counter health:1/.test(r.stderr || '')) die('audit: a bad counter entry aborted the whole apply instead of being refused by name', r)
  const afterBadCounter = readJson(health)
  if (!afterBadCounter.lastApply || afterBadCounter.lastApply.at !== '2026-08-10' || !afterBadCounter.lastApply.rejected.some((x) => x.kind === 'counter' && x.ref === 'health:1' && /does not exist in repo/.test(x.reason)) || afterBadCounter.lastApply.accepted < 1) die('audit: lastApply does not record the refused counter entry: ' + JSON.stringify(afterBadCounter.lastApply))
  if (afterBadCounter.verdicts.find((v) => v.n === 1).why === 'missing-agent-proof.js' || readFileSync(findings, 'utf-8') === beforeCounterFindings) die('audit: refused entry leaked, or accepted entries were dropped with it')
  void beforeCounterHealth

  const fill = join(tmp, 'audit-fill.json')
  writeFileSync(fill, JSON.stringify({
    planHash: readJson(plan).planHash,
    verdicts: [{ n: 3, verdict: 'ok', why: 'The committed helper is present.', evidence: [{ type: 'path', ref: 'src/util/log.js' }] }],
    findings: [{ id: 'F-2', severity: 'bad', text: 'Parser behavior contradicts the issue.', evidence: { type: 'issue', ref: '2' } }],
  }))
  r = run([...applyArgs, '--apply', fill, '--audit-plan', plan])
  if (r.status !== 0) die('audit: apply exit ' + r.status, r)
  const appliedVerdict = readJson(health).verdicts.find((v) => v.n === 3 && v.verdict === 'ok')
  if (!appliedVerdict) die('audit: verdict was not written')
  if (appliedVerdict.auditedAt !== '2026-08-10' || !/^[0-9a-f]{64}$/.test(appliedVerdict.evidenceHash)) die('audit: Forma did not stamp deterministic verdict provenance')
  const appliedFinding = readJson(findings).findings.find((f) => f.id === 'F-2' && f.severity === 'bad')
  if (!appliedFinding) die('audit: finding was not written')
  if (appliedFinding.auditedAt !== '2026-08-10' || !/^[0-9a-f]{64}$/.test(appliedFinding.evidenceHash)) die('audit: Forma did not stamp finding provenance — a finding that cannot expire is the reference dashboard\'s failure')
  if (readJson(health).lastApply.rejected.length !== 0 || readJson(health).lastApply.accepted !== 2) die('audit: lastApply miscounted a clean fill: ' + JSON.stringify(readJson(health).lastApply))
  // signal and milestone evidence resolve by KEY against the snapshot and hash the WHOLE record, so a
  // new workflow run or a moved milestone marks the evidence changed — never an index, never a file.
  const withSignals = readJson(issues)
  withSignals.signals.workflows.ci = { state: 'present', name: 'ci', path: '.github/workflows/ci.yml', headBranch: 'main', headSha: '0'.repeat(40), event: 'push', status: 'completed', conclusion: 'success', createdAt: '2026-08-01T00:00:00Z', url: 'https://github.com/acme/alpha/actions/runs/1' }
  const signalHash = hashEvidence(repo, [{ type: 'signal', ref: 'workflows/ci' }], withSignals)
  const movedRun = JSON.parse(JSON.stringify(withSignals)); movedRun.signals.workflows.ci.headSha = 'f'.repeat(40)
  if (signalHash !== hashEvidence(repo, [{ type: 'signal', ref: 'workflows/ci' }], withSignals) || signalHash === hashEvidence(repo, [{ type: 'signal', ref: 'workflows/ci' }], movedRun)) die('audit evidence: signal hash is not deterministic or ignores a new run')
  const refetched = JSON.parse(JSON.stringify(withSignals)); refetched.fetchedAt = '2030-01-01T00:00:00Z'
  if (signalHash !== hashEvidence(repo, [{ type: 'signal', ref: 'workflows/ci' }], refetched)) die('audit evidence: fetchedAt leaked into a signal hash')
  const msHash = hashEvidence(repo, [{ type: 'milestone', ref: withSignals.milestones[0].title }], withSignals)
  const movedMs = JSON.parse(JSON.stringify(withSignals)); movedMs.milestones[0].closed += 1
  if (msHash === hashEvidence(repo, [{ type: 'milestone', ref: withSignals.milestones[0].title }], movedMs)) die('audit evidence: milestone hash ignores a closed issue')
  for (const bad of [{ type: 'signal', ref: 'workflows/nope' }, { type: 'milestone', ref: 'no such milestone' }, { type: 'signal', ref: 'workflows/ci' }]) {
    let rejected = null
    try { validateEvidence(repo, bad, 'keyed', bad.ref === 'workflows/ci' ? new Set([1]) : withSignals) } catch (error) { rejected = error }
    if (!rejected) die('audit evidence: keyed evidence resolved where it must not: ' + JSON.stringify(bad))
  }

  const beforeHealth = readFileSync(health, 'utf-8'), beforeFindings = readFileSync(findings, 'utf-8')
  r = run([...planArgs, plan]); if (r.status !== 0) die('audit: fresh plan before rejected fill exit ' + r.status, r)
  writeFileSync(fill, JSON.stringify({
    planHash: readJson(plan).planHash,
    verdicts: [{ n: 3, verdict: 'bad', why: 'Unsupported.', evidence: [{ type: 'path', ref: 'src/util/log.js' }] }],
    findings: [{ id: 'F-3', severity: 'warn', text: 'Would be a partial write.', evidence: { type: 'path', ref: 'src/core/engine.js' } }],
  }))
  r = run([...applyArgs, '--apply', fill, '--audit-plan', plan])
  if (r.status !== 0 || !/rejected verdict #3: verdict #3 was not in the plan/.test(r.stderr || '')) die('audit: an unplanned verdict was not refused by name', r)
  if (readJson(health).verdicts.find((v) => v.n === 3).verdict !== 'ok' || !readJson(findings).findings.some((f) => f.id === 'F-3')) die('audit: the refused verdict leaked, or the valid finding beside it was dropped')
  if (!readJson(health).lastApply.rejected.some((x) => x.kind === 'verdict' && x.ref === '#3')) die('audit: lastApply does not name the refused verdict')
  void beforeHealth; void beforeFindings

  // `room update --counter` owns the deterministic half of unattended operation. The external
  // adapter writes the result; update regenerates the plan, refuses stale/missing output, applies
  // it per active programme, then composes the briefing (#69).
  const updateManifest = readJson(manifest)
  updateManifest.staleAfterDays = 7
  updateManifest.programs[0].auditPlan = plan
  updateManifest.programs[0].counterResults = counter
  writeFileSync(manifest, JSON.stringify(updateManifest, null, 2) + '\n')
  r = run([...applyArgs, '--stale-after-days', '7', '--plan', plan]); if (r.status !== 0) die('audit update: fresh plan exit ' + r.status, r)
  const updateResult = stubAuditAgent(readJson(plan))
  const updateContradiction = updateResult.results.find((entry) => entry.claimId === 'health:1')
  updateContradiction.verdict = 'contradicted'; updateContradiction.reason = 'Update pipeline found a contradiction.'
  writeFileSync(counter, JSON.stringify(updateResult, null, 2) + '\n')
  const updatedRoom = join(repo, 'updated-room.html')
  r = run(['room', 'update', '--manifest', manifest, '--out', updatedRoom, '--skip-verify', '--counter'])
  if (r.status !== 0) die('audit update: counter-verification exit ' + r.status, r)
  if (readJson(plan).staleAfterDays !== 7) die('audit update: counter plan ignored manifest.staleAfterDays')
  if (readJson(health).verdicts.find((v) => v.n === 1).why !== updateContradiction.reason) die('audit update: counter result did not reach health before composition')
  if (!readFileSync(updatedRoom, 'utf-8').includes(updateContradiction.reason)) die('audit update: recomposed briefing does not surface the contradiction')
  const beforeMissingResult = readFileSync(health, 'utf-8')
  renameSync(counter, counter + '.away')
  r = run(['room', 'update', '--manifest', manifest, '--out', updatedRoom, '--skip-verify', '--counter'])
  renameSync(counter + '.away', counter)
  if (r.status === 0 || !/counter result missing/.test(r.stderr || '')) die('audit update: missing counter result did not fail loud', r)
  if (readFileSync(health, 'utf-8') !== beforeMissingResult) die('audit update: missing result changed health')
  console.log('  ok audit — deterministic offline plan; item-by-item apply that names every refusal in lastApply; findings and keyed signal/milestone evidence expire')
}

// Frontmatter is the one document lifecycle source. Superseded UI names and duplicate inline
// statuses are archaeology, not current contracts (#58).
{
  const findings = readFileSync(join(HERE, '..', 'lib/schema/c4-findings.schema.json'), 'utf-8')
  const adr = readFileSync(join(HERE, '..', 'docs/adr/0004-control-room-as-a-forma-rendering.md'), 'utf-8')
  const scope = readFileSync(join(HERE, '..', 'docs/SCOPE-room.md'), 'utf-8')
  if (/\bseg\b|superseded/i.test(findings)) die('doc-prune: findings schema still carries a rejected UI shape')
  if (/^[- ]*\*\*Status:\*\*/m.test(adr)) die('doc-prune: ADR-0004 duplicates its frontmatter status in the body')
  if (/^Status:\s*\*\*open\*\*/m.test(scope)) die('doc-prune: SCOPE-room duplicates a stale open status in the body')
  if (!/### Success metric[\s\S]*room update[\s\S]*1:1[\s\S]*room-presentable[\s\S]*forma check/.test(scope)) die('success-metric: SCOPE-room has no checkable reconciliation condition')
  if (/Parametricity across repos is not proven|A second target repo proving/.test(scope)) die('success-metric: SCOPE-room still calls the completed portfolio proof future work')
  console.log('  ok doc-prune — schemas and governance docs carry only the current shape')
}

// One committer is the solo tier. Governance may keep the external standard as a reference, but
// required CI and its enforcement prose must not claim the retired enterprise/private gate (#60).
{
  const profile = readFileSync(join(HERE, '..', 'standards/doc-profile'), 'utf-8')
  const governance = readFileSync(join(HERE, '..', 'docs/GOVERNANCE.md'), 'utf-8')
  const agents = readFileSync(join(HERE, '..', 'AGENTS.md'), 'utf-8')
  const decisions = readFileSync(join(HERE, '..', 'DECISION_REGISTRY.md'), 'utf-8')
  if (!/^tier_floor:\s*solo$/m.test(profile)) die('governance-solo: standards/doc-profile is not pinned to solo')
  if (/enterprise column|documentation gates.*blocks|docs-gate.*CI/i.test(governance)) die('governance-solo: GOVERNANCE still claims enterprise/private CI grading')
  if (/engines that grade them live in `arbiter` and run in the `docs` CI job/.test(agents)) die('governance-solo: AGENTS still requires the removed private CI job')
  if (!/\| D-03 \| Documentation is graded on the \*\*solo\*\*/.test(decisions) || /docs-gate.*CI job/.test(decisions)) die('governance-solo: D-03 does not describe its actual solo enforcement')
  console.log('  ok governance-solo — policy, profile and CI all describe the solo tier')
}

console.log('OK — mini, flat-python, data-noise, virgin-kebab, go-nested, go-grouped, context-seed, two-stack, attach-doc, enrich, scaffold, status-overlay, status-apply, component-hash, verify, layout-hints, viewer, schema, timeline, docmap, declaration, presentable, room, rtm, views, scan, serve, markdown, strings, rtm-dogfood all green.')
