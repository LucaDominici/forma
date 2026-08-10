#!/usr/bin/env node
// forma — present your architecture instead of slides.
// Thin CLI dispatcher over the lib/ engine. Every subcommand is a plain Node script, so any
// agent (or a human with no AI) drives the same contract. The engine is model-agnostic.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')
const cmd = process.argv[2]
const rest = process.argv.slice(3)

const MAP = { init: 'init.mjs', gen: 'gen.mjs', check: 'check.mjs', doc: 'doc.mjs', serve: 'serve.mjs', verify: 'verify.mjs', room: 'room.mjs' }

if (cmd === '-v' || cmd === '--version') {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf-8'))
  console.log(pkg.version); process.exit(0)
}
if (!cmd || cmd === '-h' || cmd === '--help' || !MAP[cmd]) {
  console.log(`forma — present your architecture instead of slides.

Usage: forma <command> [--repo <path>]

  init    seed docs/architecture/c4-topology.json from your source dirs (best-effort; then curate)
  gen     walk src/ leaves + derive container edges from real code → c4-model.json
  check   deterministic drift check — fails if the model no longer matches the code
  doc     project the arc42 scaffold (ARCHITECTURE.scaffold.md) from the model
  serve   open the live explorer at http://localhost:4173
  verify  refresh status from live GitHub issues via your gh CLI (the only networked command)
  room    compose the Control Room — model + overlays + gh snapshot -> one self-contained HTML
          (docs/SCOPE-room.md; needs \`forma verify\` and a forma.room.json manifest first)

The file contract is lib/schema/c4-model.schema.json. Enrichment (curate the topology, write the
arc42 prose) is model-agnostic — any agent edits the same JSON/Markdown.`)
  const unknown = cmd && cmd !== '-h' && cmd !== '--help' && !MAP[cmd]
  process.exit(unknown ? 1 : 0)
}

const r = spawnSync(process.execPath, [join(LIB, MAP[cmd]), ...rest], { stdio: 'inherit' })
process.exit(r.status == null ? 1 : r.status)
