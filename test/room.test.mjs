#!/usr/bin/env node
// Control Room composition end to end: room.mjs, roomderive.mjs, link.mjs and taxonomy.mjs, the
// trackedFiles() cache lifetime, scan+serve autodetection, and the PRD requirements-trace dogfood.
import test, { describe } from "node:test";

import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import { validateModel } from "../lib/validate.mjs";
import {
  daysBetween,
  deriveAll,
  derivePortfolio,
  documentGate,
  deriveBlocks,
  deriveCapabilities,
  deriveHistory,
  deriveKanban,
  deriveKpis,
  deriveMilestones,
  deriveQueue,
} from "../lib/roomderive.mjs";
import { loadDocs } from "../lib/roomdocs.mjs";
import { deriveRtm } from "../lib/rtm.mjs";

import { HERE, FIX, freshTmp, run, die, readJson } from "./helpers.mjs";

const tmp = freshTmp();

describe("room", () => {
  // The Control Room, end to end: compose it, gate it, and prove the gate can fail. Until this block
  // existed nothing in the suite touched room.mjs, roomderive.mjs, link.mjs or taxonomy.mjs — and
  // both gates over them were broken in ways a single run would have caught. The fixture carries no
  // .git (a nested repository cannot be committed), so the history the link layer reads is built here
  // with pinned author dates: the month buckets are asserted below and must not drift with the clock.
  test("room: room", async () => {
    const R = join(tmp, "room"),
      alpha = join(R, "alpha"),
      beta = join(R, "beta");
    cpSync(FIX("room"), R, { recursive: true });
    const git = (repo, args, date) => {
      const env = {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      };
      const r = spawnSync("git", ["-C", repo, ...args], {
        encoding: "utf-8",
        env,
      });
      if (r.status !== 0)
        die(
          "room fixture: git " +
            args.join(" ") +
            "\n" +
            (r.stdout || "") +
            (r.stderr || ""),
        );
    };
    const born = (repo) => {
      git(repo, ["init", "-q", "."], "2026-01-01T00:00:00");
      git(
        repo,
        ["config", "user.email", "test@example.invalid"],
        "2026-01-01T00:00:00",
      );
      git(repo, ["config", "user.name", "Forma Test"], "2026-01-01T00:00:00");
    };
    const commit = (repo, message, date) => {
      git(repo, ["add", "-A"], date);
      git(repo, ["commit", "-q", "-m", message], date);
    };
    const touch = (file) =>
      writeFileSync(file, readFileSync(file, "utf-8") + "\n// touched\n");

    const claimsDoc = join(alpha, "docs/GATE-CLAIMS.md");
    const claimTarget = join(alpha, "claim-target.txt");
    writeFileSync(
      claimsDoc,
      "# Measured claims\n\nPath claim: src/core/engine.js:1\nDisposable path: claim-target.txt:1\nTracked sources: 3\nJSON mode: strict\nJSON missing: absent\nJSON object: object\n\n# INV-COMMENT\n\n**Enforced by:** `scripts/check.mjs`\n\n# INV-DUP first\n\n# INV-DUP second\n",
    );
    writeFileSync(claimTarget, "tracked evidence\n");
    writeFileSync(
      join(alpha, "docs/gate-registry.js"),
      '/*\nnode scripts/check.mjs\n*/\nconst x=1; // fake-proof\nconst proof = "fake-proof"\n',
    );
    writeFileSync(
      join(alpha, "docs/gate-registry.yml"),
      "# node scripts/check.mjs\nstep: noop # fake-proof\n",
    );
    writeFileSync(
      join(alpha, "gate-target.json"),
      JSON.stringify({ mode: "strict", nested: { value: "strict" } }),
    );
    born(alpha);
    commit(alpha, "chore: scaffold", "2026-06-15T10:00:00");
    touch(join(alpha, "src/core/engine.js"));
    commit(alpha, "feat(core): the engine (#1)", "2026-07-10T10:00:00");
    touch(join(alpha, "src/core/parser.js"));
    commit(alpha, "fix(core): parser (#99)", "2026-07-20T10:00:00");
    for (const f of [
      "src/core/engine.js",
      "src/core/parser.js",
      "src/util/log.js",
    ])
      touch(join(alpha, f));
    commit(alpha, "chore: sweep three files (#2)", "2026-08-01T10:00:00");
    born(beta);
    commit(beta, "feat: beta (#5)", "2026-07-05T10:00:00");

    const topo = join(alpha, "topology.json"),
      model = join(alpha, "model.json"),
      manifest = join(R, "manifest.json");
    const roomHtml = join(R, "control-room.html"),
      roomHtml2 = join(R, "second.html");
    const claimsManifest = readJson(manifest);
    claimsManifest.programs[0].docs.gate.claims = [
      {
        id: "path-ok",
        path: "docs/GATE-CLAIMS.md",
        pattern: "^Path claim: (\\S+)$",
        type: "path",
      },
      {
        id: "path-delete",
        path: "docs/GATE-CLAIMS.md",
        pattern: "^Disposable path: (\\S+)$",
        type: "path",
      },
      {
        id: "count-ok",
        path: "docs/GATE-CLAIMS.md",
        pattern: "^Tracked sources: (\\d+)$",
        type: "tracked-count",
        include: ["src/**/*.js"],
      },
      {
        id: "json-ok",
        path: "docs/GATE-CLAIMS.md",
        pattern: "^JSON mode: (\\S+)$",
        type: "json",
        target: "gate-target.json",
        pointer: "/mode",
      },
    ];
    const roomSchema = new URL(
      "../lib/schema/forma.room.schema.json",
      import.meta.url,
    );
    if (validateModel(claimsManifest, roomSchema).length)
      die("document claims schema: the complete typed claim fixture is invalid");
    for (const [id, field] of [
      ["count-ok", "include"],
      ["json-ok", "target"],
      ["json-ok", "pointer"],
    ]) {
      const malformed = JSON.parse(JSON.stringify(claimsManifest));
      delete malformed.programs[0].docs.gate.claims.find(
        (claim) => claim.id === id,
      )[field];
      if (!validateModel(malformed, roomSchema).length)
        die(
          "document claims schema: " + id + " without " + field + " was accepted",
        );
    }
    // #2480 wave 6: give the programme an arbiter milestone projection so the room actually derives
    // a milestone path and a reconciliation. Without this the two keys are null in every fixture and
    // `check`'s comparison of them is vacuous — a gate nobody has seen go red.
    writeFileSync(
      join(alpha, "milestones.json"),
      JSON.stringify(
        {
          schema: "arbiter-milestones-v1",
          milestones: [
            {
              id: "MS-01",
              title: "Alpha groundwork",
              depends_on: [],
              horizon: "now",
              status: "active",
              estimate_days: 8,
              members: { issues: [1, 2] },
            },
            {
              id: "MS-02",
              title: "Alpha delivery",
              depends_on: ["MS-01"],
              horizon: "next",
              status: "planned",
              estimate_days: 4,
            },
          ],
        },
        null,
        2,
      ),
    );
    claimsManifest.programs[0].arbiter = { milestones: "milestones.json" };
    writeFileSync(manifest, JSON.stringify(claimsManifest, null, 2));
    let r = run(["init", "--repo", alpha, "--out", topo, "--force"]);
    if (r.status !== 0) die("room: init exit " + r.status, r);
    // A governed future, so the checkpoint stepper has something to be measured against. Curated
    // after init because that is how a real timeline arrives: init seeds structure, a human writes
    // where it is going.
    const seeded = readJson(topo);
    seeded.timeline = {
      source: "docs/DESIGN.md",
      checkpoints: [
        {
          id: "normalize",
          label: "Input normalized in one place",
          patch: {
            nodes: {
              update: [
                {
                  id: "core",
                  set: { status2: "in-progress" },
                  change: "core takes over normalization",
                },
              ],
            },
          },
        },
        {
          id: "one-logger",
          label: "Every message through one helper",
          patch: {
            nodes: {
              update: [
                {
                  id: "util",
                  set: { status2: "done" },
                  change: "util owns all output",
                },
              ],
            },
          },
        },
      ],
    };
    writeFileSync(topo, JSON.stringify(seeded, null, 2));
    r = run(["gen", "--repo", alpha, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("room: gen exit " + r.status, r);
    r = run(["room", "--manifest", manifest, "--out", roomHtml]);
    if (r.status !== 0) die("room: exit " + r.status, r);

    // Determinism (I12): the only clock is manifest.today, so two renders of unchanged inputs are
    // byte-identical. This is also the property scripts/room-presentable.mjs re-checks independently.
    r = run(["room", "--manifest", manifest, "--out", roomHtml2]);
    if (r.status !== 0) die("room: second render exit " + r.status, r);
    if (readFileSync(roomHtml, "utf-8") !== readFileSync(roomHtml2, "utf-8"))
      die("room: two renders of the same manifest are not byte-identical");

    const roomOf = (file) => {
      const m = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(
        readFileSync(file, "utf-8"),
      );
      if (!m) die("room: __ROOM__ seam not found in " + file);
      return JSON.parse(m[1]);
    };
    const ROOM = roomOf(roomHtml);
    const progOf = (id) => {
      const p = (ROOM.programs || []).find((x) => x.id === id);
      if (!p) die("room: programme " + id + " is missing from the artifact");
      return p;
    };
    const A = progOf("alpha"),
      B = progOf("beta");

    // Work blocks are a projection of the open queue: commands name exactly their issue set, while
    // a declared human blocker disables automation. Closed #3 must never leak into either shape.
    const blockIssues = A.derived.blocks
      .flatMap((block) => block.iss.map((issue) => issue[0]))
      .sort((a, b) => a - b);
    if (blockIssues.join() !== "1,2")
      die("room: work blocks must contain open issues only, got " + blockIssues);
    const autoBlock = A.derived.blocks.find((block) =>
      block.iss.some((issue) => issue[0] === 1),
    );
    const manualBlock = A.derived.blocks.find((block) =>
      block.iss.some((issue) => issue[0] === 2),
    );
    if (
      !autoBlock ||
      autoBlock.cmd !== "gh issue view 1" ||
      autoBlock.auto !== true
    )
      die(
        "room: auto block command drifted from its exact issue set: " +
          JSON.stringify(autoBlock),
      );
    if (
      !manualBlock ||
      manualBlock.auto !== false ||
      manualBlock.cmd !== null ||
      manualBlock.note.labelled.join() !== "2" ||
      manualBlock.note.external.join() !== "2" ||
      !manualBlock.why.some(
        (why) =>
          why.from.repo === "acme/alpha" &&
          why.to.repo === "acme/platform" &&
          why.to.number === 90,
      )
    )
      die(
        "room: structured declared-label/external blocker facts did not disable automation: " +
          JSON.stringify(manualBlock),
      );

    // Human-waiting labels are programme vocabulary, never engine vocabulary. Declaring only
    // owner-decision must count/bucket that label and leave a coincidental needs-human unaudited;
    // omitting blockedBy makes the KPI unknown rather than reviving an implicit default.
    const labelSnapshot = {
      fetchedAt: "2026-08-10T00:00:00Z",
      milestones: [],
      issues: [
        { n: 1, state: "OPEN", labels: ["owner-decision"], ms: null },
        { n: 2, state: "OPEN", labels: ["needs-human"], ms: null },
      ],
    };
    const ownerManifest = {
      today: "2026-08-10",
      blockedBy: { labels: ["owner-decision"] },
    };
    const ownerKanban = deriveKanban(
      labelSnapshot,
      [],
      ownerManifest.blockedBy.labels,
    );
    if (
      deriveKpis(labelSnapshot, null, ownerManifest).needsHumanCount !== 1 ||
      ownerKanban["aspettano-umano"].join() !== "1" ||
      ownerKanban["non-auditate"].join() !== "2"
    )
      die(
        "room labels: owner-decision declaration leaked implicit needs-human semantics",
      );
    const undeclaredKanban = deriveKanban(labelSnapshot, [], []);
    if (
      deriveKpis(labelSnapshot, null, { today: "2026-08-10" }).needsHumanCount !==
        null ||
      undeclaredKanban["aspettano-umano"].length ||
      undeclaredKanban["non-auditate"].join() !== "1,2"
    )
      die(
        "room labels: absent blockedBy was treated as an implicit needs-human rule",
      );

    // #120 AC1 — "with problems" and "live resources/deploys" KPIs: derived joins over the health
    // overlay and the workflow signals already in the snapshot, never a new fetch. Undeclared health
    // (4th arg omitted) stays null/unknown (I6/I7); a declared-but-empty overlay counts as a measured
    // zero, which is why `[]` and `undefined` must read differently below.
    const problemSnapshot = {
      fetchedAt: "2026-08-10T00:00:00Z",
      milestones: [],
      issues: [
        { n: 1, state: "OPEN", labels: [], ms: null },
        { n: 2, state: "OPEN", labels: [], ms: null },
      ],
      signals: {
        workflows: {
          ci: { state: "present", conclusion: "success" },
          nightly: { state: "present", conclusion: "failure" },
        },
      },
    };
    const problemManifest = { today: "2026-08-10" };
    const noHealthKpis = deriveKpis(
      problemSnapshot,
      null,
      problemManifest,
      undefined,
    );
    if (
      noHealthKpis.withProblemsCount !== null ||
      noHealthKpis.withProblemsTotal !== null
    )
      die(
        "room kpis: an undeclared health overlay must read unmeasured, not zero: " +
          JSON.stringify(noHealthKpis),
      );
    const healthKpis = deriveKpis(problemSnapshot, null, problemManifest, [
      { n: 1, verdict: "bad", stale: false },
      { n: 2, verdict: "ok", stale: false },
    ]);
    if (healthKpis.withProblemsCount !== 1 || healthKpis.withProblemsTotal !== 2)
      die(
        "room kpis: withProblems did not count fresh non-ok verdicts over fresh verdicts total: " +
          JSON.stringify(healthKpis),
      );
    const staleHealthKpis = deriveKpis(problemSnapshot, null, problemManifest, [
      { n: 1, verdict: "bad", stale: true },
      { n: 2, verdict: "ok", stale: false },
    ]);
    if (
      staleHealthKpis.withProblemsCount !== 0 ||
      staleHealthKpis.withProblemsTotal !== 1
    )
      die(
        "room kpis: a stale verdict lost its colour but still counted as a live problem: " +
          JSON.stringify(staleHealthKpis),
      );
    if (
      healthKpis.liveResourcesCount !== 1 ||
      healthKpis.liveResourcesTotal !== 2
    )
      die(
        "room kpis: liveResources did not count completed-workflow conclusions over declared runs: " +
          JSON.stringify(healthKpis),
      );
    const noWorkflowKpis = deriveKpis(
      { ...problemSnapshot, signals: { workflows: {} } },
      null,
      problemManifest,
      [],
    );
    if (
      noWorkflowKpis.liveResourcesCount !== null ||
      noWorkflowKpis.liveResourcesTotal !== null
    )
      die(
        "room kpis: no workflow runs at all must read unmeasured, not zero: " +
          JSON.stringify(noWorkflowKpis),
      );

    // #120 AC2 — milestones carry a `state` (closed when nothing is open), sort by the due-date
    // constraint (ascending, undated last, title as tiebreak), and the KPI line names it when NO
    // milestone in the snapshot carries a due date at all — the exact shape of the viafera snapshot.
    const milestoneSnapshot = {
      fetchedAt: "2026-08-10T00:00:00Z",
      milestones: [
        { title: "b-undated", due: null, open: 2, closed: 1 },
        { title: "a-dated", due: "2026-09-01", open: 0, closed: 3 },
        { title: "c-undated", due: null, open: 0, closed: 0 },
      ],
      issues: [],
    };
    const orderedMilestones = deriveMilestones(milestoneSnapshot);
    if (
      orderedMilestones.map((m) => m.title).join(",") !==
      "a-dated,b-undated,c-undated"
    )
      die(
        "room milestones: due-date constraint order was not applied (dated first, then title): " +
          orderedMilestones.map((m) => m.title).join(","),
      );
    if (
      orderedMilestones[0].state !== "closed" ||
      orderedMilestones[1].state !== "open" ||
      orderedMilestones[2].state !== "empty"
    )
      die(
        "room milestones: per-milestone state (closed/open/empty) was not derived: " +
          JSON.stringify(orderedMilestones.map((m) => [m.title, m.state])),
      );
    if (
      deriveKpis(milestoneSnapshot, null, problemManifest).noMilestoneDueDates !==
      false
    )
      die(
        "room kpis: noMilestoneDueDates fired even though one milestone carries a due date",
      );
    const allUndated = {
      ...milestoneSnapshot,
      milestones: milestoneSnapshot.milestones.map((m) => ({
        ...m,
        due: null,
      })),
    };
    if (
      deriveKpis(allUndated, null, problemManifest).noMilestoneDueDates !== true
    )
      die(
        "room kpis: noMilestoneDueDates did not fire when every milestone lacks a due date",
      );

    // Endpoint identity is repo + number. An unrelated repository's #1 must not attach itself to
    // alpha #1 merely because both counters happen to match — neither the capability nor its work
    // block may inherit that foreign dependency.
    const alphaSnapshot = readJson(join(alpha, "issues.json")),
      alphaConfig = readJson(manifest).programs[0];

    // Gate extraction is an evidence path, not part of the briefing byte budget. Even when no
    // document can be embedded, the tracked source, its body line and its git date remain available
    // to the pure document gate.
    const cappedGateDocs = loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 1 });
    const fullGateDocs = loadDocs(alpha, {
      ...alphaConfig.docs,
      maxBytes: 200000,
    });
    if (cappedGateDocs.embedded.length || !cappedGateDocs.gateInputs)
      die(
        "document gate: maxBytes suppressed the gate input or embedded an over-budget document",
      );
    if (
      JSON.stringify(cappedGateDocs.gateInputs) !==
      JSON.stringify(fullGateDocs.gateInputs)
    )
      die("document gate: gateInputs changed with the presentation byte cap");
    const designGateInput = cappedGateDocs.gateInputs.documents.find(
      (document) => document.path === "docs/DESIGN.md",
    );
    if (
      !designGateInput ||
      designGateInput.bodyStartLine !== 1 ||
      designGateInput.invariants.length !== 1 ||
      designGateInput.invariants[0].id !== "How" ||
      designGateInput.invariants[0].line !== 1
    )
      die(
        "document gate: DESIGN heading/body source lines were not preserved: " +
          JSON.stringify(designGateInput),
      );
    if (
      !/^2026-06-15T10:00:00(?:Z|[+-]\d\d:\d\d)$/.test(
        designGateInput.lastChangedAt || "",
      )
    )
      die(
        "document gate: tracked DESIGN has no deterministic git change date: " +
          JSON.stringify(designGateInput && designGateInput.lastChangedAt),
      );
    const designAlone = loadDocs(alpha, {
      gate: { invariants: [{ path: "docs/DESIGN.md", idPattern: "^(How)\\b" }] },
    }).gateInputs.documents.find(
      (document) => document.path === "docs/DESIGN.md",
    );
    const designWithSibling = loadDocs(alpha, {
      gate: {
        invariants: [
          { path: "docs/DESIGN.md", idPattern: "^(How)\\b" },
          { path: "docs/GATE-CLAIMS.md", idPattern: "^(INV-COMMENT)$" },
        ],
      },
    }).gateInputs.documents.find(
      (document) => document.path === "docs/DESIGN.md",
    );
    if (
      !designAlone ||
      !designWithSibling ||
      designAlone.lastChangedAt !== designWithSibling.lastChangedAt
    )
      die(
        "document gate: a file lastChangedAt changed when an unrelated sibling joined the path set",
      );

    // One invariant, one finding. An invariant-specific registry match is measured; a declared
    // match that did not resolve is contradicted; and no mapping is explicitly unknown.
    const pureGateInputs = {
      trackedPaths: ["docs/GATE.md", "scripts/check.mjs"],
      errors: [],
      claims: [],
      freshness: [],
      documents: [
        {
          path: "docs/GATE.md",
          tracked: true,
          bodyStartLine: 1,
          metadata: [],
          lastChangedAt: "2026-08-01T00:00:00Z",
          reason: null,
          invariants: [
            {
              id: "WIRED",
              heading: "Wired check",
              line: 1,
              claims: [
                {
                  kind: "command",
                  line: 2,
                  text: "scripts/check.mjs",
                  tokens: ["scripts/check.mjs"],
                },
              ],
            },
            {
              id: "LOOSE",
              heading: "Loose check",
              line: 3,
              claims: [
                {
                  kind: "command",
                  line: 4,
                  text: "scripts/missing.mjs",
                  tokens: ["scripts/missing.mjs"],
                },
              ],
            },
          ],
        },
      ],
      registries: [
        {
          path: "package.json",
          tracked: true,
          lastChangedAt: "2026-08-01T00:00:00Z",
          reason: null,
          lines: [{ line: 1, text: "node scripts/check.mjs" }],
        },
      ],
      wiring: [
        {
          invariant: "WIRED",
          registry: "package.json",
          line: 1,
          resolved: true,
          reason: null,
        },
        {
          invariant: "LOOSE",
          registry: "package.json",
          line: null,
          resolved: false,
          reason: "not-found",
        },
      ],
    };
    const pureGate = documentGate(pureGateInputs, "2026-08-10");
    const wired = pureGate.rows.find((row) => row.invariant === "WIRED"),
      unregistered = pureGate.rows.find((row) => row.invariant === "LOOSE");
    if (!wired || wired.severity !== "ok" || wired.reason !== "wired")
      die(
        "document gate: declared registry evidence did not produce wired/ok: " +
          JSON.stringify(wired),
      );
    if (
      !unregistered ||
      unregistered.severity !== "bad" ||
      unregistered.reason !== "wiring-missing"
    )
      die(
        "document gate: missing registry evidence did not produce wiring-missing/bad: " +
          JSON.stringify(unregistered),
      );
    if (
      pureGate.rows.length !== 2 ||
      pureGate.findings.length !== pureGate.rows.length ||
      pureGate.rows.some((row, i) => pureGate.findings[i].id !== row.id)
    )
      die("document gate: invariant rows and c4 findings are not one-to-one");
    const findingErrors = validateModel(
      { findings: pureGate.findings },
      new URL("../lib/schema/c4-findings.schema.json", import.meta.url),
    );
    if (findingErrors.length)
      die(
        "document gate: emitted findings violate c4-findings.schema.json: " +
          findingErrors.join("; "),
      );
    const findingKeys = new Set(["id", "severity", "text", "evidence", "trace"]);
    if (
      pureGate.findings.some((finding) =>
        Object.keys(finding).some((key) => !findingKeys.has(key)),
      )
    )
      die(
        "document gate: a finding leaked fields outside the c4-findings contract: " +
          JSON.stringify(pureGate.findings),
      );
    const noRegistry = documentGate(
      { ...pureGateInputs, registries: [], wiring: [] },
      "2026-08-10",
    );
    if (
      noRegistry.rows.some(
        (row) => row.severity !== "warn" || row.reason !== "registry-not-mapped",
      )
    )
      die(
        "document gate: no invariant-to-registry mapping did not remain an explicit warning: " +
          JSON.stringify(noRegistry.rows),
      );
    const inputErrorGate = documentGate(
      {
        ...pureGateInputs,
        errors: [{ path: "docs/GATE.md", field: "pattern", reason: "invalid" }],
      },
      "2026-08-10",
    );
    if (
      inputErrorGate.errors.length !== 1 ||
      inputErrorGate.summary.bad !== pureGate.summary.bad + 1
    )
      die(
        "document gate: input errors were dropped or omitted from the bad summary: " +
          JSON.stringify(inputErrorGate),
      );

    const commentGateInputs = loadDocs(alpha, {
      maxBytes: 1,
      gate: {
        invariants: [
          { path: "docs/GATE-CLAIMS.md", idPattern: "^(INV-COMMENT)$" },
        ],
        registry: ["docs/gate-registry.js", "docs/gate-registry.yml"],
        wiring: [
          {
            invariant: "INV-COMMENT",
            registry: "docs/gate-registry.js",
            pattern: "scripts/check\\.mjs",
          },
          {
            invariant: "INV-COMMENT",
            registry: "docs/gate-registry.yml",
            pattern: "scripts/check\\.mjs",
          },
        ],
      },
    }).gateInputs;
    const commentGate = documentGate(commentGateInputs, "2026-08-10");
    if (
      commentGateInputs.wiring.length !== 2 ||
      commentGateInputs.wiring.some(
        (entry) => entry.resolved || entry.reason !== "not-found",
      ) ||
      commentGate.rows[0].reason !== "wiring-missing" ||
      commentGate.rows[0].severity !== "bad"
    )
      die(
        "document gate: a line/hash/block comment was accepted as wiring: " +
          JSON.stringify({
            wiring: commentGateInputs.wiring,
            row: commentGate.rows[0],
          }),
      );
    const inlineGateInputs = loadDocs(alpha, {
      maxBytes: 1,
      gate: {
        invariants: [
          { path: "docs/GATE-CLAIMS.md", idPattern: "^(INV-COMMENT)$" },
        ],
        registry: ["docs/gate-registry.js", "docs/gate-registry.yml"],
        wiring: [
          {
            invariant: "INV-COMMENT",
            registry: "docs/gate-registry.js",
            pattern: "fake-proof",
          },
          {
            invariant: "INV-COMMENT",
            registry: "docs/gate-registry.yml",
            pattern: "fake-proof",
          },
        ],
      },
    }).gateInputs;
    const jsInline = inlineGateInputs.wiring.find(
        (entry) => entry.registry === "docs/gate-registry.js",
      ),
      yamlInline = inlineGateInputs.wiring.find(
        (entry) => entry.registry === "docs/gate-registry.yml",
      );
    if (
      !jsInline ||
      !jsInline.resolved ||
      jsInline.line !== 5 ||
      !yamlInline ||
      yamlInline.resolved ||
      yamlInline.reason !== "not-found"
    )
      die(
        "document gate: inline comments supplied proof or the same text inside a JS quote was truncated: " +
          JSON.stringify(inlineGateInputs.wiring),
      );
    const htmlCommentInputs = loadDocs(join(HERE, ".."), {
      maxBytes: 1,
      gate: {
        invariants: [
          { path: "docs/GLOBAL_INVARIANTS.md", idPattern: "^(I1)\\." },
        ],
        registry: ["lib/viewer/control-room.html"],
        wiring: [
          {
            invariant: "I1",
            registry: "lib/viewer/control-room.html",
            pattern: "measured tokens belong",
          },
        ],
      },
    }).gateInputs;
    if (
      !htmlCommentInputs.wiring[0] ||
      htmlCommentInputs.wiring[0].resolved ||
      htmlCommentInputs.wiring[0].reason !== "not-found"
    )
      die(
        "document gate: a real /* */ comment in control-room.html supplied wiring proof: " +
          JSON.stringify(htmlCommentInputs.wiring[0]),
      );

    const noMatchInputs = loadDocs(alpha, {
      maxBytes: 1,
      gate: {
        invariants: [
          { path: "docs/GATE-CLAIMS.md", idPattern: "^NEVER-MATCHES$" },
        ],
      },
    }).gateInputs;
    if (
      !noMatchInputs.errors.some(
        (error) =>
          error.field === "idPattern" && error.reason === "no-invariant-match",
      ) ||
      documentGate(noMatchInputs, "2026-08-10").summary.bad < 1
    )
      die(
        "document gate: an idPattern matching zero headings did not become a gated input error",
      );
    const danglingInputs = loadDocs(alpha, {
      maxBytes: 1,
      gate: {
        invariants: [
          { path: "docs/GATE-CLAIMS.md", idPattern: "^(INV-COMMENT)$" },
        ],
        registry: ["docs/gate-registry.js"],
        wiring: [
          {
            invariant: "INV-MISSING",
            registry: "docs/gate-registry.js",
            pattern: "node",
          },
        ],
      },
    }).gateInputs;
    if (
      !danglingInputs.errors.some(
        (error) =>
          error.field === "wiring.invariant" &&
          /unknown-INV-MISSING/.test(error.reason),
      ) ||
      danglingInputs.wiring[0].reason !== "invariant-not-found" ||
      documentGate(danglingInputs, "2026-08-10").summary.bad < 1
    )
      die(
        "document gate: dangling invariant wiring did not become a gated input error: " +
          JSON.stringify(danglingInputs),
      );
    const duplicateInputs = loadDocs(alpha, {
      maxBytes: 1,
      gate: {
        invariants: [{ path: "docs/GATE-CLAIMS.md", idPattern: "^(INV-DUP)" }],
      },
    }).gateInputs;
    if (
      !duplicateInputs.errors.some(
        (error) =>
          error.field === "invariant.id" && error.reason === "duplicate-INV-DUP",
      ) ||
      documentGate(duplicateInputs, "2026-08-10").summary.bad < 1
    )
      die(
        "document gate: duplicate invariant ids did not become a gated input error: " +
          JSON.stringify(duplicateInputs.errors),
      );

    const freshnessGate = documentGate(
      {
        trackedPaths: [
          "docs/stale.md",
          "docs/invalid.md",
          "docs/future.md",
          "docs/status.md",
        ],
        registries: [],
        wiring: [],
        claims: [],
        errors: [],
        documents: [
          {
            path: "docs/stale.md",
            tracked: true,
            reason: null,
            invariants: [],
            lastChangedAt: null,
            metadata: [
              {
                key: "last_review",
                value: "2026-01-01",
                line: 2,
                source: "frontmatter",
              },
            ],
          },
          {
            path: "docs/invalid.md",
            tracked: true,
            reason: null,
            invariants: [],
            lastChangedAt: null,
            metadata: [
              {
                key: "last_review",
                value: "not-a-date",
                line: 2,
                source: "frontmatter",
              },
            ],
          },
          {
            path: "docs/future.md",
            tracked: true,
            reason: null,
            invariants: [],
            lastChangedAt: null,
            metadata: [
              {
                key: "last_review",
                value: "2026-09-01",
                line: 2,
                source: "frontmatter",
              },
            ],
          },
          {
            path: "docs/status.md",
            tracked: true,
            reason: null,
            invariants: [],
            lastChangedAt: null,
            metadata: [
              {
                key: "status",
                value: "Accepted (2026-01-02)",
                line: 3,
                source: "frontmatter",
              },
            ],
          },
        ],
        freshness: [
          { id: "stale", staleAfterDays: 30, paths: ["docs/stale.md"] },
          { id: "invalid", staleAfterDays: 30, paths: ["docs/invalid.md"] },
          { id: "future", staleAfterDays: 30, paths: ["docs/future.md"] },
          { id: "status", staleAfterDays: 30, paths: ["docs/status.md"] },
        ],
      },
      "2026-08-10",
    );
    const freshnessReasons = Object.fromEntries(
      freshnessGate.freshness.map((entry) => [entry.id, entry.reason]),
    );
    const statusFreshness = freshnessGate.freshness.find(
      (entry) => entry.id === "status",
    );
    if (
      freshnessReasons.stale !== "stale" ||
      freshnessReasons.invalid !== "date-invalid" ||
      freshnessReasons.future !== "date-future" ||
      !statusFreshness ||
      statusFreshness.at !== "2026-01-02" ||
      statusFreshness.reason !== "stale" ||
      freshnessGate.freshness.some((entry) => entry.verdict !== "warn") ||
      freshnessGate.summary.stale !== 4
    )
      die(
        "document gate: stale/invalid/future/status dates are not advisory warnings: " +
          JSON.stringify(freshnessGate.freshness),
      );

    if (
      !A.derived.documentGate ||
      A.derived.documentGate.rows.length !== 1 ||
      A.derived.documentGate.findings.length !== 1 ||
      A.derived.documentGate.rows[0].reason !== "no-enforcement-claim"
    )
      die(
        "room: the document gate was not embedded from the programme docs: " +
          JSON.stringify(A.derived.documentGate),
      );
    const typedClaims = Object.fromEntries(
      A.derived.documentGate.claims.map((claim) => [claim.id, claim]),
    );
    if (
      !typedClaims["path-ok"] ||
      typedClaims["path-ok"].type !== "path" ||
      typedClaims["path-ok"].measured !== "src/core/engine.js" ||
      typedClaims["path-ok"].verdict !== "ok"
    )
      die(
        "document claims: tracked path was not measured: " +
          JSON.stringify(typedClaims["path-ok"]),
      );
    if (
      !typedClaims["path-delete"] ||
      typedClaims["path-delete"].measured !== "claim-target.txt" ||
      typedClaims["path-delete"].verdict !== "ok"
    )
      die(
        "document claims: disposable tracked path was not measured before deletion: " +
          JSON.stringify(typedClaims["path-delete"]),
      );
    if (
      !typedClaims["count-ok"] ||
      typedClaims["count-ok"].type !== "tracked-count" ||
      typedClaims["count-ok"].measured !== 3 ||
      typedClaims["count-ok"].verdict !== "ok"
    )
      die(
        "document claims: tracked file count was not measured: " +
          JSON.stringify(typedClaims["count-ok"]),
      );
    if (
      !typedClaims["json-ok"] ||
      typedClaims["json-ok"].type !== "json" ||
      typedClaims["json-ok"].measured !== "strict" ||
      typedClaims["json-ok"].verdict !== "ok"
    )
      die(
        "document claims: JSON pointer was not measured: " +
          JSON.stringify(typedClaims["json-ok"]),
      );
    if (A.docs.gateInputs !== undefined)
      die("room: raw gateInputs leaked into the reader-facing document corpus");
    const numberCollision = {
      edges: [
        {
          active: true,
          source: "native",
          from: { repo: "acme/foreign", number: 1 },
          to: { repo: "acme/upstream", number: 90 },
        },
      ],
    };
    const collisionBlocks = deriveBlocks(
      alphaSnapshot,
      deriveQueue(alphaSnapshot, alphaConfig.taxonomy),
      numberCollision,
      alphaConfig,
    );
    const collisionBlock = collisionBlocks.find((block) =>
      block.iss.some((issue) => issue[0] === 1),
    );
    const collisionCapabilities = deriveCapabilities(
      alpha,
      alphaConfig.capabilities,
      alphaSnapshot,
      numberCollision,
    );
    const collisionCapability = collisionCapabilities.rows.find(
      (row) => row.id === "F-1",
    );
    if (
      !collisionBlock ||
      !collisionBlock.auto ||
      collisionBlock.why.length ||
      !collisionCapability ||
      collisionCapability.blockers.length
    )
      die(
        "room dependencies: a foreign repo edge with local number #1 blocked alpha #1",
      );

    // Capability state stays the document's vocabulary plus its explicit mapping; issue, RTM and
    // release evidence are joined to the same row rather than persisted in another overlay.
    const capabilities = A.derived.capabilities && A.derived.capabilities.rows;
    const f1 = capabilities && capabilities.find((row) => row.id === "F-1");
    const f2 = capabilities && capabilities.find((row) => row.id === "F-2");
    if (
      !f1 ||
      f1.originalStatus !== "In delivery" ||
      f1.status !== "in-progress" ||
      f1.openIssues.join() !== "1" ||
      f1.release !== "v1"
    )
      die(
        "room: F-1 capability lost its mapped status, issue or release: " +
          JSON.stringify(f1),
      );
    if (
      !f2 ||
      f2.originalStatus !== "Released" ||
      f2.status !== "done" ||
      f2.openIssues.length ||
      f2.release !== "v1"
    )
      die(
        "room: F-2 capability lost its closed issue or release: " +
          JSON.stringify(f2),
      );
    if (
      f1.verification.length !== 1 ||
      f1.verification[0].verdict !== "PASS" ||
      f1.verification[0].requirement !== "R-1"
    )
      die(
        "room: capability did not join its RTM verdict: " +
          JSON.stringify(f1.verification),
      );
    if (
      f1.useCases.join() !== "UC-1" ||
      f1.verification[0].useCaseIds.join() !== "UC-1"
    )
      die(
        "room: feature did not inherit RTM evidence through its declared use case: " +
          JSON.stringify(f1),
      );

    // A commit touching more files than linkMaxFiles is a sweep: excluded from attribution, but
    // counted and named rather than silently dropped (I9). The manifest declares 2; the sweep is 3.
    if (A.derived.link.excludedSweeps.length !== 1)
      die(
        "room: expected 1 excluded sweep at linkMaxFiles=2, got " +
          JSON.stringify(A.derived.link.excludedSweeps),
      );

    // One assertion covering two regressions at once. #1 landed in 2026-07 and is a real issue; #99
    // landed in 2026-07 too but is a PULL REQUEST number, absent from the snapshot; #2's only commit
    // is the August sweep. So: exactly one month, exactly one landing.
    //  - if the snapshot intersection were dropped, #99 would make 2026-07 read `landed: 2`;
    //  - if linkMaxFiles stopped reaching the portfolio path, the sweep would add a 2026-08 bucket.
    const landing = (ROOM.portfolio.landing || []).find(
      (l) => l.program === "alpha",
    );
    if (
      !landing ||
      landing.months.length !== 1 ||
      landing.months[0].month !== "2026-07" ||
      landing.months[0].landed !== 1
    ) {
      die(
        "room: alpha landing should be exactly [{2026-07, landed 1}], got " +
          JSON.stringify(landing && landing.months),
      );
    }

    // A programme with no map still derives everything its issues can answer. It used to derive
    // nothing at all, so the gate had nothing per-programme to re-derive for it.
    if (B.derived === null)
      die(
        "room: beta derived nothing — a programme without a map must still derive from its issues",
      );
    if (B.derived.link !== null || B.derived.commitDrift !== null)
      die(
        "room: beta has no map, so link and commitDrift must be null, got " +
          JSON.stringify({
            link: B.derived.link,
            commitDrift: B.derived.commitDrift,
          }),
      );
    if (B.derived.kpis.linkCoveragePct !== null)
      die(
        "room: beta was never asked the issue-to-code question; coverage must be null, not " +
          B.derived.kpis.linkCoveragePct,
      );
    if (!B.derived.kanban || B.derived.kanban.chiuse.join() !== "6")
      die(
        "room: beta kanban should still bucket its own issues, got " +
          JSON.stringify(B.derived.kanban),
      );
    if (ROOM.portfolio.totals.unknownRule !== 1)
      die(
        "room: beta declares no blocking rule, so unknownRule must be 1 (absent is not empty, I7), got " +
          ROOM.portfolio.totals.unknownRule,
      );
    if (ROOM.portfolio.totals.blocked !== null)
      die(
        "room: one unknown blocking rule makes the portfolio blocked total unknown, got " +
          ROOM.portfolio.totals.blocked,
      );
    const betaSummary = ROOM.portfolio.programs.find((p) => p.id === "beta"),
      betaMoving = ROOM.portfolio.moving.find((p) => p.program === "beta");
    if (!betaSummary || betaSummary.blocked !== null)
      die(
        "room: beta unknown blocking state collapsed to a number: " +
          JSON.stringify(betaSummary),
      );
    if (!betaMoving || betaMoving.count !== null || betaMoving.byCluster !== null)
      die(
        "room: beta moving claim collapsed unknown into an empty queue: " +
          JSON.stringify(betaMoving),
      );
    if (A.derived.kpis.snapshotAgeDays !== 1 || betaSummary.snapshotAgeDays !== 1)
      die("room: snapshot civil age was not derived consistently");
    if (
      daysBetween("2026-08-17T23:59:59Z", "2026-08-17") !== 0 ||
      daysBetween("not-a-date", "2026-08-17") !== null
    )
      die("room: civil date comparison regressed to timestamp rounding");
    const incompleteHistory = deriveHistory(
      {
        issues: [
          { n: 1, state: "OPEN", createdAt: "2026-01-01" },
          { n: 2, state: "CLOSED", createdAt: "2026-01-15" },
        ],
      },
      "2026-02-01",
    );
    if (
      !incompleteHistory ||
      incompleteHistory.unplaceable !== 1 ||
      incompleteHistory.points.some(
        (point) => point.open !== 1 || point.closed !== 0 || point.created !== 1,
      )
    )
      die(
        "room history: CLOSED without closedAt entered the series instead of being named unplaceable",
      );
    // Blocked has two sources and the row says which: alpha #2 carries the declared label AND an open
    // cross-repo blocker on a native edge; the counts split, and the item names both (I7, never fused).
    const alphaSummary = ROOM.portfolio.programs.find((p) => p.id === "alpha"),
      alphaBlocked = ROOM.portfolio.blocked.find(
        (b) => b.program === "alpha" && b.n === 2,
      );
    if (
      !alphaSummary ||
      alphaSummary.blocked !== 1 ||
      alphaSummary.blockedByLabel !== 1 ||
      alphaSummary.blockedByDependency !== 1
    )
      die(
        "room: alpha blocked sources not split, got " +
          JSON.stringify(
            alphaSummary && [
              alphaSummary.blocked,
              alphaSummary.blockedByLabel,
              alphaSummary.blockedByDependency,
            ],
          ),
      );
    if (
      !alphaBlocked ||
      JSON.stringify(alphaBlocked.blockedBy) !==
        JSON.stringify({
          labels: ["needs-human"],
          blockers: [{ repo: "acme/platform", number: 90, source: "native" }],
        })
    )
      die(
        "room: the blocked row does not say which label and which blocker: " +
          JSON.stringify(alphaBlocked && alphaBlocked.blockedBy),
      );
    if (
      !betaSummary ||
      betaSummary.blockedByLabel !== null ||
      betaSummary.blockedByDependency !== null
    )
      die(
        "room: beta unknown blocked sources collapsed to numbers: " +
          JSON.stringify(betaSummary),
      );

    const presentable = (file) =>
      spawnSync(
        process.execPath,
        [
          join(HERE, "..", "scripts", "room-presentable.mjs"),
          "--room",
          file,
          "--manifest",
          manifest,
        ],
        { encoding: "utf-8" },
      );
    r = presentable(roomHtml);
    if (r.status !== 0)
      die(
        "room-presentable: the generated briefing does not pass its own publication gate\n" +
          (r.stdout || "") +
          (r.stderr || ""),
      );

    const checkRoom = (file, mf) =>
      run([
        "check",
        "--repo",
        alpha,
        "--model",
        model,
        "--topology",
        topo,
        "--room",
        file,
        "--manifest",
        mf || manifest,
      ]);
    r = checkRoom(roomHtml);
    if (r.status !== 0)
      die(
        "room: check fails on an untouched briefing\n" +
          (r.stdout || "") +
          (r.stderr || ""),
      );

    // A typed claim is a live comparison, not decorative metadata. Changing the written count
    // makes the pure result bad and the shared room/check gate must refuse the stale artifact.
    const pristineClaims = readFileSync(claimsDoc, "utf-8");
    writeFileSync(
      claimsDoc,
      pristineClaims.replace("Tracked sources: 3", "Tracked sources: 99"),
    );
    const mismatchedClaimInputs = loadDocs(alpha, {
      ...alphaConfig.docs,
      maxBytes: 1,
    }).gateInputs;
    const mismatchedClaimGate = documentGate(mismatchedClaimInputs, "2026-08-10");
    const mismatchedCount = mismatchedClaimGate.claims.find(
      (claim) => claim.id === "count-ok",
    );
    if (
      !mismatchedCount ||
      mismatchedCount.reason !== "mismatch" ||
      mismatchedCount.verdict !== "bad" ||
      mismatchedCount.measured !== 3
    )
      die(
        "document claims: a false tracked count did not derive mismatch/bad: " +
          JSON.stringify(mismatchedCount),
      );
    r = checkRoom(roomHtml);
    if (r.status === 0 || !/DOCUMENT CLAIM alpha: count-ok/.test(r.stderr || ""))
      die(
        "room: check did not reject and name a mismatched typed document claim",
        r,
      );
    writeFileSync(claimsDoc, pristineClaims);
    r = checkRoom(roomHtml);
    if (r.status !== 0)
      die("room: restoring a typed claim did not restore the green gate", r);

    // The critical path is a live comparison like every other aggregate, not decorative metadata
    // written once and never read (#2480 wave 3). Rewriting the published schedule must make the
    // shared room/check gate refuse the artifact — a derivation nobody recomputes is prose in JSON.
    const pristineRoom = readFileSync(roomHtml, "utf-8");
    const cpAt = pristineRoom.indexOf('"criticalPath":');
    const cpEnd = pristineRoom.indexOf(',"blocks":', cpAt);
    if (cpAt < 0 || cpEnd < 0)
      die("room: the briefing carries no criticalPath aggregate to compare");
    writeFileSync(
      roomHtml,
      pristineRoom.slice(0, cpAt) +
        '"criticalPath":{"durationModel":"invented","projectDurationDays":999,"nodes":[],"criticalPath":[],"cycles":[],"excludedForeign":[]}' +
        pristineRoom.slice(cpEnd),
    );
    r = checkRoom(roomHtml);
    if (r.status === 0 || !/[Cc]ritical[ Pp]?[Pp]ath/.test((r.stderr || "") + (r.stdout || "")))
      die("room: check did not reject and NAME the invented critical path", r);
    writeFileSync(roomHtml, pristineRoom);
    r = checkRoom(roomHtml);
    if (r.status !== 0)
      die("room: restoring the critical path did not restore the green gate", r);

    // The milestone path derives from arbiter's projection, so it is arbiter's claim rendered by
    // forma — and it must be gated exactly like a derivation forma computed alone. Rewriting the
    // published schedule must be refused (#2480 wave 6).
    const mpAt = pristineRoom.indexOf('"milestonePath":');
    const mpEnd = pristineRoom.indexOf(',"milestoneReconciliation":', mpAt);
    if (mpAt < 0 || mpEnd < 0)
      die("room: the briefing carries no milestonePath aggregate — the arbiter projection did not reach it");
    writeFileSync(
      roomHtml,
      pristineRoom.slice(0, mpAt) +
        '"milestonePath":{"durationModel":"invented","projectDurationDays":4242,"isLowerBound":false,"unestimated":[],"nodes":[],"criticalPath":[],"cycles":[]}' +
        pristineRoom.slice(mpEnd),
    );
    r = checkRoom(roomHtml);
    if (r.status === 0 || !/[Mm]ilestone/.test((r.stderr || "") + (r.stdout || "")))
      die("room: check did not reject and NAME an invented milestone path", r);
    writeFileSync(roomHtml, pristineRoom);
    r = checkRoom(roomHtml);
    if (r.status !== 0)
      die("room: restoring the milestone path did not restore the green gate", r);

    const missingJsonConfig = JSON.parse(JSON.stringify(alphaConfig.docs));
    missingJsonConfig.gate.claims.push(
      {
        id: "json-missing",
        path: "docs/GATE-CLAIMS.md",
        pattern: "^JSON missing: (\\S+)$",
        type: "json",
        target: "gate-target.json",
        pointer: "/absent",
      },
      {
        id: "json-object",
        path: "docs/GATE-CLAIMS.md",
        pattern: "^JSON object: (\\S+)$",
        type: "json",
        target: "gate-target.json",
        pointer: "/nested",
      },
    );
    const jsonEdgeGate = documentGate(
      loadDocs(alpha, { ...missingJsonConfig, maxBytes: 1 }).gateInputs,
      "2026-08-10",
    );
    const jsonMissing = jsonEdgeGate.claims.find(
        (claim) => claim.id === "json-missing",
      ),
      jsonObject = jsonEdgeGate.claims.find(
        (claim) => claim.id === "json-object",
      );
    if (
      !jsonMissing ||
      jsonMissing.reason !== "pointer-unresolved" ||
      jsonMissing.verdict !== "bad" ||
      !jsonObject ||
      jsonObject.reason !== "target-non-scalar" ||
      jsonObject.verdict !== "bad"
    )
      die(
        "document claims: missing/non-scalar JSON pointers were not bad: " +
          JSON.stringify({ jsonMissing, jsonObject }),
      );
    const captureConfig = JSON.parse(JSON.stringify(alphaConfig.docs));
    captureConfig.gate.claims = [
      {
        id: "capture-missing",
        path: "docs/GATE-CLAIMS.md",
        pattern: "^Path claim: (\\S+)$",
        capture: 99,
        type: "path",
      },
    ];
    const captureGate = documentGate(
      loadDocs(alpha, { ...captureConfig, maxBytes: 1 }).gateInputs,
      "2026-08-10",
    );
    const captureMissing = captureGate.claims.find(
      (claim) => claim.id === "capture-missing",
    );
    if (
      !captureMissing ||
      captureMissing.reason !== "capture-unresolved" ||
      captureMissing.verdict !== "bad"
    )
      die(
        "document claims: an explicit capture outside the regex groups did not become capture-unresolved/bad: " +
          JSON.stringify(captureMissing),
      );

    const claimTargetText = readFileSync(claimTarget, "utf-8");
    rmSync(claimTarget);
    const deletedPathGate = documentGate(
      loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 1 }).gateInputs,
      "2026-08-10",
    );
    const deletedPath = deletedPathGate.claims.find(
      (claim) => claim.id === "path-delete",
    );
    if (
      !deletedPath ||
      deletedPath.reason !== "target-unresolved" ||
      deletedPath.verdict !== "bad"
    )
      die(
        "document claims: a tracked but deleted target path remained good: " +
          JSON.stringify(deletedPath),
      );
    writeFileSync(claimTarget, claimTargetText);

    const deletedCountTarget = join(alpha, "src/util/log.js"),
      deletedCountText = readFileSync(deletedCountTarget, "utf-8");
    rmSync(deletedCountTarget);
    const deletedCountGate = documentGate(
      loadDocs(alpha, { ...alphaConfig.docs, maxBytes: 1 }).gateInputs,
      "2026-08-10",
    );
    const deletedCount = deletedCountGate.claims.find(
      (claim) => claim.id === "count-ok",
    );
    if (
      !deletedCount ||
      deletedCount.measured !== 2 ||
      deletedCount.reason !== "mismatch" ||
      deletedCount.verdict !== "bad"
    )
      die(
        "document claims: tracked-count included a tracked file deleted from the worktree: " +
          JSON.stringify(deletedCount),
      );
    writeFileSync(deletedCountTarget, deletedCountText);

    const duplicateDesignDoc = join(alpha, "docs/DESIGN.md"),
      pristineDesign = readFileSync(duplicateDesignDoc, "utf-8");
    writeFileSync(duplicateDesignDoc, pristineDesign + "\n# How duplicate\n");
    r = checkRoom(roomHtml);
    if (r.status === 0 || !/invariant\.id duplicate-How/.test(r.stderr || ""))
      die(
        "room: duplicate invariant ids were not rejected and named by check",
        r,
      );
    writeFileSync(duplicateDesignDoc, pristineDesign);

    // The gate must FAIL on a hand-altered aggregate, or its green proves nothing. Both directions:
    // the mapped programme and the map-less one, which was ungated entirely before.
    const tamper = (from, to, find, replace) => {
      const src = readFileSync(from, "utf-8"),
        out = src.replace(find, replace);
      if (out === src) die("room: tamper pattern did not apply — " + find);
      writeFileSync(to, out);
    };
    const tamperedA = join(R, "tampered-alpha.html"),
      tamperedB = join(R, "tampered-beta.html"),
      tamperedBlock = join(R, "tampered-block.html"),
      tamperedDocumentGate = join(R, "tampered-document-gate.html");
    tamper(roomHtml, tamperedA, '"openCount":2', '"openCount":7');
    r = checkRoom(tamperedA);
    if (r.status === 0)
      die(
        "room: check passed a briefing whose Executive KPIs were altered by hand",
      );
    if (!/alpha — Executive KPIs/.test(r.stderr || ""))
      die(
        "room: check failed but did not name the programme and the field, got: " +
          (r.stderr || ""),
      );
    const betaAt = readFileSync(roomHtml, "utf-8").indexOf('"id":"beta"');
    tamper(roomHtml, tamperedB, /"noMilestoneCount":1/g, '"noMilestoneCount":0');
    if (betaAt < 0) die("room: beta is not present in the artifact at all");
    r = checkRoom(tamperedB);
    if (r.status === 0)
      die(
        "room: check passed an altered aggregate on the programme with no map — the map-less path is ungated",
      );
    tamper(
      roomHtml,
      tamperedBlock,
      '"cmd":"gh issue view 1"',
      '"cmd":"gh issue view 99"',
    );
    r = checkRoom(tamperedBlock);
    if (r.status === 0)
      die("room: check passed a hand-altered derived work block");
    const alteredDocumentGate = JSON.parse(
      JSON.stringify(A.derived.documentGate),
    );
    alteredDocumentGate.summary.warn += 1;
    tamper(
      roomHtml,
      tamperedDocumentGate,
      JSON.stringify(A.derived.documentGate),
      JSON.stringify(alteredDocumentGate),
    );
    r = checkRoom(tamperedDocumentGate);
    if (r.status === 0 || !/document gate/.test(r.stderr || ""))
      die("room: check did not reject and name a hand-altered document gate", r);

    // F1: the portfolio is a cross-programme aggregate `check` never re-derived — only each
    // programme's own fields were compared. A hand-altered `portfolio.totals.open` must be refused
    // and the failure must name the portfolio.
    const tamperedPortfolio = join(R, "tampered-portfolio.html");
    const alteredTotals = { ...ROOM.portfolio.totals, open: 0 };
    tamper(
      roomHtml,
      tamperedPortfolio,
      JSON.stringify(ROOM.portfolio.totals),
      JSON.stringify(alteredTotals),
    );
    r = checkRoom(tamperedPortfolio);
    if (r.status === 0 || !/portfolio/.test(r.stderr || ""))
      die(
        "room: check did not reject and name a hand-altered portfolio.totals.open",
        r,
      );

    // F1: `meta.today` and `meta.excluded` are re-derived and compared alongside `portfolio` — a
    // hand-altered determinism anchor or exclusion list must be refused just as loudly.
    const tamperedMetaToday = join(R, "tampered-meta-today.html");
    tamper(
      roomHtml,
      tamperedMetaToday,
      '"today":' + JSON.stringify(ROOM.meta.today),
      '"today":' + JSON.stringify("2099-01-01"),
    );
    r = checkRoom(tamperedMetaToday);
    if (r.status === 0 || !/meta\.today/.test(r.stderr || ""))
      die(
        "room: check did not reject and name a hand-altered meta.today",
        r,
      );

    const tamperedMetaExcluded = join(R, "tampered-meta-excluded.html");
    tamper(
      roomHtml,
      tamperedMetaExcluded,
      '"excluded":' + JSON.stringify(ROOM.meta.excluded),
      '"excluded":' +
        JSON.stringify([
          ...ROOM.meta.excluded,
          { id: "ghost", ghRepo: "acme/ghost" },
        ]),
    );
    r = checkRoom(tamperedMetaExcluded);
    if (r.status === 0 || !/meta\.excluded/.test(r.stderr || ""))
      die(
        "room: check did not reject and name a hand-altered meta.excluded",
        r,
      );

    // F8: `room` schema-validates a programme's model before composing (lib/room.mjs), but `check
    // --room` re-reads the same model.json from disk without validating it at all — an
    // additionalProperties violation leaves `deriveAll`'s output byte-identical (so the
    // re-derivation-parity comparisons above cannot catch it), yet the model is invalid. `check
    // --room` must report it, naming the schema, the same way `room` would refuse to compose it.
    // `--model` here points at a file that does not exist, so the top-level (non-room) C4 gate that
    // `checkRoom` normally also exercises is skipped (ROOM_ONLY) and only the room block is under
    // test.
    const pristineModel = readFileSync(model, "utf-8");
    const brokenModel = JSON.parse(pristineModel);
    brokenModel._bogus = true;
    writeFileSync(model, JSON.stringify(brokenModel, null, 2));
    r = run([
      "check",
      "--model",
      join(R, "no-such-model.json"),
      "--room",
      roomHtml,
      "--manifest",
      manifest,
    ]);
    writeFileSync(model, pristineModel);
    if (r.status === 0 || !/c4-model\.schema\.json/.test(r.stderr || ""))
      die(
        "room: check --room did not reject a schema-invalid programme model (F8)",
        r,
      );

    // Codex round 1 (HIGH): a top-level JSON `null` model must not be treated the same as a
    // read failure — it is a successfully parsed value that is certainly schema-invalid (the
    // schema requires an object), and the loader must still run it through `validateModel` rather
    // than silently skipping validation because the parsed value happens to be JS `null`.
    writeFileSync(model, "null");
    r = run([
      "check",
      "--model",
      join(R, "no-such-model.json"),
      "--room",
      roomHtml,
      "--manifest",
      manifest,
    ]);
    writeFileSync(model, pristineModel);
    if (r.status === 0 || !/c4-model\.schema\.json/.test(r.stderr || ""))
      die(
        "room: check --room accepted a top-level JSON null model instead of schema-validating it",
        r,
      );

    // Codex round 1 (HIGH): a diagnostic that check --room has always continued past (a schema-
    // invalid overlay, or a manifest/snapshot mismatch) must still let the rest of the gate run —
    // in particular the re-derivation-parity comparison below it. Corrupt alpha's health overlay
    // (schema-invalid, reported but not fatal) AND hand-alter the embedded Executive KPIs (only
    // caught by the parity comparison that runs AFTER the overlay is loaded): both failures must
    // appear together, proving the health-schema diagnostic did not short-circuit the run.
    const alphaHealth = join(alpha, "health.json");
    const pristineAlphaHealth = readFileSync(alphaHealth, "utf-8");
    const brokenHealth = JSON.parse(pristineAlphaHealth);
    brokenHealth._bogus = true;
    writeFileSync(alphaHealth, JSON.stringify(brokenHealth, null, 2));
    const tamperedKpi = join(R, "tampered-continuation.html");
    tamper(roomHtml, tamperedKpi, '"openCount":2', '"openCount":7');
    r = checkRoom(tamperedKpi);
    writeFileSync(alphaHealth, pristineAlphaHealth);
    if (
      r.status === 0 ||
      !/health overlay/.test(r.stderr || "") ||
      !/Executive KPIs/.test(r.stderr || "")
    )
      die(
        "room: check --room did not continue past a schema-invalid overlay to the later parity comparison",
        r,
      );

    // Codex round 3 (HIGH 1, #140 S3): `loadProgram` marks `issues-truncated` fatal, but
    // `checkDiagnosticMessages` used to have no case for it — the programme was silently skipped
    // (no FAIL line at all) even though the loop still `continue`d past it. Must now exit 1 and name
    // the truncation.
    const alphaIssues = join(alpha, "issues.json");
    const pristineAlphaIssues = readFileSync(alphaIssues, "utf-8");
    const truncatedSnap = JSON.parse(pristineAlphaIssues);
    truncatedSnap.truncated = true;
    writeFileSync(alphaIssues, JSON.stringify(truncatedSnap));
    r = checkRoom(roomHtml);
    writeFileSync(alphaIssues, pristineAlphaIssues);
    if (r.status === 0 || !/truncated/.test(r.stderr || ""))
      die(
        "room: check --room did not reject a truncated issue snapshot (issues-truncated diagnostic)",
        r,
      );

    // Codex round 3 (HIGH 1, #140 S3): same gap for `model-topology-symmetry` — declaring a model
    // without a topology (or vice versa) must exit 1 and name the mismatch, not silently skip. The
    // manifest declares `model` and no `topology` for alpha; the top-level (non-room) C4 gate still
    // reads the real, untouched model/topology via --model/--topology, so only the room block is
    // exercising the asymmetry.
    const manifestNoTopology = join(R, "manifest-no-topology.json");
    const mNoTopo = readJson(manifest);
    delete mNoTopo.programs.find((p) => p.id === "alpha").topology;
    writeFileSync(manifestNoTopology, JSON.stringify(mNoTopo, null, 2));
    r = checkRoom(roomHtml, manifestNoTopology);
    if (r.status === 0 || !/model and topology must either both be present or both be absent/.test(r.stderr || ""))
      die(
        "room: check --room did not reject a model declared without a topology (model-topology-symmetry diagnostic)",
        r,
      );

    // Codex round 3 (HIGH 2, #140 S3): main's inline boundary skipped a programme SILENTLY on any
    // falsy parsed overlay (`null`, `false`, `0`, `""`) — no FAIL line, exit 0. The shared loader must
    // fail closed the same way (now reporting why, which is stricter, not a regression): a `null`
    // health overlay must produce exactly one FAIL line, exit 1, and no raw Node stack trace.
    writeFileSync(alphaHealth, "null");
    r = checkRoom(roomHtml);
    writeFileSync(alphaHealth, pristineAlphaHealth);
    const failLines = (r.stderr || "").split("\n").filter((l) => /^ - /.test(l));
    if (
      r.status === 0 ||
      failLines.length !== 1 ||
      !/health overlay/.test(failLines[0]) ||
      /at .*:\d+:\d+/.test(r.stderr || "")
    )
      die(
        "room: check --room did not fail closed on a null health overlay with exactly one FAIL line",
        r,
      );

    // A manifest and an artifact that disagree about which programmes exist is drift, not a detail.
    const manifestGamma = join(R, "manifest-gamma.json");
    const mf = readJson(manifest);
    mf.programs.push({
      id: "gamma",
      ghRepo: "acme/gamma",
      repo: "beta",
      issues: "beta/issues.json",
    });
    writeFileSync(manifestGamma, JSON.stringify(mf, null, 2));
    r = checkRoom(roomHtml, manifestGamma);
    if (r.status === 0)
      die(
        "room: check passed a manifest declaring a programme the artifact does not render",
      );

    const manifestWorkflow = join(R, "manifest-workflow.json");
    const mw = readJson(manifest);
    mw.programs[0].workflows = [{ id: "ci", path: ".github/workflows/ci.yml" }];
    writeFileSync(manifestWorkflow, JSON.stringify(mw, null, 2));
    const mismatchedRoom = run([
      "room",
      "--manifest",
      manifestWorkflow,
      "--out",
      join(R, "never-workflow.html"),
    ]);
    const mismatchedCheck = checkRoom(roomHtml, manifestWorkflow);
    if (
      mismatchedRoom.status === 0 ||
      mismatchedCheck.status === 0 ||
      !/workflow signals/.test(
        (mismatchedRoom.stderr || "") + (mismatchedCheck.stderr || ""),
      )
    )
      die(
        "room: an extra manifest workflow was silently absent from its snapshot",
      );

    // A truncated snapshot cannot support counts or proportions: refuse rather than degrade (D8).
    const truncated = join(R, "truncated.json");
    const snap = readJson(join(alpha, "issues.json"));
    snap.truncated = true;
    writeFileSync(truncated, JSON.stringify(snap));
    const mfTrunc = join(R, "manifest-truncated.json");
    const mt = readJson(manifest);
    mt.programs[0].issues = "truncated.json";
    writeFileSync(mfTrunc, JSON.stringify(mt, null, 2));
    r = run(["room", "--manifest", mfTrunc, "--out", join(R, "never.html")]);
    if (r.status === 0)
      die("room: composed a briefing from a snapshot flagged truncated");

    // The traceability chain. alpha declares two documents: docs/PRD.md carries R-* requirements,
    // docs/DESIGN.md carries D-* decisions that satisfy them and land on issues. Together the last
    // two assertions are what makes "the GitHub issues ARE the WBS" falsifiable rather than a wish:
    // nothing planned may be unaccounted for, and nothing open may be unplanned.
    const matrix = A.derived.rtm;
    if (!matrix) die("rtm: alpha declares an rtm block and derived no matrix");
    if (matrix.coverage.requirements !== 5 || matrix.coverage.withIssues !== 3)
      die(
        "rtm: expected 5 requirements, 3 landing on issues, got " +
          JSON.stringify(matrix.coverage),
      );
    if (matrix.progress["D-3"].pct !== 100)
      die(
        "rtm: D-3 cites only the closed issue #3, so it reads 100%, got " +
          JSON.stringify(matrix.progress["D-3"]),
      );
    if (matrix.progress["R-1"].pct !== null)
      die(
        "rtm: R-1 cites no issue at all, so it has no percentage rather than a zero (I6), got " +
          JSON.stringify(matrix.progress["R-1"]),
      );
    for (const hole of [
      "duplicateIds",
      "danglingRefs",
      "uncovered",
      "orphanIssues",
    ]) {
      if (matrix.orphans[hole].length)
        die(
          `rtm: the fixture matrix is complete, but ${hole} is not empty: ` +
            JSON.stringify(matrix.orphans[hole]),
        );
    }
    if (B.derived.rtm !== null)
      die(
        "rtm: beta declares no rtm block, so it must derive null — opt-in by presence (I11)",
      );

    // Each hole, one at a time, edited into the document rather than into the artifact: this is the
    // chain failing at its source, which is where a reader has to fix it.
    const rtmBreaks = [
      [
        "a duplicate id",
        (s) =>
          s.replace(
            "\n\n| id | capability",
            "\n| D-1 | A second row answering to D-1 | `R-2` | `#2` |\n\n| id | capability",
          ),
        /id "D-1" is declared twice/,
      ],
      [
        "a reference to a requirement that does not exist",
        (s) => s.replace("`R-2` | `#2`", "`R-9` | `#2`"),
        /cites satisfies R-9, which does not exist/,
      ],
      [
        "a decision that lands on no work",
        (s) => s.replace("| `R-1` | `#3` |", "| `R-1` | |"),
        /requirement "D-3" lands on no issue and names no verification/,
      ],
      [
        "open work no requirement claims",
        (s) => s.replace("`R-2` | `#2`", "`R-2` | `#1`"),
        /open issue #2 .* is cited by no requirement/,
      ],
    ];
    // The document is restored BEFORE the assertions, not after the loop: a die() mid-loop would
    // otherwise leave the fixture edited, and the next block's failure would point at the wrong thing.
    const designDoc = join(alpha, "docs/DESIGN.md"),
      designSrc = readFileSync(designDoc, "utf-8");
    for (const [what, edit, expected] of rtmBreaks) {
      const broken = edit(designSrc);
      if (broken === designSrc)
        die(
          `rtm: the edit for "${what}" changed nothing — the fixture document drifted`,
        );
      writeFileSync(designDoc, broken);
      const rebuilt = join(R, "rtm-broken.html");
      const composed = run(["room", "--manifest", manifest, "--out", rebuilt]);
      const graded = composed.status === 0 ? checkRoom(rebuilt) : null;
      writeFileSync(designDoc, designSrc);
      if (!graded)
        die(
          `rtm: room refused to compose with ${what}; the matrix is graded by check, not by the composer`,
          composed,
        );
      if (graded.status === 0) die(`rtm: check passed a matrix with ${what}`);
      if (!expected.test(graded.stderr || ""))
        die(
          `rtm: check failed on ${what} but did not say so — got: ` +
            (graded.stderr || "").slice(0, 400),
        );
    }

    // A document that contributes nothing is named. Untracked is the case that matters: the matrix
    // must not depend on what happens to be lying in a working tree.
    const extra = join(alpha, "docs/EXTRA.md");
    writeFileSync(
      extra,
      "| id | requirement | issues |\n|---|---|---|\n| R-7 | Never entered git | `#1` |\n",
    );
    const mfExtra = join(R, "manifest-extra.json");
    const withExtra = readJson(manifest);
    withExtra.programs[0].rtm.docs.push({
      path: "docs/EXTRA.md",
      idPattern: "^R-\\d+$",
      role: "requirement",
    });
    writeFileSync(mfExtra, JSON.stringify(withExtra, null, 2));
    r = run(["room", "--manifest", mfExtra, "--out", join(R, "rtm-extra.html")]);
    if (r.status !== 0) die("rtm: room refused an untracked rtm document", r);
    r = checkRoom(join(R, "rtm-extra.html"), mfExtra);
    if (r.status === 0)
      die("rtm: check passed a matrix built from a document git does not track");
    if (
      !/docs\/EXTRA\.md contributed no rows \(not tracked by git\)/.test(
        r.stderr || "",
      )
    )
      die(
        "rtm: an untracked document was skipped without being named — got: " +
          (r.stderr || "").slice(0, 300),
      );
    rmSync(extra);

    // Where we were. The whole series comes out of ONE snapshot, from createdAt/closedAt, so there is
    // no register to keep and no second fetch — and the clock stays manifest.today.
    const history = A.derived.history;
    if (!history) die("room: alpha carries issue dates, so history must derive");
    const firstPoint = history.points[0],
      lastPoint = history.points[history.points.length - 1];
    if (lastPoint.at !== "2026-08-10")
      die(
        "room: the history series must end on manifest.today, got " +
          lastPoint.at,
      );
    if (lastPoint.open !== 2 || lastPoint.closed !== 1)
      die(
        "room: today reads 2 open / 1 closed, got " + JSON.stringify(lastPoint),
      );
    if (firstPoint.at.slice(0, 7) !== "2026-04")
      die(
        "room: the series must start at the first issue, not a fixed window back, got " +
          firstPoint.at,
      );
    const june = history.points.filter(function (p) {
      return p.at.slice(0, 7) === "2026-06";
    })[0];
    if (!june || june.open !== 3 || june.closed !== 0)
      die(
        "room: on 2026-06-30 all three issues were open and none closed, got " +
          JSON.stringify(june),
      );
    if (B.derived.history === null)
      die("room: beta also carries dates, so it too must derive history");
    // A snapshot written before the fields existed must say so rather than draw a flat line.
    const dateless = join(R, "dateless.json");
    const stripped = readJson(join(alpha, "issues.json"));
    for (const it of stripped.issues) {
      delete it.createdAt;
      delete it.closedAt;
    }
    writeFileSync(dateless, JSON.stringify(stripped));
    const mfDateless = join(R, "manifest-dateless.json");
    const md = readJson(manifest);
    md.programs[0].issues = "dateless.json";
    writeFileSync(mfDateless, JSON.stringify(md, null, 2));
    r = run([
      "room",
      "--manifest",
      mfDateless,
      "--out",
      join(R, "dateless.html"),
    ]);
    if (r.status !== 0)
      die("room: a snapshot without issue dates must still compose", r);
    if (roomOf(join(R, "dateless.html")).programs[0].derived.history !== null)
      die(
        "room: a snapshot with no dates must derive null history, not an empty or flat series",
      );

    // The checkpoint stepper, given a completion it can be held to. `normalize` patches `core`, and
    // issue #1 landed on core, so it reads 0 of 1 closed. `one-logger` patches `util`, which no
    // surviving link reaches, so it reads null — never 0%, which would look like measured failure.
    const cps = A.derived.checkpoints;
    if (!cps || cps.length !== 2)
      die(
        "room: alpha declares two checkpoints, got " +
          JSON.stringify(cps && cps.length),
      );
    const normalize = cps[0];
    if (normalize.nodes.join() !== "core")
      die(
        "room: the normalize checkpoint patches core, got " +
          JSON.stringify(normalize.nodes),
      );
    if (normalize.total !== 1 || normalize.closed !== 0 || normalize.pct !== 0)
      die(
        "room: normalize should read 0 of 1 closed, got " +
          JSON.stringify(normalize),
      );
    if (cps[1].total !== 0 || cps[1].pct !== null)
      die(
        "room: a checkpoint no issue reaches reports null, not 0% — got " +
          JSON.stringify(cps[1]),
      );

    // Documents: the canon in full, in declared order, within the budget.
    if (!A.docs) die("room: alpha declares docs.include and carried none");
    if (
      A.docs.embedded
        .map(function (d) {
          return d.path;
        })
        .join() !== "docs/PRD.md,docs/DESIGN.md"
    )
      die(
        "room: the canon must be carried in declared order, got " +
          JSON.stringify(
            A.docs.embedded.map(function (d) {
              return d.path;
            }),
          ),
      );
    if (!/R-1/.test(A.docs.embedded[0].text))
      die("room: a canon document was carried without its text");
    if (A.docs.bytes > A.docs.maxBytes)
      die("room: the carried corpus exceeded its own budget");
    if (B.docs !== null)
      die(
        "room: beta declares no docs, so it carries null rather than an empty corpus",
      );
    // The budget refuses, it never truncates: a document that does not fit is listed with its reason.
    const mfTiny = join(R, "manifest-tiny.json");
    const tiny = readJson(manifest);
    tiny.docs = { maxBytes: 1 };
    writeFileSync(mfTiny, JSON.stringify(tiny, null, 2));
    r = run(["room", "--manifest", mfTiny, "--out", join(R, "tiny.html")]);
    if (r.status !== 0)
      die("room: a byte budget nothing fits inside must still compose", r);
    const tinyDocs = roomOf(join(R, "tiny.html")).programs[0].docs;
    if (tinyDocs.embedded.length)
      die("room: a document was embedded past the byte budget");
    if (
      !tinyDocs.listed.some(function (d) {
        return /budget/.test(d.why);
      })
    )
      die(
        "room: a document dropped for size must be listed with that as its reason, got " +
          JSON.stringify(tinyDocs.listed),
      );

    // A programme turned off is excluded and NAMED. Absent and deliberately excluded differ (I7).
    if (
      ROOM.programs.some(function (p) {
        return p.id === "gamma";
      })
    )
      die("room: a programme with enabled:false was composed anyway");
    if (
      !(ROOM.meta.excluded || []).some(function (p) {
        return p.id === "gamma";
      })
    )
      die(
        "room: a programme was excluded without being named in the Options view",
      );

    // The shell: every route is a real element, the pre-tab anchors still resolve, and printing
    // un-hides all of them — an artifact that replaces a deck has to come out of a printer whole.
    const shell = readFileSync(roomHtml, "utf-8");
    for (const filled of [
      "window.__ROOM__ = {",
      "window.__STRINGS__ = {",
      'id="holo-src"',
    ]) {
      if (shell.indexOf(filled) < 0)
        die(
          "room: the generated file is missing " +
            filled +
            " — a template seam went unfilled",
        );
    }
    if (shell.indexOf("__STRINGS__*/null") >= 0)
      die(
        "room: the strings seam was left unfilled, so the page would render with no words at all",
      );
    if (
      !/@media print[\s\S]*\.view\[hidden\]\{display:block!important\}/.test(
        shell,
      )
    )
      die(
        "room: printing does not un-hide the inactive views, so a printed briefing is one page of seven",
      );
    for (const legacy of ["verdict", "now", "moving", "mismatch"]) {
      if (shell.indexOf('"' + legacy + '"') < 0)
        die(
          "room: the pre-tab anchor #" +
            legacy +
            " is no longer a section id, so an existing link breaks",
        );
    }

    // One programme has no portfolio to roll up: the front door is that programme's first published
    // lens, the aggregate view is not mounted, and the pre-tab anchors land on the same door. Two
    // programmes keep the briefing as front door (ADR-0007). The routing is lifted out of the shipped
    // template and driven directly, the same trick this suite uses for the viewer's other functions.
    {
      const grab = (re, what) => {
        const m = re.exec(shell)
        if (!m) die('room: ' + what + ' not found in the shell — the routing moved')
        return m[0]
      }
      const keyFn = grab(/function key\(p,t\)\{[^\n]*\n/, 'key()')
      const lensesOfFn = grab(/function lensesOf\(program\)\{[\s\S]*?\n\}/, 'lensesOf()')
      const homeOfFn = grab(/function homeOf\(program\)\{[^\n]*\n/, 'homeOf()')
      const homeFn = grab(/function home\(\)\{[^\n]*\n/, 'home()')
      const normFn = grab(/function normalize\(h\)\{[\s\S]*?\n\}/, 'normalize()')
      const legacy = grab(/var LEGACY=\{[^\n]*\n/, 'the legacy hash table')
      const legacyTab = grab(/var LEGACY_TAB=\{[^\n]*\n/, 'the legacy tab table')
      const regFn = grab(/function registerAll\(\)\{[\s\S]*?\n\}/, 'registerAll()')
      const navFn = grab(/function buildNav\(\)\{[\s\S]*?\n\}/, 'buildNav()')
      if (!/if\(ROOM\.programs\.length!==1\)\{mount\("\/"\)/.test(regFn)) die('room: the portfolio view is mounted for a single programme, so print and routing meet an empty aggregate')
      const route = new Function('ROOM', 'VIEWS', 'LENS_SPEC', `${legacy}${legacyTab}
        function byId(id){var i;for(i=0;i<ROOM.programs.length;i++)if(ROOM.programs[i].id===id)return ROOM.programs[i];return null;}
        ${keyFn}${lensesOfFn}${homeOfFn}${homeFn}${normFn} return normalize`)
      const spec = ['verdict', 'plan', 'architecture', 'traceability', 'operations', 'provenance'].map((id) => ({ id }))
      const lenses = { verdict: true, plan: true, architecture: false, traceability: false, operations: false, provenance: false }
      const one = { programs: [{ id: 'alpha', derived: { lenses } }] }
      const two = { programs: [{ id: 'alpha', derived: { lenses } }, { id: 'beta', derived: { lenses } }] }
      const oneViews = { '/alpha/verdict': 1, '/alpha/plan': 1, '/options': 1 }
      const twoViews = { '/': 1, '/alpha/verdict': 1, '/beta/verdict': 1, '/options': 1 }
      const n1 = route(one, oneViews, spec), n2 = route(two, twoViews, spec)
      for (const h of ['', '#', '#/', '#now', '#/nope', '#/alpha/auto', '#/alpha/wbs', '#/alpha/exec']) {
        const want = h === '#/alpha/auto' ? '/alpha/plan' : '/alpha/verdict'
        if (n1(h) !== want) die('room: with one programme ' + JSON.stringify(h) + ' must open ' + want + ', got ' + n1(h))
      }
      if (n1('#/options') !== '/options') die('room: with one programme the Options view must stay reachable')
      for (const h of ['', '#/', '#now', '#/nope']) if (n2(h) !== '/') die('room: with two programmes ' + JSON.stringify(h) + ' must open the briefing, got ' + n2(h))
      if (n2('#/beta/verdict') !== '/beta/verdict') die('room: with two programmes a programme route must resolve as itself')

      // Exercise the navigation builder: a programme link must target the first lens that is
      // actually published. The old `/exec` link rendered only because normalize() repaired it
      // after navigation, leaving the address and aria-current state wrong.
      const node = () => ({ children: [], appendChild(child) { this.children.push(child); }, addEventListener() {}, setAttribute(name, value) { this[name] = value; } })
      const documentStub = { getElementById(id) { return this[id] || (this[id] = node()) } }
      const navLink = (href, text) => ({ href: '#' + href, textContent: text, setAttribute(name, value) { this[name] = value; } })
      const fakeEl = (tag, className, text) => Object.assign(node(), { tagName: tag.toUpperCase(), className, textContent: text || '' })
      const build = new Function('ROOM', 'VIEWS', 'LENS_SPEC', 'STR', 'key', 'lensesOf', 'homeOf', 'lensLabel', 'navLink', 'el', 'document', `${navFn}; return buildNav`)
      const buildNav = build(one, { '/alpha/verdict': 1, '/options': 1 }, spec, { routePortfolio: 'Portfolio', routeOptions: 'Options' },
        (p, t) => '/' + p + '/' + t, (program) => Object.keys(program.derived.lenses).filter((id) => program.derived.lenses[id]),
        (program) => '/alpha/verdict', (id) => id, navLink, fakeEl, documentStub)
      buildNav()
      const programmeLink = documentStub['nav-programs'].children.find((link) => link.textContent === 'alpha')
      if (!programmeLink || programmeLink.href !== '#/alpha/verdict') die('room: programme navigation linked to ' + (programmeLink && programmeLink.href) + ', expected #/alpha/verdict')
    }

    // A skin is one token block chosen in the manifest: every id the viewer knows has a palette block
    // the palette audit measures and a value the schema accepts — a skin that is not measured, or one
    // the manifest cannot name, is a look nobody gated.
    {
      const skinIds = [...(/var SKINS=\{([^}]*)\}/.exec(shell) || ['', ''])[1].matchAll(/([a-z-]+):"(light|dark)"/g)].map((m) => m[1])
      if (!skinIds.length) die('room: SKINS not found in the shell — the skin contract moved')
      const paletteSrc = readFileSync(join(HERE, '..', 'scripts/palette.mjs'), 'utf-8')
      const roomSchemaJson = readJson(roomSchema)
      const schemaSkins = roomSchemaJson.properties.skin && roomSchemaJson.properties.skin.enum
      for (const id of skinIds) {
        if (shell.indexOf('html[data-skin="' + id + '"]{') < 0) die('room: skin ' + id + ' has no token block in the shell')
        if (paletteSrc.indexOf("selector: 'html[data-skin=\"" + id + "\"]{'") < 0) die('room: skin ' + id + ' is not registered in scripts/palette.mjs, so its palette is not measured')
        if (!schemaSkins || !schemaSkins.includes(id)) die('room: skin ' + id + ' is not a value forma.room.schema.json accepts')
      }
      if (!/html\[data-skin\] #theme-toggle\{display:none\}/.test(shell)) die('room: the theme toggle stays visible under a skin that fixes its own scheme')
      const skinned = readJson(manifest); skinned.skin = skinIds[0]
      const skinnedPath = join(R, 'manifest.skin.json'); writeFileSync(skinnedPath, JSON.stringify(skinned))
      const skinnedOut = join(R, 'room.skin.html')
      r = run(['room', '--manifest', skinnedPath, '--out', skinnedOut]); if (r.status !== 0) die('room: skinned render exit ' + r.status, r)
      const skinnedRoom = JSON.parse(/window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(readFileSync(skinnedOut, 'utf-8'))[1])
      if (skinnedRoom.meta.skin !== skinIds[0]) die('room: manifest.skin did not reach ROOM.meta.skin')
      if (ROOM.meta.skin !== null) die('room: a manifest without a skin must compose with meta.skin null, got ' + JSON.stringify(ROOM.meta.skin))
    }

    // "Why this batch" comes from the brief, not from a curated blocks file: a note anchored to the
    // block's milestone or to one of its issues rides on that block; anything else does not. It is
    // attached in deriveBlocks so the viewer's plan lens never reads derived.brief (I20).
    {
      const narrSnap = { ghRepo: 'acme/alpha', issues: [
        { n: 7, state: 'OPEN', title: 'seven', ms: 'M1', labels: [] },
        { n: 8, state: 'OPEN', title: 'eight', ms: 'M1', labels: [] },
      ] }
      const narrQueue = { clusters: [{ key: 'feat', issues: [7, 8] }] }
      const narrBrief = { notes: [
        { id: 'ms', kind: 'note', text: 'milestone note', about: { milestone: 'M1' } },
        { id: 'iss', kind: 'note', text: 'issue note', about: { issue: 7 } },
        { id: 'other', kind: 'note', text: 'elsewhere', about: { milestone: 'M2' } },
        { id: 'path', kind: 'note', text: 'a path', about: { path: 'README.md' } },
      ] }
      const [narrBlock] = deriveBlocks(narrSnap, narrQueue, { edges: [] }, {}, narrBrief)
      const got = narrBlock.notes.map((c) => c.id)
      if (JSON.stringify(got) !== JSON.stringify(['ms', 'iss'])) die('room: block narrative picked ' + JSON.stringify(got) + ', wanted the milestone note and the issue note only')
      if (deriveBlocks(narrSnap, narrQueue, { edges: [] }, {}, null)[0].notes.length !== 0) die('room: a programme without a brief must yield no block narrative')
      if (!/STR\.blockWhy/.test(shell)) die('room: the block narrative heading string is not read by the template')
    }

    // A room over programmes that have no architecture map is gated from a directory with no model:
    // `--room` makes the C4 half not applicable — said out loud — and the room half still runs in full
    // (the tamper tests below prove it bites). Without `--room`, a missing model is still the failure.
    const noModelDir = join(R, 'no-model'); mkdirSync(noModelDir, { recursive: true })
    r = run(['check', '--repo', noModelDir, '--room', roomHtml, '--manifest', manifest])
    if (r.status !== 0 || !/no model at .*C4 assertions not applicable/.test(r.stdout || '')) die('room: check --room from a model-less directory must gate the room only and say so\n' + (r.stdout || '') + (r.stderr || ''))
    const tamperedNoModel = join(R, 'tampered-nomodel.html'); tamper(roomHtml, tamperedNoModel, '"openCount":2', '"openCount":7')
    r = run(['check', '--repo', noModelDir, '--room', tamperedNoModel, '--manifest', manifest])
    if (r.status === 0) die('room: check --room without a model accepted a hand-altered aggregate')
    r = run(['check', '--repo', noModelDir])
    if (r.status === 0 || !/model missing \(no SKIP\)/.test(r.stderr || '')) die('room: check without --room must still fail on a missing model')

    console.log('  ok room — the briefing composes deterministically, both gates fire, and both refuse a hand-altered aggregate')
    console.log('  ok rtm — requirements trace to issues, and check names each of the four holes at its source line')
    console.log('  ok views — history from one snapshot, checkpoints with measured completion, a canon within budget, and a programme deliberately left out')
    console.log(
      "  ok room — the briefing composes deterministically, both gates fire, and both refuse a hand-altered aggregate",
    );
    console.log(
      "  ok rtm — requirements trace to issues, and check names each of the four holes at its source line",
    );
    console.log(
      "  ok views — history from one snapshot, checkpoints with measured completion, a canon within budget, and a programme deliberately left out",
    );
  });

  // §one-cpm-cache — repofiles.mjs' trackedFiles() cache must not survive across composes (#133 S4
  // follow-up, Codex round 1 HIGH). `room --serve` recomposes on every GET in one long-lived process
  // (`compose(true)` in room.mjs); a process-lifetime cache made a file `git add`ed after the server
  // started invisible until restart, which is exactly the staleness `git ls-files` was memoised to
  // avoid causing three times over, now caused once but forever. Reuses the `room` fixture's `alpha`
  // checkout, already committed by the block above — this block only adds one more commit to it.
  test("room: one-cpm-cache", async () => {
    const R = join(tmp, "room"),
      alpha = join(R, "alpha"),
      manifest = join(R, "manifest.json");
    const child = spawn(
      process.execPath,
      [join(HERE, "..", "lib", "room.mjs"), "--manifest", manifest, "--port", "0", "--serve"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(
        () => reject(new Error("one-cpm-cache: room --serve did not report a port in time: " + out)),
        5000,
      );
      const onData = (chunk) => {
        out += chunk.toString();
        const m = /serving http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) { clearTimeout(timer); child.stdout.off("data", onData); resolvePort(Number(m[1])); }
      };
      child.stdout.on("data", onData);
      child.on("error", reject);
    });
    try {
      // Added AFTER the server's first compose() at startup — a real mid-session edit, the same shape
      // as a document landing between two Options-view reloads.
      writeFileSync(
        join(alpha, "docs/LIVE-ADD.md"),
        "# Live-added\n\nCommitted after the server started (#133 S4 follow-up).\n",
      );
      const git = (args) => spawnSync("git", ["-C", alpha, ...args], { encoding: "utf-8" });
      git(["add", "docs/LIVE-ADD.md"]);
      const committed = git(["commit", "-q", "-m", "docs: live-add after serve start"]);
      if (committed.status !== 0)
        die("one-cpm-cache: could not commit the live-added doc", committed);
      const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
      if (!/LIVE-ADD\.md/.test(html))
        die(
          "one-cpm-cache: a doc git-added after the server started must appear on the very next compose, not require a restart",
        );
    } finally {
      child.kill();
    }
    console.log(
      "  ok one-cpm-cache — trackedFiles is reset at each compose(), not stuck for the life of the server",
    );
  });

  // `forma scan` and `forma room --serve`: the two halves of "autodetect, with checkboxes". The
  // second exists because static HTML cannot write a file, and the first exists so the answer to
  // "which programmes are there" is not typed by hand. Both are graded on the same thing: a decision
  // a human made must survive the tool running again.
  test("room: scan+serve", async () => {
    const root = join(tmp, "scan-root"),
      mf = join(root, "forma.room.json");
    const git = (repo, args) => {
      const r = spawnSync("git", ["-C", repo, ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00",
        },
      });
      if (r.status !== 0)
        die(
          "scan fixture: git " +
            args.join(" ") +
            "\n" +
            (r.stdout || "") +
            (r.stderr || ""),
        );
    };
    for (const name of ["one", "two"]) {
      const dir = join(root, name);
      mkdirSync(join(dir, "docs/architecture"), { recursive: true });
      writeFileSync(join(dir, "docs/architecture/c4-issues.json"), "{}");
      git(dir, ["init", "-q", "."]);
      git(dir, ["remote", "add", "origin", `git@github.com:acme/${name}.git`]);
      git(dir, ["config", "user.email", "test@example.invalid"]);
      git(dir, ["config", "user.name", "Forma Test"]);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "init"]);
    }
    writeFileSync(join(root, "one/docs/architecture/c4-model.json"), "{}");
    writeFileSync(join(root, "one/docs/architecture/c4-topology.json"), "{}");
    mkdirSync(join(root, "one/docs/PRODUCT"), { recursive: true });
    writeFileSync(
      join(root, "one/docs/PRODUCT/REQUIREMENTS_MATRIX.md"),
      readFileSync(FIX("truth-room/REQUIREMENTS_MATRIX.md"), "utf-8"),
    );
    git(join(root, "one"), ["add", "docs/PRODUCT/REQUIREMENTS_MATRIX.md"]);
    git(join(root, "one"), ["commit", "-qm", "docs: add requirements"]);
    // R5-1: R4 made the model optional, so a GitHub checkout with neither generated input must still
    // be onboarded. A local checkout with no resolvable ghRepo cannot produce the required snapshot.
    const mapless = join(root, "three");
    mkdirSync(mapless, { recursive: true });
    git(mapless, ["init", "-q", "."]);
    git(mapless, ["remote", "add", "origin", "git@github.com:acme/three.git"]);
    // A directory that is not a checkout and a checkout with no origin are both skipped.
    mkdirSync(join(root, "not-a-checkout"), { recursive: true });
    const stranger = join(root, "stranger");
    mkdirSync(stranger, { recursive: true });
    git(stranger, ["init", "-q", "."]);
    const worktree = join(root, "one.worktrees", "topic");
    mkdirSync(worktree, { recursive: true });
    git(worktree, ["init", "-q", "."]);
    git(worktree, ["remote", "add", "origin", "git@github.com:acme/one.git"]);

    let r = run(["scan", "--root", root, "--manifest", mf]);
    if (r.status !== 0) die("scan: exit " + r.status, r);
    let found = readJson(mf);
    if (
      found.programs
        .map(function (p) {
          return p.id;
        })
        .join() !== "one,three,two"
    )
      die(
        "scan: expected the map-less GitHub checkout too — got " +
          JSON.stringify(
            found.programs.map(function (p) {
              return p.id;
            }),
          ),
      );
    if (found.programs[0].ghRepo !== "acme/one")
      die(
        "scan: ghRepo was not read from the git remote, got " +
          found.programs[0].ghRepo,
      );
    if (
      !found.programs[0].model ||
      found.programs[1].model ||
      found.programs[2].model
    )
      die(
        "scan: model/topology must be named only for the checkout that has both",
      );
    if (found.today !== null)
      die(
        "scan: today is the determinism anchor and must never be invented, got " +
          JSON.stringify(found.today),
      );

    // The rule that matters on the second run.
    found.today = "2026-08-10";
    found.programs[0].enabled = false;
    found.programs[0].taxonomy = { minPopulation: 1 };
    writeFileSync(mf, JSON.stringify(found, null, 2));
    r = run(["scan", "--root", root, "--manifest", mf]);
    if (r.status !== 0) die("scan: second run exit " + r.status, r);
    const again = readJson(mf);
    if (again.programs[0].enabled !== false)
      die(
        "scan: re-running silently switched a programme back on — the decision to exclude it was lost",
      );
    if (!again.programs[0].taxonomy)
      die("scan: re-running discarded a hand-curated field");
    if (again.today !== "2026-08-10")
      die("scan: re-running overwrote the determinism anchor");

    // R4-2: room init is the supported seed/merge surface over the lower-level scanner. Seed one
    // repo, preserve decisions on a second pass, and never erase a known ghRepo just because origin
    // is temporarily unavailable.
    const initManifest = join(root, "init-room.json");
    r = run([
      "room",
      "init",
      "--repo",
      join(root, "one"),
      "--manifest",
      initManifest,
      "--today",
      "2026-08-17",
    ]);
    if (r.status !== 0) die("room init: seed exit " + r.status, r);
    let initialized = readJson(initManifest);
    if (
      initialized.today !== "2026-08-17" ||
      initialized.programs.length !== 1 ||
      initialized.programs[0].ghRepo !== "acme/one"
    )
      die(
        "room init: seed did not derive today/repo: " +
          JSON.stringify(initialized),
      );
    if (
      !initialized.programs[0].docs ||
      initialized.programs[0].docs.include.join() !== "docs/**/*.md"
    )
      die(
        "room init: tracked docs corpus was not discovered safely: " +
          JSON.stringify(initialized.programs[0].docs),
      );
    if (
      !initialized.programs[0].rtm ||
      initialized.programs[0].rtm.docs.length !== 1 ||
      initialized.programs[0].rtm.docs[0].path !==
        "docs/PRODUCT/REQUIREMENTS_MATRIX.md"
    )
      die(
        "room init: parser-confirmed requirements matrix was not discovered: " +
          JSON.stringify(initialized.programs[0].rtm),
      );
    const observedRtm = deriveRtm({
      repo: join(root, "one"),
      rtm: initialized.programs[0].rtm,
      issuesSnapshot: {
        issues: [{ n: 99, title: "Observed but not claimed", state: "OPEN" }],
      },
    });
    if (observedRtm.scopeComplete || observedRtm.orphans.orphanIssues.length)
      die(
        "room init: auto-discovered RTM silently claimed to be the complete WBS: " +
          JSON.stringify(observedRtm),
      );
    const strictRtm = deriveRtm({
      repo: join(root, "one"),
      rtm: {
        ...initialized.programs[0].rtm,
        requireIssuesFrom: ["docs/PRODUCT/REQUIREMENTS_MATRIX.md"],
      },
      issuesSnapshot: {
        issues: [{ n: 99, title: "Strictly orphaned", state: "OPEN" }],
      },
    });
    if (!strictRtm.scopeComplete || strictRtm.orphans.orphanIssues.length !== 1)
      die(
        "rtm: explicit WBS completeness stopped gating uncited open issues: " +
          JSON.stringify(strictRtm),
      );
    initialized.programs[0].enabled = false;
    initialized.programs[0].taxonomy = { minPopulation: 1 };
    writeFileSync(initManifest, JSON.stringify(initialized, null, 2) + "\n");
    git(join(root, "one"), ["remote", "remove", "origin"]);
    r = run([
      "room",
      "init",
      "--repo",
      join(root, "one"),
      "--manifest",
      initManifest,
    ]);
    if (r.status !== 0) die("room init: merge exit " + r.status, r);
    initialized = readJson(initManifest);
    if (
      initialized.programs[0].enabled !== false ||
      !initialized.programs[0].taxonomy
    )
      die("room init: merge clobbered a decision");
    if (initialized.programs[0].ghRepo !== "acme/one")
      die("room init: transient missing origin erased the known ghRepo");
    if (!initialized.programs[0].docs || !initialized.programs[0].rtm)
      die("room init: rediscovery erased safe docs/RTM inputs");

    const scannedManifest = join(root, "init-scan-room.json");
    r = run([
      "room",
      "init",
      "--scan",
      "--root",
      root,
      "--manifest",
      scannedManifest,
      "--today",
      "2026-08-17",
    ]);
    if (r.status !== 0) die("room init --scan: exit " + r.status, r);
    const initializedScan = readJson(scannedManifest);
    if (
      initializedScan.today !== "2026-08-17" ||
      initializedScan.programs.map((p) => p.id).join() !== "three,two"
    )
      die(
        "room init --scan: did not stamp today over the valid discovered set: " +
          JSON.stringify(initializedScan),
      );
    r = run([
      "room",
      "init",
      "--repo",
      join(root, "one"),
      "--manifest",
      join(root, "bad-today.json"),
      "--today",
      "17-08-2026",
    ]);
    if (r.status === 0 || existsSync(join(root, "bad-today.json")))
      die("room init: invalid today wrote a manifest");

    // Serve mode binds loopback and nothing else. --port 0 asks the OS for a free one, so the test
    // cannot collide with whatever is already running on this machine.
    const served = spawnSync(
      process.execPath,
      [
        join(HERE, "..", "lib", "room.mjs"),
        "--manifest",
        join(tmp, "room", "manifest.json"),
        "--out",
        join(tmp, "served.html"),
        "--port",
        "0",
        "--serve",
      ],
      { encoding: "utf-8", timeout: 3000 },
    );
    const spoke = (served.stdout || "") + (served.stderr || "");
    if (!/serving http:\/\/127\.0\.0\.1:\d+/.test(spoke))
      die("room --serve did not bind loopback: " + spoke);
    if (/0\.0\.0\.0|::/.test(spoke))
      die("room --serve bound something wider than loopback: " + spoke);
    console.log(
      "  ok scan+serve — discovery merges instead of replacing, an excluded programme stays excluded, and serve binds loopback only",
    );
  });

  // The dogfood. A traceability convention that cannot read the document THIS repository writes is a
  // convention for other people's repositories. docs/PRD.md §6 is a real table, edited by hand for
  // prose reasons, and the parser has to find it without being told anything but the id pattern.
  // The full chain (issues, and therefore the four gate assertions) additionally needs a committed
  // `gh` snapshot; that is a disclosure decision docs/SCOPE-room.md §6 leaves open, so what is
  // asserted here is what can be asserted offline: the rows parse, and they parse as themselves.
  test("room: rtm-dogfood", async () => {
    const { parseRequirements, trackedFiles } = await import(
      join(HERE, "..", "lib", "rtm.mjs")
    );
    const repo = join(HERE, "..");
    const tracked = trackedFiles(repo);
    if (!tracked)
      die(
        "rtm-dogfood: forma is not a readable git checkout, so the tracked-files rule cannot be exercised",
      );
    if (!tracked.has("docs/PRD.md"))
      die("rtm-dogfood: docs/PRD.md is not tracked by git");
    const { rows, skipped } = parseRequirements(
      repo,
      [{ path: "docs/PRD.md", idPattern: "^R-\\d+$", role: "requirement" }],
      tracked,
    );
    if (skipped.length)
      die(
        "rtm-dogfood: forma's own PRD contributed nothing — " +
          JSON.stringify(skipped),
      );
    if (rows.length < 9)
      die(
        `rtm-dogfood: expected at least 9 R-* rows in docs/PRD.md, got ${rows.length}`,
      );
    const ids = rows.map((row) => row.id);
    if (new Set(ids).size !== ids.length)
      die(
        "rtm-dogfood: forma's own PRD declares a duplicate id: " + ids.join(", "),
      );
    for (const row of rows) {
      if (!row.text) die(`rtm-dogfood: ${row.id} parsed with no text`);
      if (!row.verified.length)
        die(
          `rtm-dogfood: ${row.id} has no "verified by" entry — the column exists precisely so this cannot happen`,
        );
      if (!(row.line > 0))
        die(
          `rtm-dogfood: ${row.id} carries no source line, so nothing could link back to the row`,
        );
    }
    // Determinism across the compose→check gap rests on the file list being sorted and git-tracked.
    // Parsing twice must give the identical answer, or `check` false-reds on an untouched tree.
    const again = parseRequirements(
      repo,
      [{ path: "docs/PRD.md", idPattern: "^R-\\d+$", role: "requirement" }],
      tracked,
    );
    if (JSON.stringify(again.rows) !== JSON.stringify(rows))
      die(
        "rtm-dogfood: two parses of the same document disagree — check would false-red on an untouched tree",
      );
    console.log(
      `  ok rtm-dogfood — forma's own PRD parses as ${rows.length} traceable requirements, every one carrying its verification and its line`,
    );
  });

  // F2 (2026-09-14 visual verification, #142) — the plan lens headline ("N decisions are waiting on
  // you") and the portfolio front door ("N things need you") both count issues matching the DECLARED
  // blocking rule (label OR an open blocker on a dependency edge, derivePortfolio's `blockedIssues`).
  // The Kanban "Waiting on a human" bucket sits on a different, narrower axis (a declared needs-human
  // LABEL only — deriveKanban never sees dependency edges) and is an intentionally separate
  // epistemic question. Reusing the same wording for both made "1 decisions are waiting on you" read
  // as contradicted by "Waiting on a human 0" on the same screen (viafera/forma: both declare
  // `blockedBy: {labels: []}`, blocking is dependency-only, invisible to the label-only bucket).
  test("room: f2-counts", async () => {
    const mk = (id, blockedLabels, issues) => {
      const issuesSnapshot = {
        issues,
        milestones: [],
        fetchedAt: "2026-01-01",
        collection: {},
        dependencies: { supported: true, complete: true, edges: [] },
      };
      const deriveContext = {};
      const derived = deriveAll(
        {
          repo: tmp,
          model: null,
          topo: null,
          issuesSnapshot,
          health: { verdicts: [], dependencyConfirmations: [] },
          findings: { findings: [] },
          brief: null,
          briefPath: null,
          manifest: { today: "2026-01-01", blockedBy: { labels: blockedLabels } },
          gateInputs: null,
          arbiterMilestones: null,
          docs: null,
        },
        deriveContext,
      );
      return {
        id,
        ghRepo: "acme/" + id,
        repo: tmp,
        model: null,
        topo: null,
        issuesSnapshot,
        derived,
        deriveContext,
        blockedBy: { labels: blockedLabels },
      };
    };
    const issue = (n, labels) => ({
      n,
      title: "t" + n,
      state: "OPEN",
      labels,
      ms: null,
      createdAt: "2026-01-01",
      closedAt: null,
    });
    // one blocked issue (singular case) ...
    const one = mk("one", ["blocked"], [issue(1, ["blocked"]), issue(2, [])]);
    // ... and two blocked issues (plural case), exercising both grammatical forms.
    const two = mk(
      "two",
      ["blocked"],
      [issue(3, ["blocked"]), issue(4, ["blocked"]), issue(5, [])],
    );
    // A programme blocked ONLY by a dependency edge, never a label — viafera/forma's real shape. #6
    // carries no needs-human label, so it must still count as blocked (union rule) while staying OUT
    // of the Kanban's label-only bucket.
    const depIssuesSnapshot = {
      issues: [issue(6, []), issue(7, [])],
      milestones: [],
      fetchedAt: "2026-01-01",
      collection: {},
      ghRepo: "acme/dep",
      dependencies: {
        supported: true,
        complete: true,
        edges: [
          {
            source: "native",
            from: { repo: "acme/dep", number: 6 },
            to: { repo: "acme/dep", number: 7, state: "OPEN" },
          },
        ],
      },
    };
    const depDeriveContext = {};
    const depDerived = deriveAll(
      {
        repo: tmp,
        model: null,
        topo: null,
        issuesSnapshot: depIssuesSnapshot,
        health: { verdicts: [], dependencyConfirmations: [] },
        findings: { findings: [] },
        brief: null,
        briefPath: null,
        manifest: { today: "2026-01-01", blockedBy: { labels: [] } },
        gateInputs: null,
        arbiterMilestones: null,
        docs: null,
      },
      depDeriveContext,
    );
    const dep = {
      id: "dep",
      ghRepo: "acme/dep",
      repo: tmp,
      model: null,
      topo: null,
      issuesSnapshot: depIssuesSnapshot,
      derived: depDerived,
      deriveContext: depDeriveContext,
      blockedBy: { labels: [] },
    };
    const portfolio = derivePortfolio({
      today: "2026-01-01",
      programs: [one, two, dep],
    });
    const summaryOf = (id) => portfolio.programs.find((p) => p.id === id);
    const perProgramCount = (id) =>
      portfolio.blocked.filter((b) => b.program === id).length;

    // The "one count" invariant: the plan headline (built from `portfolio.blocked` filtered by
    // programme) must equal the programme's own derived `blocked` figure, and the portfolio total
    // must equal the sum across programmes — the same measurement read at two scopes, never two.
    if (summaryOf("one").blocked !== 1 || perProgramCount("one") !== 1)
      die(
        "f2-counts: programme 'one' must show exactly 1 blocked issue at both the summary and the per-item list, got " +
          JSON.stringify([summaryOf("one").blocked, perProgramCount("one")]),
      );
    if (summaryOf("two").blocked !== 2 || perProgramCount("two") !== 2)
      die(
        "f2-counts: programme 'two' must show exactly 2 blocked issues at both the summary and the per-item list, got " +
          JSON.stringify([summaryOf("two").blocked, perProgramCount("two")]),
      );
    if (
      portfolio.totals.blocked !==
      summaryOf("one").blocked + summaryOf("two").blocked + summaryOf("dep").blocked
    )
      die(
        "f2-counts: the portfolio total must be the sum of the per-programme blocked counts it declares, got " +
          portfolio.totals.blocked,
      );

    // At both scopes, the dependency-only programme's union count (headline, KPI) must read 1, while
    // the label-only Kanban bucket — a different, narrower rule — must read 0. Both are correct; the
    // bug was letting them share wording that implied they were the same number.
    if (summaryOf("dep").blocked !== 1 || perProgramCount("dep") !== 1)
      die(
        "f2-counts: programme 'dep' is blocked only via a dependency edge and must still count as 1 blocked issue (portfolio and per-programme), got " +
          JSON.stringify([summaryOf("dep").blocked, perProgramCount("dep")]),
      );
    if ((dep.derived.kanban["aspettano-umano"] || []).length !== 0)
      die(
        "f2-counts: a dependency-only block must not land in the label-only Kanban bucket, got " +
          JSON.stringify(dep.derived.kanban["aspettano-umano"]),
      );
    if (dep.derived.kanbanHumanDeclared !== true)
      die(
        "f2-counts: the label-only bucket's zero must be measured (declared), not unknown, in this fixture",
      );

    // The plural fix: "N decisions are waiting on you" had no singular. `techHeadline`/`techHeadlineOne`
    // must differ only in the singular/plural of "issue(s)", both must name the blocking rule (never a
    // bare, unexplained count), and the template must actually select between them by count.
    const en = readJson(join(HERE, "..", "lib/viewer/strings/en.json"));
    const it = readJson(join(HERE, "..", "lib/viewer/strings/it.json"));
    const fmtLocal = (s, d) =>
      String(s).replace(/\{([^}]+)\}/g, (_, k) => (d[k] == null ? "" : String(d[k])));
    const pluralLocal = (n, one_, other_) => (n === 1 ? one_ : other_);
    for (const [locale, strings, singleWord, pluralWord] of [
      ["en", en, "issue matches", "issues match"],
      ["it", it, "issue corrisponde", "issue corrispondono"],
    ]) {
      const headlineOne = fmtLocal(
        pluralLocal(1, strings.techHeadlineOne, strings.techHeadline),
        { n: 1 },
      );
      const headlineTwo = fmtLocal(
        pluralLocal(2, strings.techHeadlineOne, strings.techHeadline),
        { n: 2 },
      );
      if (!headlineOne.startsWith("1 " + singleWord))
        die(
          `f2-counts (${locale}): techHeadlineOne must read "1 ${singleWord}...", got "${headlineOne}"`,
        );
      if (!headlineTwo.startsWith("2 " + pluralWord))
        die(
          `f2-counts (${locale}): techHeadline must read "2 ${pluralWord}...", got "${headlineTwo}"`,
        );
      if (
        !/blocking rule|regola di blocco/.test(strings.techHeadline) ||
        !/blocking rule|regola di blocco/.test(strings.techHeadlineOne)
      )
        die(`f2-counts (${locale}): the plan headline must name the blocking rule it counts`);
      // Same defect, portfolio scope: "{blocked} things need you" never agreed with blocked===1.
      const thesisOne = fmtLocal(strings.thesisOne, {
        blocked: 1,
        blockedWord: pluralLocal(1, strings.thesisBlockedWordOne, strings.thesisBlockedWord),
        open: 3,
        programs: 1,
      });
      const thesisTwo = fmtLocal(strings.thesisOne, {
        blocked: 2,
        blockedWord: pluralLocal(2, strings.thesisBlockedWordOne, strings.thesisBlockedWord),
        open: 3,
        programs: 1,
      });
      if (thesisOne.indexOf("1 " + strings.thesisBlockedWordOne) === -1)
        die(
          `f2-counts (${locale}): the portfolio thesis must use the singular blocked word for blocked===1, got "${thesisOne}"`,
        );
      if (thesisTwo.indexOf("2 " + strings.thesisBlockedWord) === -1)
        die(
          `f2-counts (${locale}): the portfolio thesis must use the plural blocked word for blocked===2, got "${thesisTwo}"`,
        );
      // The Kanban bucket must no longer share its label with the blocking-rule count: same wording on
      // both surfaces is exactly how "0 waiting on a human" read as a contradiction of "N blocked".
      if (strings.bucketAspettanoUmano === strings.kpiBlocked)
        die(
          `f2-counts (${locale}): the "needs-human label" bucket must not share its name with the declared-blocking-rule KPI`,
        );
    }

    // Every string the union-count verdict lens actually reads (viewVerdict: execHeadline, kpiBlocked,
    // kpiHowToRead and its rule fragment) is derived from the template itself, not hand-listed — so a
    // future string added to that same panel is covered by construction, not by remembering to add it
    // here. None of them may use the label-only bucket's wording: that mismatch is the F2 defect.
    const template = readFileSync(
      join(HERE, "..", "lib/viewer/control-room.html"),
      "utf-8",
    );
    const verdictFn = template.slice(
      template.indexOf("function viewVerdict("),
      template.indexOf("\nfunction ", template.indexOf("function viewVerdict(") + 1),
    );
    if (!verdictFn) die("f2-counts: could not locate viewVerdict in the template");
    const verdictKeys = Array.from(
      new Set(Array.from(verdictFn.matchAll(/STR\.(\w+)/g), (m) => m[1])),
    );
    if (!verdictKeys.includes("kpiBlocked") || !verdictKeys.includes("kpiHowToRead"))
      die("f2-counts: expected keys not found by scanning viewVerdict — extraction is broken");
    for (const [locale, strings, humanPhrase] of [
      ["en", en, /waiting on a human/i],
      ["it", it, /aspettano un umano/i],
    ]) {
      for (const key of verdictKeys) {
        const value = strings[key];
        if (typeof value === "string" && humanPhrase.test(value))
          die(
            `f2-counts (${locale}): ${key} is read by the union-count verdict lens and must not use the label-only "waiting on a human" wording, got "${value}"`,
          );
      }
    }

    // The template must actually route through plural(), not just declare the strings.
    if (!/plural\(mine\.length,STR\.techHeadlineOne,STR\.techHeadline\)/.test(template))
      die("f2-counts: viewPlan's headline does not select techHeadline/techHeadlineOne by count");
    if (
      !/plural\(blockedClaim\.value,STR\.thesisBlockedWordOne,STR\.thesisBlockedWord\)/.test(
        template,
      )
    )
      die(
        "f2-counts: the portfolio thesis does not select a singular/plural blocked word by count",
      );

    console.log(
      "  ok f2-counts — the plan headline, portfolio front door and verdict KPI panel derive from the same declared-blocking-rule count, name the rule, and none of them borrow the label-only bucket's wording",
    );
  });
});
