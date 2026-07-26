#!/usr/bin/env node
// Fixture tests: init → gen → check across fixtures, plus §1a/§2/§1b/§7/§3. Deterministic, no deps.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, statSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateModel } from '../lib/validate.mjs'
import { indexByNode, statusFor } from '../lib/docmap.mjs'

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
  if (String(insideMoney[0].label) !== '1×') die('P2: a single contributing edge must keep its label verbatim, got ' + insideMoney[0].label)
  if (!screen(['cmd_app', 'internal_server', 'internal_worker']).length) die('P2: the platform screen lost its internal arrow')

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

// 3e) two-stack: a product that is Go AND TypeScript. `init` models ONE stack per run, and the defect
// was that it never said so — a Go + React monorepo came out as 53 Go packages with the application
// its users open missing and no line anywhere admitting it. The fixture puts *.go and *.ts/*.tsx in
// different directories; the assertions are what init SAYS about the stack it skipped, and whether
// what it says actually WORKS when pasted.
{
  const REPO = FIX('two-stack'), topo = join(tmp, '2s-topo.json'), model = join(tmp, '2s-model.json')
  let r = run(['init', '--repo', REPO, '--out', topo, '--force']); if (r.status !== 0) die('two-stack init exit ' + r.status, r)
  const t = readJson(topo), err = r.stderr || ''

  // S1 — the dominant stack is still the one seeded, alone (this is option B, deliberately)
  if (t.meta.stack !== 'Go') die('S1: expected Go as the dominant stack, got ' + t.meta.stack)
  const off = t.nodes.filter((n) => n.kind === 'container' && n.tech !== 'Go')
  if (off.length) die('S1: a non-Go container was seeded by default: ' + JSON.stringify(off.map((n) => n.name)))

  // S2 — no silent detection: the stack it walked past is named, and counted
  if (!/TypeScript/.test(err)) die('S2: init never mentioned the TypeScript sources it walked past:\n' + err)
  if (!/\b2 director/.test(err)) die('S2: the message does not count the directories it saw:\n' + err)

  // S3 — the entries to paste are exact, one per directory, and cover BOTH extensions of the
  // language: a `match` of `\.ts$` would model half a React app and call it done.
  const u = (t._unseeded || []).find((x) => x.stack === 'TypeScript')
  if (!u) die('S3: no _unseeded entry for TypeScript: ' + JSON.stringify(t._unseeded))
  if (u.nodes.length !== 2 || u.leafSources.length !== 2) die('S3: expected one node + one leafSource per TS dir, got ' + JSON.stringify(u))
  if (!new RegExp(u.match).test('view.tsx')) die('S3: the pasted match misses *.tsx: ' + u.match)
  if (t.nodes.some((n) => u.nodes.some((x) => x.id === n.id))) die('S3: an _unseeded id collides with a seeded one — pasting it would break `gen`')
  // S3b — a directory already seeded must never be offered again. The report keys on the dirs the
  // container pass did NOT reach, per language: keyed on "every language but the dominant one" it
  // handed a React repo back its own `src/ui` (seeded from *.tsx, offered again for *.ts), and
  // pasting that stacked a second container over a directory already in the model.
  const seededDirs = new Set(t.leafSources.map((s) => s.dir))
  for (const e of t._unseeded || []) {
    if (e.stack !== t.meta.stack) continue
    for (const s of e.leafSources) if (seededDirs.has(s.dir)) die(`S3b: ${s.dir} is offered as unseeded ${e.stack} but is already a seeded container`)
  }
  // S3c — a *.tsx-dominant repo must seed the *.ts half of the same language too, not report it
  const react = mkdtempSync(join(tmpdir(), 'forma-react-'))
  mkdirSync(join(react, 'src', 'ui'), { recursive: true })
  for (const f of ['a.tsx', 'b.tsx', 'c.tsx', 'helpers.ts', 'types.ts']) writeFileSync(join(react, 'src', 'ui', f), 'export const x = 1\n')
  const rTopo = join(tmp, 'react-topo.json'), rModel = join(tmp, 'react-model.json')
  r = run(['init', '--repo', react, '--out', rTopo, '--force']); if (r.status !== 0) die('S3c react init exit ' + r.status, r)
  const rt = readJson(rTopo)
  if ((rt._unseeded || []).length) die('S3c: the dominant language came back as an unseeded stack: ' + JSON.stringify(rt._unseeded))
  r = run(['gen', '--repo', react, '--topology', rTopo, '--out', rModel]); if (r.status !== 0) die('S3c react gen exit ' + r.status, r)
  const rl = readJson(rModel).nodes.filter((n) => n.kind === 'leaf').map((n) => n.name).sort()
  if (rl.length !== 5) die(`S3c: one match per LANGUAGE — expected all 5 *.ts/*.tsx files, got ${rl.length}: ${rl}`)

  // S4 — the one that decides whether option B was delivered: move the entries in, exactly as the
  // message instructs, and the model must build AND pass the gate. A printed entry that does not
  // work is a lie dressed as help.
  t.nodes.push(...u.nodes); t.leafSources.push(...u.leafSources)
  const pasted = join(tmp, '2s-topo-pasted.json')
  writeFileSync(pasted, JSON.stringify(t, null, 2))
  r = run(['gen', '--repo', REPO, '--topology', pasted, '--out', model]); if (r.status !== 0) die('S4: the pasted _unseeded entries do not gen', r)
  const m = readJson(model)
  if (!m.nodes.some((n) => n.kind === 'container' && n.tech === 'TypeScript')) die('S4: pasting _unseeded put no TypeScript container in the model')
  if (!m.nodes.some((n) => n.kind === 'leaf' && n.name === 'view')) die('S4: the *.tsx file never became a leaf — the match under-covers the language')
  r = run(['check', '--repo', REPO, '--model', model, '--topology', pasted]); if (r.status !== 0) die('S4: the gate rejects a model built from the pasted entries', r)
  console.log(`  ok two-stack — §34 Go seeded, TypeScript named (${u.files} files, ${u.leafSources.length} dirs) with entries that gen+check accept verbatim`)

}

