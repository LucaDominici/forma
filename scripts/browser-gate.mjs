#!/usr/bin/env node
// Runtime publication gate. Browser tooling is installed only by CI and deliberately stays out of
// Forma's package/runtime graph. Locally: BROWSER_GATE_MODULES=/path/to/node_modules node ...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const modules = process.env.BROWSER_GATE_MODULES
if (!modules || !process.argv[2]) {
  console.error('usage: BROWSER_GATE_MODULES=<node_modules> node scripts/browser-gate.mjs <room.html> [...]')
  process.exit(2)
}
const { chromium } = await import(pathToFileURL(join(modules, 'playwright', 'index.mjs')).href)
const axeSource = readFileSync(join(modules, 'axe-core', 'axe.min.js'), 'utf8')
const rooms = process.argv.slice(2).map((file) => resolve(file))
const sizes = [
  { name: 'wide', width: 3440, height: 1440, axe: false },
  { name: 'desktop', width: 1920, height: 900, axe: true },
  { name: 'laptop', width: 1366, height: 768, axe: false },
  { name: 'mobile', width: 390, height: 844, axe: true },
]
const failures = []
const report = { rooms, viewports: sizes.map(({ name, width, height }) => ({ name, width, height })), routes: [], print: [] }
const fail = (where, message) => failures.push(`${where}: ${message}`)
const roomData = (file) => {
  const match = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(readFileSync(file, 'utf8'))
  if (!match) throw new Error(`${file}: window.__ROOM__ not found`)
  return JSON.parse(match[1])
}

