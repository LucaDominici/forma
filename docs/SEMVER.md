---
title: 'Versioning and compatibility'
doc_version: '1.1.0'
status: active
last_review: '2026-08-17'
owner: 'Luca Dominici'
canonical_id: 'semver'
tags: ['audience/dev', 'kind/governance']
related: ['CHANGELOG.md', 'docs/adr/0003-npm-oidc-trusted-publishing.md']
---
# Versioning and compatibility

`package.json` `version` is the single source of truth for the release number, and
[`CHANGELOG.md`](../CHANGELOG.md) is the human record. Releases follow semver.

## What the version promises

Forma's public surface is larger than its exported code, because the product *is* a set of file
contracts. Three things are covered, and a breaking change to any of them is a MAJOR:

1. **The CLI.** Command names, flags, exit codes, and the meaning of a non-zero exit.
2. **The file contracts.** `lib/schema/*.json` — the model, the four overlays, and the room
   manifest. These are what another repository's committed files must satisfy.
3. **The generated artifacts' guarantees**, not their pixels: that `forma check` re-derives, that a
   determinism claim holds, that `unknown` never renders as zero.

Explicitly **not** covered, and changeable in a MINOR or PATCH: the visual design of the viewer and
the briefing, prose wording, chart layout, the internal shape of `lib/` modules (Forma exports only
`package.json`), and the exact text of a diagnostic.

| Bump | Triggers |
|---|---|
| **MAJOR** | a command or flag removed or renamed; an exit code's meaning changed; a required field added to a schema, or a field removed; a gate assertion added that fails a repository which was previously passing without any change on its side; the minimum Node version raised |
| **MINOR** | a new command or optional flag; a new optional schema field; a new gate assertion that is opt-in by presence (I11); a new derivation, view or locale |
| **PATCH** | a bug fix that makes an existing behaviour match its documented contract; prose, wording and layout; performance |

## `schemaVersion` is a second, independent register

`c4-model.json` carries its own `schemaVersion` (currently `1.6.0`), and it does not track the
product version. It answers "can this tool read this file", which is a different question from
"what changed in the release". A model written by an older forma must keep loading; that is what
the field exists to make checkable. Forma 1.0 freezes support on schema major 1: every 1.x model
remains readable, while a future major 2 is rejected until a product release explicitly supports it.

The same separation applies to `doc_version` in each document's frontmatter — content versioning,
per document, on its own clock. Three registers, three questions, deliberately not merged.

## Deprecation

A capability is removed only after a release that still ships it while announcing the removal in
`CHANGELOG.md`. Where a flag is dropped, the CLI keeps rejecting it by name for one MAJOR with a
message that says what replaced it — an unknown-option error that does not name the replacement
makes the user read the changelog to recover, which is the manual this product tries not to need.

## Release mechanics

Conventional commits merged into `main` make Release Please open a reviewable release PR with the
next version and changelog. Merging that PR creates the matching tag; the same trusted OIDC workflow
asserts it against `package.json`, runs the full gate, packs it and publishes — no long-lived token.
The 1.0 baseline is bootstrapped once with its exact tag; after a `v1.*` tag exists, Release Please
owns normal bumps. An exact `v<version>` tag remains a recovery path for an already-reviewed release.
The checklist is in [`PUBLISH.md`](../PUBLISH.md) and the security boundary in
[ADR-0003](adr/0003-npm-oidc-trusted-publishing.md).

## Support

The latest MINOR of the current MAJOR receives fixes. Node's own supported LTS lines define the
floor; `engines.node` states it, and CI runs the matrix that proves it.
