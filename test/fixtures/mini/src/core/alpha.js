import { Bravo } from './bravo.js'
import { Charlie } from '../util/charlie.js'
export class Alpha { run() { return new Bravo().go() + new Charlie().help() } }
