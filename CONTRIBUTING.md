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
2. Branch: `feat/<slug>` or `fix/<slug>`.
3. Add or update a fixture under `test/fixtures/` if behavior changes.
4. `npm run lint && npm test` must pass.
5. Open a PR using the template. Describe the change and its blast radius.

## Reporting bugs / requesting features

Use the issue templates. For security issues, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

By contributing you agree your contributions are licensed under Apache-2.0.
