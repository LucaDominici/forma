const hits = new Map()
export function take(key) { const n = (hits.get(key) || 0) + 1; hits.set(key, n); return n }
