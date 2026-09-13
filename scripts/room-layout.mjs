#!/usr/bin/env node
// Browser acceptance for D10. Routes come from the composed artifact, not a copied route list.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const profile = mkdtempSync(resolve(tmpdir(), 'forma-room-layout-'))
const chrome = process.env.CHROME || 'google-chrome'
const browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let socket
let nextId = 1
const pending = new Map()
let browserExit = null, browserError = null, browserStderr = ''
browser.once('exit', (code, signal) => { browserExit = `exit ${code == null ? 'null' : code}${signal ? ` (${signal})` : ''}` })
browser.once('error', (error) => { browserError = error.message })
browser.stderr.on('data', (chunk) => { browserStderr = (browserStderr + chunk).slice(-4096) })
const started = Date.now()
const startup = { executable: chrome, pid: browser.pid || null, startedAt: new Date(started).toISOString(), timeoutMs: 30000 }
const result = { mode: negative ? 'negative' : 'acceptance', chrome: null, startup, routes: [], failures: [] }

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
  for (let i = 0; i < startup.timeoutMs / 50; i++) {
    if (browserError || browserExit) break
    try {
      const portFile = join(profile, 'DevToolsActivePort')
      if (!existsSync(portFile)) { await sleep(50); continue }
      const port = Number(readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0])
      if (!Number.isInteger(port) || port < 1) throw new Error(`invalid DevToolsActivePort ${JSON.stringify(String(port))}`)
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        startup.port = port
        startup.readyAt = new Date().toISOString()
        startup.elapsedMs = Date.now() - started
        return { ...(await response.json()), port }
      }
    } catch {}
    await sleep(50)
  }
  const detail = [browserError, browserExit, browserStderr.trim()].filter(Boolean).join('; ')
  throw new Error(`Chrome CDP did not become ready${detail ? `: ${detail}` : ''}`)
}

