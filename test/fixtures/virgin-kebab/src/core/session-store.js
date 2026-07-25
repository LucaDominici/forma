export const store = new Map()
export function put(k, v) { store.set(k, v); return v }
export function get(k) { return store.get(k) }
