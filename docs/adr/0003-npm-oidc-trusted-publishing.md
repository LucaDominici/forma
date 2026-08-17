---
title: 'ADR-0003: npm OIDC trusted publishing + provenance'
doc_version: '1.1.0'
status: active
last_review: '2026-08-17'
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
Publish via npm trusted publishing (OIDC): `release.yml` uses Release Please to turn conventional
commits on `main` into a reviewable version PR and matching tag. Its publish job has `id-token: write`
and runs `npm publish` with no `NODE_AUTH_TOKEN`; npm issues a short-lived credential and
Sigstore provenance is generated automatically (the repo is public). The deliberately pushed 1.0
tag bootstraps the release history; afterwards exact tags remain a guarded recovery trigger. The
first publish is bootstrapped manually once (OIDC cannot do the first), then
a Trusted Publisher is attached on npmjs.com. See [`PUBLISH.md`](../../PUBLISH.md).

## Consequences
- + No long-lived npm token in GitHub; every release is signed with provenance.
- + Version bumps and changelog entries are reviewable PRs, derived from conventional commits.
- + Dependabot bumps the pinned GitHub Action SHAs (`release.yml` is SHA-pinned).
- − First publish is manual; provenance only after the repo is public and the publisher is attached.
