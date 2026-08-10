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
// Comments are removed first: a brace inside prose ends the scan early and silently. This was not
// hypothetical — a comment containing `body{color:#000}` truncated the print palette to zero tokens,
// and only the "did this actually measure anything" guard caught it.
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
export function blockIn(rawCss, selector) {
  const css = withoutComments(rawCss)
  const start = css.indexOf(selector)
  if (start < 0) return null
  const open = css.indexOf('{', start)
  if (open < 0) return null
  // Depth-counted, so an at-rule yields everything it contains however many rules that is. The naive
  // first-`}` scan stopped at the first nested rule's close: it read `@media print{` correctly only
  // because that block's tokens happened to be declared in one `:root` and happened to be first.
  let depth = 0, close = -1
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) { close = i; break }
  }
  return close < 0 ? null : css.slice(open + 1, close)
}
export function tokensIn(rawCss, selector) {
  const body = blockIn(rawCss, selector)
  if (body === null) return null
  const out = new Map()
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) out.set(m[1], m[2].trim())
  return out
}

// A palette can be DECLARED and still lose. A media query adds no specificity to the rules inside
// it, so `@media print{ :root{…} }` scored (0,1,0) against `html[data-theme="light"]`'s (0,1,1) and
// every reader who had ever pressed the theme button printed the SCREEN palette: --muted at 5.05:1
// instead of 7.75, the hairline at 1.43:1, on cream instead of white. Dark passed only because it
// tied the base `:root` and won on source order — the accident, not the rule. This audit had no
// opinion on any of it: it read the declaration and reported the number nobody was getting.
export function specificity(sel) {
  let s = sel.trim()
  const add = [0, 0, 0]
  // Functional pseudo-classes take the specificity of their ARGUMENT, and `:where()` takes none.
  // Counting `:not(...)` as one pseudo-class AND scoring its argument made
  // `html:not([data-theme="light"])` — the canonical prefers-color-scheme pattern — score (0,2,1)
  // instead of (0,1,1), which turned a legitimate third theme into a false red. A gate that goes
  // red on correct code is abandoned, and an abandoned gate protects nothing.
  for (let guard = 0; guard < 8; guard++) {
    const m = /:(is|not|has|matches|any|where)\(([^()]*)\)/i.exec(s)
    if (!m) break
    if (m[1].toLowerCase() !== 'where') {
      // The strongest branch of the argument list wins.
      let best = [0, 0, 0]
      for (const part of m[2].split(',')) { const p = specificity(part); if (beats(p, best)) best = p }
      add[0] += best[0]; add[1] += best[1]; add[2] += best[2]
    }
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)
  }
  // Pseudo-ELEMENTS count as type selectors, so `::x` must be taken out before `:x` is counted.
  const elements = (s.match(/::[\w-]+/g) || []).length
  s = s.replace(/::[\w-]+/g, ' ')
  return [
    add[0] + (s.match(/#[\w-]+/g) || []).length,
    add[1] + (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) || []).length,
    add[2] + elements + (s.replace(/\[[^\]]*\]/g, '').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length,
  ]
}
const beats = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
// Every selector in the file that declares the ground token — i.e. every rule that IS a palette.
// Derived rather than listed, so a fourth theme added tomorrow is compared without anyone
// remembering to add it here.
// Does anything in the file out-declare the rule whose numbers this audit reports? Three ways it
// could, all found by a reviewer against the first version of this check and all reproduced in
// Chrome before being fixed here:
//   - a rival touching --ink or --muted while never mentioning --bg (the first version only looked
//     for rules declaring the ground token, so it searched for the loophole and reported none);
//   - `!important`, which beats specificity outright and which a specificity comparison cannot see;
//   - a token whose value this audit cannot parse, which used to land in `unmeasurable` and then go
//     unprinted in --check, the one mode that gates. Silence in the gating mode is not I9.
export function outranked({ file, theme, rule, css, declares }) {
  const out = [], mine = specificity(rule), want = new Set(declares)
  for (const rival of declaringRules(css)) {
    if (rival.selector === rule) continue
    const shared = rival.tokens.filter((t) => want.has(t.name))
    if (!shared.length) continue
    const bang = shared.filter((t) => t.important)
    if (bang.length) {
      out.push(`${file} · ${theme}: \`${rival.selector}\` declares ${bang.map((t) => '--' + t.name).join(', ')} with \`!important\` — that beats any specificity, so the values measured here are not the values that apply`)
    } else if (!beats(mine, specificity(rival.selector))) {
      out.push(`${file} · ${theme}: \`${rule}\` scores (${mine}) and \`${rival.selector}\` scores (${specificity(rival.selector)}) over ${shared.map((t) => '--' + t.name).join(', ')} — the palette measured here is not the one that applies, so this audit reports a number the reader never gets`)
    }
  }
  return out
}
// Every rule in the file and every custom property it declares, with whether the value is forced.
export function declaringRules(rawCss) {
  const stripped = withoutComments(rawCss)
  const styles = [...stripped.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  const css = styles.length ? styles.join('\n') : stripped
  const out = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens = [...m[2].matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)].map((d) => ({ name: d[1], important: /!\s*important/i.test(d[2]) }))
    if (!tokens.length) continue
    for (const one of m[1].split(',')) {
      const selector = one.trim().replace(/\s+/g, ' ')
      if (selector && !selector.startsWith('@')) out.push({ selector, tokens })
    }
  }
  return out
}
export function paletteRules(rawCss, ground) {
  // The sources are HTML, so the first rule's prelude would otherwise carry the whole document head
  // in front of `:root` and score (0,1,6) on the tag names in it.
  const stripped = withoutComments(rawCss)
  const styles = [...stripped.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  const css = styles.length ? styles.join('\n') : stripped
  const out = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!new RegExp('--' + ground + '\\s*:').test(m[2])) continue
    // A selector list is as strong as its strongest member, so each member is compared on its own.
    for (const one of m[1].split(',')) {
      const sel = one.trim().replace(/\s+/g, ' ')
      if (sel) out.push(sel)
    }
  }
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
  // Re-derived against the stylesheet rather than extended by hand. `next` was in no role at all and
  // therefore held to no bar, while it colours .tt/.pp — the node title and badge — both for the
  // next status and for EVERY node whenever TARGET STATE mode is on. `unk` was a mark and paints the
  // same text; `plan` is the one that legitimately stays a mark, because its text is a separate
  // token (planTxt). One sibling had the right shape and two did not.
  next: TEXT('node title and badge, for the next status and for every node in TARGET mode'),
  unk: TEXT('node title and badge of an unknown-state node'),
  plan: MARK('planned-node outline; its text is planTxt'),
  edge: MARK('a drawn relationship'),
  // Drawn at opacity .6, so the painted contrast is lower than this ratio. The bar is held anyway:
  // measuring the token is the honest floor, and a planned edge that disappears is a lost claim.
  edgeplan: MARK('a planned relationship'),
  border: HAIRLINE('node outline'), stageborder: HAIRLINE('stage outline'),
  // Classified as a disabled control's label on the strength of ONE usage (#back[disabled]). It has
  // a second: .cpstep, the checkpoint stepper's label, enabled and at full opacity. Auditing a
  // token by the friendliest of its usages is how a role table becomes a way of excusing a colour.
  ter: TEXT('checkpoint stepper label (also the disabled back button)'),
}

