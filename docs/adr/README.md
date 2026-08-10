---
title: 'Architecture Decision Records'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'adr-index'
tags: ['audience/dev', 'kind/reference']
related: ['docs/GOVERNANCE.md']
---
# Architecture Decision Records

Decisions for Forma. Each ADR is immutable once Accepted; supersede one by writing a new ADR
that links back to it. Newest last.

| ID | Decision | Status |
|---|---|---|
| [0001](0001-zero-dependency-esm.md) | Zero-dependency Node ESM CLI | Accepted |
| [0002](0002-single-source-of-truth-model.md) | One `c4-model.json` as single source of truth | Accepted |
| [0003](0003-npm-oidc-trusted-publishing.md) | Publish via npm OIDC trusted publishing + provenance | Accepted |
| [0004](0004-control-room-as-a-forma-rendering.md) | Control Room as a Forma rendering, not a second product | Accepted |
| [0005](0005-portfolio-briefing-over-per-repo-dashboard.md) | A portfolio briefing, not a per-repository dashboard | Accepted |
| [0006](0006-traceability-as-a-derivation-not-an-overlay.md) | Traceability derived from the documents, not curated into a file | Accepted |
| [0007](0007-views-nested-under-the-briefing.md) | Views nested under the briefing, not instead of it | Accepted |
