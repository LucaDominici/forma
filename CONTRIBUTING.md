---
title: 'Contributing to Forma'
doc_version: '1.0.1'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'contributing'
tags: ['audience/dev', 'kind/governance']
related: ['AGENTS.md', 'docs/GLOBAL_INVARIANTS.md']
---
# Contributing to Forma

Thanks for your interest! Forma is a small, dependency-free Node tool. The bar for
contributions is: it stays deterministic, stack-agnostic, and dependency-free.

## Ground rules

- **No runtime dependencies.** The engine is plain Node (`>=18`). Keep it that way.
- **Deterministic core.** `gen`/`check` must not depend on network or an LLM.
- **Stack-agnostic.** Nothing may hardcode one project's node ids, dirs, or stack.

## Getting started

```sh
git clone https://github.com/LucaDominici/forma.git
cd forma
npm test        # runs the fixture: init → gen → check
npm run lint    # syntax-checks bin + lib
```

## Making a change

1. Open an issue describing the problem or proposal first.
2. Branch: `feat/<slug>` or `fix/<slug>`. Never commit to `main`.
3. Add or update a fixture under `test/fixtures/` if behavior changes. Write the check that would
   fail if the change broke, and watch it fail on purpose before making it pass.
4. `npm run lint && npm test && node bin/forma.mjs check` must pass.
5. Open a PR using the template. Describe the change and its blast radius.

Commit subjects are conventional and carry `(#N)` when the work has an issue — the Control Room
reads that number out of the subject to link an issue to the files it touched.

## The Control Room, locally

`docs/architecture/control-room.html` is generated, gitignored and local-only. If you generate one,
remember that it embeds how far the architecture layer is behind `HEAD` — so
your next commit makes it stale and `forma check` will say so. That is the gate being right, not a
false alarm. Re-run `forma room --manifest forma.room.json --out docs/architecture/control-room.html`,
or delete the file: the room assertions are opt-in by its presence.

```sh
forma verify --gh-repo LucaDominici/forma      # refresh the fact base (the only networked step)
forma room --manifest forma.room.json --out docs/architecture/control-room.html
forma room --manifest forma.room.json --serve  # ...or serve it, with working Options checkboxes
```

## Touching documentation

Forma keeps the doc-set standard in [`standards/gold-doc-set.yml`](standards/gold-doc-set.yml) and
selects its solo tier in [`standards/doc-profile`](standards/doc-profile). The external `arbiter`
engines are an optional local audit; required public CI has no private-repository dependency.

Every hand-authored Markdown file carries eight frontmatter keys — `title`, `doc_version`, `status`,
`last_review`, `owner`, `canonical_id`, `tags`, `related`. `last_review` is an ISO date and
`doc_version` is semver for the *document's content*, independent of the product version
(see [`docs/SEMVER.md`](docs/SEMVER.md)). `tags` is a closed vocabulary: extend the taxonomy in the
standard before using a new one.

If an `arbiter` checkout is already available, run its optional audit from Forma's root:

```sh
A=../arbiter/scripts
node $A/check-doc-set.mjs --strict          # the solo canonical set is present
node $A/check-doc-style.mjs                 # frontmatter, ISO dates, semver, one H1
node $A/check-doc-freshness.mjs             # nothing past its review bar
node $A/check-doc-links.mjs                 # every local link resolves
node $A/check-doc-path-citations.mjs        # every backticked repo path exists
node scripts/gen-doc-index.mjs              # regenerate docs/INDEX.md, then commit it
```

`docs/INDEX.md` is generated from frontmatter — add or relabel a document and regenerate it rather
than editing it. `scripts/gen-doc-index.mjs` is a locator, not a second engine: it finds the arbiter
checkout (via `FORMA_DOC_GATES`, `.arbiter-gates/`, or `../arbiter`) and calls the generator there.
`docs/architecture/ARCHITECTURE.scaffold.md` is generated too, by `forma doc`, and emits its own
frontmatter; edit `lib/doc.mjs`, never the file.

## Reporting bugs / requesting features

Use the issue templates. For security issues, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

By contributing you agree your contributions are licensed under Apache-2.0.
