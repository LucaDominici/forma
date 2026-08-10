---
title: 'ADR-0003: npm OIDC trusted publishing + provenance'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: '0003'
tags: ['audience/dev', 'kind/adr']
related: ['docs/adr/README.md']
---
# ADR-0003: npm OIDC trusted publishing + provenance

- **Status:** Accepted (2026-07-22)

## Context
Releases should be signed and reproducible without a long-lived npm token sitting in CI.

## Decision
Publish via npm trusted publishing (OIDC): the `release.yml` workflow (trigger: tag `v*`) has
`id-token: write` and runs `npm publish` with no `NODE_AUTH_TOKEN`; npm issues a short-lived
credential and Sigstore provenance is generated automatically (the repo is public). The first
publish is bootstrapped manually once (OIDC cannot do the first), then a Trusted Publisher is
attached on npmjs.com. See [`PUBLISH.md`](../../PUBLISH.md).

## Consequences
- + No long-lived npm token in GitHub; every release is signed with provenance.
- + Dependabot bumps the pinned GitHub Action SHAs (`release.yml` is SHA-pinned).
- − First publish is manual; provenance only after the repo is public and the publisher is attached.