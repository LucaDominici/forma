#!/usr/bin/env node
// CLI surface: fail-closed flag handling, the S2 round-1 fixes, #132's unmeasured-vs-zero
// distinction, and forma serve's strict-flag/equals-flag parsing.
import test, { describe } from "node:test";

import { spawnSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  existsSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

import { validateModel } from "../lib/validate.mjs";
import { deriveAll, derivePortfolio } from "../lib/roomderive.mjs";

import { HERE, FIX, freshTmp, run, die, readJson } from "./helpers.mjs";

const tmp = freshTmp();

describe("cli", () => {
  // F3a: `arbiter.milestones` is opt-in BY PRESENCE — an empty string names no projection but is not
  // absent either, and the schema's own `minLength: 1` must reject it, not read it as undeclared.
  test("cli: s2-fail-closed-1", async () => {
    const roomSchema = new URL("../lib/schema/forma.room.schema.json", import.meta.url);
    const manifest = {
      today: "2026-01-01",
      programs: [{ id: "p", ghRepo: "acme/p", repo: ".", issues: "issues.json", arbiter: { milestones: "" } }],
    };
    const errs = validateModel(manifest, roomSchema);
    if (!errs.length || !errs.some((e) => /milestones/.test(e)))
      die("S2 F3a: an empty-string arbiter.milestones must fail manifest validation, got " + JSON.stringify(errs));
    console.log("  ok s2-fail-closed-1 — empty-string arbiter.milestones fails schema validation");
  });

  // F3b: an unsupported JSON-Schema keyword (patternProperties, oneOf, allOf, external $ref, tuple
  // items, dependencies…) must make validateModel refuse the SCHEMA, not silently under-validate the
  // model against it. The five shipped schemas must trip no guard — the supported set is complete.
  test("cli: s2-fail-closed-2", async () => {
    const badSchema = join(tmp, "s2-unsupported-keyword.schema.json");
    writeFileSync(badSchema, JSON.stringify({ type: "object", properties: { x: { type: "string", patternProperties: { "^a": { type: "string" } } } } }));
    const errs = validateModel({ x: "y" }, new URL("file://" + badSchema));
    if (!errs.length || !errs.some((e) => /unsupported schema keyword/.test(e)))
      die("S2 F3b: a schema with an unsupported keyword must make validateModel return an error, got " + JSON.stringify(errs));
    for (const f of ["c4-model.schema.json", "c4-issues.schema.json", "c4-health.schema.json", "c4-findings.schema.json", "c4-brief.schema.json", "forma.room.schema.json"]) {
      const shipped = validateModel({}, new URL("../lib/schema/" + f, import.meta.url)).filter((e) => /unsupported schema keyword/.test(e));
      if (shipped.length) die(`S2 F3b: ${f} trips the supported-keyword guard — the set is incomplete: ${shipped.join("; ")}`);
    }
    console.log("  ok s2-fail-closed-2 — an unsupported schema keyword is refused, and every shipped schema stays clean");
  });

  // F4/D-5: a programme whose repo is not a git checkout gets `linked.error` from linkIssuesToNodes.
  // deriveAll must carry that error into `derived.link.error` and turn `coverage` into an unmeasured
  // null — not a measured "0% linked" the briefing would show as if it had counted something.
  test("cli: s2-fail-closed-3", async () => {
    const noGit = join(tmp, "s2-not-a-checkout");
    mkdirSync(noGit, { recursive: true });
    const out = deriveAll({
      repo: noGit, model: { nodes: [] }, topo: { leafSources: [] },
      issuesSnapshot: {
        issues: [{ n: 1, state: "OPEN", labels: [], ms: null, title: "x", createdAt: "2026-01-01", closedAt: null }],
        milestones: [], fetchedAt: "2026-01-01", collection: {}, dependencies: { supported: false, edges: [] },
      },
      health: { verdicts: [], dependencyConfirmations: [] }, findings: { findings: [] },
      brief: null, briefPath: null, manifest: { today: "2026-01-01" },
      gateInputs: null, arbiterMilestones: null, docs: null,
    });
    if (!out.link || !out.link.error) die("S2 F4: a repo that is not a git checkout must set derived.link.error");
    if (out.link.coverage !== null) die("S2 F4: derived.link.coverage must be null (unmeasured), got " + JSON.stringify(out.link.coverage));
    console.log("  ok s2-fail-closed-3 — an unreadable git history yields link.error and a null (not zero) coverage");
  });

  // F5: a transport failure (auth, network, rate limit) on the dependency-enabled GraphQL query must
  // not be mistaken for "this API has no dependency fields" — that class alone may retry without
  // dependencies. A transport failure must fail `verify` outright and leave every file untouched.
  test("cli: s2-fail-closed-4", async () => {
    const repo = join(tmp, "s2-verify-transport"), issues = join(repo, "issues.json"), model = join(repo, "model.json");
    mkdirSync(repo, { recursive: true });
    writeFileSync(model, JSON.stringify({ meta: { ghRepo: "acme/thing" }, nodes: [], edges: [] }));
    const before = existsSync(issues) ? readFileSync(issues, "utf-8") : null;
    const r = run([
      "verify", "--repo", repo, "--model", model, "--issues", issues, "--gh-repo", "acme/thing",
      "--gh-cmd", process.execPath + " " + join(HERE, "stub-gh.mjs") + " transport-fail",
    ]);
    if (r.status === 0) die("S2 F5: a transport failure on the dependency query must not exit 0", r);
    if (existsSync(issues) && readFileSync(issues, "utf-8") !== before)
      die("S2 F5: a transport failure must leave the snapshot untouched");
    console.log("  ok s2-fail-closed-4 — a stub-gh transport failure fails verify and leaves the snapshot untouched");
  });

  // F14: SOURCE COVERAGE must fail loud on a directory it cannot read, not treat it as though it
  // held no recognised files (fail open). Skipped under uid 0, where chmod 000 does not deny reads.
  test("cli: s2-fail-closed-5", async () => {
    if (process.getuid && process.getuid() === 0) {
      console.log("  skip s2-fail-closed-5 — running as root, chmod 000 is not enforced");
    } else {
      const repo = join(tmp, "s2-unreadable-source");
      cpSync(FIX("mini"), repo, { recursive: true });
      const topo = join(tmp, "s2-unreadable-topo.json"), model = join(tmp, "s2-unreadable-model.json");
      let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
      if (r.status !== 0) die("S2 F14: init on the fixture repo failed", r);
      r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
      if (r.status !== 0) die("S2 F14: gen on the fixture repo failed", r);
      const blocked = join(repo, "src", "blocked");
      mkdirSync(blocked);
      writeFileSync(join(blocked, "hidden.js"), "export const hidden = 1\n");
      chmodSync(blocked, 0o000);
      try {
        r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
      } finally {
        chmodSync(blocked, 0o755);
      }
      if (r.status === 0 || !/SOURCE COVERAGE.*unreadable/i.test(r.stderr || ""))
        die("S2 F14: an unreadable source directory must fail SOURCE COVERAGE, not skip it", r);
      console.log("  ok s2-fail-closed-5 — an unreadable source directory fails SOURCE COVERAGE");
    }
  });

  // HIGH-1: derivePortfolio must gate `linkCoverage` on `!linked.error` exactly like deriveAll's own
  // per-programme `coverage` does (roomderive.mjs:827) — an unreadable git history is unmeasured,
  // never a measured 0%.
  test("cli: s2-round1-1", async () => {
    const noGit = join(tmp, "s2r1-portfolio-not-a-checkout");
    mkdirSync(noGit, { recursive: true });
    const deriveContext = {};
    const derived = deriveAll(
      {
        repo: noGit, model: { nodes: [] }, topo: { leafSources: [] },
        issuesSnapshot: {
          issues: [{ n: 1, state: "OPEN", labels: [], ms: null, title: "x", createdAt: "2026-01-01", closedAt: null }],
          milestones: [], fetchedAt: "2026-01-01", collection: {}, dependencies: { supported: false, edges: [] },
        },
        health: { verdicts: [], dependencyConfirmations: [] }, findings: { findings: [] },
        brief: null, briefPath: null, manifest: { today: "2026-01-01" },
        gateInputs: null, arbiterMilestones: null, docs: null,
      },
      deriveContext,
    );
    const program = {
      id: "p", ghRepo: "acme/p", repo: noGit, model: { nodes: [] }, topo: { leafSources: [] },
      issuesSnapshot: { issues: [{ n: 1, state: "OPEN", labels: [], ms: null, title: "x", createdAt: "2026-01-01", closedAt: null }], milestones: [], fetchedAt: "2026-01-01" },
      derived, deriveContext,
    };
    const portfolio = derivePortfolio({ today: "2026-01-01", programs: [program] });
    const summary = portfolio.programs.find((p) => p.id === "p");
    if (!summary || summary.linkCoverage !== null)
      die("S2R1 HIGH-1: portfolio linkCoverage must be null (unmeasured) when linked.error is set, got " + JSON.stringify(summary && summary.linkCoverage));
    console.log("  ok s2-round1-1 — portfolio linkCoverage stays null on an unreadable git history");
  });

  // #132: `link.error` gates coverage/linkCoverage already (S2/S2R1 above), but deriveCheckpoints and
  // the portfolio's workPerNode/blocked-nodes/landing still read the empty byIssue/datesByIssue maps
  // as if they were measured, presenting per-node work, landing and checkpoint completion as zero
  // instead of unknown (I6). Same not-a-checkout fixture as s2-fail-closed-3/s2-round1-1, root-proof.
  test("cli: 132-unknown-not-zero", async () => {
    const noGit = join(tmp, "132-unreadable-history");
    mkdirSync(noGit, { recursive: true });
    const model = {
      nodes: [{ id: "core", kind: "leaf", evidence: [] }],
      timeline: { checkpoints: [{ id: "cp1", label: "CP1", patch: { nodes: { add: [{ node: { id: "core" } }] } } }] },
    };
    const topo = { leafSources: [] };
    const issuesSnapshot = {
      issues: [{ n: 1, state: "OPEN", labels: ["blocked"], ms: null, title: "x", createdAt: "2026-01-01", closedAt: null }],
      milestones: [], fetchedAt: "2026-01-01", collection: {}, dependencies: { supported: false, edges: [] },
    };
    const deriveContext = {};
    const derived = deriveAll(
      {
        repo: noGit, model, topo, issuesSnapshot,
        health: { verdicts: [], dependencyConfirmations: [] }, findings: { findings: [] },
        brief: null, briefPath: null, manifest: { today: "2026-01-01" },
        gateInputs: null, arbiterMilestones: null, docs: null,
      },
      deriveContext,
    );
    if (!derived.link || !derived.link.error) die("132: a repo that is not a git checkout must set derived.link.error");

    // deriveCheckpoints: the checkpoint's own nodes come from the timeline patch (known), but which
    // issues reached them is unmeasured — null throughout, never a measured "0 of 0".
    if (!derived.checkpoints || derived.checkpoints.length !== 1)
      die("132: expected 1 checkpoint, got " + JSON.stringify(derived.checkpoints));
    const cp = derived.checkpoints[0];
    if (cp.nodes.join() !== "core")
      die("132: checkpoint nodes come from the timeline patch and stay known, got " + JSON.stringify(cp.nodes));
    if (cp.total !== null || cp.closed !== null || cp.pct !== null || cp.issues !== null)
      die("132: an unreadable history must report the checkpoint's issues/closed/total/pct as null, not 0 — got " + JSON.stringify(cp));

    const program = {
      id: "p", ghRepo: "acme/p", repo: noGit, model, topo,
      issuesSnapshot, derived, deriveContext,
      blockedBy: { labels: ["blocked"] },
    };
    const portfolio = derivePortfolio({ today: "2026-01-01", programs: [program] });
    const summary = portfolio.programs.find((p) => p.id === "p");
    if (!summary || summary.workPerNode !== null || summary.workPerNodeOpen !== null)
      die("132: workPerNode/workPerNodeOpen must be null (unmeasured) on an unreadable history, got " + JSON.stringify(summary && [summary.workPerNode, summary.workPerNodeOpen]));

    const row = portfolio.blocked.find((b) => b.program === "p" && b.n === 1);
    if (!row) die("132: expected issue #1 to be reported as blocked");
    if (row.nodes !== null)
      die("132: a blocked item's nodes must be null (unmeasured), not [] or a measured list, got " + JSON.stringify(row.nodes));
    if (row.landingMeasured !== false)
      die("132: a blocked item must say its landing is unmeasured on an unreadable history, got " + JSON.stringify(row.landingMeasured));

    const landing = portfolio.landing.find((l) => l.program === "p");
    if (!landing || landing.months !== null)
      die("132: landing.months must be null (unmeasured) on an unreadable history, got " + JSON.stringify(landing && landing.months));

    console.log("  ok 132-unknown-not-zero — checkpoints, workPerNode, blocked nodes and landing stay unmeasured on an unreadable git history");
  });

  // #132 round 1 (Codex review, HIGH): the landing chart only mounted when `summary.closed` was
  // nonzero, so an all-open programme with an unreadable git history never showed the honest null
  // this fix computes — the data said "not measured" but the screen said nothing. Composed through
  // the real `forma room` + `forma check --room` chain (not just deriveAll/derivePortfolio), and the
  // shipped viewer source is lifted and RUN against that exact data, so the assertion is on what a
  // reader would actually see, not just on the JSON the viewer reads. This test fails without the
  // `landingEntry`/mount-condition fix: the lifted `mountLanding` would leave `ev` empty.
  test("cli: 132-room-unmeasured", async () => {
    const repo = join(tmp, "132-room-unmeasured");
    cpSync(FIX("mini"), repo, { recursive: true });
    const topo = join(tmp, "132-room-topo.json"),
      model = join(tmp, "132-room-model.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("132 room: init exit " + r.status, r);
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs/DESIGN.md"), "# Design\n\nThe governed future for this repo.\n");
    const seeded = readJson(topo);
    seeded.timeline = {
      source: "docs/DESIGN.md",
      checkpoints: [
        { id: "cp1", label: "CP1", patch: { nodes: { update: [{ id: "core", set: { status2: "in-progress" }, change: "x" }] } } },
      ],
    };
    writeFileSync(topo, JSON.stringify(seeded, null, 2));
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("132 room: gen exit " + r.status, r);

    const issues = join(tmp, "132-room-issues.json");
    writeFileSync(
      issues,
      JSON.stringify({
        fetchedAt: "2026-08-09T09:00:00Z", ghRepo: "acme/p", truncated: false,
        collection: {
          pagination: "gh api graphql --paginate --slurp", nativeEdges: 0, truncatedRelations: 0,
          prose: { accepted: 0, discarded: 0, ambiguous: 0, bodyBytes: 0, maxBytesPerIssue: 65536 },
          signalsUnknown: 1, staleVerdicts: 0, milestonesComplete: false,
          milestonesReason: "Milestones are derived from issue payloads; milestones with zero issues are not observable.",
          payloadBytes: 1,
        },
        dependencies: { supported: false, complete: false, edges: [] },
        signals: { workflows: {}, release: { listState: "unknown", reason: "not declared" } },
        milestones: [],
        issues: [{ n: 1, title: "x", state: "OPEN", url: "https://github.com/acme/p/issues/1", labels: ["blocked"], updatedAt: "2026-08-09T09:00:00Z", dependenciesComplete: true, proseScanComplete: true, createdAt: "2026-08-01" }],
      }),
    );
    const manifest = join(tmp, "132-room-manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({ today: "2026-08-18", programs: [{ id: "p", ghRepo: "acme/p", repo, issues, model, topology: topo, blockedBy: { labels: ["blocked"] } }] }),
    );
    const roomOut = join(tmp, "132-room.html");
    r = run(["room", "--manifest", manifest, "--out", roomOut]);
    if (r.status !== 0) die("132 room: room exit " + r.status, r);
    r = run(["check", "--room", roomOut, "--manifest", manifest]);
    if (r.status !== 0) die("132 room: check --room must pass on this fixture (re-derivation parity)", r);

    const roomJson = JSON.parse(/window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(readFileSync(roomOut, "utf-8"))[1]);
    const program = roomJson.programs.find((p) => p.id === "p");
    if (!program.derived.link || !program.derived.link.error)
      die("132 room: expected link.error on a repo that is not a git checkout");
    const cp = program.derived.checkpoints && program.derived.checkpoints[0];
    if (!cp || cp.total !== null)
      die("132 room: expected the checkpoint's total to be null under an unreadable history, got " + JSON.stringify(cp));
    const summary = roomJson.portfolio.programs.find((p) => p.id === "p");
    if (summary.closed !== 0)
      die("132 room: fixture must be all-open (closed===0) to exercise the mount bug, got " + JSON.stringify(summary));
    if (summary.workPerNode !== null)
      die("132 room: expected workPerNode null under an unreadable history");
    const landing = roomJson.portfolio.landing.find((l) => l.program === "p");
    if (!landing || landing.months !== null)
      die("132 room: expected landing.months null under an unreadable history");

    const html = readFileSync(join(HERE, "..", "lib/viewer/control-room.html"), "utf-8");
    const lift = (name) => {
      const m = html.match(new RegExp("function " + name + "\\([^]*?\\n}\\n"));
      if (!m) die("132 room: " + name + " not liftable — it must be measurable");
      return m[0];
    };
    const mountMatch = /var landing=landingEntry\(summary\.id\);\s*\n\s*if\(summary\.closed\|\|\(landing&&landing\.months===null\)\)ev\.appendChild\(chartLanding\(summary,program\)\);/.exec(html);
    if (!mountMatch) die("132 room: the landing chart's mount condition was not found verbatim in the viewer — did the HIGH fix regress?");
    const cpBlockMatch = /var cps=program\.derived\.checkpoints,cp=panel\(STR\.timeline,STR\.provCheckpoints\);[\s\S]*?ev\.appendChild\(cp\);/.exec(html);
    if (!cpBlockMatch) die("132 room: the checkpoints panel block was not found verbatim in the viewer — did viewArchitecture change shape?");

    // A deliberately small DOM seam, same idea as test/fixtures/control-room-stress/kanban.mjs, wide
    // enough to run panel()/chart()'s table-twin construction without a browser.
    class Node {
      constructor(tag) { this.tagName = String(tag || "").toUpperCase(); this.className = ""; this.children = []; this.attributes = {}; this._text = ""; this.id = ""; this.hidden = false; }
      appendChild(n) { this.children.push(n); return n; }
      insertBefore(n) { this.children.unshift(n); return n; }
      removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; }
      set textContent(v) { this._text = String(v); this.children = []; }
      get textContent() { return this.children.length ? this.children.map((c) => (c.textContent != null ? c.textContent : "")).join("") : this._text; }
      setAttribute(k, v) { this.attributes[k] = String(v); }
      getAttribute(k) { return this.attributes[k]; }
      addEventListener() {}
      get classList() { const self = this; return { add(c) { self.className = (self.className ? self.className + " " : "") + c; } }; }
      cloneNode() { return this._clone ? this._clone() : new Node(this.tagName); }
    }
    const findAll = (node, pred, out = []) => { for (const c of node.children || []) { if (pred(c)) out.push(c); findAll(c, pred, out); } return out; };
    Node.prototype.querySelector = function (sel) {
      if (sel === "caption") return findAll(this, (n) => n.tagName === "CAPTION")[0] || null;
      if (sel === "tbody") return findAll(this, (n) => n.tagName === "TBODY")[0] || null;
      if (sel === "thead tr") { const thead = findAll(this, (n) => n.tagName === "THEAD")[0]; return thead ? findAll(thead, (n) => n.tagName === "TR")[0] || null : null; }
      return null;
    };
    const buildTemplateContent = () => {
      const table = new Node("table"), caption = new Node("caption"), thead = new Node("thead"), tr = new Node("tr"), tbody = new Node("tbody");
      thead.appendChild(tr); table.appendChild(caption); table.appendChild(thead); table.appendChild(tbody);
      table._clone = buildTemplateContent;
      return table;
    };
    const doc = {
      createElement: (t) => new Node(t),
      createElementNS: (_ns, t) => new Node(t),
      createTextNode: (t) => ({ tagName: "#text", textContent: String(t) }),
      getElementById: (id) => (id === "table-template" ? { content: { firstChild: buildTemplateContent() } } : null),
    };
    const en = readJson(join(HERE, "..", "lib/viewer/strings/en.json"));

    const src = [
      "var seq=0;",
      lift("fmt"), lift("el"), lift("setAttrs"), lift("svgEl"), lift("short"),
      lift("chips"), lift("pair"), lift("panel"), lift("chart"), lift("empty"), lift("relayout"),
      lift("landingEntry"), lift("chartLanding"), lift("chartNodes"),
      "function mountLanding(summary,ev,program){\n" + mountMatch[0] + "\n}\n",
      "function renderCheckpoints(program,ev){\n" + cpBlockMatch[0] + "\n}\n",
      "return {chartLanding:chartLanding,chartNodes:chartNodes,mountLanding:mountLanding,renderCheckpoints:renderCheckpoints};",
    ].join("\n");
    const lifted = new Function("document", "STR", "ROOM", "NS", src)(doc, en, roomJson, "http://www.w3.org/2000/svg");

    const evNode = new Node("div");
    lifted.mountLanding(summary, evNode, program);
    if (evNode.children.length !== 1)
      die(
        "132 room: the landing chart must mount even when summary.closed===0, as long as its months are unmeasured (HIGH review finding) — got " +
          evNode.children.length + " mounted panel(s)",
      );
    const landingProv = findAll(evNode.children[0], (n) => n.className === "prov")[0];
    if (!landingProv || landingProv.textContent !== en.notMeasured)
      die('132 room: the mounted landing chart must read "' + en.notMeasured + '", got ' + JSON.stringify(landingProv && landingProv.textContent));

    const nodesPanel = lifted.chartNodes(summary, program);
    const nodesProv = findAll(nodesPanel, (n) => n.className === "prov")[0];
    if (!nodesProv || nodesProv.textContent !== en.notMeasured)
      die('132 room: the per-node work chart must read "' + en.notMeasured + '" when workPerNode is null, got ' + JSON.stringify(nodesProv && nodesProv.textContent));

    const cpEv = new Node("div");
    lifted.renderCheckpoints(program, cpEv);
    const cpTexts = findAll(cpEv, () => true).map((n) => n.textContent).filter(Boolean);
    if (!cpTexts.some((t) => t === en.notMeasured))
      die('132 room: the checkpoints panel must read "' + en.notMeasured + '" for a checkpoint whose issue count is unmeasured, got ' + JSON.stringify(cpTexts));

    console.log(
      '  ok 132-room-unmeasured — a real `forma room`+`check --room` composition of an all-open, non-git programme renders "not measured" for landing, per-node work and checkpoints, not zero/blank',
    );
  });

  // HIGH-2: an auth/permission error worded like GitHub's real "Resource not accessible by
  // integration" must NOT be read as "dependency fields unsupported" — only a field-specific
  // GraphQL error naming blockedBy/blocking may enable the no-dependencies fallback.
  test("cli: s2-round1-2", async () => {
    const repo = join(tmp, "s2r1-verify-auth"), issues = join(repo, "issues.json"), model = join(repo, "model.json");
    mkdirSync(repo, { recursive: true });
    writeFileSync(model, JSON.stringify({ meta: { ghRepo: "acme/thing" }, nodes: [], edges: [] }));
    const before = existsSync(issues) ? readFileSync(issues, "utf-8") : null;
    const r = run([
      "verify", "--repo", repo, "--model", model, "--issues", issues, "--gh-repo", "acme/thing",
      "--gh-cmd", process.execPath + " " + join(HERE, "stub-gh.mjs") + " auth-fail",
    ]);
    if (r.status === 0) die("S2R1 HIGH-2: an auth/permission error must not be mistaken for unsupported dependency fields", r);
    if (existsSync(issues) && readFileSync(issues, "utf-8") !== before)
      die("S2R1 HIGH-2: an auth failure must leave the snapshot untouched");
    console.log("  ok s2-round1-2 — an auth/permission error fails verify instead of falling back silently");
  });

  // HIGH-3: tuple-form `items: [...]` must be rejected as an unsupported schema keyword, not
  // silently allowed through as if it were the single-schema form.
  test("cli: s2-round1-3", async () => {
    const badSchema = join(tmp, "s2r1-tuple-items.schema.json");
    writeFileSync(badSchema, JSON.stringify({ type: "array", items: [{ type: "string" }, { type: "number" }] }));
    const errs = validateModel(["a", 1], new URL("file://" + badSchema));
    if (!errs.length || !errs.some((e) => /unsupported schema keyword "items"/.test(e)))
      die("S2R1 HIGH-3: tuple-form items must be refused as an unsupported schema keyword, got " + JSON.stringify(errs));
    console.log("  ok s2-round1-3 — tuple-form items is refused, not silently allowlisted");
  });

  // MEDIUM-4: SOURCE COVERAGE must fail on a directory entry it cannot `statSync`, not skip it
  // silently. A dangling symlink reproduces this without chmod (root-proof).
  test("cli: s2-round1-4", async () => {
    const repo = join(tmp, "s2r1-dangling-symlink");
    cpSync(FIX("mini"), repo, { recursive: true });
    const topo = join(tmp, "s2r1-dangling-topo.json"), model = join(tmp, "s2r1-dangling-model.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("S2R1 MEDIUM-4: init on the fixture repo failed", r);
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("S2R1 MEDIUM-4: gen on the fixture repo failed", r);
    symlinkSync("nowhere", join(repo, "src", "dangling.js"));
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status === 0 || !/SOURCE COVERAGE.*(unreadable|unstatable)/i.test(r.stderr || ""))
      die("S2R1 MEDIUM-4: a dangling symlink (unstatable entry) must fail SOURCE COVERAGE, not skip it", r);
    console.log("  ok s2-round1-4 — an unstatable source entry fails SOURCE COVERAGE");
  });

  // MEDIUM-5: minLength/maxLength must count Unicode code points, not UTF-16 code units — an astral
  // character (surrogate pair) is one character, not two.
  test("cli: s2-round1-5", async () => {
    const schemaPath = join(tmp, "s2r1-codepoints.schema.json");
    writeFileSync(schemaPath, JSON.stringify({ type: "string", minLength: 2 }));
    const astral = "\u{1D11E}"; // one code point, two UTF-16 units: value.length === 2, [...value].length === 1
    const errs = validateModel(astral, new URL("file://" + schemaPath));
    if (!errs.length || !errs.some((e) => /minLength|at least/.test(e)))
      die("S2R1 MEDIUM-5: minLength must count code points (1 astral char < 2), a UTF-16-unit count wrongly passes it: " + JSON.stringify(errs));
    const schemaPath2 = join(tmp, "s2r1-codepoints-min1.schema.json");
    writeFileSync(schemaPath2, JSON.stringify({ type: "string", minLength: 2 }));
    const twoAstral = astral + astral; // two code points, four UTF-16 units
    const errs2 = validateModel(twoAstral, new URL("file://" + schemaPath2));
    if (errs2.length)
      die("S2R1 MEDIUM-5: two astral characters must satisfy minLength: 2, got " + JSON.stringify(errs2));
    console.log("  ok s2-round1-5 — minLength/maxLength count Unicode code points, not UTF-16 units");
  });

  // F13 — `forma serve` (the static doc viewer, distinct from `room --serve`) must bind loopback
  // only and answer a malformed URI with 400 instead of dying: `decodeURIComponent` throws on a lone
  // `%` escape and used to take the whole process down with it.
  test("cli: serve-cli", async () => {
    const repo = join(tmp, "serve-cli");
    mkdirSync(join(repo, "docs/architecture"), { recursive: true });
    const child = spawn(
      process.execPath,
      [join(HERE, "..", "lib", "serve.mjs"), "--repo", repo, "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(
        () => reject(new Error("serve-cli: forma serve did not report a port in time: " + out)),
        3000,
      );
      const onData = (chunk) => {
        out += chunk.toString();
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) { clearTimeout(timer); child.stdout.off("data", onData); resolvePort(Number(m[1])); }
      };
      child.stdout.on("data", onData);
      child.on("error", reject);
    });
    if (/0\.0\.0\.0|::/.test(out))
      die("serve-cli: forma serve bound something wider than loopback: " + out);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/%E0`);
      if (res.status !== 400)
        die("serve-cli: a malformed URI must answer 400, got " + res.status);
    } finally {
      child.kill();
    }
    console.log(
      "  ok serve-cli — forma serve binds loopback only and answers a malformed URI with 400 instead of crashing",
    );
  });

  // F12 — an unknown flag must fail loud (exit 1), not be silently ignored. `room.mjs`/`audit.mjs`
  // already reject unknown flags; gen/check/verify/init/serve did not.
  test("cli: strict-flags", async () => {
    const topo = join(tmp, "strict-topo.json"), model = join(tmp, "strict-model.json");
    let r = run(["init", "--repo", FIX("mini"), "--out", topo, "--force"]);
    if (r.status !== 0) die("strict-flags: setup init exit " + r.status, r);
    r = run(["gen", "--repo", FIX("mini"), "--topology", topo, "--out", model, "--bogus"]);
    if (r.status === 0) die("strict-flags: gen --bogus must exit 1, not be silently ignored", r);
    r = run(["init", "--repo", FIX("mini"), "--out", topo, "--force", "--bogus"]);
    if (r.status === 0) die("strict-flags: init --bogus must exit 1", r);
    r = run(["check", "--repo", FIX("mini"), "--model", model, "--topology", topo, "--bogus"]);
    if (r.status === 0) die("strict-flags: check --bogus must exit 1", r);
    r = run(["verify", "--repo", FIX("mini"), "--bogus"]);
    if (r.status === 0) die("strict-flags: verify --bogus must exit 1", r);
    const serveResult = spawnSync(process.execPath, [join(HERE, "..", "lib", "serve.mjs"), "--bogus"], { encoding: "utf-8" });
    if (serveResult.status === 0) die("strict-flags: serve --bogus must exit 1", serveResult);
    console.log(
      "  ok strict-flags — gen/init/check/verify/serve exit 1 on an unknown flag instead of ignoring it",
    );
  });

  // Codex round 1 HIGH — parseArgs({strict:true}) only rejects an UNKNOWN flag; the retained raw
  // `process.argv.indexOf('--key')` readers never matched a `--key=value` token, so a KNOWN flag
  // given in that form was silently ignored and fell back to its default. `forma check
  // --repo=/bad --model=/bad --topology=/bad` therefore graded the CURRENT repo (cwd), not /bad.
  test("cli: equals-flags", async () => {
    const bad = run(["check", "--repo=/bad", "--model=/bad", "--topology=/bad"]);
    if (bad.status === 0)
      die("equals-flags: check --repo=/bad --model=/bad --topology=/bad must fail, not silently grade the current repo", bad);
    console.log("  ok equals-flags-reject — check --key=/bad is honoured, not silently ignored");

    // One `--key=value` case per CLI must be honoured, not just rejected: a full init→gen→check
    // pipeline driven entirely with `=`-form flags must produce the same files a space-form pipeline
    // would, proving parseArgs().values — not indexOf — is what the value ends up coming from.
    // Copied to a scratch dir (not run against FIX("mini") directly): `verify` below writes a live
    // c4-issues.json snapshot into --repo, and the fixture must stay pristine for every other test.
    const eqRepo = join(tmp, "eq-repo");
    cpSync(FIX("mini"), eqRepo, { recursive: true });
    const topoEq = join(tmp, "eq-topo.json"), modelEq = join(tmp, "eq-model.json");
    let r = run(["init", `--repo=${eqRepo}`, `--out=${topoEq}`, "--force"]);
    if (r.status !== 0 || !existsSync(topoEq)) die("equals-flags: init --out=<path> was not honoured", r);
    r = run(["gen", `--repo=${eqRepo}`, `--topology=${topoEq}`, `--out=${modelEq}`]);
    if (r.status !== 0 || !existsSync(modelEq)) die("equals-flags: gen --topology=/--out= were not honoured", r);
    r = run(["check", `--repo=${eqRepo}`, `--model=${modelEq}`, `--topology=${topoEq}`]);
    if (r.status !== 0) die("equals-flags: check --repo=/--model=/--topology= were not honoured", r);

    const GH = process.execPath + " " + join(HERE, "stub-gh.mjs");
    r = run(["verify", `--repo=${eqRepo}`, `--model=${modelEq}`, "--gh-repo=acme/thing", `--gh-cmd=${GH}`]);
    if (r.status !== 0) die("equals-flags: verify --gh-repo=/--gh-cmd= were not honoured", r);

    const child = spawn(process.execPath, [join(HERE, "..", "lib", "serve.mjs"), `--repo=${eqRepo}`, "--port=0"], { stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise((resolvePort, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("equals-flags: forma serve --port=0 did not report a port in time: " + out)), 3000);
      const onData = (chunk) => {
        out += chunk.toString();
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) { clearTimeout(timer); child.stdout.off("data", onData); resolvePort(Number(m[1])); }
      };
      child.stdout.on("data", onData);
      child.on("error", reject);
    });
    child.kill();
    if (!(port > 0)) die("equals-flags: serve --port=0 was not honoured");
    console.log("  ok equals-flags-honour — init/gen/check/verify/serve all honour --key=value, not just --key value");
  });

  // Codex round 1 MEDIUM — `room update` still parsed and forwarded `--limit`, though the flag was
  // removed from `verify`; strict parsing was added everywhere else but not here.
  test("cli: limit-strict", async () => {
    const SCRATCH_OUT = join(tmp, "limit-strict-out.html");
    const r = run(["room", "update", "--manifest", "forma.room.json", "--out", SCRATCH_OUT, "--skip-verify", "--limit", "5"]);
    if (r.status === 0) die("limit-strict: room update --limit must exit 1 (the flag was removed, not just unforwarded)", r);
    console.log("  ok limit-strict — room update --limit is an unknown flag now, not a silently-accepted dead one");
  });

  // Codex round 1 LOW — the DRILL label must be a real localization (it differs from en), and must
  // actually be rendered through STR.drillLabel rather than sitting in the table unread.
  // (F20's read-only-install case is not covered by a test — see HANDOFF.md.)
  test("cli: drill-label", async () => {
    const src = readFileSync(join(HERE, "..", "lib/viewer/c4-hologram.html"), "utf-8");
    const enMatch = src.match(/drillLabel:"([^"]+)"/);
    const itMatch = [...src.matchAll(/drillLabel:"([^"]+)"/g)][1];
    if (!enMatch || !itMatch)
      die("drill-label: STRINGS is missing a drillLabel key for en or it");
    if (enMatch[1] === itMatch[1])
      die('drill-label: it.drillLabel must be a real translation, not a copy of en ("' + enMatch[1] + '")');
    if (!/STR\.drillLabel\b/.test(src))
      die("drill-label: the DRILL text is declared but never rendered through STR.drillLabel");
    console.log("  ok drill-label — [+] DRILL is localized (en/it) and rendered through STR.drillLabel, not hardcoded");
  });
});
