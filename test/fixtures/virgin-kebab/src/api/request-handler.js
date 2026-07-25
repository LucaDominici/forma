import { allow } from '../core/session-guard.js'
import { take } from '../core/rate-limiter.js'
import { policy } from '../core/rate-policy.js'
export function handle(req) {
  if (!allow(req.session)) return { code: 401 }
  if (take(req.ip) > policy.burst) return { code: 429 }
  return { code: 200 }
}
