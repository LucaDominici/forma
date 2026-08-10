#!/usr/bin/env node
// palette.mjs — the measurement docs/DESIGN.md D6 says it already made.
//
// D6 reads "Verified, not judged by eye. Both palettes were run through the measurement script."
// No such script was in the repository and scripts/presentable.mjs carries no colour predicate, so
// the claim could not be reproduced by anyone, including its author. This file is that script, and
// wiring it into `npm test` is what turns the sentence from a preference into a rule.
//
// It measures three things a palette can be wrong about, and refuses each:
//   1. CONTRAST. Text below its WCAG bar is unreadable for someone this product is for.
//   2. CVD SEPARATION. The status trio (ok / warn / bad) is the only place colour carries meaning,
//      and roughly one man in twelve cannot separate red from green. D6's answer is that colour is
//      never alone — glyph plus word plus colour. This measures how far apart the trio actually is
//      under simulated protanopia, deuteranopia and tritanopia, and requires the secondary encoding
//      whenever any pair falls inside the ambiguous band.
//   3. THE EXTREMES. Pure #000 and #fff, and high chroma pushed against the ends of the lightness
//      range, which is where a palette starts to look synthetic.
//
// Zero dependencies, no network. Tokens are lifted out of the two tracked viewer files rather than
// duplicated here, the same trick test/run.mjs uses to test the viewer's own pure functions: a
// second copy of the palette would be a second source of truth for the thing being audited.
//
// Usage:
//   node scripts/palette.mjs            # report + verdict, exit 0 unless a check fails
//   node scripts/palette.mjs --check    # verdict only, exit 1 on any failure
//   node scripts/palette.mjs --report   # full table, always exit 0
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const REPORT_ONLY = args.includes('--report')

// ---------------------------------------------------------------------------
// Colour maths. Björn Ottosson's OKLab, WCAG 2.1 relative luminance, and the
// Machado/Oliveira/Fernandes (2009) CVD matrices at full severity.
// ---------------------------------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
// oklch() is unreadable at a glance, so the report prints the sRGB the browser will paint.
const hexOf = (linear) => "#" + linear.map((c) => Math.round(clamp01(toSrgb(c)) * 255).toString(16).padStart(2, "0")).join("")

function linearFromHex(hex) {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(toLinear)
}

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}

function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}

const oklabToOklch = ([L, a, b]) => {
  const h = (Math.atan2(b, a) * 180) / Math.PI
  return [L, Math.sqrt(a * a + b * b), h < 0 ? h + 360 : h]
}
const oklchToOklab = ([L, C, H]) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)]

// WCAG 2.1 relative luminance takes LINEAR channel values, which is why every colour here is kept
// linear until the last moment.
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const CVD = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
}
const simulate = ([r, g, b], m) => [
  clamp01(m[0] * r + m[1] * g + m[2] * b),
  clamp01(m[3] * r + m[4] * g + m[5] * b),
  clamp01(m[6] * r + m[7] * g + m[8] * b),
]
// Euclidean distance in OKLab, scaled to the 0-100 range people quote for deltaE. OKLab is near
// enough to perceptually uniform that a plain distance is meaningful; this is a separation measure,
// not a colour-difference standard, and it is used only to compare pairs against each other.
const separation = (a, b) => {
  const [l1, a1, b1] = linearToOklab(a), [l2, a2, b2] = linearToOklab(b)
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) * 100
}

// ---------------------------------------------------------------------------
// Reading the palette out of the files that ship it
// ---------------------------------------------------------------------------

// Accepts what the stylesheets actually contain: #rgb, #rrggbb, and oklch(L C H) with L as a
// percentage or a 0-1 number. Anything else is reported rather than guessed at.
export function parseColor(raw) {
  const value = String(raw).trim()
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(value)) return { linear: linearFromHex(value), src: value }
  const m = /^oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(value)
  if (m) {
    const L = value.includes('%') ? Number(m[1]) / 100 : Number(m[1])
    return { linear: oklabToLinear(oklchToOklab([L, Number(m[2]), Number(m[3])])).map(clamp01), src: value }
  }
  return null
}

