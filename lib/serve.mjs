#!/usr/bin/env node
// forma serve — tiny static server for the interactive viewer + model. Local dev only.
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// F12: reject an unknown flag instead of silently ignoring it. parseArgs is the ONLY reader of
// process.argv below, so `--key=value` is honoured too.
let values
try {
  ({ values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true, options: {
    repo: { type: 'string' }, port: { type: 'string' },
  } }))
} catch (e) { console.error(`[forma serve] ${e.message}`); process.exit(1) }
const REPO = values.repo || process.cwd()
const PORT = parseInt(values.port ?? '4173', 10)
const HERE = dirname(fileURLToPath(import.meta.url))
const dir = resolve(REPO, 'docs/architecture')
const viewerFallback = join(HERE, 'viewer', 'c4-hologram.html')
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

const server = createServer((req, res) => {
  let p
  try { p = decodeURIComponent((req.url || '/').split('?')[0]) } catch (e) { res.writeHead(400); return res.end('bad request: ' + ((e && e.message) || e)) }
  if (p === '/' || p === '') p = '/c4-viewer.html'
  // resolve within dir and refuse anything that escapes it (no path traversal)
  const file = resolve(dir, '.' + p)
  if (file !== dir && !file.startsWith(dir + sep)) { res.writeHead(403); return res.end('forbidden') }
  let target = file
  if (p === '/c4-viewer.html' && !existsSync(target)) target = viewerFallback
  if (!existsSync(target)) { res.writeHead(404); return res.end('not found: ' + p) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream' })
  res.end(readFileSync(target))
})
server.listen(PORT, '127.0.0.1', () => {
  // Report the ACTUAL bound address/port, not a hardcoded string: if `listen(PORT, '127.0.0.1', …)`
  // ever regresses back to `listen(PORT, …)`, the printed host must say so (0.0.0.0/::), not lie by
  // repeating "127.0.0.1" from a literal. --port 0 is how a test asks the OS for a free port.
  const a = server.address()
  console.log(`[forma] serving ${dir} → http://${a.address}:${a.port}/  (model: /c4-model.json)`)
})
