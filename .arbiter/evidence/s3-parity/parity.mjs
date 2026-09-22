#!/usr/bin/env node
// One-off parity harness for #140 slice S3 (group A). NOT a permanent script — lives in evidence/,
// not scripts/. Compares `check --room` and `room` behavior between origin/main (fab0539, checked
// out read-only at ./baseline-checkout) and this branch's HEAD, across an input-corruption matrix
// built on test/fixtures/room. Composition happens ONCE with the baseline `forma room`, so both
// columns' `check --room` runs are graded against the identical artifact — isolating the comparison
// to check behavior, not composition drift.
//
// Usage: node .arbiter/evidence/s3-parity/parity.mjs
// Exit: 0 if every cell is `same` or `stricter`, 1 if any cell is `REGRESSION`.
import { existsSync, mkdtempSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRANCH_ROOT = join(HERE, '..', '..', '..') // worktree root
const BASELINE_ROOT = join(HERE, 'baseline-checkout')
if (!existsSync(BASELINE_ROOT)) {
  console.error('missing baseline checkout at ' + BASELINE_ROOT + ' — run: git worktree add --detach ' + BASELINE_ROOT + ' fab0539')
  process.exit(2)
}

const WORK = mkdtempSync(join(tmpdir(), 'forma-s3-parity-'))
const R = join(WORK, 'room'), alpha = join(R, 'alpha'), beta = join(R, 'beta')
cpSync(join(BRANCH_ROOT, 'test/fixtures/room'), R, { recursive: true })

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf-8', ...opts })
const git = (repo, args, date) => {
  const r = sh('git', ['-C', repo, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  if (r.status !== 0) { console.error('fixture git failed: ' + args.join(' ') + '\n' + r.stdout + r.stderr); process.exit(2) }
}
const born = (repo) => {
  git(repo, ['init', '-q', '.'], '2026-01-01T00:00:00')
  git(repo, ['config', 'user.email', 'test@example.invalid'], '2026-01-01T00:00:00')
  git(repo, ['config', 'user.name', 'Forma Test'], '2026-01-01T00:00:00')
}
const commit = (repo, message, date) => { git(repo, ['add', '-A'], date); git(repo, ['commit', '-q', '-m', message], date) }
born(alpha); commit(alpha, 'chore: scaffold', '2026-06-15T10:00:00')
born(beta); commit(beta, 'feat: beta (#5)', '2026-07-05T10:00:00')

const topo = join(alpha, 'topology.json'), model = join(alpha, 'model.json'), manifest = join(R, 'manifest.json')
const roomHtml = join(R, 'control-room.html')

// Compose with the BASELINE forma, once. Both columns' `check --room` runs grade the same artifact.
const baseForma = (args, opts) => sh('node', [join(BASELINE_ROOT, 'bin/forma.mjs'), ...args], opts)
const branchForma = (args, opts) => sh('node', [join(BRANCH_ROOT, 'bin/forma.mjs'), ...args], opts)

let r = baseForma(['init', '--repo', alpha, '--out', topo, '--force'])
if (r.status !== 0) { console.error('fixture init failed\n' + r.stdout + r.stderr); process.exit(2) }
r = baseForma(['gen', '--repo', alpha, '--topology', topo, '--out', model])
if (r.status !== 0) { console.error('fixture gen failed\n' + r.stdout + r.stderr); process.exit(2) }
r = baseForma(['room', '--manifest', manifest, '--out', roomHtml])
if (r.status !== 0) { console.error('fixture room compose failed\n' + r.stdout + r.stderr); process.exit(2) }

// ---- matrix machinery -------------------------------------------------------------------------
// Snapshot every manifest-declared input file for alpha so each cell can corrupt one and restore.
const ORIGINAL_MANIFEST = readFileSync(manifest, 'utf-8')
const baseManifestObj = JSON.parse(ORIGINAL_MANIFEST)
const alphaProgram = baseManifestObj.programs.find((p) => p.id === 'alpha')
const FIELD_PATH = {
  issues: join(R, alphaProgram.issues),
  model: join(R, alphaProgram.model),
  topology: join(R, alphaProgram.topology),
  health: join(R, alphaProgram.health),
  findings: join(R, alphaProgram.findings),
}
const ORIGINALS = {}
for (const [k, p] of Object.entries(FIELD_PATH)) ORIGINALS[k] = existsSync(p) ? readFileSync(p, 'utf-8') : null
const restore = () => { for (const [k, p] of Object.entries(FIELD_PATH)) if (ORIGINALS[k] !== null) writeFileSync(p, ORIGINALS[k]) }

const runCheck = (formaFn) => formaFn(['check', '--model', join(R, 'no-such-model.json'), '--room', roomHtml, '--manifest', manifest])
const runRoom = (formaFn, manifestPath = manifest) => formaFn(['room', '--manifest', manifestPath, '--out', join(WORK, 'never-' + Math.random().toString(36).slice(2) + '.html')])

const hasStack = (s) => /at [\w./: \\-]+\(.*:\d+:\d+\)/.test(s || '') && !/\[check-c4\]|\[forma room\]/.test((s || '').split('\n')[0])
const failLines = (s) => (s || '').split('\n').filter((l) => /FAIL:/.test(l))

function classify(base, branch) {
  // uncaught stack trace appearing where baseline had none, or vice versa turning worse
  const baseStack = hasStack(base.stderr), branchStack = hasStack(branch.stderr)
  if (branchStack && !baseStack) return 'REGRESSION (new uncaught stack)'
  if (base.status === 1 && branch.status === 0) return 'REGRESSION (exit flipped 1->0)'
  const baseFails = failLines(base.stderr || base.stdout)
  const branchFails = failLines(branch.stderr || branch.stdout)
  const lost = baseFails.filter((l) => !branchFails.includes(l))
  if (lost.length) return 'REGRESSION (lost message: ' + lost[0] + ')'
  if (base.status === branch.status && baseFails.length === branchFails.length && baseFails.every((l, i) => l === branchFails[i])) return 'same'
  return 'stricter'
}

const rows = []
function cell(name, mutate, kind /* 'check' | 'room' */) {
  restore()
  mutate()
  let baseResult, branchResult, verdict
  if (kind === 'check') {
    baseResult = runCheck(baseForma)
    branchResult = runCheck(branchForma)
  } else {
    baseResult = runRoom(baseForma)
    branchResult = runRoom(branchForma)
  }
  verdict = classify(baseResult, branchResult)
  rows.push({
    name, kind,
    baseExit: baseResult.status, branchExit: branchResult.status,
    baseFirstErr: (baseResult.stderr || '').split('\n').find(Boolean) || '',
    branchFirstErr: (branchResult.stderr || '').split('\n').find(Boolean) || '',
    verdict,
  })
  restore()
}

const FIELDS = ['issues', 'model', 'health', 'findings']
const CORRUPTIONS = {
  missing: (p) => { spawnSync('rm', ['-f', p]) },
  'falsy-null': (p) => writeFileSync(p, 'null'),
  'falsy-false': (p) => writeFileSync(p, 'false'),
  'falsy-zero': (p) => writeFileSync(p, '0'),
  'falsy-emptystring': (p) => writeFileSync(p, '""'),
  'truthy-number': (p) => writeFileSync(p, '1'),
  'truthy-string': (p) => writeFileSync(p, '"x"'),
  'truthy-bool': (p) => writeFileSync(p, 'true'),
  'truthy-array': (p) => writeFileSync(p, '[]'),
  'invalid-json': (p) => writeFileSync(p, '{not json'),
  'schema-invalid-object': (p) => writeFileSync(p, JSON.stringify({ _bogus: true })),
}

for (const field of FIELDS) {
  for (const [ckind, mutate] of Object.entries(CORRUPTIONS)) {
    for (const kind of ['check', 'room']) {
      cell(`${field} / ${ckind}`, () => mutate(FIELD_PATH[field]), kind)
    }
  }
}

// truncated: true (issues field)
cell('issues / truncated:true', () => {
  const snap = JSON.parse(ORIGINALS.issues)
  snap.truncated = true
  writeFileSync(FIELD_PATH.issues, JSON.stringify(snap))
}, 'check')
cell('issues / truncated:true', () => {
  const snap = JSON.parse(ORIGINALS.issues)
  snap.truncated = true
  writeFileSync(FIELD_PATH.issues, JSON.stringify(snap))
}, 'room')

// model-without-topology
cell('model-without-topology', () => { spawnSync('rm', ['-f', FIELD_PATH.topology]) }, 'check')
cell('model-without-topology', () => { spawnSync('rm', ['-f', FIELD_PATH.topology]) }, 'room')

// manifest mismatch: change alpha's declared ghRepo so it disagrees with the issue snapshot
function withManifest(mutateManifestObj, kind) {
  restore()
  const mf = JSON.parse(ORIGINAL_MANIFEST)
  mutateManifestObj(mf)
  const mpath = join(WORK, 'manifest-mismatch.json')
  writeFileSync(mpath, JSON.stringify(mf, null, 2))
  let baseResult, branchResult
  if (kind === 'check') {
    baseResult = baseForma(['check', '--model', join(R, 'no-such-model.json'), '--room', roomHtml, '--manifest', mpath])
    branchResult = branchForma(['check', '--model', join(R, 'no-such-model.json'), '--room', roomHtml, '--manifest', mpath])
  } else {
    baseResult = runRoom(baseForma, mpath)
    branchResult = runRoom(branchForma, mpath)
  }
  const verdict = classify(baseResult, branchResult)
  rows.push({ name: 'manifest-mismatch (ghRepo)', kind, baseExit: baseResult.status, branchExit: branchResult.status, baseFirstErr: (baseResult.stderr || '').split('\n').find(Boolean) || '', branchFirstErr: (branchResult.stderr || '').split('\n').find(Boolean) || '', verdict })
  restore()
}
withManifest((mf) => { mf.programs.find((p) => p.id === 'alpha').ghRepo = 'acme/not-alpha' }, 'check')
withManifest((mf) => { mf.programs.find((p) => p.id === 'alpha').ghRepo = 'acme/not-alpha' }, 'room')

// --staged-inputs cell: stage a corrupt health file for alpha, only meaningful for `room` (check
// has no --staged-inputs flag). Check whether the error message names inputs.* vs paths.* — that's
// informational, not a REGRESSION trigger by itself.
{
  restore()
  const stagedHealth = join(WORK, 'staged-bad-health.json')
  writeFileSync(stagedHealth, 'not json')
  const stagedManifest = join(WORK, 'staged.json')
  writeFileSync(stagedManifest, JSON.stringify({ alpha: { health: stagedHealth } }))
  const baseResult = baseForma(['room', '--manifest', manifest, '--out', join(WORK, 'staged-base.html'), '--staged-inputs', stagedManifest])
  const branchResult = branchForma(['room', '--manifest', manifest, '--out', join(WORK, 'staged-branch.html'), '--staged-inputs', stagedManifest])
  const verdict = classify(baseResult, branchResult)
  const baseErr = (baseResult.stderr || '').split('\n').find(Boolean) || ''
  const branchErr = (branchResult.stderr || '').split('\n').find(Boolean) || ''
  const pathWordingChanged = /inputs\./.test(baseErr) !== /inputs\./.test(branchErr) || /paths\./.test(baseErr) !== /paths\./.test(branchErr)
  rows.push({ name: '--staged-inputs (corrupt health, invalid json)', kind: 'room', baseExit: baseResult.status, branchExit: branchResult.status, baseFirstErr: baseErr, branchFirstErr: branchErr, verdict, note: pathWordingChanged ? 'path wording in message differs (informational)' : '' })
  restore()
}

// ---- report -------------------------------------------------------------------------------------
const lines = []
lines.push('# S3 parity harness result')
lines.push('generated ' + new Date().toISOString())
lines.push('')
lines.push('| cell | kind | base exit | branch exit | verdict |')
lines.push('|---|---|---|---|---|')
let regressions = 0
for (const row of rows) {
  if (/REGRESSION/.test(row.verdict)) regressions += 1
  lines.push(`| ${row.name} | ${row.kind} | ${row.baseExit} | ${row.branchExit} | ${row.verdict} |`)
}
lines.push('')
lines.push('## Details (first stderr line per column, only where verdict != same)')
for (const row of rows) {
  if (row.verdict === 'same') continue
  lines.push(`- ${row.name} [${row.kind}] :: ${row.verdict}`)
  lines.push(`  base:   ${row.baseFirstErr}`)
  lines.push(`  branch: ${row.branchFirstErr}`)
  if (row.note) lines.push(`  note:   ${row.note}`)
}
lines.push('')
lines.push(`Total cells: ${rows.length}, REGRESSION: ${regressions}`)
const out = lines.join('\n') + '\n'
console.log(out)
mkdirSync(HERE, { recursive: true })
writeFileSync(join(HERE, 'result.txt'), out)

if (regressions > 0) { console.error(`\n${regressions} REGRESSION cell(s) — see .arbiter/evidence/s3-parity/result.txt`); process.exit(1) }
console.log('\nzero REGRESSION cells.')
