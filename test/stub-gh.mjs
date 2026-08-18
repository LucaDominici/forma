#!/usr/bin/env node
// Offline stand-in for the gh commands used by forma verify.
const args = process.argv.slice(2)
const mode = ['multi', 'fail-signals', 'truncated', 'unsupported'].includes(args[0]) ? args.shift() : 'default'
const after = (value) => { const i = args.indexOf(value); return i < 0 ? null : args[i + 1] }
const issue = (number, fields = {}) => ({
  number, title: number === 7 ? 'Fix the thing' : 'Open the other thing', state: number === 7 ? 'CLOSED' : 'OPEN',
  url: `https://github.com/acme/thing/issues/${number}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  closedAt: number === 7 ? '2026-01-02T00:00:00Z' : null,
  milestone: number === 7 ? { title: 'v1', dueOn: '2026-01-01T00:00:00Z' } : null,
  labels: { nodes: number === 7 ? [{ name: 'bug' }] : [] }, ...fields,
})
const relation = (nodes = []) => ({ totalCount: nodes.length, nodes })
const endpoint = (number, state) => ({ number, state, url: `https://github.com/acme/thing/issues/${number}`, repository: { nameWithOwner: 'acme/thing' } })

if (args[0] === 'api' && args[1] === 'graphql') {
  if (!args.includes('--paginate') || !args.includes('--slurp')) { console.error('stub-gh: GraphQL must prove pagination with --paginate --slurp'); process.exit(2) }
  const withDependencies = String(after('-f') || '').includes('blockedBy(first:50)')
  if (mode === 'unsupported' && withDependencies) { console.error('blockedBy is not supported'); process.exit(3) }
  const seven = issue(7, withDependencies ? { blockedBy: relation(), blocking: relation([endpoint(8, 'OPEN')]) } : {})
  const eight = issue(8, withDependencies ? { blockedBy: { totalCount: mode === 'truncated' ? 2 : 1, nodes: [endpoint(7, 'CLOSED')] }, blocking: relation() } : {})
  const nine = issue(9, withDependencies ? { blockedBy: relation(), blocking: relation() } : {})
  const pages = ['default', 'truncated', 'unsupported'].includes(mode)
    ? [{ data: { repository: { issues: { nodes: [seven, eight], pageInfo: { hasNextPage: false, endCursor: null } } } } }]
    : [
        { data: { repository: { issues: { nodes: [seven, eight], pageInfo: { hasNextPage: true, endCursor: 'page-2' } } } } },
        { data: { repository: { issues: { nodes: [nine], pageInfo: { hasNextPage: false, endCursor: null } } } } },
      ]
  console.log(JSON.stringify(pages))
} else if (args[0] === 'issue' && args[1] === 'view') {
  const number = Number(args[2])
  const negatives = [
    'Related #8',
    'Not blocked by #8.',
    'This issue is not blocked by #8.',
    'The phrase "blocked by #8" is documentation.',
    'How to express "depends on #8" is undecided.',
    'It was previously blocked by #8, now resolved.',
    'This does not depend on #8.',
    'A check for text `blocked by #8`.',
    'Discovered while implementing #8.',
    'The pre-existing doctor check #8 still runs.',
  ].join('\n')
  console.log(JSON.stringify({ body: number === 7 ? negatives : number === 8 ? 'Blocked by #7 because the fix lands first.' : 'Part of epic #6 (see the ADR). Depends on #8' }))
} else if (args[0] === 'run' && args[1] === 'list') {
  if (mode === 'fail-signals') { console.error('run list unavailable'); process.exit(3) }
  const path = args.find((value) => value.startsWith('--workflow='))?.slice('--workflow='.length) || 'ci.yml'
  console.log(JSON.stringify([{
    name: `Run ${path}`, headBranch: 'main', headSha: '0123456789abcdef', event: 'push', status: 'completed', conclusion: 'success',
    createdAt: '2026-01-03T00:00:00Z', url: 'https://github.com/acme/thing/actions/runs/1',
  }]))
} else if (args[0] === 'release' && args[1] === 'list') {
  if (mode === 'fail-signals') { console.error('release list unavailable'); process.exit(3) }
  console.log(JSON.stringify([{ tagName: 'v1.0.0', publishedAt: '2026-01-04T00:00:00Z', isLatest: true, isDraft: false }]))
} else if (args[0] === 'release' && args[1] === 'view') {
  console.log(JSON.stringify({ tagName: 'v1.0.0', publishedAt: '2026-01-04T00:00:00Z', url: 'https://github.com/acme/thing/releases/tag/v1.0.0' }))
} else if (args[0] === 'api' && /^repos\/acme\/thing\/commits\//.test(args[1] || '')) {
  console.log(JSON.stringify({
    sha: 'fedcba9876543210', html_url: 'https://github.com/acme/thing/commit/fedcba9876543210',
    commit: { committer: { date: '2026-01-04T00:00:00Z' } },
  }))
} else {
  console.error(`stub-gh: unsupported argv: ${args.join(' ')}`)
  process.exit(2)
}
