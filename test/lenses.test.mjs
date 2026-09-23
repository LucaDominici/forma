#!/usr/bin/env node
// The lens ontology: derived-vs-read partitioning, ownership boundaries, and the locale tables
// each lens draws its strings from.
import test, { describe } from "node:test";

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  deriveAll,
  deriveMilestonePath,
  deriveMilestoneReconciliation,
  deriveUseCases,
  deriveRunbooks,
} from "../lib/roomderive.mjs";
import { codepointCompare } from "../lib/evidence.mjs";
import { lensDrift } from "./fixtures/control-room-stress/make.mjs";
import {
  DERIVED_KEYS,
  LENSES,
  SHELL_OWNS,
  UNRENDERED,
  derivedLenses,
  derivedReads,
  ownershipViolations,
  scriptRegions,
  unpartitionedReads,
} from "../lib/lenses.mjs";

import { HERE, BIN, freshTmp, run, die, readJson } from "./helpers.mjs";

const tmp = freshTmp();

describe("lenses", () => {
  // §ontology-lenses — use cases and runbook coverage, the two surfaces wave 8 gave a home (#2480).
  //
  // Both arrive as arbiter projections, and the discipline is the one the milestone seam established:
  // forma derives what it can SEE and restates nothing arbiter already decided. Two properties are
  // computed here because they are questions about the SET, which no row can answer alone — and one
  // property is deliberately NOT computed, because arbiter already proved it.
  test("lenses: ontology-lenses", async () => {
    const ucDoc = (useCases) => ({ schema: "arbiter-use-cases-v1", useCases });
    const uc = (id, over = {}) => ({
      id,
      actor: "Traveler",
      goal: "do a thing worth doing",
      featureIds: ["F-A"],
      exercisedBy: [],
      ...over,
    });

    // The measurement travels; forma does not recompute the join.
    {
      const d = deriveUseCases(ucDoc([uc("UC-01", { status: "linked", exercisedBy: ["1. A journey"] })]));
      if (d.rows[0].exercisedBy.length !== 1) die("use-cases: exercisedBy must pass through untouched");
      if (d.rows[0].status !== "linked")
        die("use-cases: the declared status must survive even when it disagrees with the walk");
      if (d.exercised !== 1) die("use-cases: a walked use case counts as exercised");
    }

    // The rule arbiter's gate CANNOT report: a use case that never claimed `exercised` and that no
    // scenario walks. The gate only fails a row that made the claim, so this surface is the only
    // place the silent case shows.
    {
      const d = deriveUseCases(ucDoc([uc("UC-01"), uc("UC-02", { exercisedBy: ["1. J"] })]));
      if (d.unexercised.join() !== "UC-01") die("use-cases: an unwalked use case must be named");
      if (d.exercised !== 1 || d.total !== 2) die("use-cases: exercised/total wrong");
    }

    {
      const d = deriveUseCases(ucDoc([uc("UC-02", { actor: "Ops", featureIds: ["F-B", "F-A"] }), uc("UC-01")]));
      if (d.rows.map((r) => r.id).join() !== "UC-01,UC-02") die("use-cases: rows must sort by id");
      if (d.featuresReached.join() !== "F-A,F-B") die("use-cases: featuresReached must be the sorted union");
      if (d.actors.join() !== "Ops,Traveler") die("use-cases: actors must be the sorted distinct set");
    }

    // Absent and empty are different claims (I6/I7): no projection means the lens does not publish;
    // an empty projection means the programme declares none, which is a fact worth rendering.
    if (deriveUseCases(null) !== null) die("use-cases: an absent projection derives null, not an empty set");
    if (deriveUseCases({ schema: "x" }) !== null) die("use-cases: a projection with no array derives null");
    {
      const d = deriveUseCases(ucDoc([]));
      if (d === null || d.total !== 0) die("use-cases: an EMPTY projection is a declaration, not an absence");
    }

    const rbDoc = (runbooks, coverage) => ({ schema: "arbiter-runbooks-v1", runbooks, coverage });

    // The uncovered LIST, not its length: a number cannot say which failure has no procedure.
    {
      const d = deriveRunbooks(rbDoc([{ id: "RB-01", file: "a.md", handles: ["INV-74"] }], { operationalTotal: 49, uncovered: ["INV-17", "INV-16"] }));
      if (d.uncovered.join() !== "INV-16,INV-17") die("runbooks: the uncovered list must survive, sorted");
      if (d.coveredCount !== 47) die("runbooks: coveredCount must be total minus uncovered");
    }

    // A total arbiter did not declare must NOT become zero: "no procedures at all" and "the projection
    // did not say" are different claims, and a percentage invented from the second is undetectable.
    {
      const d = deriveRunbooks(rbDoc([{ id: "RB-01", file: "a.md", handles: ["INV-1"] }], {}));
      if (d.operationalTotal !== null || d.coveredCount !== null)
        die("runbooks: an undeclared operational total must stay null, never 0");
    }

    // The other direction. arbiter's gate already fails a runbook handling nothing, so this should
    // always be empty — derived anyway, because a surface that can only display agreement cannot
    // show a disagreement.
    {
      const d = deriveRunbooks(rbDoc([{ id: "RB-02", file: "b.md", handles: [] }], { operationalTotal: 1, uncovered: [] }));
      if (d.orphans.join() !== "RB-02") die("runbooks: a runbook handling nothing must be named");
    }

    if (deriveRunbooks(null) !== null) die("runbooks: an absent projection derives null");
    {
      const d = deriveRunbooks(rbDoc([], { operationalTotal: 5, uncovered: ["INV-1"] }));
      if (d === null || d.total !== 0 || d.uncovered.length !== 1)
        die("runbooks: no runbooks with uncovered invariants is the WORST case, not an absent one");
    }

    // Both surfaces must reach a viewer through deriveAll, or the lens has a home for nothing.
    {
      const out = deriveAll({
        repo: HERE, model: null, topo: null,
        issuesSnapshot: { issues: [], milestones: [], fetchedAt: "2026-01-01", collection: {}, dependencies: { supported: false, edges: [] } },
        health: { verdicts: [], dependencyConfirmations: [] }, findings: { findings: [] },
        brief: null, briefPath: null, manifest: { today: "2026-01-01" },
        gateInputs: null, arbiterMilestones: null, docs: null,
        arbiterUseCases: ucDoc([uc("UC-01")]),
        arbiterRunbooks: rbDoc([{ id: "RB-01", file: "a.md", handles: ["INV-1"] }], { operationalTotal: 2, uncovered: ["INV-2"] }),
      });
      if (!out.useCases || out.useCases.total !== 1) die("use-cases: deriveAll must expose the surface");
      if (!out.runbooks || out.runbooks.uncovered.length !== 1) die("runbooks: deriveAll must expose the surface");
    }

    // Publication is per programme on backing artifacts (I7): a programme with neither projection
    // must not publish a route that renders three zeros.
    {
      const traceability = LENSES.find((l) => l.id === "traceability");
      const operations = LENSES.find((l) => l.id === "operations");
      if (traceability.publishes({ derived: { useCases: { total: 1 } } }) !== true)
        die("lenses: traceability must publish on use cases alone");
      if (operations.publishes({ derived: { runbooks: { total: 1 } }, issuesSnapshot: null }) !== true)
        die("lenses: operations must publish on runbooks alone");
      if (operations.publishes({ derived: {}, issuesSnapshot: null }) !== false)
        die("lenses: operations must NOT publish with neither signals nor runbooks");
    }

    console.log(
      "  ok ontology-lenses — use cases and runbook coverage derived from arbiter's projections, " +
        "the measurement passed through and the unwalked named",
    );
  });

  // §lenses — the declared lens partition, and I20: one home per derived surface (#2480 wave 7).
  //
  // ADR-0008 named six lenses and said the partition "is only real if it is enforced". A partition
  // that lives in ~400 lines of DOM code is a convention: two views read `derived.commitDrift`, one
  // of them says so in a comment, and nothing goes red. So the partition is DECLARED in lib/lenses.mjs
  // and MEASURED out of the viewer, and the two must agree exactly — an unread declaration is a lie
  // in the other direction, so the check refuses that too.
  test("lenses: lenses", async () => {
    const HTML = readFileSync(join(HERE, "..", "lib", "viewer", "control-room.html"), "utf-8");
    const ids = LENSES.map((l) => l.id);

    // The table is the IA. Portfolio plus six lenses, one question each (owner decision 5).
    if (ids.length !== 7) die("lenses: expected portfolio + 6 lenses, got " + ids.join(", "));
    if (ids[0] !== "portfolio") die("lenses: the portfolio is the entry route and must come first");
    for (const lens of LENSES) {
      if (!lens.question) die(`lenses: ${lens.id} has no question — a lens without one is a drawer`);
      if (typeof lens.publishes !== "function") die(`lenses: ${lens.id} has no publication predicate`);
    }

    // Every region the analyzer knows must be present in the viewer exactly as declared, and the
    // regions that are NOT lenses (shared primitives, the shell) must own nothing derived.
    const regions = scriptRegions(HTML);
    for (const id of [...ids, "shared", "shell"])
      if (!regions.has(id)) die(`lenses: the viewer declares no /*lens:${id}*/ region`);
    if (derivedReads(regions.get("shared")).size !== 0)
      die("lenses: a shared primitive that reads a derived surface gives that surface two homes");

    // I20 proper, over the real viewer: measured == declared, and no surface read twice.
    const live = ownershipViolations(HTML, DERIVED_KEYS);
    if (live.length) die("lenses: I20 fails on the shipped viewer —\n  " + live.join("\n  "));

    // DERIVED_KEYS is the pin, so it has to BE pinned: measured against a real deriveAll call, not
    // hand-kept beside it. Without this, adding a key to deriveAll and forgetting the list leaves
    // every check below iterating a stale set and reporting green — the wave-3/6 defect again, one
    // level up.
    {
      const snapshot = (issues) => ({ issues, milestones: [], fetchedAt: "2026-01-01", collection: {}, dependencies: { supported: false, edges: [] } });
      const keysFor = (over) =>
        Object.keys(
          deriveAll({
            repo: HERE, model: null, topo: null, issuesSnapshot: snapshot([]),
            health: { verdicts: [], dependencyConfirmations: [] }, findings: { findings: [] },
            brief: null, briefPath: null, manifest: { today: "2026-01-01" },
            gateInputs: null, arbiterMilestones: null, docs: null,
            ...over,
          }),
        ).sort();
      const pinned = [...DERIVED_KEYS].sort();
      // Two samples, because one proves only that the key set matches for THAT input. A key added
      // conditionally — present only when some artifact exists — would slip past a single-sample pin
      // and land with no home, which is the defect the pin exists to stop.
      for (const [label, over] of [
        ["a programme with nothing declared", {}],
        ["a programme with issues, a gate and a milestone projection", {
          issuesSnapshot: snapshot([{ n: 1, state: "OPEN", labels: [], ms: null, title: "x", createdAt: "2026-01-01", closedAt: null }]),
          gateInputs: { documents: [], wiring: [], freshness: [], claims: [], errors: [] },
          arbiterMilestones: { schema: "arbiter-milestones-v1", milestones: [] },
          docs: { embedded: [], listed: [] },
        }],
      ]) {
        const live = keysFor(over);
        if (JSON.stringify(live) !== JSON.stringify(pinned))
          die(
            `lenses: DERIVED_KEYS has drifted from deriveAll for ${label} — only in deriveAll: ` +
              live.filter((k) => !pinned.includes(k)).join(", ") +
              " · only in DERIVED_KEYS: " +
              pinned.filter((k) => !live.includes(k)).join(", "),
          );
      }
    }

    // Every key deriveAll returns is either owned or explicitly declared unrendered WITH a reason —
    // a surface that is computed and rendered nowhere is the defect this found in waves 3 and 6.
    const owned = new Set(LENSES.flatMap((l) => l.owns).concat(SHELL_OWNS));
    for (const key of DERIVED_KEYS) {
      if (owned.has(key)) continue;
      const excused = UNRENDERED.find((u) => u.key === key);
      if (!excused) die(`lenses: derived.${key} is computed and has no home lens (I20)`);
      if (!excused.why || excused.why.length < 24)
        die(`lenses: derived.${key} is excused from I20 without a reason worth reading`);
    }
    for (const key of owned)
      if (!DERIVED_KEYS.includes(key)) die(`lenses: ${key} is owned by a lens but deriveAll never returns it`);

    // TAMPER 1 — the same surface rendered in two lenses. This is the actual defect in the five-view
    // viewer (commitDrift on `map` and on `tech`), and the one a comment cannot catch.
    const twoHomes = HTML.replace(
      "/*lens:operations*/",
      "/*lens:operations*/\nfunction stray(program){return program.derived.commitDrift;}\n",
    );
    const dup = ownershipViolations(twoHomes, DERIVED_KEYS);
    if (!dup.some((v) => /commitDrift/.test(v) && /operations/.test(v) && /architecture/.test(v)))
      die("lenses: a surface read from two lens regions must be refused, naming both — got " + JSON.stringify(dup));

    // TAMPER 1b — every spelling that is NOT `derived.<key>`. The one-home rule is lexical, so the
    // only defence against writing the same read differently is to allow exactly two spellings and
    // refuse the rest BY NAME. Untested, that branch could be deleted and every other assertion here
    // would stay green while an alias walked through.
    for (const [name, code] of Object.entries({
      alias: "function stray(p){var d=p.derived;return d.rtm;}",
      destructure: "function stray(p){var {rtm}=p.derived;return rtm;}",
      bracket: 'function stray(p){return p["derived"].rtm;}',
      optional: "function stray(p){return p.derived?.rtm;}",
      computed: "function stray(p,k){return p.derived[k];}",
    })) {
      const spelled = HTML.replace("/*lens:operations*/", "/*lens:operations*/\n" + code + "\n");
      if (!ownershipViolations(spelled, DERIVED_KEYS).some((v) => /operations.*reaches a derived surface as/.test(v)))
        die(`lenses: a derived surface spelled as a ${name} must be refused by name`);
    }
    // ...and the same rule above the partition, where a weaker check would be a bypass: a script
    // inserted before the opening one leaves the anchor pair intact.
    const aliasedHead = HTML.replace('<script>\n(function(){', '<script>function stray(p){var d=p.derived;return d.rtm;}</script>\n<script>\n(function(){');
    if (!unpartitionedReads(aliasedHead).some((v) => /above the first lens region/.test(v)))
      die("lenses: an aliased derived read above the partition must be refused");

    // A comment is not code, and a string is. codeOnly() decides that, and it decides it with
    // regexes, so both directions are pinned: a comment must not create a read, and a string must
    // not lose one. The second is the fail-OPEN direction — a swallowed line hides a duplicate home.
    if (derivedReads('// renders derived.rtm\nvar x=1;').size !== 0)
      die("lenses: a comment must not count as a read");
    if (!derivedReads('var url="https://x/y";var v=p.derived.rtm;').has("rtm"))
      die("lenses: a URL in code must not swallow the rest of the line");
    if (!derivedReads('/* derived.kpis */\nvar v=p.derived.rtm;').has("rtm"))
      die("lenses: a block comment must not swallow the code after it");
    if (derivedReads('/* derived.kpis */').size !== 0)
      die("lenses: a surface named only inside a block comment is not rendered");

    // TAMPER 2 — a shared primitive reaching into derived. Allowed once, it re-scatters the partition.
    const sharedRead = HTML.replace(
      "/*lens:shared*/",
      "/*lens:shared*/\nfunction stray(program){return program.derived.rtm;}\n",
    );
    if (!ownershipViolations(sharedRead, DERIVED_KEYS).some((v) => /shared/.test(v) && /rtm/.test(v)))
      die("lenses: a derived read inside the shared region must be refused");

    // TAMPER 3 — a declaration nobody honours. The table must not be able to claim a surface the
    // viewer never renders: that is exactly how the five-view predicate rotted into decoration.
    const phantom = LENSES.map((l) => (l.id === "operations" ? { ...l, owns: [...l.owns, "kpis"] } : l));
    if (!ownershipViolations(HTML, DERIVED_KEYS, phantom).some((v) => /operations/.test(v) && /kpis/.test(v)))
      die("lenses: a lens declaring a surface it does not read must be refused");

    // TAMPER 4 — a region silently deleted. EVERY marker for the lens, because regions may repeat and
    // removing one of two leaves the region present: the check that would then fire is the duplicate-
    // home one, and the missing-region branch would go untested while looking tested.
    const noRegion = HTML.split("/*lens:provenance*/").join("");
    if (!ownershipViolations(noRegion, DERIVED_KEYS).some((v) => /declares no \/\*lens:provenance\*\//.test(v)))
      die("lenses: a lens region missing from the viewer must be refused by name");

    // Nothing may sit above the partition. This is a TEMPLATE rule, checked here rather than in
    // room-presentable, because a composed briefing's head legitimately carries the room JSON, both
    // locale tables and the whole C4 hologram viewer spliced in ahead of the main script.
    if (unpartitionedReads(HTML).length)
      die("lenses: the shipped template has code above the partition — " + unpartitionedReads(HTML).join("; "));
    const outside = HTML.replace('"use strict";\n/*lens:shared*/', '"use strict";\nfunction stray(p){return p.derived.rtm;}\n/*lens:shared*/');
    if (!unpartitionedReads(outside).some((v) => /does not open on a lens region/.test(v)))
      die("lenses: code above the first lens region must be refused");
    // A whole script wedged in ahead of the partition leaves the anchor pair intact — the anchor
    // branch does NOT fire — so what must catch it is the head read. Asserted on that message alone,
    // because an alternation would have concealed which half was doing the work.
    const wedged = HTML.replace('<script>\n(function(){', '<script>function stray(p){return p.derived.rtm;}</script>\n<script>\n(function(){');
    if (!unpartitionedReads(wedged).some((v) => /derived\.rtm is read above the first lens region/.test(v)))
      die("lenses: a script wedged in above the partition must be refused by its read");

    // ...and the converse, which is not hypothetical: room-presentable runs this same analyzer over
    // the COMPOSED artifact, whose head carries the room JSON, the locale tables and the embedded
    // canon. docs/GLOBAL_INVARIANTS.md quotes `derived.health` while explaining this very rule, so an
    // analyzer that read the whole file would fail every briefing that documents its own invariant.
    const composed = `<script>window.__ROOM__ = {"docs":["I20 keeps derived.health and derived.rtm to one lens each"]};</script>\n${HTML}`;
    if (ownershipViolations(composed, DERIVED_KEYS).length)
      die("lenses: embedded repository prose quoting a surface must not read as a lens rendering it");

    // Publication is a predicate over BACKING ARTIFACTS, not a route that always exists (I7, F1).
    // The flagship demo — every issue closed, no map, no rtm — must publish fewer lenses, not the
    // same six full of zeros.
    const bare = {
      id: "bare", hasMap: false, docs: { embedded: [], listed: [] },
      issuesSnapshot: { issues: [{ n: 1, state: "CLOSED" }], signals: { workflows: {}, release: { listState: "unknown", reason: "not declared" } } },
      derived: { kpis: { openCount: 0 }, milestones: [], rtm: null, capabilities: null, documentGate: null, criticalPath: null, milestonePath: null },
    };
    const bareLenses = derivedLenses(bare);
    if (bareLenses.verdict !== true) die("lenses: the verdict lens answers even when the answer is 'nothing open'");
    if (bareLenses.plan !== false) die("lenses: a programme with no open work and no milestones must not publish a plan lens (F1)");
    if (bareLenses.architecture !== false) die("lenses: no model means the architecture lens is absent, not empty (I7)");
    if (bareLenses.traceability !== false) die("lenses: no rtm and no capabilities means no traceability lens");
    if (bareLenses.operations !== false) die("lenses: undeclared signals means no operations lens");
    if (bareLenses.provenance !== false) die("lenses: no documents and no gate means no provenance lens");
    if (bareLenses.portfolio !== true) die("lenses: the portfolio is always the entry route");

    const rich = {
      id: "rich", hasMap: true, docs: { embedded: [{ path: "docs/PRD.md" }], listed: [] },
      issuesSnapshot: { issues: [{ n: 1, state: "OPEN" }], signals: { workflows: { ci: { state: "present" } }, release: { listState: "present" } } },
      derived: { kpis: { openCount: 1 }, milestones: [], rtm: { coverage: {} }, capabilities: null, documentGate: null, criticalPath: null, milestonePath: null },
    };
    const richLenses = derivedLenses(rich);
    for (const id of ids)
      if (richLenses[id] !== true) die(`lenses: a programme with every artifact must publish ${id}, got ${richLenses[id]}`);

    // The map is exactly the declared set — a stray key here is a route the shell would mount blind.
    if (JSON.stringify(Object.keys(richLenses).sort()) !== JSON.stringify([...ids].sort()))
      die("lenses: the publication map must carry exactly the declared lenses");

    // The routing itself, lifted and run — not grepped. A publication predicate that decides
    // correctly while registerAll mounts all six anyway would leave every one of the assertions above
    // green and the empty panels still on screen, which is precisely UX finding F1.
    {
      const fn = (name, multiline = true) =>
        (new RegExp("function " + name + "\\(" + (multiline ? "[^]*?\\n\\}" : "[^\\n]*\\n")).exec(HTML) || [])[0] ||
        die(`lenses: ${name}() not found in control-room.html`);
      const stub = `
        var mounted = [];
        var content = {appendChild: function (c) { mounted.push(c.id) }};
        var document = {
          getElementById: function () { return content },
          createElement: function (t) { return {tagName: t, id: "", className: "", hidden: false, textContent: "",
            children: [], appendChild: function (c) { this.children.push(c); return c }} },
        };
        var VIEWS = {}, VIEW_SPEC = {}, ORDER = [];
        var LENS_SPEC = ${JSON.stringify(LENSES.filter((l) => l.id !== "portfolio").map(({ id }) => ({ id })))};
        var ROOM = {programs: []};
        ${fn("el", false)}
        ${fn("key", false)}
        ${fn("mount")}
        ${fn("lensesOf")}
        ${fn("registerAll")}
        return function (programs) { ROOM = {programs: programs}; mounted = []; VIEWS = {}; VIEW_SPEC = {}; ORDER = [];
                                     registerAll(); return mounted; };`;
      const mountAll = new Function(stub)();
      const withLenses = (id, lenses) => ({id: id, derived: {lenses: lenses}});
      // One programme has no portfolio to roll up, so the aggregate route is not mounted at all
      // (map ticket #90); with two it returns as the front door.
      const bare = mountAll([withLenses("bare", {portfolio: true, verdict: true, plan: false, architecture: false, traceability: false, operations: false, provenance: false})]);
      if (bare.join() !== "view--bare-verdict,view--options")
        die("lenses: a programme whose artifacts publish one lens must mount one route, got " + bare.join(" "));
      const full = mountAll([withLenses("full", Object.fromEntries(ids.map((id) => [id, true])))]);
      if (full.length !== 7)
        die("lenses: a programme publishing every lens must mount six routes plus options, got " + full.join(" "));
      if (full.some((id) => id === "view--full-portfolio"))
        die("lenses: the portfolio is the entry route, never a per-programme one");
      const pair = mountAll([withLenses("one", Object.fromEntries(ids.map((id) => [id, true]))), withLenses("two", Object.fromEntries(ids.map((id) => [id, true])))]);
      if (pair[0] !== "view--" || pair.length !== 14)
        die("lenses: with two programmes the briefing is the front door and every lens mounts, got " + pair.join(" "));
    }

    // The stress fixture is the only artifact the DOM, paging, mobile and print measurements run
    // over, and it declares its own publication set. Pinned against a fresh derivation so it cannot
    // drift into asserting an IA the product would never produce — the state it was actually in.
    if (lensDrift().length) die("lenses: the stress fixture declares lenses its own artifacts do not — " + lensDrift().join("; "));

    // hasMapDeclared: the predicate and the viewer must read ONE definition of hasMap. Passing it
    // explicitly wins over the value deriveAll computes for itself, and an omitted one falls back —
    // both directions, because a fallback that silently reinstated the other definition would undo
    // the fix without failing anything.
    {
      const base = {
        repo: HERE, model: null, topo: null,
        issuesSnapshot: { issues: [], milestones: [], fetchedAt: "2026-01-01", collection: {}, dependencies: { supported: false, edges: [] } },
        health: { verdicts: [], dependencyConfirmations: [] }, findings: { findings: [] },
        brief: null, briefPath: null, manifest: { today: "2026-01-01" },
        gateInputs: null, arbiterMilestones: null, docs: null,
      };
      if (deriveAll({ ...base, hasMapDeclared: true }).lenses.architecture !== true)
        die("lenses: a declared model must publish the architecture lens even when deriveAll computes hasMap itself");
      if (deriveAll({ ...base, hasMapDeclared: false }).lenses.architecture !== false)
        die("lenses: an explicit false must be honoured, not read as absent");
      if (deriveAll(base).lenses.architecture !== false)
        die("lenses: with nothing declared the architecture lens must stay absent");
    }

   console.log("  ok lenses — one home per derived surface, publication measured from backing artifacts, routing mounts only what publishes");
  });

  // F2 unit pin: `codepointCompare` must order true Unicode SCALAR values, not UTF-16 code units.
  // Plain `<`/`>` on strings compares code units, which puts every astral character (a surrogate
  // pair, U+10000 and up) before any BMP character in U+E000..U+FFFF — backwards from scalar order.
  // Also pins that it does not reproduce ICU's NUL-ignoring defect (`("r"+NUL+"2").localeCompare("r2")
  // === 0`, the exact case the audit measured against `verify.mjs`'s edge sort).
  test("lenses: codepoint-compare", async () => {
    const astral = String.fromCodePoint(0x10000), pua = String.fromCodePoint(0xe000);
    if (codepointCompare(astral, pua) !== 1)
      die(
        "codepointCompare: an astral character (U+10000) must sort AFTER a BMP private-use character (U+E000)",
      );
    if (codepointCompare(pua, astral) !== -1)
      die("codepointCompare: is not antisymmetric for the astral/BMP pair");
    // Mixed-case ASCII: unaffected by the scalar-vs-code-unit distinction (ASCII has one code unit
    // per scalar), but pinned so a future change to the comparator cannot silently invert it.
    if (
      codepointCompare("a", "Z") !== 1 ||
      codepointCompare("Z", "a") !== -1 ||
      codepointCompare("a", "a") !== 0
    )
      die("codepointCompare: mixed-case ASCII order regressed");
    const NUL = String.fromCharCode(0);
    if (("r" + NUL + "2").localeCompare("r2") !== 0)
      die(
        "codepointCompare: the ICU defect this replaces is no longer reproducible — re-verify the audit's baseline claim",
      );
    if (codepointCompare("r" + NUL + "2", "r2") === 0)
      die(
        "codepointCompare: must NOT collapse a NUL-adjacent digit the way ICU's localeCompare does",
      );
    console.log(
      "  ok codepoint-compare — true Unicode scalar order (astral vs BMP, mixed-case ASCII), and the ICU NUL-collapse defect does not reproduce",
    );
  });

  // F2: `localeCompare` is locale-dependent — sorting non-ASCII, mixed-case ids/titles under a
  // Swedish collation locale gives a different order than under `C`. Every site the audit named
  // (`deriveMilestones`, `deriveUseCases`, `deriveRunbooks`, `deriveMilestonePath`,
  // `deriveMilestoneReconciliation`) must sort by codepoint, so the JSON they emit is byte-identical
  // regardless of the runtime locale — reverting any one of the five back to `localeCompare` must
  // fail this probe.
  test("lenses: locale-plan", async () => {
    const localeScript = join(tmp, "locale-probe.mjs");
    writeFileSync(
      localeScript,
      [
        "import { deriveMilestones, deriveUseCases, deriveRunbooks, deriveMilestonePath, deriveMilestoneReconciliation } from " +
          JSON.stringify(join(HERE, "..", "lib", "roomderive.mjs")) + ";",
        "const ids = ['z', 'ä', 'a', 'Z'];",
        "const issuesSnapshot = { milestones: ids.map((title) => ({ title, due: null, open: 1, closed: 0 })), issues: [] };",
        "const useCaseProjection = { useCases: ids.map((id) => ({ id, actor: 'x', goal: 'g' })) };",
        "const runbookProjection = { runbooks: ids.map((id) => ({ id, file: 'r.md', handles: [] })) };",
        // No estimate_days: `unestimated` is filtered straight off `ids` in the array's own order,
        // so unlike `nodes` (re-sorted with a plain, locale-independent `.sort()` downstream) it
        // actually surfaces the id-sort comparator's order — the thing this probe has to catch.
        "const milestonePathProjection = { milestones: ids.map((id) => ({ id, depends_on: [], status: 'planned', horizon: 'now' })) };",
        "process.stdout.write(JSON.stringify({",
        "  milestones: deriveMilestones(issuesSnapshot),",
        "  useCases: deriveUseCases(useCaseProjection),",
        "  runbooks: deriveRunbooks(runbookProjection),",
        "  milestonePath: deriveMilestonePath(milestonePathProjection),",
        "  milestoneReconciliation: deriveMilestoneReconciliation(milestonePathProjection, issuesSnapshot),",
        "}));",
      ].join("\n"),
    );
    const runLocale = (LC_ALL) =>
      spawnSync(process.execPath, [localeScript], {
        encoding: "utf-8",
        env: { ...process.env, LC_ALL },
      });
    const sv = runLocale("sv_SE.UTF-8");
    const c = runLocale("C");
    if (sv.status !== 0 || c.status !== 0)
      die("locale: milestone/use-case/runbook probe did not run cleanly", {
        sv,
        c,
      });
    if (sv.stdout !== c.stdout)
      die(
        "locale: derived milestone/use-case/runbook/milestone-path/reconciliation order is not byte-identical across LC_ALL=sv_SE.UTF-8 and LC_ALL=C:\n" +
          sv.stdout +
          "\n" +
          c.stdout,
      );
    console.log(
      "  ok locale — milestone, use-case, runbook and milestone-path/reconciliation order is codepoint-stable across LC_ALL=sv_SE.UTF-8 and LC_ALL=C",
    );
  });

  // F2 (verify.mjs edge sort): one issue blocked by four external endpoints sharing the same
  // number, whose repo names differ only by case/diacritic. The sort key's deciding component is
  // that diacritic-sensitive string, so `dependencies.edges` must come out byte-identical across
  // locales — reverting `verify.mjs`'s edge sort to `localeCompare` must fail this probe.
  test("lenses: locale-verify", async () => {
    const localeRepo = join(tmp, "verify-locale-repo");
    mkdirSync(localeRepo, { recursive: true });
    const GH_LOCALE = process.execPath + " " + join(HERE, "stub-gh.mjs") + " locale";
    const runVerifyLocale = (LC_ALL) => {
      const issues = join(tmp, "verify-locale-issues-" + LC_ALL.replace(/[^a-zA-Z0-9]/g, "_") + ".json");
      const r = spawnSync(
        process.execPath,
        [
          BIN, "verify", "--repo", localeRepo, "--issues", issues,
          "--gh-repo", "acme/thing", "--gh-cmd", GH_LOCALE,
        ],
        { encoding: "utf-8", env: { ...process.env, LC_ALL } },
      );
      if (r.status !== 0) die("locale: verify (edge sort) did not run cleanly under " + LC_ALL, r);
      const snap = readJson(issues);
      return JSON.stringify(snap.dependencies.edges);
    };
    const svEdges = runVerifyLocale("sv_SE.UTF-8");
    const cEdges = runVerifyLocale("C");
    if (svEdges !== cEdges)
      die(
        "locale: verify's dependencies.edges are not byte-identical across LC_ALL=sv_SE.UTF-8 and LC_ALL=C:\n" +
          svEdges +
          "\n" +
          cEdges,
      );
    console.log(
      "  ok locale — verify's edge sort is codepoint-stable across LC_ALL=sv_SE.UTF-8 and LC_ALL=C",
    );
  });
});
