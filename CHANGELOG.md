# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-22

### Added
- CLI (`forma`) with `init`, `gen`, `check`, `doc`, `serve`.
- `init`: seed a `c4-topology.json` from real source directories (language-detected, Java-package aware).
- `gen`: walk `src/` leaves + derive container edges from real code references → `c4-model.json`.
- `check`: deterministic anti-drift gate (fails when the model diverges from the code).
- `doc`: project an arc42 scaffold from the model (deterministic C4 diagrams + ADR index; prose stubbed).
- `serve`: local static server for the interactive viewer.
- Stack-agnostic viewer with swappable skins (`holo`, `blueprint`).
- JSON schema contract (`lib/schema/c4-model.schema.json`).

[Unreleased]: https://github.com/LucaDominici/forma/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LucaDominici/forma/releases/tag/v0.1.0
