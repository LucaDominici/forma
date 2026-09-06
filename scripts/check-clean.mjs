#!/usr/bin/env node
// prepack guard: refuse to publish if the reviewed runtime allowlist changes or carries residue.
import { readdirSync, lstatSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const expected = new Set(`LICENSE
NOTICE
README.md
bin/forma.mjs
lib/audit.mjs
lib/check.mjs
lib/cluster.mjs
lib/describe.mjs
lib/doc.mjs
lib/docmap.mjs
lib/enrich.mjs
lib/gen.mjs
lib/init.mjs
lib/lang.mjs
lib/lenses.mjs
lib/link.mjs
lib/render.mjs
lib/room.mjs
lib/roomderive.mjs
lib/roomdocs.mjs
lib/roominit.mjs
lib/roomload.mjs
lib/roomupdate.mjs
lib/rtm.mjs
lib/scan.mjs
lib/schema/c4-brief.schema.json
lib/schema/c4-findings.schema.json
lib/schema/c4-health.schema.json
lib/schema/c4-issues.schema.json
lib/schema/c4-model.schema.json
lib/schema/CONTRACT.json
lib/schema/forma.room.schema.json
lib/serve.mjs
lib/taxonomy.mjs
lib/validate.mjs
lib/verify.mjs
lib/viewer/c4-hologram.html
lib/viewer/control-room.html
lib/viewer/strings/en.json
lib/viewer/strings/it.json
package.json`.split('\n'))
const files = [], bad = []
for (const rel of ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'bin/forma.mjs']) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) continue
  const stat = lstatSync(p)
  if (stat.isSymbolicLink() || !stat.isFile()) bad.push(rel)
  else files.push(rel)
}
;(function scan(d) { for (const e of readdirSync(join(ROOT, d))) { const rel = `${d}/${e}`, p = join(ROOT, rel), stat = lstatSync(p); if (/\.fuse_hidden|~$|\.swp$/.test(e) || stat.isSymbolicLink()) bad.push(rel); else if (stat.isDirectory()) scan(rel); else files.push(rel) } })('lib')
if (bad.length) { console.error('prepack: stray artifacts in shipped files:\n - ' + bad.join('\n - ')); process.exit(1) }
const unexpected = files.filter((file) => !expected.has(file)).sort(), missing = [...expected].filter((file) => !files.includes(file)).sort()
if (unexpected.length || missing.length) {
  console.error('prepack: reviewed runtime allowlist changed' + (unexpected.length ? '\n unexpected:\n - ' + unexpected.join('\n - ') : '') + (missing.length ? '\n missing:\n - ' + missing.join('\n - ') : ''))
  process.exit(1)
}
console.error(`prepack: ${files.length} reviewed runtime files, clean`)