// Every `--token: value` inside a rule whose selector matches `selector`.
export function tokensIn(css, selector) {
  const start = css.indexOf(selector)
  if (start < 0) return null
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return null
  const out = new Map()
  for (const m of css.slice(open + 1, close).matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) out.set(m[1], m[2].trim())
  return out
}

// Which token plays which role, and therefore which bar it must clear. A palette cannot be audited
// without this: the same ratio is a failure for text and irrelevant for a separator.
//
// The bars are WCAG 2.1: 1.4.3 puts text at 4.5:1, and 1.4.11 puts at 3:1 the parts of a graphic
// that are *required to understand the content*. The third bar is the one worth defending. A
// hairline between two rows is not a UI component and carries no state — WCAG exempts decoration
// outright, and holding a 1px separator to 3:1 would force a heavy rule that wrecks the density
// this interface is built on. It still has to be VISIBLE, so it gets a floor rather than an
// exemption: a border nobody can see is a border that should have been deleted.
const TEXT = (why) => ({ bar: 4.5, why })
const MARK = (why) => ({ bar: 3.0, why })
const HAIRLINE = (why) => ({ bar: 1.2, why })

const BRIEFING_ROLES = {
  ink: TEXT('body text'),
  muted: TEXT('secondary text, set as small as 11px'),
  accent: TEXT('link text, and the focus ring'),
  ok: TEXT('status text'), warn: TEXT('status text'), bad: TEXT('status text'),
  series2: MARK('chart mark carrying data'),
  ramp1: MARK('chart mark, lightest ordinal step'), ramp2: MARK('chart mark'),
  ramp3: MARK('chart mark'), ramp4: MARK('chart mark'),
  line: HAIRLINE('structural hairline: decorative under 1.4.11, but it must be visible'),
}
// The explorer names the same jobs differently, and an audit that only knew one vocabulary would
// silently grade half the product.
// Read off the stylesheet rather than guessed at: a token that paints `rect{stroke:…}` is a mark,
// not text, and holding it to the text bar would be this audit inventing a failure.
const EXPLORER_ROLES = {
  nm: TEXT('node name'), now: TEXT('current-state prose'), ddtxt: TEXT('detail text'),
  sec: TEXT('secondary text'), ter2: TEXT('checkpoint badge, set at 8px'),
  elbl: TEXT('edge label'), planTxt: TEXT('planned-node label'),
  cyan: TEXT('accent, and the interactive affordance'), tgt: TEXT('target-state prose'),
  done: TEXT('status text'), prog: TEXT('status text'), prob: TEXT('status text'),
  src: TEXT('provenance text'),
  plan: MARK('planned-node outline'), unk: MARK('unknown-state outline'),
  edge: MARK('a drawn relationship'),
  // Drawn at opacity .6, so the painted contrast is lower than this ratio. The bar is held anyway:
  // measuring the token is the honest floor, and a planned edge that disappears is a lost claim.
  edgeplan: MARK('a planned relationship'),
  border: HAIRLINE('node outline'), stageborder: HAIRLINE('stage outline'),
  // WCAG 1.4.3 exempts an inactive control, and this one is painted at opacity .28 on top: holding
  // it to a text bar would force a disabled button to shout.
  ter: HAIRLINE('text of a DISABLED control, itself drawn at opacity .28'),
}

