// The fixture's core engine. Touched by the commit citing #1.
import { log } from '../util/log.js'

export function run(input) {
  log('engine running')
  return String(input).trim()
}