// 4) §1b attach-mode + check freshness, end-to-end on a copy of the self-repo
{
  const repo = join(tmp, 'selfrepo')
  cpSync(join(HERE, '..'), repo, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) })
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
  const GH = process.execPath + ' ' + join(HERE, 'stub-gh.mjs')
  const openBefore = JSON.stringify(readJson(model).nodes.find((n) => n.id === c2.id))
  r = run(['verify', '--repo', repo, '--model', model, '--gh-repo', 'acme/thing', '--gh-cmd', GH])
  if (r.status !== 0) die('WP-A5: verify exit ' + r.status, r)
  let v = readJson(model)
  const done = v.nodes.find((n) => n.id === c1.id), open = v.nodes.find((n) => n.id === c2.id)
  if (!(done.status2 === 'done' && done.completion === 100)) die('WP-A5: node on a CLOSED issue not marked done')
  // the badge renders statusWord over completion, so a curated word must not outlive the verdict
  if (done.statusWord !== '100%') die('WP-A5: badge still reads "' + done.statusWord + '" on a node verified done')
  if (!/^Closed with evidence \(#7 CLOSED, gh .*\)\. Was in progress\.$/.test(done.current)) die('WP-A5: evidence prefix missing/malformed: ' + done.current)
  if (JSON.stringify(open) !== openBefore) die('WP-A5: node on an OPEN issue was modified: ' + JSON.stringify(open))
  if (!(v.meta.verifiedAt && v.meta.verifyMethod === 'gh live')) die('WP-A5: fact base not stamped')
  // structure is untouched and the gate is unaffected, before and after
  r = run(['check', '--repo', repo, '--model', model, '--topology', topo]); if (r.status !== 0) die('WP-A5: check must stay green after verify', r)
  // idempotent: a second run must not stack evidence prefixes
  r = run(['verify', '--repo', repo, '--model', model, '--gh-repo', 'acme/thing', '--gh-cmd', GH])
  if (r.status !== 0) die('WP-A5: second verify exit ' + r.status, r)
  v = readJson(model)
  if ((String(v.nodes.find((n) => n.id === c1.id).current).match(/Closed with evidence/g) || []).length !== 1) die('WP-A5: evidence prefix stacked on re-run')
  // gh missing → loud failure, model byte-identical
  const before = readFileSync(model, 'utf-8')
  r = run(['verify', '--repo', repo, '--model', model, '--gh-repo', 'acme/thing', '--gh-cmd', 'forma-no-such-gh-binary'])
  if (r.status === 0) die('WP-A5: a missing gh must fail loud')
  if (readFileSync(model, 'utf-8') !== before) die('WP-A5: model was modified despite the gh failure')
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
  console.log('  ok schema — a conforming model passes; a missing required field and an out-of-enum kind are both rejected by name')
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
  if (core.status2 !== 'unknown' || core.completion != null) die(`docmap: over-cap node got state ${core.status2}/${core.completion}`)

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

console.log('OK — mini, flat-python, data-noise, virgin-kebab, go-nested, go-grouped, context-seed, two-stack, attach-doc, enrich, scaffold, status-overlay, status-apply, component-hash, verify, layout-hints, viewer, schema, docmap, declaration, presentable all green.')
