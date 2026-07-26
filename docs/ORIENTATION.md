# Orientation — what forma does, how it actually does it, what is not wired

> **Audited at `8af203c` (v0.6.0).** Every count in this document is reproducible with the command
> shown next to it. This is not the README: the README says what forma offers, this says what the
> code actually executes, and which of the offered mechanisms nothing in the repo ever reaches.

Read this before changing anything under `lib/`.

> **Delta since the audit commit.** The Go language adapter (PR #18, `7c11e69`, issue #16) landed on
> `main` while this audit was being written. Re-checked against it, line by line:
>
> - **Line numbers shift** — `gen.mjs` +1 to +7 (the new `lang.mjs` import; pass 1 is now `:67`,
>   `STATUS_FIELDS` now `:165`), `describe.mjs` +3 from line 87.
> - **Two rows of §3.3 gain a producer** — `init` now emits `leafSources[].filesOnly`, and
>   `leafSources[].exclude` for Go. They are no longer "wired, never fed".
> - **Everything else holds.** The description chain (§2.3) gained **no** documentary source — zero
>   `descSource` lines changed — so §4's analysis of DoD 1-3 stands as written. `descriptions` is
>   still seeded `{}`; the five unwired flags are still untested and undocumented; nothing validates
>   the schema (`git grep "c4-model.schema" -- lib bin scripts test` → the help text and the schema's
>   own `$id`); CI still never runs the gate.
>
> **Delta since, part 2 — `docmap` (issue #17, first slice).** `lib/docmap.mjs` added the
> documentary source the audit says does not exist, and with it the first deterministic producer of
> programme state. What this changes in the text below:
>
> - **§2.3** gains a step between `node.description` and the docstring for non-leaf nodes, and one
>   between the READMEs and arc42 for leaves: `descSource: 'docmap'`, quoting a capability row from
>   a doc listed in `topo.docSources`. **§4 DoD 1 and DoD 2 are closed** — measured on haben below.
> - **§4 DoD 3 is closed only for repos whose capability table carries a status column.** `gen`
>   derives `status2`/`completion` from those rows; the keyless *agent* channel the section
>   analyses is untouched and still cannot carry state. §3.4 and §5 are otherwise unchanged.
> - **§2.4** gains assertion 8: `check` re-derives the doc-based state and fails on drift, per
>   field, skipping fields the overlay owns.
> - **§3.3** — `descriptions`' key format is now documented (`README.md`), and `docSources` is
>   seeded by `init` from real detection, so it is *not* a new "wired, never fed" row.
> - `firstPara` now strips YAML front matter: haben's `migrations`/`scripts` boxes read prose
>   instead of `--- title: 'haben — README' docversion: '2.1.0'`.
> - Schema `1.4.0` → `1.5.0` (`descSource` enum += `docmap`); shipped files 19 → 20.
>
> **Measured on haben** (`init` → `gen`, 107 nodes): `descSource` was `{curated 1, fallback 104,
> readme 2}` and every node `unknown`. It is now `{curated 1, docmap 50, fallback 54, readme 2}`
> with **50 nodes carrying derived progress**, **25 of 53 containers** reading their own capability
> sentence. `internal/store` (12 rows) and `internal/server` (20) stay on the fallback on purpose —
> see the cap in §2.3.

---

## 1. The purpose

From [issue #17](https://github.com/LucaDominici/forma/issues/17), in the owner's words:

> Forma, applied to a repo, must be usable **instead of PowerPoint** to explain the project to
> stakeholders — without inventing anything, it is material taken from the documents — and in
> particular showing progress graphically: modules done, to do, % complete. Drill-down inevitably
> descends to the implementation level, but only as far as is useful for that purpose.

Four properties follow, and they are the yardstick for the rest of this document:

1. **Big picture first, drill-down on demand** — context → container → component → leaf.
2. **The box text explains, in a non-technical register, what the thing does for the user.**
3. **Nothing is invented**: every sentence comes from a document in the repo, and its provenance is
   recorded (`descSource`).
4. **Progress is visible**: done / in progress / to build, with a percentage, per level.

Forma today delivers (1) fully, (2) and (3) only where the code happens to carry documentation, and
(4) only if a human writes the numbers by hand. §4 maps each gap to the code that causes it.

Issue #16 is the adjacent problem — the *skeleton* (Go packages instead of directories, edges from
`import` blocks instead of name heuristics). This document is about the *flesh*: what is written in
the boxes and what the colours mean.

---

## 2. How it actually works

### 2.1 The shape of the thing

Zero runtime dependencies, no build step, ES modules. `bin/forma.mjs:15` is the whole dispatcher:

```js
const MAP = { init: 'init.mjs', gen: 'gen.mjs', check: 'check.mjs', doc: 'doc.mjs', serve: 'serve.mjs', verify: 'verify.mjs' }
```

Each subcommand is a standalone script spawned as a child process (`bin/forma.mjs:39`) — there is no
shared runtime, no plugin registry, no config loader. Four more modules in `lib/` are libraries, not
commands: `cluster.mjs`, `describe.mjs`, `enrich.mjs`, `render.mjs`.

Two files hold everything:

| File | Written by | Read by | Committed? |
|---|---|---|---|
| `docs/architecture/c4-topology.json` | `forma init` (seed) + a human (curation) | `gen`, `check` | yes |
| `docs/architecture/c4-model.json` | `forma gen`, `forma verify`, `forma doc --attach` | `check`, `doc`, `serve`, the viewer | yes |
| `docs/architecture/c4-status.json` | **nobody** — hand-written | `gen` (`gen.mjs:164`) | yes |

That third row is the single most consequential fact in this document. See §3 and §4.

### 2.2 `gen`, step by step

`lib/gen.mjs` is 302 lines executed top to bottom. The order matters, because each pass consumes the
previous one's output:

| # | Line | Pass | What it decides |
|---|---|---|---|
| 1 | `gen.mjs:66` | curated nodes | context/container/component nodes are copied verbatim from the topology |
| 2 | `gen.mjs:69-84` | live leaves | one leaf per file matching `leafSources[].match`; the parent gets `glob` evidence with a file count |
| 3 | `gen.mjs:87-94` | curated leaves | `topo.curatedLeaves` — mixed-location leaves, optional `countFrom` computed counts |
| 4 | `gen.mjs:97-107` | planned leaves | `topo.plannedLeaves` — fails loud if `sourceMustContain` no longer holds |
| 5 | `gen.mjs:112-121` | §2 clustering | a container with more than `--cluster-min` (8) leaves is split into `component` nodes by shared `foo<-_.>*` prefix (`cluster.mjs:21`) |
| 6 | `gen.mjs:124-137` | defaults | `category`, `status2: 'unknown'`, `target: ''` |
| 7 | `gen.mjs:141-142` | §1a describe | `func` + `descSource` per node (`describe.mjs:81`) |
| 8 | `gen.mjs:149-155` | component prose | a synthesized component composes its text from up to 3 children's first sentences |
| 9 | `gen.mjs:161-187` | WP-A1 overlay | `c4-status.json` decorates nodes by id; **form only** — enums, ranges, known fields, resolvable ids |
| 10 | `gen.mjs:193-214` | §7 enrichment | cache-merge always; `--enrich-apply` then `--enrich` |
| 11 | `gen.mjs:221-249` | auto-edges | for each container, count whole-word references to *another* container's leaf names in its own files; `count > 0` ⇒ an edge |
| 12 | `gen.mjs:273-299` | assemble + write | provenance, `meta`, `levels`, `nodes`, `edges` |

Two decisions in that list are load-bearing and easy to miss:

- **Pass 9 validates form, never prose** (`gen.mjs:161`). `STATUS_FIELDS` is a closed set of seven
  keys; `func` is explicitly refused (`gen.mjs:174`) because what a module *does* comes from its
  documentation, and what it is *worth* is programme state. That separation is correct and is the
  reason the overlay can be trusted.
- **Pass 11 is a name heuristic, not an import parser** (`gen.mjs:243`). It matches a leaf name
  verbatim with `(^|[^\w-])name([^\w-]|$)`. Language-agnostic, additive, and — per #16 — wrong for
  any language that declares its dependencies explicitly.

### 2.3 The description chain (`describe.mjs:81`)

This is where issue #17's first requirement lives. One chain, applied identically to every node
kind, first hit wins:

| Order | Source | Line | `descSource` |
|---|---|---|---|
| 1 | `topo.descriptions[<containerId>/<stem>]` | `describe.mjs:85` | `curated` |
| 2 | `node.description` (from the topology) | `describe.mjs:86` | `curated` |
| 2b | **capability rows from `topo.docSources`, non-leaf only** | `describe.mjs` (`fromDocs`) | `docmap` |
| 3 | module docstring — Python `"""…"""`, JS/TS leading block or `//` run | `describe.mjs:87-91` | `docstring` |
| 4 | `README.md` in the file's directory | `describe.mjs:92-93` | `readme` |
| 5 | `README.md` in the container's glob directory | `describe.mjs:97-101` | `readme` |
| 5b | **the same capability rows, now for leaves** | `describe.mjs` (`fromDocs`) | `docmap` |
| 6 | arc42 section whose heading normalizes to the node's name or id | `describe.mjs:102` | `arc42` |
| 7 | `Component of module X.` for leaves (`:106`); a measured child count otherwise (`:108`) | `describe.mjs:104-108` | `fallback` |

Steps 2b and 5b are **the same source at two priorities**, and that asymmetry is the whole point:
above the leaf the document outranks the code, at the leaf the code outranks the document. Steps
3-5 are code-first, which is right for a file and wrong for a container.

`docmap.MAX_ROWS = 3` guards the join. A node named by more rows than that is not described by the
matrix, only touched by it — on haben `internal/store` is referenced by 12 rows and
`internal/server` by 20, and stitching their first sentences together would state a purpose no
document states. Past the cap the step yields nothing, for the text and for the derived state
alike, and the rest of the chain runs.

### 2.4 `check` — what the gate actually asserts

`lib/check.mjs`, in order, collecting all failures before exiting:

| # | Line | Assertion |
|---|---|---|
| 1 | `check.mjs:29-30` | `schemaVersion` is semver-shaped; at least one node |
| 2 | `check.mjs:41-46` | **independently re-walks `src/`** and compares live file counts to the model per container |
| 3 | `check.mjs:53-65` | optional `countChecks` — a regex count in a source file vs the model, and vs a number claimed in a doc |
| 4 | `check.mjs:68` | every `path` evidence still exists |
| 5 | `check.mjs:71-74` | `plannedLeaves` premises still hold |
| 6 | `check.mjs:84-101` | the injected `forma:begin/end` block in `docPath` **and every doc in `source.attachedDocs`** matches a fresh render |
| 7 | `check.mjs:105-109` | the status overlay decorates no id the model has lost |
| 8 | `check.mjs` (doc drift) | doc-derived `status2`/`completion` are **re-derived from the document** and must match the model, per field, except where the overlay owns the field |
| 9 | `check.mjs:113-117` | *soft warning only* — LLM prose whose input hash moved |

Assertion 2 is the real gate: it does not trust the model, it recomputes the truth. Note what is
**not** here: the model is never validated against `lib/schema/c4-model.schema.json` (§5.1).

### 2.5 The viewer

`lib/viewer/c4-hologram.html` — one file, 746 lines, ES5 style, no dependencies, no build. It boots
from `window.__C4_MODEL__` if present, else fetches `./c4-model.json` (`:736-738`).

- `draw()` (`:324`) renders one C4 level: children of `stack[top]`, laid out by `seedLayout` (curated
  `meta.layout` pins, `:286`) or `autoLayout` (`:300`), with a fit-to-content viewBox (`:351-366`).
- The box text is `n.current || n.func` in CURRENT mode and `n.target || n.func` in TARGET mode
  (`:382`). The badge is `n.statusWord || n.completion% || "?"` (`:383`).
- The colour is `STMAP[n.status2]` (`:227`), six states including the neutral `unknown`.
- The breadcrumb carries the per-level tally — a dot per status with counts, plus mean completion
  (`:420-431`). **That tally is the "progress bar" issue #17 is asking for**, and it is already
  built; it renders whatever the model carries.

---

## 3. Orphan inventory

Five verdicts, because the owner's three do not cover everything found:

| Verdict | Meaning |
|---|---|
| **dead** | no producer, no consumer, nothing would notice its removal |
| **not wired** | it works, nothing in the repo routes to it |
| **wired, never fed** | the *consumer* exists and is correct; the *producer* is missing — the owner's category |
| **producer, no consumer** | it is written on every run; nothing ever reads it |
| **contract surface** | schema vocabulary for third-party generators; unexercised by forma is not the same as wrong |

Counts below are from the repo root at `8af203c`. `lib+bin` counts quoted-literal occurrences in
`lib/` and `bin/`; `test` counts them in `test/run.mjs`; `README` counts them in `README.md`.

### 3.1 Exported symbols (`grep -rn "^export " lib/*.mjs` → 18)

`package.json:30` exposes only `./package.json`, so nothing outside the repo can import `lib/*`.
An export with no sibling importer is therefore pure surface.

| Symbol | Defined | Importers | Call sites | Verdict |
|---|---|---|---|---|
| `containerOf` | `cluster.mjs:10` | 3 (`gen`, `check`, `render`) + passed into 2 ctx objects | 5 | wired |
| `componentsFor` | `cluster.mjs:21` | 1 (`gen`) | 1 | wired |
| `makeDescribeCtx`, `resolveDescription` | `describe.mjs:76,81` | 1 (`gen`) | 1 each | wired |
| `descInputHash` | `enrich.mjs:23` | 1 (`check`) | 1 external + 4 internal | wired |
| `loadCache`, `mergeCache`, `agentPlan`, `applyFills`, `enrich` | `enrich.mjs:93-144` | 1 (`gen`) | 1 each | wired |
| **`holesIn`** | `enrich.mjs:115` | **0** | 2, both inside `enrich.mjs` | **export with no importer** |
| **`BEGIN`, `END`** | `render.mjs:9-10` | **0** | 3 each, all inside `render.mjs` | **export with no importer** |
| `renderParts`, `renderBlock`, `norm`, `extractBetween`, `replaceBetween` | `render.mjs:13-67` | `doc` and/or `check` | 1-2 each | wired |

Note: `render.mjs:57` exports `norm` (whitespace normalizer for block comparison) and
`describe.mjs:8` defines a *private, different* `norm` (lowercase+trim for heading lookup). Same
name, different contract, in modules that sit next to each other.

### 3.2 Commands and flags

All six commands are dispatched, documented in `README.md:28-36` and listed in `bin/forma.mjs:26-31`.
The flags are another matter:

| Flag | Defined | lib+bin | test | README | Verdict |
|---|---|---|---|---|---|
| `--repo`, `--out`, `--model`, `--topology`, `--force` | all commands | 7/3/3/2/1 | 70/46/25/51/12 | 0 | wired (test-driven; deliberately not in the README) |
| `--attach` | `doc.mjs:74` | 1 | 3 | 2 | wired |
| `--enrich`, `--enricher`, `--enrich-apply` | `gen.mjs:20-25` | 1 each | 8/7/3 | 6/2/1 | wired |
| `--cluster-min`, `--group-min` | `gen.mjs:33` | 1 | 2/3 | 1 each | wired |
| `--gh-repo`, `--gh-cmd` | `verify.mjs:14-20` | 1 each | 3 each | 1/0 | wired |
| `--status <path>` | `gen.mjs:23-24` | 2 | **0** | 1 | wired; only the *default* path is tested |
| `--no-cluster` | `gen.mjs:19` | 1 | **0** | 1 | wired, untested |
| `--skip-tests`, `--include` | `init.mjs:17-18` | 1 each | **0** | **0** | wired, untested, README-invisible |
| `--enrich-model` | `gen.mjs:22` | 1 | **0** | **0** | not wired — no test, no doc, no caller |
| `--no-auto-edges` | `gen.mjs:221` | 1 | **0** | **0** | not wired — the one switch that turns off the heuristic #16 complains about, and nothing mentions it |
| `--limit` | `verify.mjs:15` | 2 | **0** | **0** | not wired |
| `--port` | `serve.mjs:10` | 1 | **0** | **0** | not wired — `README.md:34` hardcodes `4173` as if it were fixed |
| **`--from-docs`** | `gen.mjs:286-298` | 1 | **0** | **0** | **producer, no consumer** — see below |

**`--from-docs` in detail.** It sets three fields and nothing reads any of them:

```
$ node bin/forma.mjs gen --out /tmp/fd.json --from-docs
[gen-c4] --from-docs: 0 planned milestone(s), 3/4 ADR accepted
meta.docTargets= []   meta.adr= {"total":4,"accepted":3}
meta.verifyMethod= "from-docs (project-status milestones + ADR statuses)"
```

- `meta.docTargets` (`gen.mjs:293`) and `meta.adr` (`gen.mjs:294`): `grep -rn "docTargets\|meta\.adr"` →
  1 hit each, the assignment itself. The viewer never reads them; `render.mjs` never reads them.
- `meta.verifyMethod` **is** read — the viewer prints it in the fact-base stamp (`viewer:712`). So the
  one observable effect of the flag is to make the stamp advertise a verification method whose two
  outputs are invisible.
- It hardcodes `docs/project-status.md` (`gen.mjs:288`) and a `| M1 | PLANNED | … |` table regex.
  `CONTRIBUTING.md` says: *"Nothing may hardcode one project's node ids, dirs, or stack."*
- Its ADR scanner (`gen.mjs:292`) excludes only `template`, while the ADR index renderer
  (`render.mjs:39`) excludes `readme|template`. On this repo that is 4 ADRs vs 3 — `--from-docs`
  counts `docs/adr/README.md` as an ADR.

### 3.3 Configuration and model fields

**Topology** (`c4-topology.json`):

| Field | Read at | Written by | Verdict |
|---|---|---|---|
| `nodes`, `leafSources`, `edges`, `levels`, `docPath`, `meta.repo/stack` | `gen`, `check`, `render` | `init` + curation | wired |
| `layout` | `gen.mjs:279` → viewer `:286` | curation (present in this repo) | wired |
| **`descriptions`** | `describe.mjs:85` — **highest priority in the whole chain** | `init` seeds `{}`; this repo has `{}`; 0 fixtures; 0 tests | **wired, never fed** |
| **`curatedLeaves`** (+ `countFrom`) | `gen.mjs:87-94` | nothing; 0 tests; 0 docs | **wired, never fed** |
| **`plannedLeaves`** (+ `sourceRef`, `sourceMustContain`) | `gen.mjs:97-107`, `check.mjs:71-74` | nothing; 0 tests; 0 docs | **wired, never fed** |
| **`countChecks`** | `check.mjs:53-65` | nothing; 0 tests; documented only in the comment above it | **wired, never fed** |
| **`leafSources[].exclude` / `.filesOnly`** | `gen.mjs:44-47`, `check.mjs:35-37` | `init` never emits either | **wired, never fed** |
| **`meta.ghRepo`** | `verify.mjs:20` | `init` never writes it; this repo's topology does not set it | **wired, never fed** |
| **`meta.lang`** | viewer `:219` | nothing, anywhere | **wired, never fed** |
| **`meta.skin`** | viewer `:723` | nothing, anywhere | **wired, never fed** |
| `meta.title` | viewer `:720` | this repo's topology | wired |
| `_skipped` | only `test/run.mjs:94` | `init.mjs:102` | informational; not carried into the model |

The `descriptions` key format is **undocumented anywhere** — not in the README, not in AGENTS.md, not
in the schema. Verified empirically on the `mini` fixture:

| Key | Effect |
|---|---|
| `core/alpha` | leaf `alpha` in container `core` → `descSource: curated` ✅ |
| `core/core` | the container itself (a container is its own container) → `descSource: curated` ✅ |
| `util` | ignored — falls through to `fallback` ❌ |

So the one documentary channel that outranks the code requires a hand-written map, one entry per
node, keyed by a convention nobody wrote down. That is the mechanism issue #17 needs, and it has
never been fed once — including by forma on forma.

**Model** (`c4-model.json`):

| Field | Written | Read | Verdict |
|---|---|---|---|
| **`evidence[].count`** | `gen.mjs:83`, on every container's glob evidence | **nobody** | **producer, no consumer** — the schema calls it a *"drift anchor"* (`schema:162`), but `check.mjs:41-46` re-walks the filesystem instead and never looks at it |
| **`edges[].status`** | `gen.mjs:282` (`'current'` on every edge) | the viewer reads `estatus` only (`:371`) | **producer, no consumer** |
| `source.branch`, `source.generator` | `gen.mjs:276` | nobody (the test strips `branch` as volatile) | producer, no consumer (harmless provenance) |
| `node.target` | `gen.mjs:136` — `''` for every node | viewer `:382`, skipped when empty | 4 of 25 nodes carry text; TARGET STATE is mostly blank |
| `node.issues` | overlay only | `verify.mjs:27`, viewer `:475` | **0 nodes carry any** — see §3.5 |

**Schema vocabulary never produced by forma** — *contract surface*, not dead code: the schema
declares itself a contract for any generator (`schema:5`), so unexercised is not the same as
useless. Listed so nobody mistakes them for live features: `node.drill`, `node.link`, `node.meta`,
`edges[].level`, `edges[].evidence`, `kind: store|boundary`, `status: partial|deprecated|unknown`.

And the sharp finding, separate from the above: **nothing validates against the schema.**
`grep -rn "c4-model.schema" bin lib scripts test .github` returns only prose mentions — the file is
never loaded by any code path. See §5.1.

### 3.4 Viewer features vs. data `gen` can produce

| Feature | Code | Data it needs | Reality |
|---|---|---|---|
| **Catalogue collapse + searchable roster** | `:238-276`, `:481-505`, CSS `:102-113`, 4 i18n strings | >24 childless siblings **sharing a `category`** | **wired, never fed, and mis-fed when it does fire.** `gen.mjs:126` gives every leaf its *parent's* category, so all 15 leaves in this repo's model carry `category: "container"`. Feeding 25 such leaves to the shipped `collapseCatalogs` collapses them into **one** box named `container`; give them two real categories and you get 25 boxes back. No test, no fixture, never triggered. |
| TARGET STATE mode | `:571`, `:382` | `node.target` | overlay-only; 4/25 nodes have text |
| Detail "Issue" row | `:475` | `node.issues` | 0/25 — never renders |
| `statusWord` badge | `:383` | overlay-only | 10/25 |
| `problem` state (`.s-prob`, red) | `:61`, `:227` | `status2: "problem"` | only a hand-written overlay can produce it |
| **`it` locale** | `:195-214`, parity enforced by `test/run.mjs:487-493` | `meta.lang` or `?lang=it` or `window.__C4_LANG__` | **no repo artifact ever selects it** — reachable only by typing `?lang=it` in the URL |
| `window.__C4_MODEL__/__C4_LANG__/__C4_SKIN__/__C4_API__` | `:219,:723,:728,:736` | an embedder | *declared planned* — the `boards` context node is `status: planned` in the model itself. Not a hidden orphan. |
| **RE-VERIFY** button | `:572-579` | — | re-**reads** `./c4-model.json`; it does **not** run `forma verify`. The label promises more than the handler does. |

### 3.5 `adapters/`, `scripts/`, `docs/`

| Path | Reached by | Verdict |
|---|---|---|
| `adapters/claude/SKILL.md` | `README.md:81`, `c4-status.json` `verify.source` | **not wired for distribution** — excluded by both `.npmignore` and `package.json:33 files`, so no npm consumer can install it; usable only from a clone. No installer, no `skills/` path. |
| `scripts/lint.mjs` | `npm run lint`, CI | wired — but its file list (`lint.mjs:8`) is `bin/forma.mjs` + `lib/*.mjs` + `scripts/lint.mjs` + `test/run.mjs`, which **omits `scripts/check-clean.mjs` and `test/stub-gh.mjs`**: two shipped-adjacent scripts the syntax check never sees |
| `scripts/check-clean.mjs` | `prepack` only | wired. `AGENTS.md:27` claims *"`npm pack --dry-run` must stay at the 17 shipped files"* — that count is **not enforced** by anything (it happens to be 17 today) |
| `docs/architecture/ARCHITECTURE.md` | `model.source.docPath` | **wired, never fed.** It contains **zero** `forma:begin/end` markers, so `source.attachedDocs` is empty and `check.mjs:84-101` skips it entirely. Its container table (`ARCHITECTURE.md:65-70`) is hand-maintained and ungoverned — forma's flagship "one source of truth" feature is not applied to forma's own architecture doc. |
| `docs/architecture/ARCHITECTURE.scaffold.md` | — | gitignored, present on disk; the untracked output of `forma doc` |
| `docs/social-preview.png` | nothing | tracked but unreferenced — `LAUNCH.md:8` points at `forma-social-preview.png`, an *untracked* file at the repo root |
| `LAUNCH.md` | nothing | references `GITHUB_ABOUT.md` (does not exist), a README GIF and README badges (the README has neither) |
| `.github/workflows/ci.yml` | GitHub | runs `npm run lint` + `npm test`. **It never runs `forma gen` or `forma check`.** `grep -rn "forma check\|check\.mjs\|bin/forma" .github` → 2 hits, both prose in comments |

**On the dogfood gate.** The committed model is *currently* fresh — regenerating it to a scratch path
and diffing yields exactly three paths, all volatile:

```
$ node bin/forma.mjs gen --out /tmp/model.json
$ diff-paths(committed, regenerated) → generatedAt, source.commit, source.branch
```

So this is not "the demo is stale"; it is "nothing would tell you if it were". `pages.yml:4` states
it outright in a comment: *"Drift-check (forma check) is a local responsibility"* — and it deploys
`docs/architecture/c4-model.json` to Pages as-is on every push to `main`.

---

## 4. What is missing for the purpose

Keyed to the Definition of Done in issue #17, with the code-level blocker for each.

### DoD 1 — a documentary source before the code, for context and container, with `descSource` declaring it

**Blocker:** `resolveDescription` (`describe.mjs:81-108`) is one chain applied identically to every
node kind, and only two of its seven steps precede the code:

- Step 1, `topo.descriptions` — the right channel, keyed `<containerId>/<stem>`, undocumented, empty
  in every fixture and in this repo (§3.3).
- Step 2, `node.description` — works, and is the only reason this repo's containers read
  `descSource: curated` at all. It is hand-written in the topology, one node at a time.
- Step 6, the arc42 branch (`describe.mjs:102`) — fires only when a heading's *normalized text equals
  a node's name or id*. It does work: a doc with `# core` gives container `core`
  `descSource: arc42`. But the numbered scaffold that **`forma doc` itself writes** — `## 3. Context
  and Scope` — can never match a node name. The tool's own generator guarantees its own resolver
  branch cannot fire on its own output.

There is no reader for a feature matrix, a spec, or a requirements document. Nothing to extend —
this source does not exist yet.

### DoD 2 — on a repo with a feature matrix, containers inherit non-technical prose

**Blocker:** the same. The only documentary channel that outranks code (`descriptions`) demands one
hand-written entry per node under an undocumented key. On haben, #17 measured the result:
`"Component of module haben."` on 43 of 44 nodes — that is step 7, `describe.mjs:106`, the leaf
fallback, doing exactly what it was written to do because steps 1-6 all missed.

### DoD 3 — the progress overlay must be *generable*, not only hand-writable

This is the one the owner named, and it is the sharpest gap in the repo.

**The consumer is complete and correct.** `gen.mjs:161-187` reads `c4-status.json`, validates seven
fields, rejects unknown ids, bad enums, out-of-range completions, malformed issue numbers, and
refuses `func` outright. `check.mjs:105-109` fails when the overlay goes stale. The viewer renders
all of it, tally included (`viewer:420-431`).

**There is no producer.** No command writes `c4-status.json`. `grep -rn "c4-status" lib bin` returns
the default-path constant (`gen.mjs:23`) and a comment — every occurrence in the engine is on the
read side. `init` does not scaffold it, `doc` does not project it, `verify` updates the *model* and
never the overlay.

**And the keyless channel #17 proposes to extend cannot carry it as it stands.** The agent path is
prose-only by construction:

- `agentPlan` (`enrich.mjs:123`) emits `{ id, prompt, descInputHash }` — the prompt asks for *"ONE
  plain sentence (max 18 words)"* (`enrich.mjs:47`).
- `applyFills` (`enrich.mjs:129-139`) writes exactly three fields — `func`, `descSource`,
  `descInputHash` — and **throws** if the target node is described by anything other than
  `fallback`/`llm`.
- The overlay vocabulary `STATUS_FIELDS` (`gen.mjs:161`) — `status2`, `completion`, `statusWord`,
  `current`, `target`, `verify`, `issues` — is **disjoint** from those three.

So extending "fill the prose holes" into "read the project documents and produce the overlay" is not
a matter of a better prompt: the plan format, the fill format and the apply function would all need
a second, status-shaped channel. The validation to receive it already exists; the writer does not.

**The one existing generator of state is also unfed.** `forma verify` (`verify.mjs`) derives
`status2: done` + `completion: 100` from closed GitHub issues — genuinely generated progress. It
needs `node.issues`, which only the hand-written overlay supplies, and `meta.ghRepo`, which `init`
never writes. On this repo: **0 nodes carry an issue**, so `verify` exits at `verify.mjs:34` with
*"no issue references in the model — nothing to verify"*. The only command that can generate
progress from reality is a no-op on the flagship repo.

### DoD 4 — the tally shows real progress and stays `unknown` when it truly is unknown

The honest default landed in 0.6.0 and works. What it exposes is the emptiness above:

| Level | Nodes | Decorated | `unknown` |
|---|---|---|---|
| context + container | 10 | 10 | 0 |
| leaf | 15 | 0 | **15** |

The top two levels read as a programme board because someone hand-wrote ten overlay entries. Drill
one level down and every box is `?`. A stakeholder who drills — which is the entire premise — lands
on a screen with no progress on it.

### DoD 5 — `check` keeps failing when the model and the code diverge

The gate itself is intact: it passes on `8af203c`, and the fixtures prove it fails on drift (a stale
doc block, a tampered attached doc, a deleted marker, a stale overlay id — `test/run.mjs:176-206`,
`:294`). Nothing in §4 weakens it.

Its problem is **reach**, not strength:

1. CI never runs it (§3.5). The gate that is the product is not applied to the product.
2. It never validates the model against the schema (§5.1).
3. The doc it exists to govern — `ARCHITECTURE.md` — carries no markers, so it is out of scope
   (§3.5).

---

## 5. Where the code contradicts the stated intent

1. **`docs/architecture/ARCHITECTURE.md:108`** — *"**Validation:** the model is validated against
   `lib/schema/c4-model.schema.json` (JSON Schema)."* Nothing validates anything. The schema is
   never read by any code path in the repo. This is the flattest documented-intent-vs-code
   contradiction in the project, and it sits in the architecture document forma generates about
   itself.
2. **`lib/schema/c4-model.schema.json:162`** — `evidence[].count` is described as a *"drift anchor"*.
   It is written on every run and read by nothing; `check` re-walks the filesystem instead.
3. **`AGENTS.md:30`** — *"`forma check` fails if that model drifts from the code."* True of the
   command, false of the repo: no automation runs it (§3.5).
4. **`AGENTS.md:27`** — *"`npm pack --dry-run` must stay at the 17 shipped files"* — unenforced;
   `check-clean.mjs` only greps for editor artifacts.
5. **`CONTRIBUTING.md`** — *"Nothing may hardcode one project's node ids, dirs, or stack"* vs
   `gen.mjs:288`, which hardcodes `docs/project-status.md` and a milestone-table regex.
6. **`README.md:37`** — *"…else a mapped arc42 section"* is listed as a normal step of the chain. It
   can only fire on a heading literally named after a node, which the arc42 scaffold `forma doc`
   writes never is (§4, DoD 1).
7. **`README.md:34`** — `forma serve` is presented as fixed at port 4173; `--port` exists and is
   undocumented.
8. **Two ADR scanners disagree** — `render.mjs:39` (3 ADRs) vs `gen.mjs:292` (4, counting
   `docs/adr/README.md`).
9. **`LAUNCH.md`** — a playbook that references `GITHUB_ABOUT.md`, a README GIF and README badges,
   none of which exist in the repo.

### Dead code found and deliberately left in place

`HERE` is computed and never used in `gen.mjs:13` and `check.mjs:13`; `basename` is imported and
never used in `gen.mjs:6`. Removing them also orphans `fileURLToPath` in both files and `dirname` in
`check.mjs:7`. Left untouched on purpose: `gen.mjs` was being rewritten concurrently for #16 when
this audit ran, and a three-line cleanup is not worth a conflict inside someone else's diff.

---

## Appendix — reproducing the counts

```sh
# exported symbols and their importers
grep -rn "^export " lib/*.mjs
grep -rn "from '\./" lib/*.mjs

# per-flag references (lib+bin / test / README)
for f in --from-docs --no-auto-edges --enrich-model --limit --port; do
  printf "%-16s lib=%s test=%s readme=%s\n" "$f" \
    "$(grep -rn -F -- "'$f'" lib bin | wc -l)" \
    "$(grep -rn -F -- "'$f'" test/run.mjs | wc -l)" \
    "$(grep -o -F -- "$f" README.md | wc -l)"
done

# fields nobody reads
grep -rn "docTargets\|meta\.adr\|verifyError" bin lib test .github     # 3 hits, all assignments

# nothing validates the schema
grep -rn "c4-model.schema" bin lib scripts test .github                # prose only

# CI never runs the gate
grep -rn "forma check\|check\.mjs\|bin/forma" .github                  # 2 hits, both comments

# the committed model is fresh (but unenforced)
node bin/forma.mjs gen --out /tmp/forma-model.json                     # then diff, ignoring
                                                                       # generatedAt/commit/branch

# self-model composition
node -e "const m=require('./docs/architecture/c4-model.json');
  const c=(f)=>m.nodes.reduce((a,n)=>(a[f(n)]=(a[f(n)]||0)+1,a),{});
  console.log(c(n=>n.descSource), c(n=>n.status2), 'issues:', m.nodes.filter(n=>n.issues).length)"
```
