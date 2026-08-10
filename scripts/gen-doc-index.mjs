#!/usr/bin/env node
// gen-doc-index.mjs — regenerate docs/INDEX.md from every document's frontmatter.
//
// A LOCATOR, not an engine. The generator lives in arbiter, which owns the doc-set standard; this
// file finds that checkout and calls its exported `runCli`. Re-implementing it here would put two
// implementations behind one rule — the divergence roomload.mjs and roomderive.mjs exist to
// prevent, and the reason DECISION_REGISTRY.md D-04 keeps the gate engines out of this repo.
//
// It exists at all because the index it writes cites its own generator by path, and a document
// citing a path that does not exist is precisely what check-doc-path-citations.mjs refuses. Making
// the citation true was cheaper and more honest than exempting it.
//
// Usage:
//   node scripts/gen-doc-index.mjs              # rewrite docs/INDEX.md
//   node scripts/gen-doc-index.mjs --check      # exit 1 if it is stale
//   FORMA_DOC_GATES=/path/to/arbiter node scripts/gen-doc-index.mjs
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
// Ordered by how deliberate each location is: an explicit override, then the CI checkout, then the
// sibling clone CONTRIBUTING.md tells a contributor to make.
const CANDIDATES = [process.env.FORMA_DOC_GATES, join(REPO, '.arbiter-gates'), join(REPO, '..', 'arbiter')]
const found = CANDIDATES.filter(Boolean).map((p) => resolve(p)).find((p) => existsSync(join(p, 'scripts', 'gen-doc-index.mjs')))
if (!found) {
  console.error('[forma docs] the doc-set engines were not found. Clone arbiter beside this repo:')
  console.error('  git clone https://github.com/LucaDominici/arbiter.git ../arbiter && (cd ../arbiter && npm ci)')
  console.error('  ...or point FORMA_DOC_GATES at an existing checkout. See CONTRIBUTING.md.')
  process.exit(2)
}

const { runCli } = await import(pathToFileURL(join(found, 'scripts', 'gen-doc-index.mjs')).href)
process.exit(await runCli(join(REPO, 'docs'), join(REPO, 'docs', 'INDEX.md'), process.argv.includes('--check')))
