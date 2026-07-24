#!/usr/bin/env node
// Offline stand-in for the `gh` CLI, used via `forma verify --gh-cmd "node test/stub-gh.mjs"`.
// Prints the same shape as `gh issue list --json number,state`. #7 closed, #8 open — nothing else.
console.log(JSON.stringify([{ number: 7, state: 'CLOSED' }, { number: 8, state: 'OPEN' }]))