try {
  const info = await version()
  result.chrome = info.Browser
  const target = await (await fetch(`http://127.0.0.1:${info.port}/json/new?about:blank`, { method: 'PUT' })).json()
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
  // 1440x900 added for #120 AC5: the reported panel-overlap and label-clip defects were found on a
  // 1440-wide screenshot and are narrower-gutter-dependent (they did not reproduce as clearly at
  // the wider two).
  for (const [width, height] of [[3440, 1440], [1920, 900], [1440, 900]]) {
    for (const route of routes) {
      await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await command('Page.navigate', { url: `file://${instrumented}?layout=${width}x${height}#` + route })
      await ready()
      if (negative) await evaluate('document.documentElement.style.minHeight=(innerHeight+1)+"px"')
      const measured = await evaluate(`(function(){var route=${JSON.stringify(route)},active=(route==='/'||route==='/options')?document.querySelector('#nav-programs a[href="#'+route+'"][aria-current="true"]'):document.querySelector('#nav-views a[aria-current="page"]');return {innerHeight:innerHeight,scrollHeight:document.documentElement.scrollHeight,activeRoute:active&&active.getAttribute('href').slice(1)};})()`)
      const overflow = measured.scrollHeight > measured.innerHeight
      // #120 AC5: two classes of defect a scrollHeight/route assertion cannot see, both found only
      // by a screenshot — a panel whose own row track did not grow to its content painting over the
      // sibling panel below it (z-overlap), and a right-anchored SVG label whose truncation budget
      // still rendered wider than its gutter, clipping the leftmost glyph off-canvas. Both are
      // geometry, not markup, so this stays a browser check rather than a static one.
      const visual = await evaluate(`(function(){
        // A panel inside an overflow:auto tier (.answer, .evidence) can be laid out well past its
        // own tier's visible box without ever being painted there — the tier clips it. Comparing
        // raw getBoundingClientRect() across tiers flags that as a false "overlap"; intersect each
        // panel's box with every overflow-constrained ancestor first, so only the portion a user
        // could actually see is compared.
        function visibleRect(el){
          var r=el.getBoundingClientRect(),vt=r.top,vb=r.bottom,vl=r.left,vr=r.right,node=el.parentElement;
          while(node){
            var cs=getComputedStyle(node);
            if(/(auto|hidden|scroll)/.test(cs.overflowX)||/(auto|hidden|scroll)/.test(cs.overflowY)){
              var cr=node.getBoundingClientRect();
              vt=Math.max(vt,cr.top);vb=Math.min(vb,cr.bottom);vl=Math.max(vl,cr.left);vr=Math.min(vr,cr.right);
            }
            node=node.parentElement;
          }
          return {top:vt,bottom:vb,left:vl,right:vr,visible:vb>vt+0.5&&vr>vl+0.5};
        }
        var rects=Array.from(document.querySelectorAll('.panel')).map(visibleRect);
        var overlaps=[];
        for(var i=0;i<rects.length;i++)for(var j=i+1;j<rects.length;j++){
          var a=rects[i],b=rects[j];
          if(!a.visible||!b.visible)continue;
          if(a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5)overlaps.push(i+'-'+j);
        }
        // Left-clip: compare a leaf text node's own rect against its nearest containing .panel.
        // Tolerance is 2px, not 0 — an SVG glyph's ink can render slightly past its own advance
        // width (font hinting/antialiasing), a ~1.3px artefact confirmed present on both sides of
        // this fix and on unrelated labels; the reported defect (a truncation budget that let a
        // milestone name render wider than its own gutter) measured ~2.9-3px, comfortably above
        // that floor.
        var clipped=[];
        document.querySelectorAll('.panel *').forEach(function(node){
          if(node.tagName==='TITLE')return;
          var text=(node.textContent||'').trim();
          if(!text||(node.querySelector&&node.querySelector('*')))return;
          var panel=node.closest('.panel');if(!panel)return;
          var pr=panel.getBoundingClientRect(),r=node.getBoundingClientRect();
          if(r.width===0||r.height===0)return;
          if(pr.left-r.left>2)clipped.push(text.slice(0,40));
        });
        return {overlapCount:overlaps.length,overlaps:overlaps.slice(0,5),clippedCount:clipped.length,clipped:clipped.slice(0,5)};
      })()`)
      // #120 AC5 (density P2): a clip-aware count of `.issue-pill`/`.queue-command` actually
      // visible above the fold on the plan lens (the queue's one home, I20) — recorded as data on
      // every route/width for audit, but only GATED at 1440x900 on the plan route, and only on
      // "at least one command reaches the first screen" (the half of P2 this fix can hold without
      // starving every other panel below the queue). `.evidence>.panel`'s 180px-per-panel floor
      // means ≥20 pills is not reachable by a queue cap alone — that is an evidence-tier density
      // decision, not a layout-floor regression, so it is not gated here (see HANDOFF.md).
      const density = /\/plan$/.test(route) ? await evaluate(`(function(){
        function visibleRect(el){
          var r=el.getBoundingClientRect(),vt=r.top,vb=r.bottom,vl=r.left,vr=r.right,node=el.parentElement;
          while(node){
            var cs=getComputedStyle(node);
            if(/(auto|hidden|scroll)/.test(cs.overflowY)||/(auto|hidden|scroll)/.test(cs.overflowX)){
              var cr=node.getBoundingClientRect();
              vt=Math.max(vt,cr.top);vb=Math.min(vb,cr.bottom);vl=Math.max(vl,cr.left);vr=Math.min(vr,cr.right);
            }
            node=node.parentElement;
          }
          return {top:vt,bottom:vb,left:vl,right:vr};
        }
        function aboveFold(sel){
          return Array.from(document.querySelectorAll(sel)).filter(function(el){
            var r=visibleRect(el);
            return r.bottom>r.top+0.5&&r.right>r.left+0.5&&r.top>=0&&r.top<innerHeight;
          }).length;
        }
        return {pillsAboveFold:aboveFold('.issue-pill'),commandsAboveFold:aboveFold('.queue-command')};
      })()`) : null
      result.routes.push({ route, width, height, ...measured, overflow, panelOverlapCount: visual.overlapCount, leftClippedCount: visual.clippedCount, ...(density ? { pillsAboveFold: density.pillsAboveFold, commandsAboveFold: density.commandsAboveFold } : {}) })
      if (measured.activeRoute !== route) result.failures.push(`${route} at ${width}x${height}: rendered ${measured.activeRoute || 'no active route'}`)
      if (negative ? !overflow : overflow) result.failures.push(`${route} at ${width}x${height}: scrollHeight ${measured.scrollHeight}, innerHeight ${measured.innerHeight}`)
      if (visual.overlapCount) result.failures.push(`${route} at ${width}x${height}: ${visual.overlapCount} panel(s) overlap a sibling panel's rect (${visual.overlaps.join(', ')})`)
      if (visual.clippedCount) result.failures.push(`${route} at ${width}x${height}: ${visual.clippedCount} element(s) clipped at their panel's left edge (${JSON.stringify(visual.clipped)})`)
      if (density && width === 1440 && height === 900 && density.commandsAboveFold < 1) result.failures.push(`${route} at ${width}x${height}: 0 .queue-command visible above the fold (density P2's command half)`)
  }
  }
} catch (error) {
  startup.error = error.message || String(error)
  if (browserError) startup.browserError = browserError
  if (browserExit) startup.browserExit = browserExit
  if (browserStderr.trim()) startup.stderr = browserStderr.trim()
  result.failures.push(`harness: ${error.message || error}`)
} finally {
  if (socket) socket.close()
  try { process.kill(-browser.pid, 'SIGTERM') } catch {}
  await Promise.race([once(browser, 'close'), sleep(500)])
  rmSync(profile, { recursive: true, force: true })
}
console.log(JSON.stringify(result, null, 2))
process.exit(negative ? (result.failures.length ? 2 : 1) : (result.failures.length ? 1 : 0))
