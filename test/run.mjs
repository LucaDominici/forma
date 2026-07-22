#!/usr/bin/env node
// Fixture test: init → gen → check on a tiny repo. Deterministic, no deps.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'forma.mjs')
const REPO = join(HERE, 'fixtures', 'mini')
const tmp = mkdtempSync(join(tmpdir(), 'forma-test-'))
const topo = join(tmp, 'topo.json'), model = join(tmp, 'model.json')
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' })
const die = (m, r) => { console.error('FAIL: ' + m + (r ? '\n' + (r.stdout || '') + (r.stderr || '') : '')); process.exit(1) }

let r = run(['init', '--repo', REPO, '--out', topo, '--force'])
if (r.status !== 0) die('init exit ' + r.status, r)
r = run(['gen', '--repo', REPO, '--topology', topo, '--out', model])
if (r.status !== 0) die('gen exit ' + r.status, r)
r = run(['check', '--repo', REPO, '--model', model, '--topology', topo])
if (r.status !== 0) die('check exit ' + r.status, r)

const m = JSON.parse(readFileSync(model, 'utf-8'))
const containers = m.nodes.filter((n) => n.kind === 'container').length
const leaves = m.nodes.filter((n) => n.kind === 'leaf').length
const derived = m.edges.filter((e) => e.kind === 'import').length
if (containers < 2) die(`expected >=2 containers, got ${containers}`)
if (leaves < 3) die(`expected >=3 leaves, got ${leaves}`)
if (derived < 1) die(`expected >=1 derived edge (core→util), got ${derived}`)
console.log(`OK — init→gen→check green; ${containers} containers, ${leaves} leaves, ${derived} derived edge(s).`)
