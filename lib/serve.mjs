#!/usr/bin/env node
// forma serve — tiny static server for the interactive viewer + model. Local dev only.
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }
const REPO = arg('--repo', process.cwd())
const PORT = parseInt(arg('--port', '4173'), 10)
const HERE = dirname(fileURLToPath(import.meta.url))
const dir = resolve(REPO, 'docs/architecture')
const viewerFallback = join(HERE, 'viewer', 'c4-hologram.html')
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0])
  if (p === '/' || p === '') p = '/c4-viewer.html'
  // resolve within dir and refuse anything that escapes it (no path traversal)
  const file = resolve(dir, '.' + p)
  if (file !== dir && !file.startsWith(dir + sep)) { res.writeHead(403); return res.end('forbidden') }
  let target = file
  if (p === '/c4-viewer.html' && !existsSync(target)) target = viewerFallback
  if (!existsSync(target)) { res.writeHead(404); return res.end('not found: ' + p) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream' })
  res.end(readFileSync(target))
}).listen(PORT, () => console.log(`[forma] serving ${dir} → http://localhost:${PORT}/  (model: /c4-model.json)`))
