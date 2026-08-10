---
title: 'Privacy'
doc_version: '1.0.0'
status: active
last_review: '2026-08-10'
owner: 'Luca Dominici'
canonical_id: 'privacy'
tags: ['audience/dev', 'kind/security']
related: ['SECURITY.md', 'docs/GOVERNANCE.md']
---
# Privacy

Forma is a command-line tool that runs on your machine. It has no server, no account, no telemetry
and no analytics. Nothing you run is reported anywhere.

## What Forma reads

Your repository: source files, `git log`, and the JSON and Markdown under `docs/architecture/`.
Everything it produces is written next to that repository, and nothing leaves the machine — with
exactly two exceptions, both of which you invoke deliberately.

## The two ways data leaves your machine

| Command | Where it goes | What is sent | How to avoid it |
|---|---|---|---|
| `forma verify` | GitHub, through **your** `gh` CLI and your own credentials | One `gh issue list` call naming the repository. Forma sends no content of yours; it reads. | Do not run it. Every other command is offline (I2). |
| `gen --enrich --enricher <provider>` | The model provider **you** name | The description holes being filled: node names, file paths, and the surrounding docstrings or README text of the modules concerned. | Omit the flag. Enrichment is off unless you ask for it, and `--enricher agent` keeps it fully local by writing a plan file for an agent you already run. |

`forma room --serve` and `forma serve` bind `127.0.0.1` and serve only to your own machine.

## What Forma stores

Files it is asked to write, and nothing else:

- `docs/architecture/c4-model.json`, `c4-topology.json`, and the optional overlays;
- `docs/architecture/c4-issues.json` — a snapshot of **your** issue tracker: issue numbers, titles,
  states, milestones, labels and dates. Written only by `forma verify`;
- the Control Room HTML, which embeds those same facts plus the documents your manifest names.

Two consequences worth stating plainly:

- **Issue titles are content.** A generated Control Room contains the issue titles and labels of
  every programme in its manifest. Publishing that artifact publishes them. This is why publication
  is a deliberate, still-open decision rather than a default — see
  [`docs/SCOPE-room.md`](docs/SCOPE-room.md) §6.
- **`docs.include` decides what prose travels.** Only git-tracked files matching the globs you
  declare are read, and only the `canon` list is embedded in full. Nothing is picked up implicitly.

## Personal data

Forma does not process personal data as a purpose. It does incidentally carry what your repository
already contains — a commit author date, an issue title someone wrote, a name in a `CODEOWNERS`
file — because it reads those artifacts to derive its answers. It stores no additional record about
any person, builds no profile, and shares nothing.

If you point Forma at a repository whose issue titles contain personal data, the generated briefing
will contain it too. Treat the artifact with the same care as the repository it describes.

## Questions

Open an issue, or see [`SECURITY.md`](SECURITY.md) for anything that should not be public.
