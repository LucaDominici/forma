import { mint } from '../core/session-token.js'
export function write(res, body) { return { ...res, body, token: mint(res.id) } }
