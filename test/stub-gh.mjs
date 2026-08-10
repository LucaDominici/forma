#!/usr/bin/env node
// Offline stand-in for the `gh` CLI, used via `forma verify --gh-cmd "node test/stub-gh.mjs"`.
// Prints the same shape as `gh issue list --json number,title,state,milestone,labels`.
// #7 closed (milestone v1), #8 open (no milestone) — nothing else.
console.log(JSON.stringify([
  { number: 7, title: 'Fix the thing', state: 'CLOSED', milestone: { title: 'v1', dueOn: '2026-01-01T00:00:00Z' }, labels: [{ name: 'bug' }] },
  { number: 8, title: 'Open the other thing', state: 'OPEN', milestone: null, labels: [] },
]))
