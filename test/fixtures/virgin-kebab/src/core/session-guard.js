import { get } from './session-store.js'
export function allow(id) { return Boolean(get(id)) }
