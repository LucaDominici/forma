#!/usr/bin/env node
// Offline gh stand-in for the adaptive verify contract. `fail` proves that a later retry cannot
// publish the full first page; every other mode returns a finite five-issue repository.
const limitAt = process.argv.indexOf('--limit')
const limit = Number(process.argv[limitAt + 1])
if (process.argv[2] === 'fail' && limit > 2) {
  console.error('second page unavailable')
  process.exit(1)
}
const issues = Array.from({ length: 5 }, (_, i) => ({
  number: i + 1,
  title: `Issue ${i + 1}`,
  state: i === 0 ? 'CLOSED' : 'OPEN',
  milestone: null,
  labels: [],
  createdAt: '2026-08-17T12:00:00Z',
  closedAt: i === 0 ? '2026-08-17T13:00:00Z' : null,
}))
console.log(JSON.stringify(issues.slice(0, limit)))