const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_GATE_EXECUTABLE ? { executablePath: process.env.BROWSER_GATE_EXECUTABLE } : {}) })
for (const file of rooms) {
  const data = roomData(file)
  const routes = ['/', ...data.programs.flatMap((p) => ['exec', 'tech', 'map', 'wbs', 'docs'].map((v) => `/${p.id}/${v}`)), '/options']
  for (const size of sizes) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'en-US' })
    for (const route of routes) {
      const where = `${file} ${size.name} #${route}`
      const page = await context.newPage()
      page.on('console', (msg) => { if (msg.type() === 'error') fail(where, `console: ${msg.text()}`) })
      page.on('pageerror', (error) => fail(where, `page: ${error.message}`))
      await page.goto(`${pathToFileURL(file).href}#${route}`, { waitUntil: 'load' })
      await page.waitForFunction(() => document.querySelectorAll('section.view:not([hidden])').length === 1)
      const metrics = await page.evaluate(() => {
        const visible = document.querySelector('section.view:not([hidden])')
        const targets = [...document.querySelectorAll('a,button,select,summary,[role="button"],[role="img"][tabindex="0"]')].filter((el) => {
          const r = el.getBoundingClientRect(), s = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'
        }).map((el) => { const r = el.getBoundingClientRect(); return { name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) } })
        return {
          bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          issueLinks: visible.querySelectorAll('.issue-pill').length,
          smallTargets: targets.filter((t) => t.w < 44 || t.h < 44),
          pointerHits: [...document.querySelectorAll('.hit')].filter((el) => getComputedStyle(el).pointerEvents !== 'none').length,
          clippedProvenance: [...visible.querySelectorAll('.prov')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => ({ text: el.textContent.trim().slice(0, 80), width: el.clientWidth, scrollWidth: el.scrollWidth })),
        }
      })
      if (metrics.bodyWidth > metrics.viewportWidth) fail(where, `body overflows horizontally (${metrics.bodyWidth} > ${metrics.viewportWidth})`)
      if (size.name !== 'mobile' && metrics.bodyHeight > metrics.viewportHeight) fail(where, `body overflows vertically (${metrics.bodyHeight} > ${metrics.viewportHeight})`)
      if (metrics.issueLinks > 80) fail(where, `${metrics.issueLinks} issue links mounted; budget is 80`)
      if (metrics.smallTargets.length) fail(where, `targets below 44px: ${JSON.stringify(metrics.smallTargets.slice(0, 5))}`)
      if (metrics.pointerHits) fail(where, `${metrics.pointerHits} overlapping chart hit target(s) remain pointer-active; use the table control`)
      if (metrics.clippedProvenance.length) fail(where, `provenance clipped: ${JSON.stringify(metrics.clippedProvenance)}`)
      const claim = await page.evaluate((currentRoute) => {
        const actual = document.querySelector('section.view:not([hidden]) .thesis')
        const fmt = (s, values) => String(s || '').replace(/\{([^}]+)\}/g, (_, key) => values[key] == null ? '' : String(values[key]))
        const room = window.__ROOM__, strings = window.__STRINGS__.en
        let expectedState = null, expectedText = null, blockedKpi = null
        if (currentRoute === '/') {
          const t = room.portfolio.totals
          expectedState = t.open === 0 ? 'declared-zero' : t.unknownRule ? 'unknown' : Number(t.blocked) === 0 ? 'declared-zero' : 'measured'
          if (expectedState === 'unknown') expectedText = fmt(strings.thesisUnknown, { open: t.open, unknown: t.unknownRule, programs: t.programs })
        } else {
          const match = /^\/([^/]+)\/(exec|tech|wbs)$/.exec(currentRoute)
          if (match) {
            const summary = room.portfolio.programs.find((p) => p.id === match[1]), program = room.programs.find((p) => p.id === match[1])
            if (match[2] === 'wbs') expectedState = !program.derived.rtm ? null : program.derived.rtm.coverage.pct == null ? 'unknown' : program.derived.rtm.coverage.accounted === 0 ? 'declared-zero' : 'measured'
            else {
              expectedState = !summary.blockedRule.declared ? 'unknown' : Number(summary.blocked) === 0 ? 'declared-zero' : 'measured'
              if (expectedState === 'unknown') expectedText = match[2] === 'exec' ? fmt(strings.execHeadlineUnknown, { open: summary.open }) : strings.techHeadlineUnknown
              const kpis = document.querySelectorAll('section.view:not([hidden]) .kpi')
              blockedKpi = match[2] === 'exec' ? kpis[1] && kpis[1].getAttribute('data-claim-state') : kpis[4] && kpis[4].getAttribute('data-claim-state')
            }
          }
        }
        return { expectedState, expectedText, actualState: actual && actual.getAttribute('data-claim-state'), actualText: actual && actual.textContent, blockedKpi }
      }, route)
      if (claim.expectedState && (claim.actualState !== claim.expectedState || (claim.expectedText && claim.actualText !== claim.expectedText) || ((route.endsWith('/exec') || route.endsWith('/tech')) && claim.blockedKpi !== claim.expectedState))) fail(where, `claim-state mismatch: ${JSON.stringify(claim)}`)
      report.routes.push({ room: basename(file), viewport: size.name, route, body: [metrics.bodyWidth, metrics.bodyHeight], issueLinks: metrics.issueLinks, smallTargets: metrics.smallTargets.length, clippedProvenance: metrics.clippedProvenance.length, claim })
      if (size.name === 'mobile' && route === '/') {
        const skip = page.locator('#skip')
        await skip.focus(); await skip.press('Enter')
        if (await page.evaluate(() => document.activeElement && document.activeElement.id) !== 'content') fail(where, 'skip control did not move focus to the briefing')
      }
      const mapTable = route.endsWith('/map') ? page.locator('details.map-table') : null
      if (mapTable && await mapTable.count()) {
        const summary = mapTable.locator('summary')
        await summary.focus(); await summary.press('Space')
        await mapTable.locator('.kv').first().waitFor({ state: 'visible' })
        const rows = await mapTable.locator('.kv').count()
        if (!(await mapTable.evaluate((el) => el.open)) || !rows || rows > 40) fail(where, `map table keyboard/budget failure (${rows} mounted rows)`)
      }
      if (size.axe) {
        await page.addScriptTag({ content: axeSource })
        const violations = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations)
        if (violations.length) fail(where, `Axe: ${violations.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`)
      }
      const frameElement = route.endsWith('/map') ? await page.$('iframe.frame') : null
      if (frameElement) {
        const frame = await frameElement.contentFrame()
        await frame.waitForSelector('.nd[role="button"]')
        const frameTargets = await frame.evaluate(() => {
          const small = [...document.querySelectorAll('a,button,input,select,[role="button"],[role="img"][tabindex="0"]:not(.edgehit)')].filter((el) => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el)
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && (r.width < 44 || r.height < 44)
          }).map((el) => { const r = el.getBoundingClientRect(); return { name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) } })
          const narrowEdges = [...document.querySelectorAll('.edgehit[tabindex="0"]')].filter((el) => {
            const s = getComputedStyle(el)
            return parseFloat(s.strokeWidth) < 44 || s.strokeLinecap !== 'round'
          }).length
          return { small, narrowEdges }
        })
        if (frameTargets.small.length || frameTargets.narrowEdges) fail(`${where} frame`, `targets below 44px: ${JSON.stringify(frameTargets)}`)
        const detailNode = frame.locator('.nd[role="button"]:not(.drill)').first()
        if (await detailNode.count()) {
          await detailNode.focus(); await detailNode.press('Enter'); await frame.waitForTimeout(50)
          const detailSmall = await frame.evaluate(() => [...document.querySelectorAll('#detail a,#detail button,#detail input,#detail select,#detail [role="button"]')].filter((el) => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el)
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && (r.width < 44 || r.height < 44)
          }).map((el) => { const r = el.getBoundingClientRect(); return { name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) } }))
          if (detailSmall.length) fail(`${where} frame`, `detail targets below 44px: ${JSON.stringify(detailSmall)}`)
          await frame.locator('body').press('Escape')
        }
        if (size.axe) {
          await frame.addScriptTag({ content: axeSource })
          const violations = await frame.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations)
          if (violations.length) fail(`${where} frame`, `Axe: ${violations.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`)
        }
        const map = await frame.evaluate(() => {
          const stage = document.querySelector('#stage'), hint = document.querySelector('#pan-hint')
          const nodes = [...document.querySelectorAll('.nd[role="button"]')]
          return {
            role: stage.getAttribute('role'), name: stage.getAttribute('aria-label'), tabIndex: stage.tabIndex,
            overflow: stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight,
            bodyOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
            hint: !hint.hidden && getComputedStyle(hint).display !== 'none',
            visible: nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight }).length,
            unnamedNodes: nodes.filter((n) => !/ · .+ · .+/.test(n.getAttribute('aria-label') || '')).length,
            unnamedEdges: document.querySelectorAll('.edgehit:not([role="img"]),.edgehit:not([aria-label])').length,
          }
        })
        if (map.role !== 'region' || !map.name || (map.overflow && (map.tabIndex !== 0 || !map.hint)) || map.bodyOverflow || !map.visible || map.unnamedNodes || map.unnamedEdges) fail(`${where} frame`, `inoperable map: ${JSON.stringify(map)}`)
        const stage = frame.locator('#stage'); await frame.waitForTimeout(300)
        const bounds = await stage.evaluate((el) => ({ left: el.scrollLeft, leftMax: el.scrollWidth - el.clientWidth, top: el.scrollTop, topMax: el.scrollHeight - el.clientHeight }))
        const horizontal = bounds.leftMax > 0, before = horizontal ? bounds.left : bounds.top
        await stage.focus(); await stage.press(horizontal ? (bounds.left < bounds.leftMax ? 'ArrowRight' : 'ArrowLeft') : (bounds.top < bounds.topMax ? 'ArrowDown' : 'ArrowUp'))
        await frame.waitForTimeout(150)
        const after = await stage.evaluate((el, x) => x ? el.scrollLeft : el.scrollTop, horizontal)
        if (map.overflow && after === before) fail(`${where} frame`, 'arrow key did not pan the map')
        const node = frame.locator('.nd[role="button"]').first(), count = await frame.locator('.nd[role="button"]').count()
        await node.focus(); await node.press('Enter'); await frame.waitForTimeout(50)
        const operated = await frame.evaluate((oldCount) => document.querySelectorAll('.nd[role="button"]').length !== oldCount || getComputedStyle(document.querySelector('#detail')).display !== 'none', count)
        if (!operated) fail(`${where} frame`, 'Enter did not open or drill into the focused node')
        await frame.locator('body').press('Escape')
      }
      await page.close()
    }
    await context.close()
  }
  const context = await browser.newContext({ viewport: { width: 1920, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${pathToFileURL(file).href}#/`, { waitUntil: 'load' })
  await page.emulateMedia({ media: 'print' })
  await page.evaluate(() => dispatchEvent(new Event('beforeprint')))
  const printState = await page.evaluate(() => ({
    views: [...document.querySelectorAll('section.view')].filter((el) => getComputedStyle(el).display !== 'none').length,
    deadControls: [...document.querySelectorAll('.pager,.frame,.doclist,.workflow,.toggle')].filter((el) => getComputedStyle(el).display !== 'none').length,
    maps: [...document.querySelectorAll('.map-print')].filter((el) => getComputedStyle(el).display !== 'none' && el.innerText.trim()).length,
    clippedProvenance: [...document.querySelectorAll('.prov')].filter((el) => { const s = getComputedStyle(el); return s.whiteSpace === 'nowrap' || s.textOverflow === 'ellipsis' }).length,
  }))
  const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length
  const expected = 2 + data.programs.length * 5
  if (pages !== expected) fail(`${file} print`, `${pages} pages; expected ${expected}`)
  const mapped = data.programs.filter((p) => p.hasMap).length
  if (printState.views !== expected || printState.deadControls || printState.maps !== mapped || printState.clippedProvenance) fail(`${file} print`, `incomplete static projection: ${JSON.stringify(printState)}`)
  report.print.push({ room: basename(file), pages, expected, ...printState })
  if (process.env.BROWSER_GATE_REPORT) {
    const reportDir = dirname(resolve(process.env.BROWSER_GATE_REPORT)); mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, `${basename(file, '.html')}.pdf`), pdf)
  }
  await context.close()
}
await browser.close()

if (process.env.BROWSER_GATE_REPORT) {
  const path = resolve(process.env.BROWSER_GATE_REPORT); mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...report, failures }, null, 2) + '\n')
}

if (failures.length) {
  console.error(`browser-gate: NO (${failures.length})\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log(`browser-gate: YES — ${rooms.length} briefing(s), desktop/mobile/Axe/print`)
