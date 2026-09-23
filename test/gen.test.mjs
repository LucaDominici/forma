#!/usr/bin/env node
// init→gen→check across fixtures: counts, curation (§1a/§2/§1b), overlays, determinism.
import test, { describe } from "node:test";

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, statSync, symlinkSync } from "node:fs";

import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { loadDocRows } from "../lib/docmap.mjs";

import { componentsFor } from "../lib/cluster.mjs";

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

describe("gen", () => {
  test("gen: mini", async () => {
    const REPO = FIX("mini"),
      topo = join(tmp, "topo.json"),
      model = join(tmp, "model.json"),
      model2 = join(tmp, "model2.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("init exit " + r.status, r);
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("gen exit " + r.status, r);
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("check exit " + r.status, r);
    const m = readJson(model);
    const containers = m.nodes.filter((n) => n.kind === "container").length;
    const leaves = m.nodes.filter((n) => n.kind === "leaf").length;
    const derived = m.edges.filter((e) => e.kind === "import").length;
    if (containers < 2) die(`expected >=2 containers, got ${containers}`);
    if (leaves < 3) die(`expected >=3 leaves, got ${leaves}`);
    if (derived < 1) die(`expected >=1 derived edge (core→util), got ${derived}`);
    // derived edges carry a relationship verb (not a bare count), a numeric weight the viewer rolls
    // up, and an `inferred` status — so an executive reads the relationship and sees which arrows are
    // measured (curated, active) vs guessed from name references (inferred).
    const d = m.edges.find(
      (e) => e.kind === "import" && e.estatus === "inferred",
    );
    if (!d)
      die(
        `expected an inferred derived edge, got estatus set: ${[...new Set(m.edges.filter((e) => e.kind === "import").map((e) => e.estatus))].join(",")}`,
      );
    if (!/^(imports|drives|reads|references)$/.test(d.label))
      die(`derived edge label should be a verb, got "${d.label}"`);
    if (!(d.weight > 0))
      die(
        `derived edge should carry a numeric weight, got ${JSON.stringify(d.weight)}`,
      );
    if (m.edges.some((e) => e.kind === "import" && /\d×$/.test(String(e.label))))
      die(
        "a derived edge still carries a bare N× label — the verb refactor regressed",
      );
    // determinism: a second gen on the same tree is byte-identical excluding timestamps/commit
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model2]);
    if (r.status !== 0) die("gen(2) exit " + r.status, r);
    if (stripVolatile(m) !== stripVolatile(readJson(model2)))
      die("determinism: gen output differs across runs (excl. volatile fields)");
    // R2: exactly ONE volatile path — same tree, same commit ⇒ only generatedAt may differ
    const vol = diffPaths(m, readJson(model2));
    if (vol.join() !== "generatedAt")
      die(
        "R2: gen x2 should differ on generatedAt only, got [" +
          vol.join(", ") +
          "]",
      );
    // R3, lowering the bar: the 2-file report_* group is below the default groupMin and only
    // clusters when the user asks for it — the direction that matters on a real repo.
    if (m.nodes.some((n) => n.kind === "component"))
      die("R3: default thresholds should leave mini unclustered");
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      model2,
      "--cluster-min",
      "1",
      "--group-min",
      "2",
    ]);
    if (r.status !== 0)
      die("R3 --cluster-min 1 --group-min 2 exit " + r.status, r);
    if (
      !readJson(model2).nodes.some(
        (n) => n.kind === "component" && n.name === "report",
      )
    )
      die(
        "R3: lowering the thresholds did not surface the 2-file report_* group",
      );
    console.log(
      `  ok mini — ${containers} containers, ${leaves} leaves, ${derived} derived edge(s); one volatile field (generatedAt)`,
    );
  });
  test("gen: flat-python", async () => {
    const REPO = FIX("flat-python"),
      topo = join(tmp, "fp-topo.json"),
      model = join(tmp, "fp-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("fp init exit " + r.status, r);
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("fp gen exit " + r.status, r);
    // check exit 0 PROVES the containerOf fix landed everywhere (clustered leaves still counted under the container)
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0)
      die("fp check exit " + r.status + " (containerOf fix?)", r);
    const m = readJson(model);
    const compNames = m.nodes
      .filter((n) => n.kind === "component")
      .map((n) => n.name)
      .sort();
    if (compNames.length < 3)
      die(`§2: expected >=3 components, got ${compNames.length}`);
    if (!["order", "payment", "user"].every((x) => compNames.includes(x)))
      die("§2: expected order/payment/user components, got " + compNames);
    const flat = m.nodes
      .filter((n) => n.kind === "leaf" && n.parent === "services")
      .map((n) => n.name)
      .sort();
    if (!(flat.includes("health") && flat.includes("version")))
      die("§2: no-prefix leaves should stay flat, got " + flat);
    if (
      !m.nodes.some(
        (n) => n.name === "user_service" && n.descSource === "docstring",
      )
    )
      die("§1a: user_service func not from docstring");
    if (!m.nodes.some((n) => n.name === "health" && n.descSource === "readme"))
      die("§1a: health func not from dir README");
    // R4: a synthesized component describes itself from its children's docs, not "Groups related files under X."
    const userComp = m.nodes.find(
      (n) => n.kind === "component" && n.name === "user",
    );
    if (!userComp || /^Groups related files under/.test(userComp.func))
      die(
        'R4: component "user" still on the bare fallback: ' +
          (userComp && userComp.func),
      );
    if (!/user/i.test(userComp.func))
      die(
        "R4: component func not composed from its children docstrings: " +
          userComp.func,
      );
    // R3, raising the bar: this fixture's groups are 3 files each, so --group-min 4 (or a
    // --cluster-min above the leaf count) must dissolve the component layer entirely
    const m2 = join(tmp, "fp-model-thresholds.json");
    const compsOf = (p) =>
      readJson(p).nodes.filter((n) => n.kind === "component").length;
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      m2,
      "--group-min",
      "4",
    ]);
    if (r.status !== 0) die("R3 --group-min 4 exit " + r.status, r);
    if (compsOf(m2) !== 0)
      die("R3: --group-min was ignored (3-file groups still clustered at min 4)");
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      m2,
      "--cluster-min",
      "99",
    ]);
    if (r.status !== 0) die("R3 --cluster-min 99 exit " + r.status, r);
    if (compsOf(m2) !== 0)
      die(
        "R3: --cluster-min was ignored (container clustered below the new floor)",
      );
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      m2,
      "--group-min",
      "abc",
    ]);
    if (r.status === 0)
      die(
        "R3: a non-integer --group-min must fail loud, not silently disable clustering",
      );
    console.log(
      `  ok flat-python — ${compNames.length} components (${compNames}); §1a docstring+readme; R3 flags; R4 composed component prose`,
    );
  });
  test("gen: data-noise", async () => {
    const REPO = FIX("data-noise"),
      topo = join(tmp, "dn-topo.json");
    const r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("dn init exit " + r.status, r);
    const t = readJson(topo);
    if (!t.nodes.some((n) => n.name === "api")) die("§3: expected api container");
    if (t.nodes.some((n) => ["demo", "fixtures"].includes(n.name)))
      die("§3: a data dir was seeded as a container");
    if (!(t._skipped || []).some((s) => /demo|fixtures/.test(s.dir)))
      die("§3: skipped data dirs not recorded in _skipped");
    // language detection must ignore the same dirs: src/fixtures/*.py outnumbers src/api/*.js here,
    // and counting it would detect Python and then find no container at all (init exits 1).
    if (t.meta.stack !== "JavaScript")
      die("§3: data-dir files hijacked language detection, got " + t.meta.stack);
    console.log(
      "  ok data-noise — api seeded; demo/fixtures skipped, and ignored by language detection",
    );
  });
  test("gen: virgin-kebab", async () => {
    const REPO = FIX("virgin-kebab"),
      topo = join(tmp, "vk-topo.json"),
      model = join(tmp, "vk-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("vk init exit " + r.status, r);
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("vk gen exit " + r.status, r);
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("vk check exit " + r.status, r);
    const m = readJson(model);

    // F6 — a kebab name must still derive an edge (the auto-edge regex used to DELETE the hyphen,
    // producing \bsessionstore\b, which matches nothing: every kebab repo rendered edges=0).
    const derived = m.edges.filter((e) => e.kind === "import");
    if (!derived.length)
      die(
        "F6: kebab-case cross-container references derived 0 edges — the graph is empty",
      );
    if (!derived.some((e) => e.from === "api" && e.to === "core"))
      die("F6: expected the api→core edge, got " + JSON.stringify(derived));
    if (derived.some((e) => e.from === "core" && e.to === "api"))
      die("F6: edge direction inverted — core never references api");

    // F7 — the component level must exist for kebab/camel/dot repos, not only for snake_case ones.
    const comps = m.nodes
      .filter((n) => n.kind === "component")
      .map((n) => n.name)
      .sort();
    if (!comps.length)
      die(
        "F7: 9 kebab leaves in one container produced 0 components — no component level at all",
      );
    if (!(comps.includes("session") && comps.includes("rate")))
      die("F7: expected session/rate components, got " + comps);

    // the fixture must STAY virgin: one stray leading comment would give a leaf a docstring and the
    // assertions below would start passing for a reason that has nothing to do with the fix.
    if (m.nodes.some((n) => n.kind === "leaf" && n.descSource !== "fallback"))
      die(
        "F5: a leaf grew a docstring or a directory README — the fixture is no longer virgin",
      );

    // F3 — no box may be described by the name of its programming language.
    for (const n of m.nodes) {
      if (!String(n.func || "").trim())
        die(
          `F3: node ${n.id} (${n.kind}) has no description — the box falls back to its language`,
        );
      if (n.tech && String(n.func).trim() === String(n.tech).trim())
        die(`F3: node ${n.id} is described by its language ("${n.tech}")`);
    }

    // F4 — with no curated overlay the programme state is UNKNOWN, and it must say so.
    const invented = m.nodes.filter((n) => n.completion != null);
    if (invented.length)
      die(
        `F4: ${invented.length}/${m.nodes.length} node(s) carry an invented completion with no status overlay (e.g. ${invented[0].id}=${invented[0].completion})`,
      );
    const states = [...new Set(m.nodes.map((n) => n.status2))].sort();
    if (states.join() !== "unknown")
      die("F4: undecorated nodes must be status2=unknown, got [" + states + "]");

    // F1 — `--enrich` must never reach for an API key by default; the keyless path must still work.
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      join(tmp, "vk-bad.json"),
      "--enrich",
    ]);
    if (r.status === 0)
      die(
        "F1: `--enrich` with no explicit --enricher must fail loud instead of defaulting to the API-key provider",
      );
    if (!/--enricher/.test((r.stderr || "") + (r.stdout || "")))
      die("F1: the blocking message never names --enricher");
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      model,
      "--enrich",
      "--enricher",
      "agent",
    ]);
    if (r.status !== 0) die("F1: the keyless agent enricher must still work", r);

    // the viewer half of F3/F4: the box chain must not reach the language, and an unknown state
    // needs a sixth, neutral rendering — otherwise the model is honest and the screen still lies.
    const vhtml = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    if (/\|\|\s*[nm]\.tech/.test(vhtml))
      die(
        "F3: the viewer still falls back to `tech` when a box has no description",
      );
    const badgeLine = (vhtml.match(/\n\s*var badge=[^\n]*/) || [""])[0];
    if (!badgeLine)
      die("viewer: the badge expression was not found — did it move?");
    if (/tech/.test(badgeLine))
      die("F3: the badge still falls back to the language: " + badgeLine.trim());
    if (/\?"plan":"done"/.test(vhtml))
      die("F4: a node with no status2 still defaults to done (green by default)");
    const STMAP = new Function(
      (vhtml.match(/\nvar STMAP=\{[^\n]*/) || [""])[0].replace(/;\s*$/, "") +
        "; return STMAP",
    )();
    if (!STMAP.unknown)
      die(
        "F4: STMAP has no neutral sixth state — an unknown node renders as done",
      );
    if (!new RegExp("\\.s-" + STMAP.unknown + "\\b").test(vhtml))
      die("F4: the neutral state has no CSS class .s-" + STMAP.unknown);
    const ordLit = (vhtml.match(/ord=\[[^\]]*\]/) || [""])[0];
    if (!ordLit.includes('"' + STMAP.unknown + '"'))
      die(
        "F4: the per-level tally cannot count unknown nodes — the pill renders empty",
      );
    console.log(
      `  ok virgin-kebab — ${derived.length} derived edge(s), ${comps.length} component(s) (${comps}), every box described, state unknown until curated`,
    );
  });
  test("gen: go-nested", async () => {
    const REPO = FIX("go-nested"),
      topo = join(tmp, "go-topo.json"),
      model = join(tmp, "go-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("go init exit " + r.status, r);
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("go gen exit " + r.status, r);
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("go check exit " + r.status, r);
    const m = readJson(model);
    const conts = m.nodes.filter((n) => n.kind === "container");
    const cnames = conts.map((n) => n.name).sort();

    // G1 — the package is the unit of architecture: two packages nested under a common directory
    // are two containers, and the directory that merely holds them is not one.
    for (const want of ["internal/store", "internal/server", "cmd/app"])
      if (!cnames.includes(want))
        die(`G1: package ${want} is not a container, got [${cnames}]`);
    if (cnames.includes("internal"))
      die(
        "G1: `internal` is still one container swallowing its packages, got [" +
          cnames +
          "]",
      );

    // G2 — a test file is not architecture. Nothing in the model may come from a *_test.go.
    const testish = m.nodes.filter(
      (n) =>
        /_test$/.test(String(n.name)) ||
        (n.evidence || []).some((e) => /_test\.go$/.test(e.ref)),
    );
    if (testish.length)
      die("G2: _test.go files became nodes: " + testish.map((n) => n.id));

    // G3 — the package is ONE node. It used to be two: a container AND a leaf pointing at that very
    // same directory, so drilling into a package showed the package again — 53 of 53 on a real Go
    // repo, a level drawn twice. The files inside stay internal detail (#17): they are a COUNT on the
    // container, which is what the drift gate re-walks, not boxes.
    const leaves = m.nodes.filter((n) => n.kind === "leaf");
    if (leaves.length)
      die(
        `G3: a package is one node — got ${leaves.length} redundant leaf/leaves: ${leaves.map((n) => n.id)}`,
      );
    for (const c of conts) {
      const g = (c.evidence || []).find((e) => e.type === "glob");
      if (!g)
        die(
          "G3: container " +
            c.id +
            " carries no glob evidence — nothing for the gate to re-count",
        );
      if (g.ref !== c.name)
        die(
          `G3: container ${c.id} anchors on "${g.ref}", not its own package dir "${c.name}"`,
        );
      if (!statSync(join(REPO, g.ref)).isDirectory())
        die(`G3: container ${c.id} evidence is not a directory: ${g.ref}`);
    }
    // G3b — the count is the package's real non-test file count. Both halves matter: a count that is
    // always 1 is how the Go gate passed while a .go file was added or deleted.
    const storeC = conts.find((c) => c.name === "internal/store");
    const storeN = ((storeC.evidence || []).find((e) => e.type === "glob") || {})
      .count;
    if (storeN !== 2)
      die(
        `G3b: internal/store must count its 2 non-test files (store.go, query.go), got ${storeN}`,
      );

    // G4 — edges derived from the `import` block: deterministic, and the direction is right by
    // construction (the importer depends on the imported, never the reverse).
    const derived = m.edges.filter((e) => e.kind === "import");
    const idOf = (name) => (conts.find((c) => c.name === name) || {}).id;
    const store = idOf("internal/store"),
      server = idOf("internal/server"),
      app = idOf("cmd/app");
    const has = (from, to) => derived.some((e) => e.from === from && e.to === to);
    if (!has(server, store))
      die(
        'G4: `import "example.com/nested/internal/store"` derived no server→store edge, got ' +
          JSON.stringify(derived),
      );
    if (has(store, server))
      die("G4: edge direction inverted — store never imports server");
    if (!has(app, server))
      die(
        'G4: the single-line `import "…/internal/server"` form derived no cmd/app→internal/server edge',
      );
    if (derived.length !== 2)
      die(
        `G4: expected exactly the 2 declared imports (stdlib "fmt" is outside the module), got ${derived.length}: ${JSON.stringify(derived)}`,
      );
    console.log(
      `  ok go-nested — ${conts.length} package containers (${cnames}), ${leaves.length} package leaves, ${derived.length} import edge(s), zero test nodes`,
    );
  });
  test("gen: go-grouped", async () => {
    const REPO = FIX("go-grouped"),
      topo = join(tmp, "gg-topo.json"),
      model = join(tmp, "gg-model.json");
    const status = join(tmp, "gg-status.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("gg init exit " + r.status, r);
    const t = readJson(topo);
    const DOM = {
      money: ["internal/account", "internal/ledger"],
      platform: ["cmd/app", "internal/server", "internal/worker"],
    };
    const domainOf = new Map(
      Object.entries(DOM).flatMap(([d, ps]) => ps.map((p) => [p, d])),
    );
    const sys = t.nodes[0].id;
    // THE curation, exactly as a human must write it: level and parent move, `kind` does NOT.
    for (const n of t.nodes) {
      if (!domainOf.has(n.name)) continue;
      n.level = "component";
      n.parent = domainOf.get(n.name);
    }
    t.nodes.push(
      {
        id: "money",
        level: "container",
        kind: "container",
        parent: sys,
        name: "Money",
        tech: "Go",
        description: "What a customer owns and what moved.",
      },
      {
        id: "platform",
        level: "container",
        kind: "container",
        parent: sys,
        name: "Platform",
        tech: "Go",
        description: "The service that exposes the money domain.",
      },
    );
    writeFileSync(topo, JSON.stringify(t, null, 2) + "\n");
    // a verdict on the PACKAGES only — the domains stay unruled, which is the whole point of the tally
    writeFileSync(
      status,
      JSON.stringify(
        {
          nodes: {
            internal_account: { status2: "done", completion: 100 },
            internal_ledger: { status2: "done", completion: 100 },
            internal_server: { status2: "in-progress", completion: 40 },
          },
        },
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
      model,
      "--status",
      status,
    ]);
    if (r.status !== 0) die("gg gen exit " + r.status, r);
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("gg check exit " + r.status, r);
    const m = readJson(model);

    // P0 — the premise: keeping kind:"container" preserves every import edge across the regrouping.
    if (m.edges.filter((e) => e.kind === "import").length !== 5)
      die(
        "gg precondition: grouping cost import edges, got " +
          JSON.stringify(m.edges),
      );

    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    const rfn = (html.match(
      /\nfunction rollEdges\(edges,vis,parent\)\{[\s\S]*?\n\}/,
    ) || [])[0];
    if (!rfn)
      die("viewer: rollEdges not found — did the roll-up move back inline?");
    const rollEdges = new Function(rfn + "; return rollEdges")();
    const parent = Object.fromEntries(
      m.nodes.map((n) => [n.id, n.parent || null]),
    );
    const screen = (ids) =>
      rollEdges(m.edges, Object.fromEntries(ids.map((i) => [i, i])), parent);

    // P1 — the domain level draws its children's relationships, with the count SUMMED. Three model
    // edges (server→account 2×, server→ledger 1×, worker→account 1×) become ONE arrow reading 4×.
    const dom = screen(["money", "platform"]);
    if (dom.length !== 1)
      die(
        `P1: the grouped level drew ${dom.length} arrow(s), want exactly platform→money: ` +
          JSON.stringify(dom),
      );
    if (!(dom[0].from === "platform" && dom[0].to === "money"))
      die(
        "P1: arrow direction inverted — money never imports platform: " +
          JSON.stringify(dom[0]),
      );
    if (dom[0].n !== 4)
      die(
        `P1: the rolled count is ${dom[0].n}, not the sum 2+1+1=4 — the arrow under-reports what it stands for`,
      );
    if (!/^4/.test(String(dom[0].label)))
      die("P1: the summed count never reached the label: " + dom[0].label);

    // P2 — an edge whose ends sit inside the SAME box is not an arrow: account→ledger and
    // app→server are internal detail at the domain level, and both are drawn one level down.
    if (screen(["money", "platform"]).some((e) => e.from === e.to))
      die("P2: a box drew an arrow to itself");
    const insideMoney = screen(["internal_account", "internal_ledger"]);
    if (!(insideMoney.length === 1 && insideMoney[0].from === "internal_account"))
      die(
        "P2: drilling into a domain lost its internal arrow: " +
          JSON.stringify(insideMoney),
      );
    // a single contributing edge keeps its label verbatim (the verb, not a synthesized count) and
    // carries its weight in .n — the roll-up only synthesizes "n×" when it merges ≥2 edges.
    const srcInternal = m.edges.find(
      (e) => e.from === "internal_account" && e.to === "internal_ledger",
    );
    if (!srcInternal) die("P2: fixture lost the account→ledger internal edge");
    if (String(insideMoney[0].label) !== String(srcInternal.label))
      die(
        "P2: a single contributing edge must keep its label verbatim, got " +
          insideMoney[0].label +
          " (source " +
          srcInternal.label +
          ")",
      );
    if (insideMoney[0].n !== (srcInternal.weight > 0 ? srcInternal.weight : 1))
      die(
        "P2: a single edge must carry its weight in .n, got " + insideMoney[0].n,
      );
    if (!screen(["cmd_app", "internal_server", "internal_worker"]).length)
      die("P2: the platform screen lost its internal arrow");

    // P2b — a derived edge labelled with a verb (no number in the label) still counts: its `weight`
    // field feeds the roll-up, so the arrow reports the summed count without parsing the label.
    // Regression guard for the verb refactor (label = relationship, weight = count).
    const vis = Object.fromEntries(["money", "platform"].map((i) => [i, i]));
    const wm = rollEdges(
      [
        ...m.edges,
        {
          from: "platform",
          to: "money",
          label: "imports",
          weight: 3,
          kind: "import",
          estatus: "inferred",
        },
      ],
      vis,
      parent,
    ).find((e) => e.from === "platform" && e.to === "money");
    if (!wm || wm.n !== 7)
      die(
        "P2b: a verb-labelled edge with weight did not add its weight to the roll (want 7=4+3): " +
          JSON.stringify(wm),
      );

    // P3 — the tally reports the PACKAGES, not the domains. 3 of 5 packages carry a verdict; the two
    // domain boxes carry none. Before the roll-up this level read 0/2 and the 3 verdicts vanished.
    const tfn2 = (html.match(/\nfunction tallyOf\(kids,kidsOf\)\{[\s\S]*?\n\}/) ||
      [])[0];
    const tallyOf2 = new Function(
      'var STMAP={done:"done","in-progress":"prog",next:"next",planned:"plan",problem:"prob",unknown:"unk"};' +
        tfn2 +
        "; return tallyOf",
    )();
    const kidsOf = (id) => m.nodes.filter((n) => n.parent === id);
    const T = tallyOf2(
      m.nodes.filter((n) => n.parent === sys),
      kidsOf,
    );
    if (!(T.ruled === 3 && T.tot === 5))
      die(
        `P3: the grouped level tallies ${T.ruled}/${T.tot}, want 3/5 — the packages' verdicts do not reach the box that groups them`,
      );
    if (T.mean !== 80)
      die(
        `P3: mean over the ruled packages is ${T.mean}, want 80 ((100+100+40)/3)`,
      );
    if ((T.cnt.done || 0) !== 2 || (T.cnt.unk || 0) !== 2)
      die("P3: the status dots count boxes, not units: " + JSON.stringify(T.cnt));

    // P4 — the curation that WOULD cost the graph must say so. `kind: "component"` is the intuitive
    // thing to write and it takes 189 edges to 13 on a real repo, silently.
    const badTopo = join(tmp, "gg-topo-bad.json"),
      badModel = join(tmp, "gg-model-bad.json");
    const bad = readJson(topo);
    for (const n of bad.nodes) if (domainOf.has(n.name)) n.kind = "component";
    writeFileSync(badTopo, JSON.stringify(bad, null, 2) + "\n");
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      badTopo,
      "--out",
      badModel,
      "--status",
      status,
    ]);
    if (r.status !== 0) die("P4 gen exit " + r.status, r);
    if (readJson(badModel).edges.filter((e) => e.kind === "import").length)
      die(
        'P4 precondition: kind:"component" no longer drops the edges — retune this assertion',
      );
    if (!/WARNING/.test(r.stderr || ""))
      die(
        "P4: gen dropped every import edge without a word on stderr:\n" +
          (r.stderr || "<empty>"),
      );
    if (!/\b5 node\(s\)/.test(r.stderr || ""))
      die("P4: the warning does not carry the count: " + (r.stderr || ""));
    if (!/kind/.test(r.stderr || ""))
      die(
        "P4: the warning never names the field that caused it: " +
          (r.stderr || ""),
      );
    console.log(
      `  ok go-grouped — a grouping box draws its children's arrows (platform→money ${dom[0].label}, self-loops dropped), tallies their verdicts (${T.ruled}/${T.tot}), and a curation that would lose edges warns loud`,
    );
  });
  test("gen: context-seed", async () => {
    const REPO = FIX("mini"),
      topo = join(tmp, "ctx-topo.json"),
      model = join(tmp, "ctx-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("ctx init exit " + r.status, r);
    const t = readJson(topo);
    const ctx = t.nodes.filter((n) => !n.parent);
    const sys = ctx.find((n) => n.kind === "system");
    const actors = ctx.filter((n) => n.kind !== "system");

    // C1 — a person and an external system, not just the product
    for (const k of ["person", "external"])
      if (!ctx.some((n) => n.kind === k))
        die(
          `C1: init seeded no "${k}" in the context, got [${ctx.map((n) => n.kind)}]`,
        );
    // C2 — with an arrow each. Boxes and no arrows is a bulleted list in rectangles (predicate 4).
    for (const a of actors)
      if (
        !t.edges.some(
          (e) =>
            (e.from === a.id && e.to === sys.id) ||
            (e.to === a.id && e.from === sys.id),
        )
      )
        die("C2: context actor " + a.id + " carries no edge to the system");
    // C3 — a plausible invented actor ("End user") would be indistinguishable from curated truth
    for (const a of actors)
      if (!/^TODO:/.test(a.name))
        die("C3: a seeded placeholder is not marked as one: " + a.name);
    // C4 — the closing line leads with the context instead of burying it as one of three chores
    const last = (r.stdout || "").trim().split("\n").pop();
    if (!/NEXT/.test(last)) die("C4: init printed no NEXT line: " + last);
    if (!/TODO:/.test(last) || last.indexOf("TODO:") > last.indexOf("curate"))
      die("C4: the NEXT line does not put the context first: " + last);

    // C5 — while they are anonymous `gen` says so, in ONE line, naming them, and does not fail
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("C5: gen must not fail over unnamed placeholders", r);
    const note = (r.stderr || "")
      .split("\n")
      .filter((l) => /still unnamed/.test(l));
    if (note.length !== 1)
      die(
        `C5: expected exactly one reminder line on stderr, got ${note.length}:\n${r.stderr}`,
      );
    for (const a of actors)
      if (!note[0].includes(a.name))
        die("C5: the reminder never names " + a.name + ": " + note[0]);

    // C6 — predicates 1 and 4 of scripts/presentable.mjs, measured on the model the way it measures
    const m = readJson(model);
    const roots = m.nodes.filter((n) => !n.parent);
    if (roots.length < 2)
      die(
        `C6: predicate 1 still fails on a freshly initialised repo (${roots.length} box(es) at context)`,
      );
    const ids = new Set(roots.map((n) => n.id));
    if (!m.edges.some((e) => ids.has(e.from) && ids.has(e.to)))
      die(
        "C6: the context screen draws no edge — predicate 4 fails where it used to pass",
      );
    if (m.nodes.some((n) => n.parent && !String(n.func || "").trim()))
      die("C6: predicate 3 regressed — a box below the context lost its prose");

    // C7 — the reminder keys on the NAME, not on the seeded ids: rename them and it must fall silent,
    // or every curated repo carries a nag forever and the signal stops meaning anything.
    const named = readJson(topo);
    for (const n of named.nodes) if (/^TODO:/.test(n.name)) n.name = "The family";
    const namedTopo = join(tmp, "ctx-topo-named.json");
    writeFileSync(namedTopo, JSON.stringify(named, null, 2));
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      namedTopo,
      "--out",
      join(tmp, "ctx-model-named.json"),
    ]);
    if (r.status !== 0) die("C7: gen on a curated context exit " + r.status, r);
    if (/still unnamed/.test(r.stderr || ""))
      die("C7: the reminder survived the rename: " + r.stderr);
    // C8 — `init` is best-effort and must never fail on a strange repo: a directory with no recognised
    // source at all still has a true context to write, and exiting 1 left the caller with no file.
    const bare = mkdtempSync(join(tmpdir(), "forma-bare-"));
    writeFileSync(join(bare, "README.md"), "# nothing but prose\n");
    const bareTopo = join(tmp, "bare-topo.json"),
      bareModel = join(tmp, "bare-model.json");
    r = run(["init", "--repo", bare, "--out", bareTopo, "--force"]);
    if (r.status !== 0)
      die(
        "C8: init must not exit " +
          r.status +
          " on a repo with no recognised source",
        r,
      );
    const b = readJson(bareTopo);
    if (b.leafSources.length)
      die(
        "C8: a source-less repo seeded containers: " +
          JSON.stringify(b.leafSources),
      );
    if (b.nodes.filter((n) => !n.parent).length !== 3)
      die(
        "C8: the context was not written anyway: " +
          JSON.stringify(b.nodes.map((n) => n.kind)),
      );
    r = run(["gen", "--repo", bare, "--topology", bareTopo, "--out", bareModel]);
    if (r.status !== 0) die("C8: the context-only topology does not gen", r);
    console.log(
      `  ok context-seed — §33 ${actors.length} placeholder actor(s) + ${t.edges.length} edge(s), gen names them once and stops after the rename; a source-less repo still gets a context`,
    );
  });
  test("gen: two-stack", async () => {
    const REPO = FIX("two-stack"),
      topo = join(tmp, "2s-topo.json"),
      model = join(tmp, "2s-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("two-stack init exit " + r.status, r);
    const t = readJson(topo);

    if (
      t.meta.stack !== "Go + TypeScript" ||
      (t.meta.stacks || []).join() !== "Go,TypeScript"
    )
      die("S1: both stacks are not declared: " + JSON.stringify(t.meta));
    const techs = new Set(
      t.nodes.filter((n) => n.kind === "container").map((n) => n.tech),
    );
    if (!techs.has("Go") || !techs.has("TypeScript"))
      die("S1: both stacks are not seeded: " + JSON.stringify([...techs]));
    if ((t._unseeded || []).length)
      die("S2: init left an ungoverned stack: " + JSON.stringify(t._unseeded));
    const tsSources = t.leafSources.filter(
      (s) => (t.nodes.find((n) => n.id === s.parent) || {}).tech === "TypeScript",
    );
    if (
      !tsSources.length ||
      !tsSources.some((s) => new RegExp(s.match).test("view.tsx"))
    )
      die("S3: TypeScript source roots miss *.tsx: " + JSON.stringify(tsSources));
    // S3c — a *.tsx-dominant repo must seed the *.ts half of the same language too, not report it
    const react = mkdtempSync(join(tmpdir(), "forma-react-"));
    mkdirSync(join(react, "src", "ui"), { recursive: true });
    for (const f of ["a.tsx", "b.tsx", "c.tsx", "helpers.ts", "types.ts"])
      writeFileSync(join(react, "src", "ui", f), "export const x = 1\n");
    const rTopo = join(tmp, "react-topo.json"),
      rModel = join(tmp, "react-model.json");
    r = run(["init", "--repo", react, "--out", rTopo, "--force"]);
    if (r.status !== 0) die("S3c react init exit " + r.status, r);
    const rt = readJson(rTopo);
    r = run(["gen", "--repo", react, "--topology", rTopo, "--out", rModel]);
    if (r.status !== 0) die("S3c react gen exit " + r.status, r);
    const rl = readJson(rModel)
      .nodes.filter((n) => n.kind === "leaf")
      .map((n) => n.name)
      .sort();
    if (rl.length !== 5)
      die(
        `S3c: one match per LANGUAGE — expected all 5 *.ts/*.tsx files, got ${rl.length}: ${rl}`,
      );

    // Direct first-run: no paste or generated-file editing between init and gen/check.
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("S4: multi-stack topology does not gen directly", r);
    const m = readJson(model);
    if (!m.nodes.some((n) => n.kind === "container" && n.tech === "TypeScript"))
      die("S4: generated model has no TypeScript container");
    if (!m.nodes.some((n) => n.kind === "leaf" && n.name === "view"))
      die(
        "S4: the *.tsx file never became a leaf — the match under-covers the language",
      );
    if (
      m.edges.filter((e) => e.kind === "import" && e.estatus === "inferred")
        .length < 2
    )
      die(
        "S4: composing stack adapters lost the declared Go imports: " +
          JSON.stringify(m.edges),
      );
    const pathLeaves = [
      "billing/A.java",
      "billing/B.java",
      "billing/C.java",
      "orders/D.java",
      "orders/E.java",
      "orders/F.java",
    ].map((path, i) => ({
      id: "j" + i,
      name: "Class" + i,
      evidence: [{ type: "path", ref: "src/main/java/com/acme/" + path }],
    }));
    const pathComponents = componentsFor(
      { id: "java", category: "container" },
      pathLeaves,
    )
      .components.map((c) => c.name)
      .join();
    if (pathComponents !== "billing,orders")
      die(
        "S4: package paths did not become usable Java components: " +
          pathComponents,
      );
    const twoById = new Map(m.nodes.map((n) => [n.id, n]));
    if (
      m.edges.some(
        (e) =>
          e.label === "imports" &&
          (twoById.get(e.from) || {}).tech === "TypeScript",
      )
    )
      die(
        "S4: Go adapter attributed a Go import to the co-located TypeScript container: " +
          JSON.stringify(m.edges),
      );
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("S4: direct multi-stack model fails check", r);

    const nestedGo = join(tmp, "go-nested-module"),
      nestedTopo = join(tmp, "go-nested-module-topo.json"),
      nestedModel = join(tmp, "go-nested-module-model.json");
    mkdirSync(join(nestedGo, "service", "a"), { recursive: true });
    mkdirSync(join(nestedGo, "service", "b"), { recursive: true });
    writeFileSync(
      join(nestedGo, "service", "go.mod"),
      "module example.com/service\n\ngo 1.22\n",
    );
    writeFileSync(
      join(nestedGo, "service", "a", "a.go"),
      'package a\nimport "example.com/service/b"\nfunc A() string { return b.B() }\n',
    );
    writeFileSync(
      join(nestedGo, "service", "b", "b.go"),
      'package b\nfunc B() string { return "b" }\n',
    );
    r = run(["init", "--repo", nestedGo, "--out", nestedTopo, "--force"]);
    if (r.status !== 0) die("S4: nested Go module init failed", r);
    r = run([
      "gen",
      "--repo",
      nestedGo,
      "--topology",
      nestedTopo,
      "--out",
      nestedModel,
    ]);
    if (r.status !== 0) die("S4: nested Go module gen failed", r);
    if (!readJson(nestedModel).edges.some((e) => e.label === "imports"))
      die("S4: nested Go module lost its declared import edge");
    r = run([
      "check",
      "--repo",
      nestedGo,
      "--model",
      nestedModel,
      "--topology",
      nestedTopo,
    ]);
    if (r.status !== 0) die("S4: nested Go module check failed", r);

    const testsTopo = join(tmp, "2s-topo-tests.json"),
      testsModel = join(tmp, "2s-model-tests.json");
    r = run([
      "init",
      "--repo",
      REPO,
      "--out",
      testsTopo,
      "--force",
      "--include-tests",
    ]);
    if (r.status !== 0) die("S4: Go include-tests init failed", r);
    const withTests = readJson(testsTopo),
      goParents = new Set(
        withTests.nodes.filter((n) => n.tech === "Go").map((n) => n.id),
      );
    if (
      withTests.leafSources
        .filter((s) => goParents.has(s.parent))
        .some((s) => s.exclude)
    )
      die("S4: Go --include-tests kept the _test.go exclusion");
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      testsTopo,
      "--out",
      testsModel,
    ]);
    if (r.status !== 0) die("S4: Go include-tests gen failed", r);
    r = run([
      "check",
      "--repo",
      REPO,
      "--model",
      testsModel,
      "--topology",
      testsTopo,
    ]);
    if (r.status !== 0) die("S4: Go include-tests check failed", r);

    // Removing one whole stack must make check red even though every remaining leafSource recounts.
    const bad = readJson(topo),
      badTopo = join(tmp, "2s-topo-missing-ts.json");
    const tsParents = new Set(
      bad.nodes.filter((n) => n.tech === "TypeScript").map((n) => n.id),
    );
    bad.leafSources = bad.leafSources.filter((s) => !tsParents.has(s.parent));
    writeFileSync(badTopo, JSON.stringify(bad, null, 2));
    r = run(["check", "--repo", REPO, "--model", model, "--topology", badTopo]);
    if (r.status === 0 || !/SOURCE COVERAGE TypeScript/.test(r.stderr || ""))
      die("S5: removing TypeScript coverage did not fail closed", r);
    const bypass = readJson(topo),
      bypassTopo = join(tmp, "2s-topo-no-coverage.json");
    delete bypass.sourceCoverage;
    bypass.leafSources = bypass.leafSources.filter(
      (s) => !tsParents.has(s.parent),
    );
    writeFileSync(bypassTopo, JSON.stringify(bypass, null, 2));
    r = run([
      "check",
      "--repo",
      REPO,
      "--model",
      model,
      "--topology",
      bypassTopo,
    ]);
    if (r.status === 0 || !/missing sourceCoverage/.test(r.stderr || ""))
      die("S5: deleting the coverage contract made the omitted stack pass", r);
    console.log(
      "  ok two-stack — Go + TypeScript seeded, generated and checked directly; removing one stack fails coverage",
    );
  });
  test("gen: cold-start-closure", async () => {
    const REPO = FIX("cold-start-closure"),
      topo = join(tmp, "cs-topo.json"),
      model = join(tmp, "cs-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("cold-start init exit " + r.status, r);
    const t = readJson(topo),
      sources = JSON.stringify(t.leafSources),
      exclusions = (t.sourceCoverage || {}).exclusions || [];
    for (const stack of ["Java", "TypeScript"])
      if (!(t.meta.stacks || []).includes(stack))
        die("cold-start: production stack not detected: " + stack);
    if (
      (t.meta.stacks || []).some((stack) => stack === "C#" || stack === "Swift")
    )
      die(
        "cold-start: test-only stack entered the production topology: " +
          t.meta.stacks,
      );
    if (
      !t.docSources.some(
        (s) => (typeof s === "string" ? s : s.path) === "docs/FEATURES.md",
      )
    )
      die("cold-start: valid rooted docSource not adopted");
    if (
      t.docSources.some(
        (s) => (typeof s === "string" ? s : s.path) === "docs/BROKEN.md",
      )
    )
      die("cold-start: dead docSource adopted and will break gen");
    for (const unsafe of ["docs/MISSING_REF.md", "docs/ESCAPE.md"])
      if (
        t.docSources.some((s) => (typeof s === "string" ? s : s.path) === unsafe)
      )
        die("cold-start: non-atomic or escaping docSource adopted: " + unsafe);
    const symlinkRepo = join(tmp, "doc-symlink"),
      outside = join(tmp, "outside.js");
    mkdirSync(join(symlinkRepo, "src"), { recursive: true });
    mkdirSync(join(symlinkRepo, "docs"), { recursive: true });
    writeFileSync(outside, "export const outside = true\n");
    symlinkSync(outside, join(symlinkRepo, "src", "external.js"));
    writeFileSync(
      join(symlinkRepo, "docs", "FEATURES.md"),
      "| capability | status | code_ref |\n|---|---|---|\n| Escape | DONE | `src/external.js` |\n",
    );
    if (
      !loadDocRows(symlinkRepo, ["docs/FEATURES.md"], true).some(
        (row) => row.dead.length,
      )
    )
      die("cold-start: a symlink escaped the doc evidence trust boundary");
    if (!/frontend/.test(sources) || !/backend/.test(sources))
      die("cold-start: backend/frontend roots not seeded");
    for (const part of ["androidTest", "testFixtures", "uiTests"])
      if (!exclusions.some((x) => String(x.dir || "").includes(part) && x.reason))
        die("cold-start: missing reasoned exclusion for " + part);
    if (!exclusions.some((x) => x.match && x.reason))
      die("cold-start: co-located test files have no reasoned exclusion");
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("cold-start gen exit " + r.status, r);
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("cold-start check exit " + r.status, r);
    const refs = readJson(model)
      .nodes.flatMap((n) => n.evidence || [])
      .map((e) => e.ref || "")
      .join("\n");
    if (
      /(?:^|\/)(?:test|tests|androidTest|testFixtures|uiTests)(?:\/|$)|(?:Test|Tests|\.test|\.spec)\.[^.]+$/m.test(
        refs,
      )
    )
      die("cold-start: test source entered the production model: " + refs);

    const allTopo = join(tmp, "cs-all-topo.json"),
      allModel = join(tmp, "cs-all-model.json");
    r = run([
      "init",
      "--repo",
      REPO,
      "--out",
      allTopo,
      "--force",
      "--include-tests",
    ]);
    if (r.status !== 0) die("cold-start include-tests init exit " + r.status, r);
    const all = readJson(allTopo);
    if (
      !(all.meta.stacks || []).includes("C#") ||
      (all.sourceCoverage.exclusions || []).some((x) =>
        /test source/.test(x.reason),
      )
    )
      die("cold-start: --include-tests did not restore every test stack");
    r = run(["gen", "--repo", REPO, "--topology", allTopo, "--out", allModel]);
    if (r.status !== 0) die("cold-start include-tests gen exit " + r.status, r);
    r = run([
      "check",
      "--repo",
      REPO,
      "--model",
      allModel,
      "--topology",
      allTopo,
    ]);
    if (r.status !== 0) die("cold-start include-tests check exit " + r.status, r);
    console.log(
      "  ok cold-start-closure — multiroot/multistack, atomic docs, reasoned test exclusions and include-tests all close",
    );
  });
  test("gen: attach-doc", async () => {
    const repo = join(tmp, "selfrepo");
    // The copy stands in for a fresh checkout, so it must not carry what a checkout does not have.
    // control-room.html is generated (verify -> gen -> room) and gitignored; copying it in would make
    // this block fail for a true reason in a false situation — the git-derived halves of the briefing
    // (commit drift, the issue-to-code link) cannot re-derive equal inside a tree with no .git.
    cpSync(join(HERE, ".."), repo, {
      recursive: true,
      filter: (s) =>
        !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) &&
        !/control-room\.html$/.test(s),
    });
    // this test regenerates a synthetic topology over the self-repo copy; the repo's REAL programme
    // overlay refers to the curated topology's ids, so drop it or gen fails loud (correctly) on it
    rmSync(join(repo, "docs/architecture/c4-status.json"), { force: true });
    const topo = join(tmp, "s-topo.json"),
      model = join(tmp, "s-model.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("attach init exit " + r.status, r);
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("attach gen exit " + r.status, r);
    const docFile = join(repo, "docs/architecture/ARCHITECTURE.md"); // == model.source.docPath
    mkdirSync(dirname(docFile), { recursive: true });
    writeFileSync(
      docFile,
      "# Arch\n\nHuman intro prose.\n\n<!-- forma:begin (generated — do not edit) -->\nSTALE\n<!-- forma:end -->\n\nHuman footer prose.\n",
    );
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status === 0) die("§1b: check should FAIL on a stale doc block");
    r = run(["doc", "--repo", repo, "--model", model, "--attach", docFile]);
    if (r.status !== 0) die("§1b: doc --attach exit " + r.status, r);
    const d = readFileSync(docFile, "utf-8");
    if (!(d.includes("Human intro prose.") && d.includes("Human footer prose.")))
      die("§1b: attach clobbered human prose");
    if (!d.includes("C4Context"))
      die("§1b: attach did not inject the generated block");
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("§1b: check should PASS after regen", r);

    // R1: a block attached to a file that is NOT source.docPath must be governed too — otherwise
    // `forma doc --attach any.md` produces a generated block no gate ever checks (false green).
    const other = join(repo, "docs/architecture/NOTES.md");
    writeFileSync(other, "# Notes\n\nHuman notes.\n");
    r = run(["doc", "--repo", repo, "--model", model, "--attach", other]);
    if (r.status !== 0) die("R1: doc --attach NOTES.md exit " + r.status, r);
    if (
      !(readJson(model).source.attachedDocs || []).includes(
        "docs/architecture/NOTES.md",
      )
    )
      die("R1: --attach did not register the target in source.attachedDocs");
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("R1: check should PASS right after attach", r);
    // the registry must survive a plain regen, or the gate silently stops governing the file
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("R1 regen exit " + r.status, r);
    if (
      !(readJson(model).source.attachedDocs || []).includes(
        "docs/architecture/NOTES.md",
      )
    )
      die(
        "R1: gen dropped source.attachedDocs — the attached doc is un-governed again",
      );
    writeFileSync(
      other,
      readFileSync(other, "utf-8").replace("C4Context", "C4Tampered"),
    );
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status === 0)
      die(
        "R1: check stayed green on a tampered block in an attached doc (false green)",
      );
    if (!/NOTES\.md/.test((r.stdout || "") + (r.stderr || "")))
      die("R1: check failed but did not name the offending file");
    r = run(["doc", "--repo", repo, "--model", model, "--attach", other]);
    if (r.status !== 0) die("R1: re-attach exit " + r.status, r);
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("R1: check should PASS after re-attach", r);
    // deleting BOTH markers must not un-govern the doc: registry membership proves a block was
    // injected, and the now-frozen text keeps shipping to readers as if it were still generated
    writeFileSync(
      other,
      readFileSync(other, "utf-8").replace(
        /<!-- forma:(begin[^>]*|end) -->/g,
        "",
      ),
    );
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status === 0)
      die(
        "R1: check went green after the forma markers were deleted from a registered doc",
      );
    rmSync(other);
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status === 0)
      die("R1: check went green after a registered doc was deleted");
    console.log(
      "  ok attach-doc — §1b inject preserves prose; R1 gate governs attached docs ≠ docPath, survives regen",
    );
  });
  test("gen: scaffold", async () => {
    const REPO = FIX("mini"),
      topo = join(tmp, "sc-topo.json"),
      model = join(tmp, "sc-model.json"),
      out = join(tmp, "ARCH.scaffold.md");
    run(["init", "--repo", REPO, "--out", topo, "--force"]);
    run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    const r = run(["doc", "--repo", REPO, "--model", model, "--out", out]);
    if (r.status !== 0) die("scaffold doc exit " + r.status, r);
    const s = readFileSync(out, "utf-8");
    if (
      !(
        s.includes("C4Context") &&
        s.includes("| Container | Tech | Leaves") &&
        s.includes("TODO(forma)")
      )
    )
      die("scaffold-regression: missing expected sections");
    for (const key of [
      "title",
      "doc_version",
      "status",
      "last_review",
      "owner",
      "canonical_id",
      "tags",
      "related",
    ]) {
      if (!new RegExp("^" + key + ":", "m").test(s))
        die("scaffold-regression: generated frontmatter is missing " + key);
    }
    console.log("  ok scaffold — default forma doc unchanged");
  });
  test("gen: component-hash", async () => {
    const repo = join(tmp, "comp-hash");
    cpSync(FIX("flat-python"), repo, { recursive: true });
    const topo = join(tmp, "ch-topo.json"),
      model = join(tmp, "ch-model.json");
    run(["init", "--repo", repo, "--out", topo, "--force"]);
    let r = run([
      "gen",
      "--repo",
      repo,
      "--topology",
      topo,
      "--out",
      model,
      "--enrich",
      "--enricher",
      "echo",
    ]);
    if (r.status !== 0) die("comp-hash enrich exit " + r.status, r);
    const comp = readJson(model).nodes.find(
      (n) => n.kind === "component" && n.name === "user",
    );
    if (!comp || comp.descSource !== "llm")
      die("comp-hash precondition: the component was not enriched");
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (/enrichment stale/.test(r.stderr || ""))
      die("comp-hash: freshly enriched component reported stale");
    // a child's documentation changes → the component's composed description would change with it
    const kid = join(repo, "src/services/user_service.py");
    const q3 = '"'.repeat(3);
    writeFileSync(
      kid,
      q3 +
        "Rewritten: registers, authenticates and deletes user accounts." +
        q3 +
        "\n",
    );
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("comp-hash regen exit " + r.status, r);
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0)
      die("comp-hash: check must stay green (staleness is advisory)", r);
    if (!new RegExp("enrichment stale for " + comp.id).test(r.stderr || ""))
      die(
        "comp-hash: a child gaining docs left the component prose frozen and unflagged",
      );
    r = run([
      "gen",
      "--repo",
      repo,
      "--topology",
      topo,
      "--out",
      model,
      "--enrich",
      "--enricher",
      "echo",
    ]);
    if (!/filled 1\/1/.test(r.stdout || ""))
      die(
        "comp-hash: --enrich could not re-admit the component as a hole: " +
          (r.stdout || ""),
      );
    console.log(
      "  ok component-hash — a child gaining documentation marks the component prose stale and refillable",
    );
  });
  test("gen: layout-hints", async () => {
    const REPO = FIX("mini"),
      topo = join(tmp, "ly-topo.json"),
      model = join(tmp, "ly-model.json");
    let r = run(["init", "--repo", REPO, "--out", topo, "--force"]);
    if (r.status !== 0) die("layout init exit " + r.status, r);
    const t = readJson(topo);
    const layout = {
      root: { [t.nodes[0].id]: { x: 40, y: 190, w: 190, h: 82 } },
    };
    writeFileSync(topo, JSON.stringify({ ...t, layout }, null, 2));
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("layout gen exit " + r.status, r);
    if (JSON.stringify(readJson(model).meta.layout) !== JSON.stringify(layout))
      die("WP-A4: topology layout did not reach meta.layout verbatim");

    const html = readFileSync(
      join(HERE, "..", "lib", "viewer", "c4-hologram.html"),
      "utf-8",
    );
    const src = (html.match(/\nvar NW=[\s\S]*?(?=\nfunction layoutFor\()/) ||
      [])[0];
    if (!src) die("WP-A4: seedLayout/autoLayout not found in the viewer");
    const seedLayout = new Function(src + "; return seedLayout")();
    const kids = [
      { id: "pinned", kind: "container" },
      { id: "free1", kind: "container" },
      { id: "free2", kind: "container" },
    ];
    const hint = { pinned: { x: 40, y: 190, w: 190, h: 82 } };
    const lay = seedLayout(kids, hint);
    const p = lay.pos.pinned;
    if (!(p.x === 40 && p.y === 190 && p.w === 190 && p.h === 82))
      die(
        "WP-A4: hinted node not placed at its coordinates: " + JSON.stringify(p),
      );
    const hits = (a, b) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const id of ["free1", "free2"]) {
      if (!lay.pos[id]) die("WP-A4: unhinted node lost its slot: " + id);
      if (hits(p, lay.pos[id]))
        die(`WP-A4: unhinted ${id} overlaps the pinned node`);
      if (
        lay.pos[id].x + lay.pos[id].w > lay.W ||
        lay.pos[id].y + lay.pos[id].h > lay.H
      )
        die("WP-A4: viewBox does not cover the auto-placed nodes");
    }
    if (
      JSON.stringify(seedLayout(kids, null)) !== JSON.stringify(seedLayout(kids))
    )
      die("WP-A4: no-hint path changed shape");

    // LEGIBILITY FLOOR. The owner's complaint about a real 53-container repo — "you cannot read
    // anything" — stated as a number. The stage is full-width by 74vh and the viewBox is
    // fit-to-content with xMidYMid meet, so the on-screen font is the model font times
    // min(stageW/W, stageH/H). A title under ~9px is not readable on a projector; the shipped
    // 4-column cap put it at 3.24px for 53 siblings, and at less than 9px for 44 of the 60 counts.
    const autoLayout = new Function(src + "; return autoLayout")();
    const TITLE_PX = 11.5,
      FLOOR = 9,
      STAGE_W = 1884,
      STAGE_H = 799;
    let worst = { px: Infinity, n: 0 };
    for (let n = 1; n <= 60; n++) {
      const l = autoLayout(
        [...Array(n)].map((_, i) => ({ id: "k" + i, kind: "container" })),
      );
      const px = TITLE_PX * Math.min(STAGE_W / l.W, STAGE_H / l.H);
      if (px < worst.px) worst = { px, n };
    }
    if (worst.px < FLOOR)
      die(
        `viewer legibility: a title renders at ${worst.px.toFixed(2)}px with ${worst.n} siblings — under the ${FLOOR}px floor, nobody can read the board`,
      );
    console.log(
      `  ok layout-hints — WP-A4 layout verbatim, pinned coords honoured; legibility floor holds to 60 siblings (worst ${worst.px.toFixed(1)}px)`,
    );
  });
});
