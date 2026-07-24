#!/usr/bin/env node
// Fixture tests: init → gen → check across fixtures, plus §1a/§2/§1b/§7/§3. Deterministic, no deps.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// 4) §1b attach-mode + check freshness, end-to-end on a copy of the self-repo
{
  const repo = join(tmp, 'selfrepo')
  cpSync(join(HERE, '..'), repo, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) })
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
  // holes are leaves and components — containers are described by the topology, not by an enricher
  const holeIds = readJson(model).nodes.filter((n) => n.descSource === 'fallback' && (n.kind === 'leaf' || n.kind === 'component')).map((n) => n.id).sort()
  if (JSON.stringify(plan.entries.map((e) => e.id).sort()) !== JSON.stringify(holeIds)) die('WP-A6: plan entries do not match the model holes')
  if (!plan.entries.every((e) => e.prompt && e.descInputHash)) die('WP-A6: plan entry missing prompt/descInputHash')
  if (!plan.entries.some((e) => /Read the file at .+ if you need certainty\./.test(e.prompt))) die('WP-A6: the agent prompt never offers the source path (that is the point of agent mode)')
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
  console.log('  ok layout-hints — WP-A4 topology → meta.layout verbatim; pinned coords honoured, unhinted nodes placed clear of them')
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
  // every UI string must exist in BOTH locales (repo rule: en is default, it must keep up)
  const lit = (html.match(/\nvar STRINGS=\{[\s\S]*?\n\};/) || [])[0]
  if (!lit) die('viewer: STRINGS literal not found')
  const S = new Function(lit.replace(/;$/, '') + '; return STRINGS')()
  const missing = Object.keys(S.en).filter((k) => !(k in S.it))
  if (missing.length) die('viewer i18n: keys missing from `it`: ' + missing.join(', '))
  if (!/labels:/.test(lit)) die('viewer i18n: the LABELS toggle string is not in STRINGS')
  console.log(`  ok viewer — edge label anchored on the curve; i18n parity (${Object.keys(S.en).length} keys, en/it)`)
}

console.log('OK — mini, flat-python, data-noise, attach-doc, enrich, scaffold, status-overlay, verify, layout-hints, viewer all green.')
