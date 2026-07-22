#!/usr/bin/env node
// Cross-platform syntax check: node --check over bin + lib.
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = ['bin/forma.mjs', ...readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => 'lib/' + f), 'scripts/lint.mjs', 'test/run.mjs']
let bad = 0
for (const f of files) { try { execFileSync(process.execPath, ['--check', join(ROOT, f)]); } catch (e) { bad++; console.error('SYNTAX ERROR: ' + f + '\n' + (e.stderr || e.message)) } }
if (bad) { console.error(`lint: ${bad} file(s) failed`); process.exit(1) }
console.log(`lint OK — ${files.length} files`)
