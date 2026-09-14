// repofiles.mjs — `git ls-files`, read once per repo PER COMPOSE (#133 S4). docmap.mjs, roomdocs.mjs
// and rtm.mjs each shelled out to git independently for the same answer; one `forma room` compose
// paid that cost three times over for a file list that cannot change mid-compose. Memoised here so
// every caller within one compose shares one spawn and one Set.
//
// NOT memoised for the life of the process (#133 S4 round 2, Codex HIGH): `room --serve` calls
// `compose()` again on every GET in one long-lived process, and a file `git add`ed between two
// requests must be visible on the very next one, not require a restart. `resetTrackedFiles()` is
// called at the start of every compose boundary (room.mjs's `compose()`, check.mjs's per-run entry)
// so the cache's lifetime is one compose, never the process.
//
// Only files git tracks. A naive walk of a real repo finds agent working copies and build output
// (measured on one: 8899 files, 8544 of them under .claude/worktrees), and an untracked file
// entering a gate would make the answer depend on the state of somebody's desk.
import { execFileSync } from 'node:child_process'

let cache = new Map()

export function resetTrackedFiles() {
  cache = new Map()
}

export function trackedFiles(repo) {
  if (cache.has(repo)) return cache.get(repo)
  let result
  try {
    result = new Set(execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 })
      .split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    result = null // not a checkout we can read; the caller reports it rather than silently finding nothing
  }
  cache.set(repo, result)
  return result
}
