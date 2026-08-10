// taxonomy.mjs — auto-detect label "families" (priority, size, type, domain, ...) from a repo's
// own label vocabulary. Pure pattern matching, never semantic inference: a family exists because
// enough labels share a `name<sep>value` shape, not because a model decided what they mean.
// Verified on three real repos (haben/arbiter/viafera, 2026-08-09): `priority`+`size` recur, each
// repo also grows its own (tier/wave/release, type/domain/status/invariant/risk...).

const SEP = /^([A-Za-z][\w-]*)[:/](.+)$/

export function detectFamilies(allLabels, opts = {}) {
  const minPopulation = opts.minPopulation || 3
  const exclude = new Set((opts.exclude || []).map((s) => s.toLowerCase()))
  const alias = opts.alias || {} // family -> {rawValue: canonicalValue}
  const families = new Map() // family -> Map(value -> count)
  const bare = new Map() // label -> count, for labels with no name<sep>value shape
  for (const raw of allLabels) {
    const m = SEP.exec(raw)
    if (!m) { bare.set(raw, (bare.get(raw) || 0) + 1); continue }
    const fam = m[1].toLowerCase()
    const canon = ((alias[fam] || {})[m[2]]) || m[2]
    if (!families.has(fam)) families.set(fam, new Map())
    const vals = families.get(fam)
    vals.set(canon, (vals.get(canon) || 0) + 1)
  }
  const axes = [], other = new Map(bare) // "other" starts as every bare label, then gains excluded/under-threshold families
  for (const [fam, vals] of families) {
    const population = [...vals.values()].reduce((a, b) => a + b, 0)
    if (exclude.has(fam) || population < minPopulation) {
      for (const [v, c] of vals) other.set(`${fam}:${v}`, (other.get(`${fam}:${v}`) || 0) + c)
      continue
    }
    axes.push({ family: fam, values: [...vals.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })) })
  }
  axes.sort((a, b) => b.values.reduce((s, v) => s + v.count, 0) - a.values.reduce((s, v) => s + v.count, 0))
  return { axes, other: [...other.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })) }
}

// Which axis+value an issue's own label set carries, for one named family (e.g. "priority").
// Returns null if the issue carries none of that family's (aliased) values.
export function valueFor(labels, family, alias = {}) {
  const famAlias = alias[family] || {}
  for (const raw of labels) {
    const m = SEP.exec(raw)
    if (m && m[1].toLowerCase() === family) return famAlias[m[2]] || m[2]
  }
  return null
}
