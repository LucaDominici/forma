#!/usr/bin/env node
// Browser acceptance for D10. Routes come from the composed artifact, not a copied route list.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const room = process.argv[2]
const negative = process.argv[3] === '--negative'
if (!room || (process.argv[3] && !negative)) {
  console.error('usage: node scripts/room-layout.mjs <control-room.html> [--negative]')
  process.exit(2)
}

const port = 19000 + (process.pid % 1000)
const profile = mkdtempSync(resolve(tmpdir(), 'forma-room-layout-'))
const chrome = process.env.CHROME || 'google-chrome'
const browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', detached: true })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let socket
let nextId = 1
const pending = new Map()

const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
  const id = nextId++
  pending.set(id, { resolve: resolveCommand, reject: rejectCommand })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text || 'browser evaluation failed')
  return result.result.value
}
const ready = async () => {
  for (let i = 0; i < 80; i++) {
    if (await evaluate("document.readyState === 'complete' && document.querySelector('#nav-programs a')")) return
    await sleep(50)
  }
  throw new Error('briefing did not finish loading')
}
const version = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return response.json()
    } catch {}
    await sleep(50)
  }
  throw new Error('Chrome CDP did not become ready')
}

const result = { mode: negative ? 'negative' : 'acceptance', chrome: null, routes: [], failures: [] }
try {
  const info = await version()
  result.chrome = info.Browser
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener('open', resolveSocket, { once: true })
    socket.addEventListener('error', rejectSocket, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
  })
  await command('Page.enable')
  await command('Runtime.enable')
  const path = resolve(room)
  // The viewer keeps VIEWS private. Alias its real object in a disposable copy so this probe
  // still enumerates the canonical routes rather than the active programme's navigation links.
  const marker = 'var VIEWS={},VIEW_SPEC={},PRINT_FILL=[];'
  const source = readFileSync(path, 'utf8')
  if (!source.includes(marker)) throw new Error('briefing VIEWS seam not found')
  const instrumented = join(profile, 'room.html')
  writeFileSync(instrumented, source.replace(marker, 'var VIEWS=window.__LAYOUT_VIEWS__={},VIEW_SPEC={},PRINT_FILL=[];'))
  await command('Page.navigate', { url: `file://${instrumented}?layout=routes#/` })
  await ready()
  const routes = await evaluate('Object.keys(window.__LAYOUT_VIEWS__).sort()')
  if (!Array.isArray(routes) || !routes.length) throw new Error('the composed briefing exposed no routes')
  for (const [width, height] of [[3440, 1440], [1920, 900]]) {
    for (const route of routes) {
      await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await command('Page.navigate', { url: `file://${instrumented}?layout=${width}x${height}#` + route })
      await ready()
      if (negative) await evaluate('document.documentElement.style.minHeight=(innerHeight+1)+"px"')
      const measured = await evaluate(`(function(){var route=${JSON.stringify(route)},active=(route==='/'||route==='/options')?document.querySelector('#nav-programs a[href="#'+route+'"][aria-current="true"]'):document.querySelector('#nav-views a[aria-current="page"]');return {innerHeight:innerHeight,scrollHeight:document.documentElement.scrollHeight,activeRoute:active&&active.getAttribute('href').slice(1)};})()`)
      const overflow = measured.scrollHeight > measured.innerHeight
      result.routes.push({ route, width, height, ...measured, overflow })
      if (measured.activeRoute !== route) result.failures.push(`${route} at ${width}x${height}: rendered ${measured.activeRoute || 'no active route'}`)
      if (negative ? !overflow : overflow) result.failures.push(`${route} at ${width}x${height}: scrollHeight ${measured.scrollHeight}, innerHeight ${measured.innerHeight}`)
    }
  }
} catch (error) {
  result.failures.push(`harness: ${error.message || error}`)
} finally {
  if (socket) socket.close()
  try { process.kill(-browser.pid, 'SIGTERM') } catch {}
  await Promise.race([once(browser, 'close'), sleep(500)])
  rmSync(profile, { recursive: true, force: true })
}
console.log(JSON.stringify(result, null, 2))
process.exit(negative ? (result.failures.length ? 2 : 1) : (result.failures.length ? 1 : 0))
