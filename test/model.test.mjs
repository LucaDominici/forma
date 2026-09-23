#!/usr/bin/env node
// Schema validation, timeline/docmap derivation, declaration+doc-drift, presentable gates.
import test, { describe } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, renameSync } from "node:fs";

import { join } from "node:path";

import { materializeTimeline, validateModel } from "../lib/validate.mjs";
import { indexByNode, statusFor } from "../lib/docmap.mjs";

import {
  HERE,
  BIN,
  FIX,
  freshTmp,
  run,
  die,
  readJson,
  stripVolatile,
  diffPaths,
} from "./helpers.mjs";


const tmp = freshTmp();

describe("model", () => {
  test("model: schema", async () => {
    const REPO = FIX("mini"),
      topo = join(tmp, "schema-topo.json"),
      model = join(tmp, "schema-model.json");
    const badTopo = join(tmp, "schema-topo-bad.json"),
      badModel = join(tmp, "schema-model-bad.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("schema init exit " + r.status, r);
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("schema gen exit " + r.status, r);
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("schema check exit " + r.status, r);
    const conforming = readJson(model);
    // a required field removed by hand: check must fail AND name the field, or the report is useless
    const missingKind = readJson(model);
    delete missingKind.nodes[0].kind;
    writeFileSync(model, JSON.stringify(missingKind, null, 2) + "\n");
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    const missOut = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0 || !(/kind/.test(missOut) && /SCHEMA/.test(missOut)))
      die(
        'schema: check accepted a node with no "kind" (or never named the field)',
        r,
      );
    // topo.nodes are copied verbatim into the model, so a curated kind outside the enum is the one
    // way a plain `gen` can emit a non-conforming model — it must refuse instead of writing it.
    const topoBad = readJson(topo);
    topoBad.nodes[0].kind = "widget";
    writeFileSync(badTopo, JSON.stringify(topoBad, null, 2) + "\n");
    r = run(["gen", "--repo", REPO, "--topology", badTopo, "--out", badModel]);
    const badGenOut = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0 || !/kind/.test(badGenOut))
      die(
        "schema: gen wrote a model whose node kind is outside the schema enum",
        r,
      );
    // the dogfood: forma's own committed model is the one every reader of the Pages demo sees
    const committed = validateModel(
      readJson(join(HERE, "..", "docs/architecture/c4-model.json")),
    );
    if (committed.length)
      die(
        "schema: this repo's committed c4-model.json does not validate:\n - " +
          committed.join("\n - "),
      );
    const oldMinor = validateModel({ ...conforming, schemaVersion: "1.0.0" });
    const nextMajor = validateModel({ ...conforming, schemaVersion: "2.0.0" });
    if (oldMinor.length || !nextMajor.some((e) => /schemaVersion/.test(e)))
      die(
        "schema freeze: compatible 1.x must load and unsupported major 2 must fail",
      );
    r = run(["--version"]);
    const packageVersion = readJson(join(HERE, "..", "package.json")).version;
    if (r.status !== 0 || r.stdout.trim() !== packageVersion)
      die(`release: CLI version does not match package.json (${packageVersion})`, r);
    console.log(
      `  ok schema — 1.x contract frozen; incompatible major rejected; package ${packageVersion}`,
    );
  });
  test("model: timeline", async () => {
    const repo = join(tmp, "timeline-repo");
    cpSync(FIX("mini"), repo, { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "roadmap.md"),
      "# Governed future architecture\n",
    );
    const topo = join(tmp, "timeline-topo.json"),
      model = join(tmp, "timeline-model.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("timeline init exit " + r.status, r);
    const t = readJson(topo);
    const system = t.nodes.find((n) => n.kind === "system");
    if (!system) die("timeline precondition: init produced no system");
    t.timeline = {
      source: "docs/roadmap.md",
      checkpoints: [
        { id: "g0", label: "G0 · readiness", badge: "35 board · 2 P0" },
        {
          id: "g1",
          label: "G1 · new surface",
          badge: "9 board · 1 P0",
          patch: {
            nodes: {
              add: [
                {
                  node: {
                    id: "future_api",
                    level: "container",
                    parent: system.id,
                    kind: "container",
                    name: "Future API",
                    status: "planned",
                    status2: "planned",
                    func: "A governed future surface.",
                  },
                  change: "Add the future API.",
                },
                {
                  node: {
                    id: "future_legacy",
                    level: "leaf",
                    parent: "future_api",
                    kind: "leaf",
                    name: "Temporary adapter",
                    status: "planned",
                    status2: "planned",
                    func: "A transition-only adapter.",
                  },
                  change: "Add the transition adapter.",
                },
              ],
              update: [
                {
                  id: "core",
                  set: { current: "Core also serves the future API." },
                  change: "Extend the core responsibility.",
                },
              ],
            },
            edges: {
              add: [
                {
                  edge: {
                    from: "core",
                    to: "future_api",
                    label: "serves",
                    kind: "runtime",
                    status: "planned",
                    estatus: "to-build",
                  },
                  change: "Connect core to the future API.",
                },
              ],
            },
          },
        },
        {
          id: "g2",
          label: "G2 · direct utility",
          patch: {
            nodes: {
              update: [
                {
                  id: "future_api",
                  set: {
                    status2: "next",
                    current: "Future API reads utility directly.",
                  },
                  change: "Promote the surface to the next checkpoint.",
                },
              ],
              remove: [
                { id: "future_legacy", change: "Remove the transition adapter." },
              ],
            },
            edges: {
              rewire: [
                {
                  match: { from: "core", to: "future_api", label: "serves" },
                  set: { from: "util", label: "serves directly" },
                  change: "Route the surface through utility.",
                },
              ],
            },
          },
        },
      ],
    };
    writeFileSync(topo, JSON.stringify(t, null, 2) + "\n");
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("timeline gen exit " + r.status, r);
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("timeline check exit " + r.status, r);
    const base = readJson(model);
    if (base.schemaVersion !== "1.6.0")
      die("timeline: schema version is " + base.schemaVersion);
    if (base.nodes.some((n) => n.id === "future_api"))
      die("timeline: future node leaked into the AS-IS baseline");
    const built = materializeTimeline(base, {
      sourceExists: (rel) => existsSync(join(repo, rel)),
    });
    if (built.errors.length)
      die(
        "timeline materializer rejected valid fixture:\n - " +
          built.errors.join("\n - "),
      );
    if (built.states.length !== 3)
      die("timeline: expected 3 checkpoints, got " + built.states.length);
    const g0 = built.states[0],
      g1 = built.states[1],
      g2 = built.states[2];
    if (
      JSON.stringify(g0.model.nodes) !== JSON.stringify(base.nodes) ||
      JSON.stringify(g0.model.edges) !== JSON.stringify(base.edges)
    ) {
      die(
        "timeline honesty: a display-only board badge generated architecture operations",
      );
    }
    if (g0.badge !== "35 board · 2 P0")
      die(
        "timeline honesty: checkpoint badge was interpreted or rewritten: " +
          g0.badge,
      );
    if (
      !g1.model.nodes.some((n) => n.id === "future_api") ||
      !g1.model.nodes.some((n) => n.id === "future_legacy")
    )
      die("timeline G1: additions missing");
    if (
      !g1.model.nodes.find((n) => n.id === "core").current.includes("future API")
    )
      die("timeline G1: baseline update missing");
    if (
      !g2.model.nodes.some((n) => n.id === "future_api") ||
      g2.model.nodes.some((n) => n.id === "future_legacy")
    )
      die("timeline G2: cumulative add/remove wrong");
    if (
      !g2.model.nodes.find((n) => n.id === "core").current.includes("future API")
    )
      die("timeline G2: G1 update did not survive cumulatively");
    if (
      !g2.model.edges.some(
        (e) =>
          e.from === "util" &&
          e.to === "future_api" &&
          e.label === "serves directly",
      )
    )
      die("timeline G2: rewire missing");
    if (
      g2.model.edges.some(
        (e) => e.from === "core" && e.to === "future_api" && e.label === "serves",
      )
    )
      die("timeline G2: pre-rewire edge survived");
    if (
      g2.delta.nodes.length !== 1 ||
      g2.delta.nodes[0].id !== "future_api" ||
      g2.delta.edges.length !== 1 ||
      g2.delta.edges[0].type !== "REWIRE"
    ) {
      die(
        "timeline G2: local delta includes changes from earlier checkpoints: " +
          JSON.stringify(g2.delta),
      );
    }
    if (
      g2.delta.removedNodes.length !== 1 ||
      g2.delta.removedNodes[0].id !== "future_legacy"
    )
      die("timeline G2: removal not reported in local summary");

    // The ES5 viewer owns a deliberately small mirror of the validated materializer. Drive the same
    // fixture through it so the browser cannot silently diverge from gen/check.
    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    const tlBlock = (html.match(/function jsonCopy\([\s\S]*?(?=\nvar BASE=)/) ||
      [])[0];
    if (!tlBlock) die("timeline viewer: pure materializer block not found");
    const viewer = new Function(
      tlBlock +
        "\nreturn {timelineStates:timelineStates,timelineSummary:timelineSummary}",
    )();
    const viewerStates = viewer.timelineStates(base);
    const vg2 = viewerStates.states[2];
    if (
      !vg2 ||
      JSON.stringify(vg2.model.nodes) !== JSON.stringify(g2.model.nodes) ||
      JSON.stringify(vg2.model.edges) !== JSON.stringify(g2.model.edges)
    ) {
      die(
        "timeline viewer: cumulative graph differs from the engine materializer",
      );
    }
    const emptySummary = viewer.timelineSummary("g0", g0.delta);
    const asIsSummary = viewer.timelineSummary("as-is", { counts: {} });
    const changedSummary = viewer.timelineSummary("g2", g2.delta);
    if (
      !emptySummary.empty ||
      emptySummary.parts.length ||
      asIsSummary.empty ||
      changedSummary.empty ||
      changedSummary.parts.map((x) => x.key).join(",") !==
        "deltaUpdate,deltaRewire,deltaRemove"
    ) {
      die(
        "timeline viewer: AS-IS, empty checkpoint and typed local summary are not distinguished: " +
          JSON.stringify({ asIsSummary, emptySummary, changedSummary }),
      );
    }
    if (
      !/id="legacytime"/.test(html) ||
      !/id="timeline"/.test(html) ||
      !/BASE&&BASE\.timeline/.test(html)
    ) {
      die("timeline viewer: legacy/timeline mutual-exclusion wiring missing");
    }
    if (
      /BASE&&BASE\.timeline&&BASE\.timeline\.source\)\|\|/.test(html) ||
      !/nodeProjected\(n\.id\)&&BASE&&BASE\.timeline/.test(html) ||
      !/function nodeProjected\(id\)/.test(html) ||
      !/preserveLegacyMode&&\(!BASE\|\|!BASE\.timeline\)&&mode==="target"/.test(
        html,
      )
    ) {
      die(
        "timeline viewer: checkpoint provenance leaked onto unchanged nodes or legacy RE-VERIFY lost TARGET mode",
      );
    }
    if (
      /checkpoint-changes|class="cpchange"/.test(html) ||
      !/summary\.empty\?'<b>'\+esc\(STR\.noArchChanges\)/.test(html) ||
      !/if\(err\)st2\.appendChild\(err\)/.test(html) ||
      !/BASE=candidate;M=jsonCopy\(candidate\)/.test(html)
    ) {
      die(
        "timeline viewer: persistent change register survived, empty checkpoint is silent, or RE-VERIFY lost its live error overlay/atomic model swap",
      );
    }
    const detailStateBlock = (html.match(
      /\nfunction detailState\([\s\S]*?\n\}/,
    ) || [])[0];
    if (!detailStateBlock) die("timeline viewer: detailState not found");
    const detailState = new Function(detailStateBlock + "\nreturn detailState")();
    if (
      detailState({ func: "What it does", description: "What it does" }, true) !==
        "" ||
      detailState({ func: "What it does", current: "Projected state" }, true) !==
        "Projected state" ||
      detailState({ func: "What it does" }, false) !== "What it does"
    ) {
      die(
        "timeline viewer: unchanged function prose is duplicated as checkpoint state, or legacy detail lost its fallback",
      );
    }

    const structurallyBad = JSON.parse(JSON.stringify(base));
    structurallyBad.timeline.checkpoints[1].patch.nodes.add[0].node = {};
    structurallyBad.timeline.checkpoints[1].patch.nodes.update[0].set = {
      parent: "nonsense",
    };
    structurallyBad.timeline.checkpoints[1].patch.edges.add[0].edge = {};
    structurallyBad.timeline.checkpoints[2].patch.edges.rewire[0].set = {
      label: "not a rewire",
    };
    const structuralErrors = validateModel(structurallyBad);
    if (
      !structuralErrors.some((e) => /missing required property "id"/.test(e)) ||
      !structuralErrors.some((e) => /unexpected property "parent"/.test(e)) ||
      !structuralErrors.some((e) => /missing required property "from"/.test(e)) ||
      !structuralErrors.some((e) =>
        /does not satisfy any allowed schema shape/.test(e),
      )
    ) {
      die(
        "timeline schema: typed node/edge add and update/rewire set shapes are not structurally governed:\n - " +
          structuralErrors.join("\n - "),
      );
    }

    // Bad projections are rejected BEFORE the output is touched.
    const invalid = [
      [
        "duplicate checkpoint",
        (x) => {
          x.timeline.checkpoints[2].id = "g1";
        },
      ],
      [
        "missing source",
        (x) => {
          x.timeline.source = "docs/no-such-roadmap.md";
        },
      ],
      [
        "unknown update",
        (x) => {
          x.timeline.checkpoints[1].patch.nodes.update[0].id = "ghost";
        },
      ],
      [
        "orphan add",
        (x) => {
          x.timeline.checkpoints[1].patch.nodes.add[0].node.parent = "ghost";
        },
      ],
      [
        "forbidden target",
        (x) => {
          x.timeline.checkpoints[1].patch.nodes.add[0].node.target =
            "a second target";
        },
      ],
      [
        "live child on remove",
        (x) => {
          x.timeline.checkpoints[2].patch.nodes.remove = [
            { id: "future_api", change: "unsafe parent removal" },
          ];
        },
      ],
      [
        "ambiguous rewire",
        (x) => {
          x.timeline.checkpoints[1].patch.edges.add.push({
            edge: {
              from: "core",
              to: "future_api",
              label: "second route",
              kind: "runtime",
            },
            change: "Second route.",
          });
          delete x.timeline.checkpoints[2].patch.edges.rewire[0].match.label;
        },
      ],
    ];
    for (let i = 0; i < invalid.length; i++) {
      const badTopo = join(tmp, `timeline-bad-${i}.json`),
        badModel = join(tmp, `timeline-bad-${i}-model.json`);
      const bad = JSON.parse(JSON.stringify(t));
      invalid[i][1](bad);
      writeFileSync(badTopo, JSON.stringify(bad, null, 2) + "\n");
      writeFileSync(badModel, "KEEP\n");
      r = run(["gen", "--repo", repo, "--topology", badTopo, "--out", badModel]);
      if (r.status === 0) die("timeline invalid accepted: " + invalid[i][0]);
      if (readFileSync(badModel, "utf-8") !== "KEEP\n")
        die(
          "timeline invalid overwrote output before rejection: " + invalid[i][0],
        );
    }

    const tampered = readJson(model);
    tampered.timeline.checkpoints[0].badge = "invented after generation";
    writeFileSync(model, JSON.stringify(tampered, null, 2) + "\n");
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (
      r.status === 0 ||
      !/TIMELINE DRIFT/.test((r.stdout || "") + (r.stderr || ""))
    )
      die("timeline: check accepted a model-only timeline edit", r);
    console.log(
      "  ok timeline — legacy baseline + 3 cumulative checkpoints; local delta; board badge inert; invalid patches fail before write",
    );
  });
  test("model: docmap", async () => {
    const REPO = FIX("docmap"),
      topo = join(tmp, "dm-topo.json"),
      model = join(tmp, "dm-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("dm init exit " + r.status, r);
    const t = readJson(topo);
    // auto-detection: the inventory is adopted, the refactor PLAN (Feature|File, no status column)
    // is not — auto-adopting one would put "C1 move the helper" in a stakeholder's box.
    if (!(t.docSources || []).includes("docs/FEATURES.md"))
      die(
        "docmap: init did not detect docs/FEATURES.md, got " +
          JSON.stringify(t.docSources),
      );
    if ((t.docSources || []).some((d) => /plan\.md/.test(d)))
      die(
        "docmap: init adopted a change plan as a capability table — " +
          JSON.stringify(t.docSources),
      );

    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("dm gen exit " + r.status, r);
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("dm check exit " + r.status, r);
    const at = (id) =>
      readJson(model).nodes.find((n) => n.id === id) ||
      die("docmap: no node " + id);
    const m = readJson(model);

    // DoD 1/2 — a CONTAINER's box quotes the capability table, verbatim, ahead of any code.
    const billing = at("billing");
    if (billing.descSource !== "docmap")
      die(
        "docmap: container billing descSource=" +
          billing.descSource +
          " (want docmap)",
      );
    if (
      !/Bill a customer/.test(billing.func) ||
      !/Chase an invoice/.test(billing.func)
    )
      die("docmap: billing box does not quote its two rows: " + billing.func);
    // DoD 3 — progress the DOCUMENT states: 1 of billing's 2 capabilities is DONE.
    if (billing.status2 !== "in-progress" || billing.completion !== 50)
      die(
        `docmap: billing state ${billing.status2}/${billing.completion} (want in-progress/50)`,
      );
    if (!/FEATURES\.md/.test((billing.verify || {}).source || ""))
      die(
        "docmap: no provenance on a derived state: " +
          JSON.stringify(billing.verify),
      );
    const reporting = at("reporting");
    if (reporting.status2 !== "done" || reporting.completion !== 100)
      die(
        `docmap: reporting ${reporting.status2}/${reporting.completion} (want done/100)`,
      );

    // The cap — `core` is referenced by all four rows, so the matrix does not DESCRIBE it. Stitching
    // four capabilities into one sentence would invent a claim; falling through is the honest answer.
    const core = at("core");
    if (core.descSource === "docmap")
      die("docmap: a node touched by 4 rows was described anyway: " + core.func);
    // #43: the cap used to withhold the VERDICT too, so the more rows named a module the less it was
    // judged — `internal_budget` on the real demo, named by four DONE rows, rendered as unassessed.
    // The two halves part company: the verdict is still something the document says; a percentage
    // over a reach nobody can state is not.
    //
    // This IS the #43 guard, and it lives here rather than against a live checkout of the demo's
    // source repository. statusFor never branches on MAX_ROWS to compute status2 — the cap reaches
    // only `completion` — so an over-cap node whose rows are all DONE runs this same path; asserting
    // it twice bought nothing, and asserting it against an uncommitted working copy meant the fixture
    // could change under the test, which is exactly what happened.
    if (core.status2 !== "in-progress")
      die(`docmap: over-cap node lost its verdict: ${core.status2}`);
    if (core.completion != null)
      die(
        `docmap: over-cap node got a percentage over an unstatable reach: ${core.completion}`,
      );

    // DoD 4 — a container the matrix never names stays honestly blank. This is the 0.6.0 guarantee.
    const plumbing = at("plumbing");
    if (plumbing.descSource !== "fallback" || plumbing.status2 !== "unknown")
      die(
        `docmap: undocumented container reads ${plumbing.descSource}/${plumbing.status2} — the honest default broke`,
      );

    // The chain is document-first ABOVE the leaf and code-first AT it: invoice.js has a docstring and
    // must keep it; dunning.js has none and reaches the matrix row instead of "Component of module".
    if (at("billing__invoice_js").descSource !== "docstring")
      die("docmap: a leaf with a docstring lost it to the matrix");
    if (at("billing__dunning_js").descSource !== "docmap")
      die("docmap: an undocumented leaf did not reach the matrix row");

    // Precedence — the hand-curated overlay is still the authority over anything derived.
    const status = join(tmp, "dm-status.json"),
      model2 = join(tmp, "dm-model2.json");
    writeFileSync(
      status,
      JSON.stringify(
        { nodes: { billing: { status2: "problem", completion: 10 } } },
        null,
        2,
      ),
    );
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      model2,
      "--status",
      status,
    ]);
    if (r.status !== 0) die("dm gen --status exit " + r.status, r);
    const over = readJson(model2).nodes.find((n) => n.id === "billing");
    if (over.status2 !== "problem" || over.completion !== 10)
      die(
        `docmap: the curated overlay lost to the derived state (${over.status2}/${over.completion})`,
      );
    r = run(["check", "--repo", REPO, "--model", model2, "--topology", topo]);
    if (r.status !== 0)
      die("docmap: check flagged an overlay-owned field as doc drift", r);

    // The gate — a derived percentage nobody re-derives is a false green. Tamper with the committed
    // model and `check` must recompute the truth from the document, exactly as it does for src/.
    const stale = join(tmp, "dm-stale.json");
    const tampered = readJson(model);
    Object.assign(
      tampered.nodes.find((n) => n.id === "reporting"),
      { status2: "done", completion: 100 },
    );
    Object.assign(
      tampered.nodes.find((n) => n.id === "billing"),
      { status2: "done", completion: 100 },
    );
    writeFileSync(stale, JSON.stringify(tampered, null, 2) + "\n");
    r = run(["check", "--repo", REPO, "--model", stale, "--topology", topo]);
    if (r.status === 0)
      die(
        "docmap: check passed a model claiming 100% where the document says 50%",
      );
    if (!/DOC DRIFT: billing/.test((r.stdout || "") + (r.stderr || "")))
      die("docmap: drift reported without naming the node", r);

    const described = m.nodes.filter((n) => n.descSource === "docmap").length;
    console.log(
      `  ok docmap — §17 ${described} node(s) described from docs/FEATURES.md; billing 50% derived, core over-cap, plumbing honest; overlay wins; drift gated`,
    );
  });
  test("model: declaration", async () => {
    // (a) a status column that never says "not done" is an INVENTORY. `done/rows.length` is then
    // pinned to 1 by arithmetic: haben's feature matrix is 39 rows, 39 DONE, and every one of the
    // 27 nodes it reaches came out at exactly 100. A constant is not a measure.
    const repo = join(tmp, "decl-repo");
    cpSync(FIX("docmap"), repo, { recursive: true });
    const doc = join(repo, "docs", "FEATURES.md");
    writeFileSync(
      doc,
      readFileSync(doc, "utf-8").replace("| BACKLOG |", "| DONE |"),
    );
    const topo = join(tmp, "decl-topo.json"),
      model = join(tmp, "decl-model.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("decl init exit " + r.status, r);
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("decl gen exit " + r.status, r);
    const billing = readJson(model).nodes.find((n) => n.id === "billing");
    if (billing.completion != null)
      die(
        `decl: a document whose status column never says "not done" measured nothing, yet billing reads ${billing.completion}%`,
      );
    // what the document DID say survives — the declaration, its citation and its reach. Dropping
    // those with the number would trade a false percentage for a missing provenance.
    if (billing.status2 !== "done")
      die(
        "decl: the declaration itself was thrown out with the number, got " +
          billing.status2,
      );
    if (!/FEATURES\.md/.test((billing.verify || {}).source || ""))
      die(
        "decl: the citation went with the number: " +
          JSON.stringify(billing.verify),
      );
    if (!(billing.verify || {}).coverage)
      die(
        "decl: the coverage went with the number: " +
          JSON.stringify(billing.verify),
      );
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0)
      die(
        "decl: check re-derives from the same document and must agree with gen",
        r,
      );

    // (b) rows that name NO unit of the node still ruled on it. On the demo the two domains with no
    // evidence of their own — `fisco`, `accesso` — read done/100 with coverage {named:0}: a verdict
    // borrowed from children, on a box whose own reach the document never touches.
    const rows = [
      {
        text: "x",
        refs: ["src/a/one.js"],
        dead: [],
        done: true,
        from: "FEATURES.md",
      },
    ];
    const idx = indexByNode(rows, [
      { id: "dom", kind: "container" },
      {
        id: "a",
        parent: "dom",
        kind: "container",
        evidence: [{ type: "path", ref: "src/a" }],
      },
    ]);
    const dom = statusFor(idx, "dom");
    if (dom)
      die(
        "decl: a box the document names no unit of got a verdict anyway — " +
          JSON.stringify(dom),
      );
    const own = statusFor(idx, "a");
    if (!own || own.status2 !== "done")
      die(
        "decl: the guard also silenced the node the row actually names — " +
          JSON.stringify(own),
      );
    console.log(
      "  ok declaration — an all-DONE inventory yields a verdict with no percentage, citation intact; a zero-reach box yields nothing",
    );
  });
  test("model: doc-drift", async () => {
    const repo = join(tmp, "dd-repo");
    cpSync(FIX("docmap"), repo, { recursive: true });
    const topo = join(tmp, "dd-topo.json"),
      model = join(tmp, "dd-model.json"),
      bad = join(tmp, "dd-bad.json");
    const doc = join(repo, "docs", "FEATURES.md");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("dd init exit " + r.status, r);
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("dd gen exit " + r.status, r);
    const pristine = readFileSync(doc, "utf-8");
    const gate = () =>
      run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    const out = (x) => (x.stdout || "") + (x.stderr || "");
    if (gate().status !== 0)
      die("dd precondition: the untouched fixture must pass");

    // the whole-product box: every row touches the system node, so its denominator is "the rows
    // somebody wrote", never "the repo" — and a container the document never names sits below it
    const sys = readJson(model).nodes.find((n) => n.kind === "system");
    if (
      !readJson(model).nodes.some(
        (n) => n.kind === "container" && n.status2 === "unknown",
      )
    )
      die(
        "dd precondition: the fixture must hold a container the document never names",
      );
    if (sys.completion != null || sys.status2 !== "unknown")
      die(
        `dd/system: the whole product reads ${sys.status2}/${sys.completion} "${(sys.verify || {}).source}" — a handful of rows became a verdict on a repo they do not cover`,
      );

    // (a) a renamed code_ref: the row stops touching its node, so the unfinished capability leaves
    // the denominator and billing goes from in-progress/50 to a freshly derived done/100
    writeFileSync(
      doc,
      pristine.replace("`src/billing/dunning.js`", "`src/billing/dunning_v2.js`"),
    );
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", bad]);
    if (r.status === 0)
      die(
        `dd/(a): gen accepted a row whose code_ref does not exist — billing silently reads ${(readJson(bad).nodes.find((n) => n.id === "billing") || {}).completion}% instead of 50%`,
      );
    // …and a glob stem is a legitimate ref that must NOT be flagged
    writeFileSync(
      doc,
      pristine.replace("`src/billing/dunning.js`", "`src/billing/dunn*.js`"),
    );
    r = run([
      "gen",
      "--repo",
      repo,
      "--topology",
      topo,
      "--out",
      join(tmp, "dd-glob.json"),
    ]);
    if (r.status !== 0)
      die(
        "dd/(a): a glob code_ref (`src/billing/dunn*.js`) was rejected as dead",
        r,
      );

    // (b) the cited document is gone: the model keeps quoting it and citing "(N/N done)"
    writeFileSync(doc, pristine);
    const gone = doc + ".gone";
    renameSync(doc, gone);
    r = gate();
    if (r.status === 0)
      die(
        "dd/(b): check passed with the cited document deleted, model still quoting it",
      );
    if (!/FEATURES\.md/.test(out(r)))
      die("dd/(b): the failure did not name the missing document", r);
    renameSync(gone, doc);

    // (c) the row's sentence was rewritten: the box still quotes the old one, vouched by descSource
    writeFileSync(
      doc,
      pristine.replace(
        "Hand the accountant the month as a spreadsheet",
        "WITHDRAWN — export was cut, see ADR-9",
      ),
    );
    if (gate().status === 0)
      die(
        "dd/(c): check passed a docmap box quoting a sentence the document no longer contains",
      );
    writeFileSync(doc, pristine);
    if (gate().status !== 0)
      die("dd: the gate did not go green again once the document was restored");
    console.log(
      "  ok doc-drift — a dead code_ref fails gen; a deleted document, a rewritten row and a silent derivation all fail check; the system box stays unknown",
    );
  });
  test("model: presentable-scaffold", async () => {
    const gate = (m) => {
      const p = join(
        tmp,
        "pres-" + Math.random().toString(36).slice(2) + ".json",
      );
      writeFileSync(p, JSON.stringify(m));
      return spawnSync(
        process.execPath,
        [join(HERE, "..", "scripts", "presentable.mjs"), p],
        { encoding: "utf-8" },
      );
    };
    const demo = readJson(join(HERE, "..", "docs/demo/c4-model.json"));
    const clean = JSON.parse(JSON.stringify(demo));
    for (const n of clean.nodes) delete n.completion;
    let r = gate(clean);
    if (r.status !== 0)
      die(
        "presentable: the demo without invented percentages must still pass every other predicate\n" +
          r.stdout +
          r.stderr,
      );
    const lying = JSON.parse(JSON.stringify(clean));
    const victim =
      lying.nodes.find((n) => (n.verify || {}).derived === true) ||
      die(
        "presentable: the demo carries no document-derived node to drive the gate with",
      );
    victim.completion = 100;
    r = gate(lying);
    if (r.status === 0)
      die(
        "presentable: a box showing a percentage its own citation calls a declaration passed the gate\n" +
          r.stdout,
      );
    if (!new RegExp(victim.id).test(r.stdout || ""))
      die("presentable: the failure did not name the offending box\n" + r.stdout);
    console.log(
      "  ok presentable — a percentage no source measured fails the publication gate, by node id",
    );
  });
  test("model: presentable-badge", async () => {
    const gate = (m) => {
      const p = join(
        tmp,
        "pres3-" + Math.random().toString(36).slice(2) + ".json",
      );
      writeFileSync(p, JSON.stringify(m));
      return spawnSync(
        process.execPath,
        [join(HERE, "..", "scripts", "presentable.mjs"), p],
        { encoding: "utf-8" },
      );
    };
    const demo = readJson(join(HERE, "..", "docs/demo/c4-model.json"));

    // (1) A percentage with NO citation at all is the easiest lie to tell, and it was the one the
    // gate waved through: the filter required verify.derived === true. `forma verify` writes
    // completion = 100 and never touches node.verify (lib/verify.mjs), so a first-class command
    // puts the complaint back on the page through a supported path.
    const noCitation = JSON.parse(JSON.stringify(demo));
    for (const n of noCitation.nodes) {
      delete n.completion;
      delete n.verify;
    }
    noCitation.nodes[0].completion = 100;
    let r = gate(noCitation);
    if (r.status === 0)
      die(
        "presentable: a percentage with no citation at all passed — the gate grades the label, not the number\n" +
          r.stdout,
      );

    // (2) The same number with the label flipped to a value nobody writes must not buy a pass.
    const flipped = JSON.parse(JSON.stringify(demo));
    for (const n of flipped.nodes) delete n.completion;
    flipped.nodes[0].completion = 100;
    flipped.nodes[0].verify = { source: "inventata", derived: false };
    r = gate(flipped);
    if (r.status === 0)
      die(
        "presentable: derived:false is a label anyone can write — it must not certify a number as measured\n" +
          r.stdout,
      );

    console.log(
      "  ok presentable — a percentage is a declaration unless its citation proves otherwise",
    );
  });
  test("model: presentable-demo", async () => {
    const r = spawnSync(
      process.execPath,
      [
        join(HERE, "..", "scripts", "presentable.mjs"),
        join(HERE, "..", "docs/demo/c4-model.json"),
      ],
      { encoding: "utf-8" },
    );
    if (r.status !== 0)
      die(
        "presentable: the SHIPPED demo model does not pass its own publication gate\n" +
          r.stdout +
          r.stderr,
      );
    console.log(
      "  ok presentable — the shipped artifact itself passes, not a cleaned copy of it",
    );
  });
});