const SOURCES = [
  {
    file: 'lib/viewer/control-room.html',
    grounds: ['bg', 'surface'], status: ['ok', 'warn', 'bad'], roles: BRIEFING_ROLES,
    palettes: [
      { theme: 'briefing/dark', selector: ':root{' },
      { theme: 'briefing/light', selector: 'html[data-theme="light"]{' },
      // Paper is a third theme and was the unmeasured one. Setting only body{color:#000} left every
      // token at its dark value, so chart numbers printed at 1.23:1 against white — and because the
      // theme persists to localStorage, the paper output differed depending on what the reader last
      // clicked. A deliverable that prints differently per reader is not a deliverable, so the print
      // palette is declared and measured like the other two.
      // `rule` is the selector INSIDE the block that carries the tokens, and it must out-specify
      // every other palette rule in the file — see `specificity` above for what going without cost.
      { theme: 'briefing/print', selector: '@media print{', rule: 'html:root:root' },
    ],
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
    for (const { theme, selector, rule } of source.palettes) {
      // When a palette names an inner `rule`, the tokens are read from THAT declaration and not from
      // the block around it. Scraping the whole `@media print{…}` let the tokens be moved to a
      // weaker `:root{}` inside it while a token-free `html:root:root{}` stayed behind to satisfy
      // the specificity check — the exact regression this check exists to prevent, passing green.
      const outer = blockIn(css, selector)
      const raw = rule ? (outer === null ? null : tokensIn(outer, rule + '{')) : tokensIn(css, selector)
      if (!raw) { problems.push(`${source.file}: no \`${rule ? selector + ' ' + rule : selector}\` rule — the palette moved and this audit stopped seeing it`); continue }
      if (rule) problems.push(...outranked({ file: source.file, theme, rule, css, declares: [...raw.keys()] }))
      const tokens = new Map(), unmeasurable = []
      for (const [name, value] of raw) {
        const parsed = parseColor(value)
        // I9: a token this audit cannot read is NAMED, never quietly skipped. A translucent overlay
        // has no ratio without knowing what is behind it, and saying so is the honest answer.
        //
        // "Named" was true only of `--report`. The list was printed inside `if (!CHECK_ONLY)`, so in
        // the one mode that gates — the mode `npm test` runs — an unparseable value on a token with
        // a declared ROLE vanished: no ratio taken, no line printed, exit 0. `color-mix()`, a
        // `var()` indirection or a stray `!important` were all enough. A token this audit cannot
        // read is a hole in the audit, and a hole is a failure, not a footnote.
        if (parsed) tokens.set(name, parsed)
        else if (source.roles[name] || source.grounds.includes(name)) {
          unmeasurable.push(`${name}: ${value}`)
          problems.push(`${source.file} · ${theme}: --${name} is \`${value}\`, which this audit cannot read — it holds ${source.grounds.includes(name) ? 'a ground' : 'the role "' + source.roles[name].why + '"'} and would otherwise pass unmeasured`)
        }
      }
      // A gate that can pass without evaluating anything is the defect this whole file exists to
      // remove, one layer down. `tokensIn` finds a rule by string match, and this file has more than
      // one `:root{` — the colour block and the layout block — so a reordering, a rename or a
      // reformat could hand back a rule with none of the tokens in it. Every loop below would then
      // skip, `failures` would stay empty, and the run would print OK having measured nothing.
      for (const ground of source.grounds) {
        if (!tokens.has(ground)) problems.push(`${source.file} · ${theme}: no --${ground} in \`${selector}\` — this audit has no ground to measure against and would otherwise pass by skipping`)
      }
      const measured = Object.keys(source.roles).filter((n) => tokens.has(n)).length
      if (measured < Object.keys(source.roles).length / 2) {
        problems.push(`${source.file} · ${theme}: only ${measured} of ${Object.keys(source.roles).length} known roles resolved in \`${selector}\` — the rule matched is not the palette`)
      }
      // Named, not counted. A threshold on how MANY roles resolved is satisfied while the three that
      // matter are missing, and the CVD check then skips in silence.
      const missingStatus = source.status.filter((n) => !tokens.has(n))
      if (missingStatus.length) {
        problems.push(`${source.file} · ${theme}: the status trio is incomplete (${missingStatus.map((n) => '--' + n).join(', ')} absent) — the colour-blind separation check cannot run, and would otherwise pass by skipping`)
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
  // Anchored to the END OF THE LINE, not to the next `\n}`. statusMark is a single-line function;
  // a lazy multi-line capture ran past its closing brace and swallowed the four functions after it,
  // so the window this check reads was set by wherever the next multi-line function happened to
  // close. It passed only because none of the swept-in code contained a matching string.
  const fn = /function statusMark\(v\)\{(.*)$/m.exec(html)
  if (!fn) return { ok: false, why: 'statusMark() not found on one line in control-room.html — the status renderer moved or was reformatted' }
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
    if (palette.unmeasurable.length) {
      console.log(`  ---- ${palette.unmeasurable.length} token(s) this audit cannot measure (translucent over an unknown backdrop):`)
      for (const u of palette.unmeasurable) console.log(`        ${u}`)
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