const SOURCES = [
  {
    file: 'lib/viewer/control-room.html',
    grounds: ['bg', 'surface'], status: ['ok', 'warn', 'bad'], roles: BRIEFING_ROLES,
    palettes: [{ theme: 'briefing/dark', selector: ':root{' }, { theme: 'briefing/light', selector: 'html[data-theme="light"]{' }],
  },
  {
    file: 'lib/viewer/c4-hologram.html',
    // `nodebg` and `stagebg` are rgba over the stage in the holo skin, so `bg` is the one ground
    // that is a solid colour in both skins and the only one a ratio can honestly be taken against.
    grounds: ['bg'], status: ['done', 'prog', 'prob'], roles: EXPLORER_ROLES,
    palettes: [{ theme: 'explorer/holo', selector: ':root{' }, { theme: 'explorer/blueprint', selector: 'html[data-skin="blueprint"]{' }],
  },
]
// Below this, two statuses are close enough under simulated CVD that colour alone cannot separate
// them — which is legal only because every status also ships a glyph and a word (D6).
const CVD_AMBIGUOUS = 10

function load() {
  const palettes = [], problems = []
  for (const source of SOURCES) {
    let css
    try { css = readFileSync(join(REPO, source.file), 'utf-8') } catch (e) { problems.push(`${source.file}: unreadable — ${(e && e.message) || e}`); continue }
    for (const { theme, selector } of source.palettes) {
      const raw = tokensIn(css, selector)
      if (!raw) { problems.push(`${source.file}: no \`${selector}\` rule — the palette moved and this audit stopped seeing it`); continue }
      const tokens = new Map(), unmeasurable = []
      for (const [name, value] of raw) {
        const parsed = parseColor(value)
        // I9: a token this audit cannot read is NAMED, never quietly skipped. A translucent overlay
        // has no ratio without knowing what is behind it, and saying so is the honest answer.
        if (parsed) tokens.set(name, parsed)
        else if (source.roles[name] || source.grounds.includes(name)) unmeasurable.push(`${name}: ${value}`)
      }
      palettes.push({ file: source.file, theme, tokens, unmeasurable, source })
    }
  }
  return { palettes, problems }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function audit(palette) {
  const { tokens } = palette
  const failures = [], rows = []
  const get = (n) => tokens.get(n)

  for (const ground of palette.source.grounds) {
    const bg = get(ground)
    if (!bg) continue
    for (const [name, role] of Object.entries(palette.source.roles)) {
      const fg = get(name)
      if (!fg) continue
      const ratio = contrast(fg.linear, bg.linear)
      const pass = ratio >= role.bar
      rows.push({ what: `${name} on ${ground}`, value: ratio.toFixed(2) + ':1', bar: role.bar.toFixed(1), pass, paint: hexOf(fg.linear) })
      if (!pass) failures.push(`${palette.theme}: --${name} on --${ground} is ${ratio.toFixed(2)}:1, below the ${role.bar}:1 bar for ${role.why}`)
    }
  }

  // The extremes. A pure black or white ground reads as a default rather than a decision, and it is
  // the one palette rule impeccable states outright.
  for (const [name, colour] of tokens) {
    const hex = colour.src.toLowerCase()
    if (hex === '#fff' || hex === '#ffffff' || hex === '#000' || hex === '#000000') {
      failures.push(`${palette.theme}: --${name} is pure ${hex} — every neutral carries a trace of the brand hue`)
    }
    const [L, C] = oklabToOklch(linearToOklab(colour.linear))
    if ((L > 0.93 || L < 0.12) && C > 0.05) {
      failures.push(`${palette.theme}: --${name} holds chroma ${C.toFixed(3)} at lightness ${L.toFixed(3)} — saturation at the ends of the range reads as synthetic`)
    }
  }

  // The status trio, under three kinds of colour blindness plus normal vision.
  const trio = palette.source.status.map((n) => [n, get(n)]).filter(([, c]) => c)
  const cvdRows = []
  let ambiguous = false
  if (trio.length === 3) {
    for (const [vision, matrix] of [['normal', null], ...Object.entries(CVD)]) {
      for (let i = 0; i < trio.length; i++) {
        for (let j = i + 1; j < trio.length; j++) {
          const a = matrix ? simulate(trio[i][1].linear, matrix) : trio[i][1].linear
          const b = matrix ? simulate(trio[j][1].linear, matrix) : trio[j][1].linear
          const d = separation(a, b)
          if (matrix && d < CVD_AMBIGUOUS) ambiguous = true
          cvdRows.push({ vision, pair: `${trio[i][0]}/${trio[j][0]}`, sep: d.toFixed(1) })
        }
      }
    }
  }
  return { failures, rows, cvdRows, ambiguous }
}

// The secondary encoding D6 promises: a status must reach the reader as a glyph AND a word, not as
// colour alone. Measured from the shipped template, not asserted — an ambiguous trio is allowed
// only while that remains true, so the two checks are one rule with two halves.
function secondaryEncodingPresent() {
  const html = readFileSync(join(REPO, 'lib/viewer/control-room.html'), 'utf-8')
  const fn = /function statusMark\(v\)\{([\s\S]*?)\n\}/.exec(html)
  if (!fn) return { ok: false, why: 'statusMark() not found in control-room.html — the status renderer moved' }
  const body = fn[1]
  // Coupled to the template on purpose. A looser check ("does it render two things") would keep
  // passing while the glyph became decoration, and the whole point is that the palette is legal
  // only because this element exists. When the class is renamed, this line should have to change.
  const hasGlyph = /"glyph"/.test(body)
  const hasWord = /STR\.status(Ok|Warn|Bad)/.test(body)
  if (!hasGlyph) return { ok: false, why: 'statusMark() no longer renders a glyph' }
  if (!hasWord) return { ok: false, why: 'statusMark() no longer renders a word' }
  return { ok: true, why: 'glyph + word + colour' }
}

// ---------------------------------------------------------------------------

const { palettes, problems } = load()
const failures = [...problems]
if (!palettes.length) failures.push('no palette was found in any tracked viewer file')

const encoding = secondaryEncodingPresent()
let anyAmbiguous = false
const report = []

for (const palette of palettes) {
  const result = audit(palette)
  failures.push(...result.failures)
  if (result.ambiguous) anyAmbiguous = true
  report.push({ palette, result })
}

if (anyAmbiguous && !encoding.ok) {
  failures.push(`the status trio is inseparable under simulated CVD (below ${CVD_AMBIGUOUS}), which is only legal with a secondary encoding — and ${encoding.why}`)
}

if (!CHECK_ONLY) {
  for (const { palette, result } of report) {
    console.log(`\n${relative(REPO, join(REPO, palette.file))} · ${palette.theme} · ${palette.tokens.size} tokens`)
    for (const row of result.rows) {
      console.log(`  ${row.pass ? 'PASS' : 'FAIL'}  ${row.what.padEnd(22)} ${row.paint}  ${String(row.value).padStart(8)}  (bar ${row.bar}:1)`)
    }
    if (result.cvdRows.length) {
      const byVision = new Map()
      for (const r of result.cvdRows) byVision.set(r.vision, [...(byVision.get(r.vision) || []), `${r.pair} ${r.sep}`])
      console.log('  status separation (OKLab distance x100):')
      for (const [vision, pairs] of byVision) console.log(`    ${vision.padEnd(14)} ${pairs.join('   ')}`)
    }
  }
  console.log(`\nsecondary encoding: ${encoding.ok ? 'present' : 'MISSING'} — ${encoding.why}`)
  console.log(`status trio under CVD: ${anyAmbiguous ? `at least one pair below ${CVD_AMBIGUOUS}, so colour alone is not enough` : 'every pair separable by colour alone'}`)
}

if (failures.length) {
  console.error(`\n[palette] FAIL (${failures.length}):\n - ` + failures.join('\n - '))
  process.exit(REPORT_ONLY ? 0 : 1)
}
console.log(`\n[palette] OK — ${palettes.length} palette(s) measured, every role clears its bar, and the status trio ships its secondary encoding.`)
