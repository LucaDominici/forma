#!/usr/bin/env node
// prepack guard: refuse to publish if a stray/editor artifact lurks in shipped dirs.
import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const bad = []
;(function scan(d) { for (const e of readdirSync(d)) { const p = join(d, e); if (/\.fuse_hidden|~$|\.swp$/.test(e)) bad.push(p.replace(ROOT + '/', '')); else if (statSync(p).isDirectory()) scan(p) } })(join(ROOT, 'lib'))
if (bad.length) { console.error('prepack: stray artifacts in shipped files:\n - ' + bad.join('\n - ')); process.exit(1) }
console.error('prepack: shipped dirs clean')
