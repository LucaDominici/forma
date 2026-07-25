import { put } from './session-store.js'
export function mint(id) { return put(id, { id, at: Date.now() }) }
