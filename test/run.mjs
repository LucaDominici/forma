#!/usr/bin/env node
// Fixture tests: init → gen → check across fixtures, plus §1a/§2/§1b/§7/§3. Deterministic, no deps.
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  rmSync,
  existsSync,
  renameSync,
  symlinkSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateModel } from "../lib/validate.mjs";
import {
  daysBetween,
  deriveAll,
  documentGate,
  deriveBlocks,
  deriveCapabilities,
  deriveCriticalPath,
  deriveMilestonePath,
  deriveMilestoneReconciliation,
  deriveHistory,
  deriveKanban,
  deriveKpis,
  deriveMilestones,
  deriveQueue,
  deriveUseCases,
  deriveRunbooks,
  derivePortfolio,
} from "../lib/roomderive.mjs";
import { loadDocs } from "../lib/roomdocs.mjs";
import { codepointCompare } from "../lib/evidence.mjs";
import { deriveRtm } from "../lib/rtm.mjs";
import { canonicalPath } from "../lib/roomload.mjs";
import { lensDrift } from "./fixtures/control-room-stress/make.mjs";
import { makeKanbanFixture } from "./fixtures/control-room-stress/kanban.mjs";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "forma.mjs");
const FIX = (n) => join(HERE, "fixtures", n);
const tmp = mkdtempSync(join(tmpdir(), "forma-test-"));
const run = (args) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf-8" });
const die = (m, r) => {
  console.error(
    "FAIL: " + m + (r ? "\n" + (r.stdout || "") + (r.stderr || "") : ""),
  );
  process.exit(1);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
// every JSON path where two objects differ (R2: gen x2 must diverge on exactly one)
const diffPaths = (a, b, at = "") => {
  if (a === b) return [];
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return [at || "<root>"];
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    out.push(...diffPaths(a[k], b[k], at ? at + "." + k : k));
  return out;
};

// 1) mini: init → gen → check, basic counts + derived edge (unchanged behavior; no clustering) + determinism

// The #43 guard ("a box many rows name is judged by all of them, not silenced by the prose cap")
// used to be asserted a second time here, against a live checkout of the demo's private source
// repository. It was removed rather than repaired, for two reasons that are the same reason:
//   - it read `docs/FEATURE_MATRIX.md` from a path outside this repository, so two people running
//     `npm test` did not get the same verdict — and it silently SKIPPED when that path was absent,
//     which is every CI run. Green by absence on CI, red on one machine, is the false green this
//     project exists to kill;
//   - the rows it pinned have since been re-declared not-done upstream, so its expectation was
//     simply wrong: `planned` was the correct answer and the assertion was the stale party.
// The property itself is asserted on the committed `docmap` fixture, on the `core` node — see the
// #43 comment there for why one assertion covers both shapes.

// The Control Room, end to end: compose it, gate it, and prove the gate can fail. Until this block
// existed nothing in the suite touched room.mjs, roomderive.mjs, link.mjs or taxonomy.mjs — and
// both gates over them were broken in ways a single run would have caught. The fixture carries no
// .git (a nested repository cannot be committed), so the history the link layer reads is built here
// with pinned author dates: the month buckets are asserted below and must not drift with the clock.
{
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
}

// §one-cpm-cache — repofiles.mjs' trackedFiles() cache must not survive across composes (#133 S4
// follow-up, Codex round 1 HIGH). `room --serve` recomposes on every GET in one long-lived process
// (`compose(true)` in room.mjs); a process-lifetime cache made a file `git add`ed after the server
// started invisible until restart, which is exactly the staleness `git ls-files` was memoised to
// avoid causing three times over, now caused once but forever. Reuses the `room` fixture's `alpha`
// checkout, already committed by the block above — this block only adds one more commit to it.
{
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
}

// `forma scan` and `forma room --serve`: the two halves of "autodetect, with checkboxes". The
// second exists because static HTML cannot write a file, and the first exists so the answer to
// "which programmes are there" is not typed by hand. Both are graded on the same thing: a decision
// a human made must survive the tool running again.
{
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
}

// I14 on a surface that did not exist before: the briefing now RENDERS markdown out of a
// repository's own documents, and a link target read from that prose is attacker-adjacent input.
// Assigning it to .href unchecked makes `[read me](javascript:...)` live XSS in a document written
// by somebody else. The renderer is lifted out of the shipped template and driven directly, the
// same trick this suite already uses for the viewer's pure functions.
{
  const src = readFileSync(
    join(HERE, "..", "lib/viewer/control-room.html"),
    "utf-8",
  );
  const inlineFn = /function inline\(target,text,program\)\{[\s\S]*?\n\}/.exec(
    src,
  );
  const elFn = /function el\(t,c,x\)\{[^\n]*\n/.exec(src);
  const markFn = /function statusMark\(v\)\{[^\n]*\n/.exec(src);
  const pillFn = /function pill\(p,n,t,endpoint\)\{[\s\S]*?\n\}/.exec(src);
  // The pill wears a health verdict, and the verdict lens owns that surface (I20): the pill reads
  // the index the lens publishes, never derived.health itself. Both halves are lifted, so this test
  // exercises the real lookup rather than a stand-in that could stay green while the pair diverged.
  const indexFn = /function indexVerdicts\(\)\{[\s\S]*?\n\}/.exec(src);
  const verdictsOfFn = /function verdictMarkOf\(program,n\)\{[^\n]*\n/.exec(src);
  if (!indexFn || !verdictsOfFn)
    die("markdown: the verdict index the pill reads is not in control-room.html");
  const mdFn = /function renderMarkdown\(src,program\)\{[\s\S]*?\n\}\n/.exec(
    src,
  );
  const mdhFn = /function mdHeading\(level\)\{[^\n]*\n/.exec(src);
  if (!inlineFn)
    die(
      "markdown: inline() not found in control-room.html — the renderer moved",
    );
  if (!elFn) die("markdown: el() not found in control-room.html");
  if (!markFn || !pillFn)
    die(
      "markdown: shared issue pill primitives not found in control-room.html",
    );
  if (!mdFn)
    die(
      "markdown: renderMarkdown() not found in control-room.html — the renderer moved",
    );
  if (!mdhFn) die("markdown: mdHeading() not found in control-room.html");
  const stub = `
    var STR = {statusOk: 'OK', statusWarn: 'Warning', statusBad: 'Bad', closed: 'Closed', stateStale: 'Stale', notAudited: 'Not audited'};
    var document = {
      createElement: function (t) { return { nodeType: 1, tagName: t.toUpperCase(), attrs: {}, children: [], className: '', textContent: '', setAttribute: function (k, v) { this.attrs[k] = v }, appendChild: function (c) { this.children.push(c); return c }, get lastChild() { return this.children[this.children.length - 1] } } },
      createTextNode: function (t) { return { nodeType: 3, text: String(t) } },
    };
    var ROOM = {programs: []}, VERDICT_MARKS = Object.create(null);
    ${indexFn[0]}
    ${verdictsOfFn[0]}
    ${elFn[0]}
    ${markFn[0]}
    ${pillFn[0]}
    ${inlineFn[0]}
    ${mdhFn[0]}
    ${mdFn[0]}
    return {inline: inline, pill: pill, renderMarkdown: renderMarkdown,
            index: function (programs) { ROOM = {programs: programs}; indexVerdicts(); }};`;
  // new Function over text lifted from a TRACKED first-party file, which is the same no-jsdom trick
  // this suite already uses to test the viewer's pure functions. The interpolated strings are our
  // own source at a reviewed commit, never input; the thing being tested is precisely that the
  // renderer refuses input.
  const lifted = new Function(stub)();
  const inline = lifted.inline;
  const anchorsFor = (md) => {
    const target = {
      children: [],
      appendChild(c) {
        this.children.push(c);
      },
    };
    inline(target, md);
    return target.children.filter((c) => c.tagName === "A");
  };
  // `//host/x` is a network-path reference — same scheme, different HOST. It is not a relative path,
  // and an allow-list that lets it through is letting a document link off-site while looking local.
  for (const hostile of [
    "[go](javascript:alert(1))",
    "[go](JaVaScRiPt:alert(1))",
    "[go](  javascript:alert(1))",
    "[go](data:text/html,<script>alert(1)</script>)",
    "[go](vbscript:msgbox)",
    "[go](//evil.example/phish)",
    "[go](\\/\\/evil.example)",
  ]) {
    const a = anchorsFor(hostile);
    if (a.length)
      die(
        `markdown: ${hostile} produced a live anchor with href ${a[0].href} — a document can inject a scheme`,
      );
  }
  for (const safe of [
    "[go](https://example.com/x)",
    "[go](./docs/PRD.md)",
    "[go](/docs/PRD.md)",
    "[go](#section)",
    "[go](mailto:a@b.c)",
  ]) {
    if (!anchorsFor(safe).length)
      die(`markdown: ${safe} should be a link and was rendered as text`);
  }
  // The rejected link is shown, not swallowed: a link that will not be followed should say so.
  const rejected = {
    children: [],
    appendChild(c) {
      this.children.push(c);
    },
  };
  inline(rejected, "[go](javascript:alert(1))");
  if (
    !rejected.children.some((c) => c.text && c.text.indexOf("javascript:") > -1)
  )
    die(
      "markdown: a refused link was dropped silently instead of being shown as text (I9)",
    );

  // A prose `#n` is an issue reference only when the programme snapshot knows it. Unknown hashes
  // remain literal repository prose; known references use the same health-aware pill as every
  // operational projection, including stale and CLOSED precedence.
  const programme = {
    id: "thing",
    ghRepo: "acme/thing",
    issuesSnapshot: {
      issues: [
        { n: 7, state: "OPEN" },
        { n: 8, state: "CLOSED" },
      ],
    },
    derived: {
      health: {
        verdicts: [
          { n: 7, verdict: "bad", why: "Anchored failure.", stale: false },
          { n: 8, verdict: "bad", why: "Superseded by closure.", stale: true },
        ],
      },
    },
  };
  lifted.index([programme]);
  const issueDoc = lifted.renderMarkdown(
    "Known #7, closed #8, unknown #99.",
    programme,
  );
  const issueAnchors = [];
  const textOf = (node) =>
    String(node.text || node.textContent || "") +
    (node.children || []).map(textOf).join("");
  (function walk(n) {
    for (const child of n.children || []) {
      if (child.tagName === "A") issueAnchors.push(child);
      walk(child);
    }
  })(issueDoc);
  if (
    issueAnchors.map((a) => a.href).join() !==
    "https://github.com/acme/thing/issues/7,https://github.com/acme/thing/issues/8"
  )
    die(
      "markdown: known issue references did not become exactly two pills: " +
        issueAnchors.map((a) => a.href),
    );
  if (!textOf(issueDoc).includes("#99"))
    die(
      "markdown: an unknown issue reference was swallowed instead of staying literal",
    );
  const badPill = issueAnchors[0],
    closedPill = issueAnchors[1];
  if (
    badPill.attrs["data-tip"] !== "Anchored failure." ||
    !/Bad/.test(badPill.attrs["aria-label"])
  )
    die("room-pill: a current health verdict lost its anchored reason or word");
  if (
    !/\bclosed\b/.test(closedPill.className) ||
    closedPill.attrs["data-tip"] !== "Closed" ||
    !/Closed/.test(closedPill.attrs["aria-label"])
  )
    die("room-pill: CLOSED did not override an older stale health verdict");
  // A foreign-repo endpoint carries no verdict of OURS. Without the guard the briefing stamps our
  // verdict and our reason onto another repository's issue number — a confident false claim about a
  // repository it has never audited, which is the whole class the pill projection exists to refuse.
  const foreign = lifted.pill(programme, 7, null, { repo: "other/repo", number: 7, state: "OPEN" });
  if (foreign.attrs["data-tip"] !== "Not audited" || /Anchored failure/.test(foreign.attrs["aria-label"] || ""))
    die("room-pill: a cross-repo endpoint was stamped with this programme's verdict");
  if (!/other\/repo/.test(foreign.attrs.href || foreign.href || ""))
    die("room-pill: a cross-repo endpoint does not link to its own repository");

  // Re-index, because the pill no longer re-reads the overlay: the verdict lens decides the mark
  // once and the pill draws it. Mutating the overlay without re-indexing is exactly the state the
  // projection makes impossible to render.
  programme.derived.health.verdicts[0].stale = true;
  lifted.index([programme]);
  const stalePill = lifted.pill(programme, 7);
  if (
    stalePill.attrs["data-tip"] !== "Anchored failure." ||
    !/Stale/.test(stalePill.attrs["aria-label"]) ||
    /\bclosed\b/.test(stalePill.className)
  )
    die(
      "room-pill: stale evidence did not become a neutral stale pill with its reason",
    );

  // Structure, not the appearance of structure. The renderer emitted `div.md-h` and `div.md-li`,
  // which looked like nine headings and ten list items and exposed NONE of them: the accessibility
  // tree for a 111-line document held zero headings and zero lists, so a screen-reader reader got
  // one undifferentiated run of paragraphs with nothing to navigate by. Ordered lists were worse
  // than invisible — `1.` was not matched at all, so PRD.md §2, this product's own definition of
  // itself, was joined into a single run-on sentence on screen AND on paper.
  const { renderMarkdown } = lifted;
  const tags = (node) => {
    const out = [];
    (function walk(n) {
      for (const c of n.children || []) {
        if (c.tagName) out.push(c.tagName);
        walk(c);
      }
    })(node);
    return out;
  };
  const find = (node, tag) => {
    let hit = null;
    (function walk(n) {
      for (const c of n.children || []) {
        if (!hit && c.tagName === tag) hit = c;
        walk(c);
      }
    })(node);
    return hit;
  };
  const doc = renderMarkdown(
    "# Title\n\n## Section\n\nProse.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n",
  );
  const t = tags(doc);
  // Demoted by two: the reader panel is already an h2, so the document\'s `#` is an h3.
  if (t.indexOf("H3") < 0 || t.indexOf("H4") < 0)
    die("markdown: `#`/`##` did not become real headings — got " + t.join(","));
  // The old renderer emitted div.md-h and div.md-li. A DIV anywhere in the output means it is back.
  if (t.indexOf("DIV") > -1)
    die(
      "markdown: the renderer emitted a <div> — headings and list items are divs again, which look like structure and expose none",
    );
  if (!find(doc, "UL") || !find(doc, "OL"))
    die(
      "markdown: a bullet list and a numbered list must be <ul> and <ol> — got " +
        t.join(","),
    );
  if (find(doc, "UL").children.filter((c) => c.tagName === "LI").length !== 2)
    die("markdown: a two-item bullet list did not produce two <li>");
  const ol = find(doc, "OL");
  if (ol.children.filter((c) => c.tagName === "LI").length !== 2)
    die(
      "markdown: `1.`/`2.` did not produce two <li> — numbered lists are being joined into a paragraph",
    );
  // Structure AND content. Every one of these assertions passed while every list item on screen was
  // empty: the renderer took the wrong capture group — the indent for a bullet, the number for an
  // ordered item — so 104 items across forma's own canon rendered as blank <li> or a bare digit, in
  // the lens whose entire payload is that canon. Counting the <li> proves a list exists; reading it
  // proves the list says something.
  const liText = (node) =>
    node.children
      .filter((c) => c.tagName === "LI")
      .map((li) => String(li.text || li.textContent || "") + (li.children || []).map(textOf).join(""));
  if (JSON.stringify(liText(find(doc, "UL"))) !== JSON.stringify(["one", "two"]))
    die("markdown: bullet items rendered without their text — got " + JSON.stringify(liText(find(doc, "UL"))));
  if (JSON.stringify(liText(ol)) !== JSON.stringify(["first", "second"]))
    die("markdown: numbered items rendered without their text — got " + JSON.stringify(liText(ol)));
  if (!find(doc, "BLOCKQUOTE"))
    die("markdown: `>` did not become a <blockquote>");
  // A list that starts at 3 renders as 3, 4 — silently renumbering somebody else\'s document is a
  // lie about what it says.
  const off = renderMarkdown("3. third\n4. fourth\n");
  if (find(off, "OL").attrs.start !== "3")
    die("markdown: a list starting at 3 was silently renumbered from 1");
  // ...but a paragraph opening with a year is prose, not the two-thousand-and-twenty-sixth item.
  if (find(renderMarkdown("2026. The year the manifest was frozen.\n"), "OL"))
    die("markdown: a sentence beginning with a year was turned into a list");
  // Once a list IS running, a four-digit item is an item. Dropping it into the paragraph buffer is
  // a silent structural loss (I9), which is worse than rendering it plainly.
  if (
    find(
      renderMarkdown("10. ten\n100. hundred\n1000. thousand\n"),
      "OL",
    ).children.filter((c) => c.tagName === "LI").length !== 3
  ) {
    die("markdown: an item numbered past 999 was dropped out of its own list");
  }
  // Nested lists (Audit #13): a deeper indent is a list under the previous item, not a flat row.
  // The renderer ingests arbitrary client documents, so a nested list that flattens is a structural
  // lie about what the document says — and the corpus has none today, which is exactly when it rots.
  const nested = renderMarkdown(
    "- parent\n  - child one\n  - child two\n- sibling\n",
  );
  const ul = find(nested, "UL");
  if (!ul) die("markdown: a bullet list did not produce a <ul>");
  const lis = ul.children.filter((c) => c.tagName === "LI");
  if (lis.length !== 2)
    die(
      `markdown: nested list flattened — expected 2 top-level <li>, got ${lis.length}`,
    );
  const childUl = lis[0].children.filter((c) => c.tagName === "UL");
  if (childUl.length !== 1)
    die(
      "markdown: a deeper indent did not become a nested <ul> under its parent item",
    );
  if (childUl[0].children.filter((c) => c.tagName === "LI").length !== 2)
    die("markdown: the nested list lost its items");
  // cross-type nesting: an ordered list under a bullet item
  const mixed = renderMarkdown("- parent\n  1. first\n  2. second\n");
  const muls = find(mixed, "UL");
  if (
    !muls ||
    !muls.children
      .filter((c) => c.tagName === "LI")[0]
      .children.some((c) => c.tagName === "OL")
  ) {
    die("markdown: an ordered list under a bullet item was not nested");
  }
  // a lone CR, U+2028 or U+2029 inside a document HUNG THE BROWSER: `.` and `$` exclude all three
  // in JavaScript, so the unanchored list detector matched a line the anchored consumer could not,
  // the index never advanced, and the loop appended empty <ul>s until the heap died. Repository
  // text reaches this renderer unfiltered, so it was a hang triggered by somebody else's bytes.
  // These cases run in-process: a regression hangs the suite, which is the honest failure — a test
  // for a non-terminating loop cannot both prove termination and return.
  for (const [why, input, want] of [
    ["a lone CR inside a bullet", "- item\rmore\n", "UL"],
    ["a lone CR inside a numbered item", "1. item\rmore\n", "OL"],
    ["U+2028 inside a bullet", "- item\u2028more\n", "UL"],
    ["U+2029 inside a bullet", "- item\u2029more\n", "UL"],
  ]) {
    if (!find(renderMarkdown(input), want))
      die(
        `markdown: ${why} did not produce a <${want.toLowerCase()}> — the line terminator was not normalised`,
      );
  }
  // Same mismatch, silent instead of fatal: the heading was rendered as a paragraph, hash included.
  if (!find(renderMarkdown("# Title\u2028more\n"), "H3"))
    die(
      "markdown: a heading followed by U+2028 rendered as a paragraph with its hash still in it",
    );
  console.log(
    "  ok markdown — a document cannot inject a scheme through a link, a refused link is shown rather than dropped, and headings, bullet lists, numbered lists and quotes are real elements",
  );
}

// Locale parity, now that the tables are files rather than a literal buried in the template. I15
// claimed this was enforced for the Control Room; it was only ever true of the single-lens viewer.
{
  const en = readJson(join(HERE, "..", "lib/viewer/strings/en.json"));
  const it = readJson(join(HERE, "..", "lib/viewer/strings/it.json"));
  const missing = Object.keys(en).filter(function (k) {
    return !(k in it);
  });
  const extra = Object.keys(it).filter(function (k) {
    return !(k in en);
  });
  if (missing.length)
    die(
      "strings: keys present in en and missing from it: " + missing.join(", "),
    );
  if (extra.length)
    die("strings: keys present in it and missing from en: " + extra.join(", "));
  // A key the template never reads is dead weight a translator still has to carry.
  const template = readFileSync(
    join(HERE, "..", "lib/viewer/control-room.html"),
    "utf-8",
  );
  // Word-boundary, not substring: `STR.drift` "reads" inside `STR.driftNoMilestone`, so a key that
  // became dead was reported alive by a key added in the same change. Any short key that prefixes a
  // longer one was invisible to this check.
  const unused = Object.keys(en).filter(function (k) {
    return !new RegExp("STR\\." + k + "\\b").test(template);
  });
  if (unused.length)
    die(
      "strings: declared but never read by the template: " + unused.join(", "),
    );
  // A string carrying a {placeholder} has to reach the reader through fmt(). Appending one raw puts
  // a literal `{closed}` on the page — which is what shipped for the length of one screenshot, in
  // the sentence written to stop the first screen reading as broken.
  const raw = Object.keys(en).filter(function (k) {
    if (!/\{[a-zA-Z]\w*\}/.test(en[k])) return false;
    return !new RegExp("(?:fmt|plural)\\([^)]*STR\\." + k + "\\b").test(
      template,
    );
  });
  if (raw.length)
    die(
      "strings: carries a {placeholder} but never reaches fmt(), so it renders literally: " +
        raw.join(", "),
    );
  console.log(
    `  ok strings — ${Object.keys(en).length} keys at en/it parity, every one read by the template`,
  );
}

// Queue and Kanban are supporting technical evidence, not two undocumented top-level products.
// They stay complete through lazy, bounded disclosure inside the plan lens; every address the
// five-view IA published stays a valid one.
{
  const template = readFileSync(
    join(HERE, "..", "lib/viewer/control-room.html"),
    "utf-8",
  );
  const viewerFn = (name) =>
    (new RegExp("function " + name + "\\([^]*?\\n}\\n").exec(template) ||
      [])[0] || "";
  // The viewer holds no literal list of routes any more: BUILD names one builder per lens and the
  // order, labels and questions arrive injected. A hard-coded array here would just restate the
  // table a third time, which is the drift lib/lenses.mjs exists to end — so what is checked is
  // that every declared lens has a builder and nothing else does.
  const buildSource = (/var BUILD=\{([^}]*)\}/.exec(template) || [])[1] || "";
  const built = [...buildSource.matchAll(/(\w+):view/g)].map((m) => m[1]);
  const routes = LENSES.map((l) => l.id).filter((id) => id !== "portfolio");
  if (built.join() !== routes.join())
    die("room-ia: BUILD does not mount exactly the declared lenses: " + built);
  if (!/var LENS_SPEC=\(window\.__LENSES__\|\|\[\]\)/.test(template))
    die("room-ia: the viewer restates its own route table instead of reading the injected one");
  for (const [from, to] of Object.entries({ exec: "verdict", tech: "plan", map: "architecture", wbs: "traceability", docs: "provenance", auto: "plan", kanban: "plan" }))
    if (!new RegExp(from + ':"' + to + '"').test(template))
      die(`room-ia: the retired /${from} address no longer redirects to ${to}`);
  if (
    !/function workflow\(/.test(template) ||
    !/d\.open&&!d\.getAttribute\("data-filled"\)/.test(template)
  )
    die("room-tech: supporting workflows are not lazy");
  const pageSize = Number(
    (/var ISSUE_PAGE_SIZE=(\d+)/.exec(template) || [])[1],
  );
  if (
    !(pageSize > 0 && pageSize <= 40) ||
    !/function pagedList\(/.test(template)
  )
    die("room-dom: issue rendering has no bounded pager");
  for (const fn of ["renderQueue", "renderKanban"]) {
    const body = viewerFn(fn);
    if (!(fn === "renderQueue" ? /filteredList\(/ : /pagedList\(/).test(body))
      die("room-dom: " + fn + " bypasses the bounded pager");
  }
  const filter = viewerFn("filteredList"),
    queue = viewerFn("renderQueue"),
    kanban = viewerFn("renderKanban"),
    item = viewerFn("queueItem");
  if (
    !/item\.search/.test(filter) ||
    !/input\.addEventListener\("input",draw\)/.test(filter)
  )
    die(
      "room-search: the bounded shared list filter no longer searches on input",
    );
  // One block renderer for the archive and for every panel that shows a block: the auto/manual
  // command boundary lives in exactly one place.
  if (
    !/filteredList\(lane\.body,items/.test(queue) ||
    !/queueItem\(program,entry\.block\)/.test(queue) ||
    !/block\.auto&&block\.cmd\?commandLine\(block\.cmd\):el\("span","state-chip",STR\.human\)/.test(
      item,
    )
  )
    die(
      "room-queue: blocks lost search or the exact auto/manual command boundary",
    );
  // The brief's own words about a batch ride on the block, and are rendered as claims — anchor,
  // staleness and refusal path intact — not retyped as prose.
  if (
    !/notes=block\.notes\|\|\[\]/.test(item) ||
    !/STR\.blockWhy/.test(item) ||
    !/briefClaimRow\(program,notes\[j\]\)/.test(item)
  )
    die("room-queue: the block narrative from the brief is not rendered on the block");
  if (
    !/input\.type="search"/.test(kanban) ||
    !/source\.filter/.test(kanban) ||
    !/names\.concat\(\[\["chiuse"/.test(kanban)
  )
    die("room-kanban: search or the CLOSED archive lane is missing");
  const makeKanban = new Function(
    "el", "panel", "markState", "fmt", "STR", "pagedList", "short", "pill", "document",
    kanban + ";return renderKanban;",
  );
  const kanbanFixture = makeKanbanFixture();
  makeKanban(
    kanbanFixture.helpers.el,
    kanbanFixture.helpers.panel,
    kanbanFixture.helpers.markState,
    kanbanFixture.helpers.fmt,
    kanbanFixture.helpers.STR,
    kanbanFixture.helpers.pagedList,
    kanbanFixture.helpers.short,
    kanbanFixture.helpers.pill,
    kanbanFixture.helpers.document,
  )(kanbanFixture.target, kanbanFixture.program);
  kanbanFixture.flush();
  const assertKanbanPage = (key, expectedRows) => {
    const lanes = kanbanFixture.lanes(), active = lanes.filter((d) => d.open);
    const pages = kanbanFixture.pages();
    if (active.length !== 1 || active[0].key !== key || pages.length !== (expectedRows ? 1 : 0))
      die("room-kanban: lane switch must retain exactly one selected lane and page (expected " + key + ", active " + active.map((d) => d.key).join(",") + ", states " + lanes.map((d) => d.key + ":" + d.open).join(",") + ", pages " + pages.length + ")");
    if (pages[0] && pages[0].children.length > 40)
      die("room-kanban: a lane mounted more than the 40-row issue page");
  };
  for (const lane of kanbanFixture.lanes()) {
    lane.open = true;
    lane.dispatch("toggle");
    kanbanFixture.flush();
    assertKanbanPage(lane.key, lane.rows.length);
  }
  const zeroLane = kanbanFixture.lanes().find((d) => d.key === "premessa-falsa");
  zeroLane.open = true;
  zeroLane.dispatch("toggle");
  kanbanFixture.flush();
  const kanbanInput = kanbanFixture.input();
  kanbanInput.value = "Stress issue 61";
  kanbanInput.dispatch("input");
  kanbanFixture.flush();
  assertKanbanPage("premessa-falsa", 0);
  const closedLane = kanbanFixture.lanes().find((d) => d.key === "chiuse");
  closedLane.open = true;
  closedLane.dispatch("toggle");
  kanbanFixture.flush();
  assertKanbanPage("chiuse", closedLane.rows.length);
  kanbanInput.value = "Stress issue";
  kanbanInput.dispatch("input");
  kanbanFixture.flush();
  assertKanbanPage("chiuse", closedLane.rows.length);
  const tech = viewerFn("viewPlan");
  if (
    !/names\[i\]\[0\]!=="aspettano-umano"\|\|program\.derived\.kanbanHumanDeclared/.test(
      tech,
    ) ||
    !/key!=="aspettano-umano"\|\|program\.derived\.kanbanHumanDeclared/.test(
      kanban,
    )
  )
    die(
      "room-kanban: an undeclared human-label rule is rendered as a measured empty bucket",
    );
  const milestones = viewerFn("milestonePanel"),
    plan = viewerFn("viewPlan");
  if (
    !/milestonesComplete/.test(milestones) ||
    !/complete\?"present":"unknown"/.test(milestones) ||
    !/STR\.milestoneIncomplete/.test(milestones)
  )
    die(
      "room-milestones: an issue-derived milestone panel does not disclose incomplete collection",
    );
  // The RESULT must reach the DOM, not merely the call. A nullable panel makes `foo(program)`
  // matchable while the append is gone, which is how a panel disappears with the test still green.
  if (!/var msPanel=milestonePanel\(program\);if\(msPanel\)ev\.appendChild\(msPanel\)/.test(plan))
    die(
      "room-milestones: milestone evidence is not nested under the plan lens, whose question it answers",
    );
  if (!/var cpPanel=criticalPathPanel\(program\);if\(cpPanel\)ev\.appendChild\(cpPanel\)/.test(plan))
    die("room-plan: the critical path is computed and not mounted");
  if (!/documentGatePanel\(program\)/.test(viewerFn("viewProvenance")))
    die(
      "room-docs: the document gate is not nested under the provenance lens",
    );
  const documentPanel = viewerFn("documentGatePanel");
  if (
    !/chips\(f\.matched\)/.test(documentPanel) ||
    !/gate\.claims\|\|\[\]/.test(documentPanel)
  )
    die(
      "room-docs: the document gate panel hides measured wiring or typed claims",
    );
  if (
    !/gate\.errors\.length/.test(documentPanel) ||
    !/gate\.errors\[i\]/.test(documentPanel)
  )
    die("room-docs: non-empty document gate input errors are not disclosed");
  if (
    !/id="mobile-program"/.test(template) ||
    !/id="mobile-view"/.test(template)
  )
    die("room-mobile: native route controls are absent");
  if (
    !/\.screen-list,\.workflow\{display:none!important\}/.test(template) ||
    /details:not\(\[open\]\)/.test(template)
  )
    die("room-print: interactive archives can expand into print");
  if (
    !/execHeadlineUnknown/.test(template) ||
    !/techHeadlineUnknown/.test(template) ||
    !/thesisUnknown/.test(template)
  )
    die("room-truth: unknown claims have no explicit headline path");
  // A viewport-locked shell turns "too tall" into "invisible", not "scrollable": an uncapped answer
  // tier took 868-967px on the verdict lens and left the evidence row at zero height with six
  // panels below an unscrollable fold. Measured at 1440x900, 1280x800 and 1920x1080.
  if (!/\.answer\{[^}]*max-height:\d+vh[^}]*overflow:auto/.test(template))
    die("room-layout: the answer tier is unbounded and can starve the evidence tier to zero height");
  if (!/\.pager button\{min-height:44px/.test(template))
    die("room-mobile: pager target is below 44px");
  if (!/\.skip\{[^}]*min-height:44px/.test(template))
    die("room-mobile: skip target is below 44px");
  if (
    !/\.prov\{overflow:visible;text-overflow:clip;white-space:normal/.test(
      template,
    )
  )
    die("room-mobile: provenance is truncated without a disclosure");
  const composer = readFileSync(join(HERE, "..", "lib/room.mjs"), "utf-8");
  if (!/theme: manifest\.theme \|\| 'light'/.test(composer))
    die("room-theme: a fresh client briefing does not default to light");
  // #120 AC5/density P2: `.queue-command` only ever exists inside the Queue workflow, which used
  // to sit collapsed and last in the plan lens's evidence tier — burying every command below the
  // fold at 1440. The queue is now the one workflow that opens (and fills) eagerly, and mounts
  // first in that tier, ahead of the blocked-issues panel.
  const viewPlan = viewerFn("viewPlan");
  if (
    !/workflow\(program,STR\.routeQueue,function\(target\)\{renderQueue\(target,program\);\},true\)/.test(
      viewPlan,
    )
  )
    die("room-density: the queue workflow no longer opens eagerly");
  const queueMount = viewPlan.indexOf("STR.routeQueue"),
    blockedMount = viewPlan.indexOf("STR.techBlocked");
  if (queueMount === -1 || blockedMount === -1 || queueMount > blockedMount)
    die(
      "room-density: the queue must mount ahead of the blocked panel to reach the first screen",
    );
  // #120 AC5 visual: `minmax(180px,auto)` never grew past its own floor for a flex panel with
  // `overflow:visible` content (confirmed empirically, not just read from the CSS) — every
  // `.evidence` row rendered at exactly 180px regardless of content, so a tall finding painted
  // over the panel below it rather than growing its own row. The row track uses plain
  // `max-content`, which this worktree confirmed grows correctly to each row's tallest panel.
  if (/\.evidence\{[^}]*grid-auto-rows:minmax\(180px,auto\)/.test(template))
    die("room-density: .evidence's row track floor is back on the broken minmax(fixed,auto) form");
  if (!/grid-auto-rows:max-content;align-content:start;align-items:start\}/.test(template))
    die("room-density: the evidence row track lost its content-based sizing");
  // #120 AC5 (second pass): a per-panel `min-height:180px` floor "fixed" the overlap above but
  // wasted ~150px on every near-empty text panel ("Waiting on a decision", one pill) — pushing the
  // panels after it past the fold. The floor belongs to the chart's own drawing area
  // (`.chart-viz`, which already carried it, `.chart{min-height:0}` resets the PANEL itself), not
  // to every evidence panel; a chart-viz floor cannot cause the row-track defect above (that was
  // the row track ignoring content height, not a panel being short) and `room-layout.mjs`'s
  // overlap/left-clip checks confirm this empty-handed.
  if (/\.evidence>\.panel\{min-height:\d+px\}/.test(template))
    die("room-density: the evidence panel floor is back — it starves the panels after a short one");
  if (!/\.chart-viz\{flex:1 1 auto;min-height:180px/.test(template))
    die("room-density: the chart's own drawing-area floor is gone");
  // A right-anchored SVG label grows LEFT from its anchor; a fixed 6.4px/char truncation budget
  // could still render wider than its own gutter and clip the leftmost glyph off-canvas (the
  // milestone chart's row names, confirmed at ~3px past the panel's own left edge). `nameLabel`
  // re-measures with `getComputedTextLength()` and keeps shrinking until it actually fits, and
  // discloses the untruncated name as a native tooltip once it has to.
  if (!/function nameLabel\(svg,x,y,full,maxWidth\)/.test(template))
    die("room-density: the milestone chart's row-name labels lost their fit-and-disclose guard");
  if (!/getComputedTextLength/.test(template))
    die("room-density: label truncation is not verified against its own rendered width");
  if (!/nameLabel\(svg,gutter-7,y\+3\.5,it\.name,gutter-4\)/.test(template))
    die("room-density: barsH row names no longer use the measured-fit label");
  // #120 AC5: a height cap on the queue panel was tried and reverted — capping it traded the
  // queue's own (honestly measured) visible pills for space that landed on the same 180px-per-panel
  // floor this pass removed, a net loss (see HANDOFF.md). Sizing the evidence tier to content
  // instead makes the cap unnecessary: the queue keeps `panel()`'s plain, uncapped call.
  if (/"cap-queue"/.test(template))
    die("room-density: a reverted queue-panel height cap is still referenced");
  console.log(
    "  ok room-workflow — lens routing from the injected table, searchable blocks/Kanban, honest milestones, bounded lazy evidence, mobile and print contracts",
  );
}

// The shipped Claude adapter is executable guidance, not brochure copy: its init→update sequence
// must work on a fresh map-less checkout and tell the agent to link the artifact it produced (#73).
{
  const repo = join(tmp, "skill-target"),
    manifest = join(repo, "forma.room.json");
  const out = join(repo, "docs/architecture/control-room.html");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/main.js"), "export const ready = true\n");
  const git = (args) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
    if (r.status !== 0) die("skill target git: " + args.join(" "), r);
  };
  git(["init", "-q", "."]);
  git(["remote", "add", "origin", "git@github.com:acme/thing.git"]);
  let r = run([
    "room",
    "init",
    "--repo",
    repo,
    "--manifest",
    manifest,
    "--today",
    "2026-08-17",
  ]);
  if (r.status !== 0) die("claude skill: room init exit " + r.status, r);
  const gh = process.execPath + " " + join(HERE, "stub-gh.mjs");
  r = run([
    "room",
    "update",
    "--manifest",
    manifest,
    "--out",
    out,
    "--gh-cmd",
    gh,
  ]);
  if (r.status !== 0 || !existsSync(out))
    die("claude skill: room update did not produce the linked artifact", r);
  const skill = readFileSync(
    join(HERE, "..", "adapters/claude/SKILL.md"),
    "utf-8",
  );
  const initAt = skill.indexOf("room init"),
    updateAt = skill.indexOf("room update");
  if (initAt < 0 || updateAt < initAt)
    die("claude skill: init→update order is not documented");
  if (!/room update[^\n]*--out/.test(skill) || !/Markdown link/i.test(skill))
    die("claude skill: the adapter does not link the generated output");
  // The ritual skill is the same text for both agents and names every gate the engine enforces, in
  // the order the engine needs them; the counter-verifier skill knows the brief claims and may
  // leave a claim unanswered rather than invent an anchor.
  const ritual = readFileSync(
    join(HERE, "..", "adapters/claude/forma-room-update/SKILL.md"),
    "utf-8",
  );
  if (
    ritual !==
    readFileSync(
      join(HERE, "..", "adapters/codex/forma-room-update/SKILL.md"),
      "utf-8",
    )
  )
    die("ritual skill: Claude and Codex copies differ");
  const order = [
    "room update",
    "audit --repo . --today",
    "--plan",
    "audit-fill.json",
    "--fill --author-engine",
    "forma-counterverify",
    "--counter --verifier-engine",
    "room-presentable",
  ];
  let last = -1;
  for (const step of order) {
    const at = ritual.indexOf(step, last + 1);
    if (at < 0) die("ritual skill: step missing or out of order: " + step);
    last = at;
  }
  // #123 follow-up (Codex review): the ritual must never document `--fill --counter` as an
  // invocation to run — only mention it (in backticks, as prose) as the combination `room update`
  // itself now rejects.
  if (/room update[^\n`]*--fill[^\n`]*--counter/.test(ritual))
    die("ritual skill: still documents the broken combined --fill --counter invocation");
  for (const rule of [
    /anchor that never expires/,
    /Caps/,
    /Never stamp provenance/,
    /Declare the gap/,
    /never from memory/i,
    /lastApply\.rejected/,
    /`about`/,
  ])
    if (!rule.test(ritual)) die("ritual skill: rule missing: " + rule);
  const counterSkill = readFileSync(
    join(HERE, "..", "adapters/codex/forma-counterverify/SKILL.md"),
    "utf-8",
  );
  if (
    !/brief-claim/.test(counterSkill) ||
    !/I do not know/.test(counterSkill) ||
    !/:signal:/.test(counterSkill)
  )
    die(
      'counter skill: brief claims, the right to say "I do not know", or signal anchors are not documented',
    );
  console.log(
    "  ok claude-skill — init→update runs on a fresh target and the adapter links the artifact; the ritual and the verifier skills carry the gates in order",
  );
}

// Publishing must follow the same chain for every future release: conventional commits become a
// reviewable Release Please PR, and only a matching immutable tag reaches npm through the existing
// OIDC publisher. This is intentionally static: it protects the CI contract without publishing.
{
  const release = readFileSync(
    join(HERE, "..", ".github/workflows/release.yml"),
    "utf-8",
  );
  if (
    !/branches:\s*\[main\]/.test(release) ||
    !/tags:\s*\["v\*"\]/.test(release) ||
    !/workflow_dispatch:/.test(release)
  )
    die("release: main, tag and recovery triggers must remain explicit");
  if (
    !/googleapis\/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7/.test(
      release,
    ) ||
    !/release-type:\s*node/.test(release)
  )
    die("release: conventional versioning is not pinned to Release Please");
  if (!/git tag --list 'v1\.\*'/.test(release))
    die(
      "release: automated bumps must wait for the deliberate 1.0 bootstrap tag",
    );
  if (!/release_created/.test(release) || !/id-token:\s*write/.test(release))
    die(
      "release: automatic publication is not gated by a created release and npm OIDC",
    );
  if (/npm@latest/.test(release) || !/npm@11\.16\.0/.test(release))
    die(
      "release: the npm publishing CLI must be an explicit supported version, never latest",
    );
  if (!/package-manager-cache:\s*false/.test(release))
    die("release: release builds must not reuse a package-manager cache");
  console.log(
    "  ok release — conventional commits create reviewable version bumps and OIDC publishes only matching releases",
  );
}

// One issue primitive keeps every view honest: colour only from validated health, the same anchored
// why on hover, a word plus glyph, and closed work visibly closed. No plain issueLink may bypass it (#63).
{
  const template = readFileSync(
    join(HERE, "..", "lib/viewer/control-room.html"),
    "utf-8",
  );
  const pill = (template.match(/function pill\([^]*?\n}/) || [])[0];
  if (!pill) die("room-pill: the shared pill() primitive is missing");
  // The colour still comes from the derived, staleness-aware health overlay — but through the index
  // the verdict lens publishes, because a shared primitive reaching into a derived surface itself
  // gives that surface a home in every lens that draws a pill (I20).
  const indexer = (template.match(/function indexVerdicts\(\)\{[^]*?\n}\n/) || [])[0] || "";
  if (!/verdictMarkOf\(p,n\)/.test(pill) || /derived/.test(pill))
    die("room-pill: colour is not read from the verdict lens's published index");
  // The index must INTERPRET, not pass through: staleness beats the verdict here, once, so no
  // other lens can get that precedence wrong (I8).
  if (!/verdicts\[j\]\.stale\?"stale":verdicts\[j\]\.verdict/.test(indexer))
    die("room-pill: the verdict index hands on the raw overlay instead of the decided mark");
  if (
    !/program\.derived&&program\.derived\.health&&program\.derived\.health\.verdicts/.test(indexer)
  )
    die(
      "room-pill: colour is not sourced from the derived, staleness-aware health overlay",
    );
  if (!/data-tip/.test(pill))
    die("room-pill: the anchored why is not exposed on the issue reference");
  if (!/statusMark/.test(pill))
    die("room-pill: the verdict has no shared glyph + word encoding");
  if (!/state==="CLOSED"/.test(pill))
    die("room-pill: closed issues are not encoded");
  if (!/\.issue-pill \.issue-text\{[^}]*min-width:0/.test(template))
    die(
      "room-pill: long issue titles escape their pill on a narrow board lane",
    );
  if (!/mark\.lastChild\.textContent/.test(pill))
    die("room-pill: the accessible name omits the verdict word");
  if (/\bissueLink\(/.test(template))
    die("room-pill: a plain issue link bypasses pill()");
  console.log(
    "  ok room-pill — every issue reference shares current/stale/closed state, anchored reason, glyph and word",
  );
}

// The map already embeds Forma's full explorer. Keep one drill surface: prove the iframe carries the
// explicit [+] control, stack navigation and C4 level breadcrumb, then pin the owner decision (#64).
{
  const room = readFileSync(
    join(HERE, "..", "lib/viewer/control-room.html"),
    "utf-8",
  );
  const holo = readFileSync(
    join(HERE, "..", "lib/viewer/c4-hologram.html"),
    "utf-8",
  );
  const decisions = readFileSync(
    join(HERE, "..", "DECISION_REGISTRY.md"),
    "utf-8",
  );
  if (!/srcdoc=frameDoc\(program\)/.test(room))
    die("room-c4-drill: the map no longer embeds the hologram");
  if (!/data-drill="1"/.test(holo) || !/stack\.push\(id\)/.test(holo))
    die("room-c4-drill: the embedded hologram cannot drill into children");
  if (
    !/tabindex="0" focusable="true" role="button" aria-label=/.test(holo) ||
    !/stage\.addEventListener\("keydown"/.test(holo) ||
    !/ev\.key!=="Enter"&&ev\.key!==" "/.test(holo)
  )
    die("room-c4-drill: SVG nodes are not keyboard controls");
  if (!/class="detaildrill"/.test(holo) || !/drillTo\(n\.id,true\)/.test(holo))
    die("room-c4-drill: touch inspection has no 44px drill action");
  if (
    !/@media\(max-width:600px\)\{#stage\{overflow:auto/.test(holo) ||
    !/liveSvg\.style\.width=Math\.ceil\(vw\)/.test(holo)
  )
    die(
      "room-c4-drill: mobile still shrinks the entire map instead of panning at readable scale",
    );
  if (!/crumbLevel\+"-L"/.test(holo))
    die("room-c4-drill: the embedded hologram does not expose its C4 level");
  if (!/matchMedia\("\(max-width:600px\)"\)\.addEventListener\("change",function\(\)\{draw\(false\);\}\)/.test(holo))
    die("room-c4-drill: crossing the mobile breakpoint does not redraw readable map dimensions");
  if (!/\| D-07 \|[^\n]*embedded hologram[^\n]*sufficient/i.test(decisions))
    die("room-c4-drill: the delegated owner decision is not recorded");
  console.log(
    "  ok room-c4-drill — the embedded map is the ratified L1→L4 drill surface",
  );
}

// The public C4 viewer must keep a semantic twin for its visual map (#50). Browser acceptance
// drives this actual iframe; this native contract keeps its table toggle, labelled SVG and required
// columns from silently disappearing between browser runs.
{
  const holo = readFileSync(
    join(HERE, "..", "lib/viewer/c4-hologram.html"),
    "utf-8",
  );
  if (!/id="btable"/.test(holo) || !/id="maptable"/.test(holo))
    die("map-a11y: the rendered C4 map has no Show table control and target");
  if (!/<svg[^>]*role="group"[^>]*aria-label=/.test(holo))
    die("map-a11y: the rendered SVG root is not a descriptively named group");
  if (!/\$\("stage"\)\.hidden=show/.test(holo) || !/<th scope="col">/.test(holo))
    die("map-a11y: table mode does not replace the map or lacks column headers");
  for (const key of ["mapNodes", "mapRelationships", "node", "category", "status", "evidencePath", "from", "to", "relationship"])
    if (!new RegExp("\\b" + key + ":").test(holo))
      die("map-a11y: text equivalent omits its " + key + " column");
  console.log("  ok map-a11y — public map contract keeps its table columns and named SVG root");
}

// The dogfood. A traceability convention that cannot read the document THIS repository writes is a
// convention for other people's repositories. docs/PRD.md §6 is a real table, edited by hand for
// prose reasons, and the parser has to find it without being told anything but the id pattern.
// The full chain (issues, and therefore the four gate assertions) additionally needs a committed
// `gh` snapshot; that is a disclosure decision docs/SCOPE-room.md §6 leaves open, so what is
// asserted here is what can be asserted offline: the rows parse, and they parse as themselves.
{
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
}

// A public repository's required CI must be runnable by a fork with its default token. Depending
// on a private sibling is a permanent red, not a documentation verdict (#55 / D-7).
{
  const ci = readFileSync(
    join(HERE, "..", ".github/workflows/ci.yml"),
    "utf-8",
  );
  if (/LucaDominici\/arbiter|ARBITER_TOKEN|\.arbiter-gates/.test(ci))
    die("ci-public: required CI still depends on private arbiter access");
  if (!/needs:\s*\[test,\s*layout\]/.test(ci) ||
      !/\[ "\$TEST" = success \] && \[ "\$LAYOUT" = success \]/.test(ci))
    die("ci-public: ci-required does not fail closed over the self-contained test and layout jobs");
  console.log(
    "  ok ci-public — required CI has no private repository or credential dependency",
  );
}

// The Control Room is validated by dogfood over real local work, not by publishing forma's quiet
// self-portrait as a second Pages demo (#56). The architecture explorer remains the public demo.
{
  const pages = readFileSync(
    join(HERE, "..", ".github/workflows/pages.yml"),
    "utf-8",
  );
  const readme = readFileSync(join(HERE, "..", "README.md"), "utf-8");
  if (
    /_site\/room|room-presentable|bin\/forma\.mjs room|bin\/forma\.mjs verify/.test(
      pages,
    )
  )
    die("dogfood: Pages still builds or publishes a Control Room");
  if (/github\.io\/forma\/room\//.test(readme))
    die("dogfood: README still advertises the retired public Control Room");
  console.log(
    "  ok dogfood — Pages publishes the explorer only; the Control Room stays local",
  );
}

// F5 (2026-09-14 visual verification): forma's own self-model must not go stale in the tree —
// the `forma` node's curated version has to track the published package, and the historical "not
// built" prose for the Control Room (shipped in #120/#121) may not survive a regen.
{
  const pkg = JSON.parse(
    readFileSync(join(HERE, "..", "package.json"), "utf-8"),
  );
  const status = JSON.parse(
    readFileSync(
      join(HERE, "..", "docs/architecture/c4-status.json"),
      "utf-8",
    ),
  );
  const model = JSON.parse(
    readFileSync(join(HERE, "..", "docs/architecture/c4-model.json"), "utf-8"),
  );
  if (status.nodes.forma.statusWord !== "v" + pkg.version)
    die(
      `self-model-fresh: c4-status.json claims ${status.nodes.forma.statusWord}, package.json is v${pkg.version}`,
    );
  if (/not built/i.test(status.nodes.boards.current))
    die(
      "self-model-fresh: the boards node still claims the Control Room is not built (#120/#121 shipped it)",
    );
  const formaNode = model.nodes.find((n) => n.id === "forma");
  if (formaNode.statusWord !== "v" + pkg.version)
    die(
      "self-model-fresh: gen did not re-decorate the committed model from the edited status overlay",
    );
  let r = run(["check"]);
  if (r.status !== 0)
    die("self-model-fresh: forma check must pass on its own regenerated model", r);
  console.log(
    "  ok self-model-fresh — forma's self-model version and Control Room status track the shipped package",
  );
}

// The audit channel is the producer for both evidence overlays: plan offline, let an agent fill
// the JSON contract, then validate everything before either file is replaced (#65).
{
  const repo = join(tmp, "audit-repo"),
    plan = join(tmp, "audit-plan.json"),
    plan2 = join(tmp, "audit-plan-2.json");
  const issues = join(repo, "issues.json"),
    health = join(repo, "health.json"),
    findings = join(repo, "findings.json");
  const topology = join(repo, "topology.json"),
    model = join(repo, "model.json");
  cpSync(FIX("room/alpha"), repo, { recursive: true });
  // A fourth, OPEN, unaudited issue: closed issues are never planned for audit (closure is their state).
  {
    const snap = readJson(issues);
    snap.issues.push({
      n: 4,
      title: "An open issue nobody has judged",
      state: "OPEN",
      url: "https://github.com/acme/alpha/issues/4",
      ms: null,
      labels: [],
      updatedAt: "2026-08-02T10:00:00Z",
      dependenciesComplete: true,
      proseScanComplete: true,
      createdAt: "2026-08-02",
    });
    writeFileSync(issues, JSON.stringify(snap, null, 2) + "\n");
  }
  let r = run(["init", "--repo", repo, "--out", topology, "--force"]);
  if (r.status !== 0) die("audit: init exit " + r.status, r);
  r = run(["gen", "--repo", repo, "--topology", topology, "--out", model]);
  if (r.status !== 0) die("audit: gen exit " + r.status, r);
  const auditModel = readJson(model);
  const doneNode = auditModel.nodes.find(
    (node) => node.evidence && node.evidence.some((e) => e.type === "path"),
  );
  mkdirSync(join(repo, "docs/architecture"), { recursive: true });
  writeFileSync(
    join(repo, "docs/architecture/c4-status.json"),
    JSON.stringify(
      {
        nodes: {
          [doneNode.id]: {
            status2: "done",
            current: "Audited fixture claim.",
            verify: { source: "test fixture" },
          },
        },
      },
      null,
      2,
    ),
  );
  r = run(["gen", "--repo", repo, "--topology", topology, "--out", model]);
  if (r.status !== 0) die("audit: decorated gen exit " + r.status, r);
  const planArgs = [
    "audit",
    "--repo",
    repo,
    "--issues",
    issues,
    "--model",
    model,
    "--topology",
    topology,
    "--health",
    health,
    "--findings",
    findings,
    "--today",
    "2026-08-10",
    "--blocked-labels",
    '["needs-human"]',
    "--plan",
  ];
  const applyArgs = [
    "audit",
    "--repo",
    repo,
    "--issues",
    issues,
    "--model",
    model,
    "--topology",
    topology,
    "--health",
    health,
    "--findings",
    findings,
    "--today",
    "2026-08-10",
    "--blocked-labels",
    '["needs-human"]',
  ];
  r = run([...planArgs, plan]);
  if (r.status !== 0) die("audit: plan exit " + r.status, r);
  r = run([...planArgs, plan2]);
  if (r.status !== 0) die("audit: second plan exit " + r.status, r);
  if (readFileSync(plan, "utf-8") !== readFileSync(plan2, "utf-8"))
    die("audit: unchanged inputs produced different plans");
  const work = readJson(plan);
  if (JSON.stringify(work.issues.map((x) => x.n)) !== "[4]")
    die(
      "audit: plan did not exclude already-audited and closed issues: " +
        JSON.stringify(work.issues),
    );
  if (
    !work.issues[0].prompt.includes("issue #4") ||
    work.output.planHash !== work.planHash ||
    !Array.isArray(work.output.verdicts) ||
    !Array.isArray(work.output.findings)
  )
    die("audit: plan does not carry the agent fill contract");
  const claimKinds = new Set(work.claims.map((claim) => claim.kind));
  for (const kind of [
    "done-node",
    "health-verdict",
    "milestone-rate",
    "waiting-human",
  ])
    if (!claimKinds.has(kind))
      die("audit: counter-verification plan has no " + kind + " claim");
  if (
    work.claims.some(
      (claim) => !claim.id || !claim.claim || !claim.where.length,
    )
  )
    die(
      "audit: a counter-verification claim lacks its name or inspection targets: " +
        JSON.stringify(work.claims),
    );
  const milestoneClaim = work.claims.find(
    (claim) => claim.kind === "milestone-rate",
  );
  if (
    !/33% \(1 closed of 3\)/.test(milestoneClaim.claim) ||
    !milestoneClaim.where.some((at) => at.type === "gh")
  )
    die(
      "audit: milestone claim does not name its derivation and gh source: " +
        JSON.stringify(milestoneClaim),
    );

  const {
    auditPlan,
    applyCounterResults,
    counterPlan,
    validateCounterResults,
    applyBrief,
  } = await import(join(HERE, "..", "lib/audit.mjs"));
  const {
    classifyVerdictStaleness,
    classifyVerification,
    hashEvidence,
    resolveEvidencePath,
    validateEvidence,
  } = await import(join(HERE, "..", "lib/evidence.mjs"));
  const labelClaims = counterPlan(
    null,
    {
      ghRepo: "acme/labels",
      milestones: [],
      issues: [
        { n: 1, state: "OPEN", labels: ["owner-decision"] },
        { n: 2, state: "OPEN", labels: ["needs-human"] },
      ],
    },
    { verdicts: [] },
    "model.json",
    ["owner-decision"],
  ).filter((claim) => claim.kind === "waiting-human");
  if (
    labelClaims.map((claim) => claim.id).join() !== "issue:waiting-human:1" ||
    /needs-human/.test(labelClaims[0].claim)
  )
    die(
      "audit labels: counter plan inferred needs-human outside the declared owner-decision vocabulary",
    );
  const evidence = [{ type: "path", ref: "src/core/engine.js" }],
    issueSnapshot = readJson(issues);
  const evidenceHash = hashEvidence(repo, evidence, issueSnapshot);
  const anchored = validateEvidence(
    repo,
    { type: "path", ref: "src/core/engine.js:1" },
    "line anchor",
  );
  if (
    anchored.ref !== "src/core/engine.js:1" ||
    anchored.line !== 1 ||
    resolveEvidencePath(repo, anchored.ref).ref !== anchored.ref
  )
    die("audit evidence: a valid path:line anchor did not resolve canonically");
  for (const [ref, expected] of [
    ["src/core/engine.js:999999", /line does not resolve/],
    ["../outside:1", /path does not exist in repo/],
  ]) {
    let rejected = null;
    try {
      validateEvidence(repo, { type: "path", ref }, "line anchor");
    } catch (error) {
      rejected = error;
    }
    if (!rejected || !expected.test(rejected.message))
      die(
        "audit evidence: unsafe or invalid anchor was not rejected clearly: " +
          ref,
      );
  }
  const lineOneHash = hashEvidence(
    repo,
    [{ type: "path", ref: "src/core/engine.js:1" }],
    issueSnapshot,
  );
  const lineTwoHash = hashEvidence(
    repo,
    [{ type: "path", ref: "src/core/engine.js:2" }],
    issueSnapshot,
  );
  if (
    lineOneHash !==
      hashEvidence(
        repo,
        [{ type: "path", ref: "src/core/engine.js:1" }],
        issueSnapshot,
      ) ||
    lineOneHash === lineTwoHash
  )
    die(
      "audit evidence: path:line hashes are not deterministic and anchor-sensitive",
    );
  // Engine identity (#123): colour is granted on a fresh `holds` only when the verifier is a
  // DIFFERENT engine than the one that authored the claim; same engine or an unknown engine on
  // either side is recorded but rendered "self-held", never a crash.
  const engineClaim = (author, verified) => ({
    writtenAt: "2026-08-10",
    ...(author ? { author: { engine: author } } : {}),
    ...(verified ? { verified: { verdict: "holds", reason: "r", evidence: { type: "path", ref: "x" }, at: "2026-08-10", ...(verified === true ? {} : { engine: verified }) } } : {}),
  });
  if (classifyVerification(engineClaim("claude", "codex"), { today: "2026-08-10" }) !== "holds")
    die("engine: a cross-engine hold was not coloured");
  if (classifyVerification(engineClaim("claude", "claude"), { today: "2026-08-10" }) === "holds")
    die("engine: a same-engine hold was coloured");
  if (classifyVerification(engineClaim("claude", true), { today: "2026-08-10" }) === "holds")
    die("engine: a verdict with no engine at all was coloured");
  if (classifyVerification(engineClaim(null, "codex"), { today: "2026-08-10" }) === "holds")
    die("engine: an unknown-author claim was coloured on someone else's hold");
  // Legacy brief: neither side ever recorded an engine. Must not crash and must not colour.
  if (classifyVerification(engineClaim(null, true), { today: "2026-08-10" }) === "holds")
    die("engine: a legacy claim with no engine data anywhere was coloured");

  // R1: provenance reuse on an unchanged fill must compare EVERY claim semantic, not just
  // text/evidence/about. A same-engine rewrite that only changes severity/class/ifBroken/
  // staleAfterDays must NOT keep an earlier cross-engine author/verifier pair — that would let a
  // same-engine edit stay coloured under a hold that no longer describes what the claim now says.
  const semEvidence = [{ type: "issue", ref: "1" }];
  const semEvidenceHash = hashEvidence(repo, semEvidence, issueSnapshot, "brief sem-1");
  const semExisting = {
    claims: [
      {
        id: "sem-1", kind: "risk", severity: "warn", text: "Same sentence, different severity.",
        about: { issue: 1 }, evidence: semEvidence,
        writtenAt: "2026-08-01", evidenceHash: semEvidenceHash,
        author: { engine: "claude" },
        verified: { verdict: "holds", reason: "held before the rewrite", evidence: semEvidence[0], at: "2026-08-01", engine: "codex" },
      },
    ],
  };
  const semApplied = applyBrief(
    repo, semExisting,
    [{ id: "sem-1", kind: "risk", severity: "bad", text: "Same sentence, different severity.", about: { issue: 1 }, evidence: semEvidence }],
    issueSnapshot,
    { today: "2026-08-10", engine: "claude" },
  ).brief.claims.find((c) => c.id === "sem-1");
  if (semApplied.verified)
    die(
      "engine: a same-text rewrite that changed severity kept its earlier (cross-engine) verification: " +
        JSON.stringify(semApplied),
    );
  if (!semApplied.author || semApplied.author.engine !== "claude")
    die("engine: a genuine rewrite did not get a fresh author stamp: " + JSON.stringify(semApplied.author));
  const staleVerdict = { auditedAt: "2026-08-10", evidenceHash };
  const unchangedIssue = { updatedAt: "2026-08-10T23:59:59Z", closedAt: null };
  const classify = (issue, today, currentHash = evidenceHash) =>
    classifyVerdictStaleness(staleVerdict, issue, {
      today,
      staleAfterDays: 14,
      evidenceHash: currentHash,
    });
  if (classify(unchangedIssue, "2026-08-17") !== "fresh")
    die("audit stale: unchanged issue and evidence did not stay fresh");
  if (
    classify(
      { ...unchangedIssue, updatedAt: "2026-08-11T00:00:00Z" },
      "2026-08-17",
    ) !== "issue-changed"
  )
    die("audit stale: issue update after audit was ignored");
  if (
    classify(unchangedIssue, "2026-08-17", "0".repeat(64)) !==
    "evidence-changed"
  )
    die("audit stale: changed evidence hash was ignored");
  if (classify(unchangedIssue, "2026-08-25") !== "expired")
    die("audit stale: verdict age limit was ignored");
  if (classify(unchangedIssue, "2026-08-09") !== "future")
    die("audit stale: a verdict from the future stayed green");
  const unrelated = JSON.parse(JSON.stringify(issueSnapshot));
  unrelated.issues.find((it) => it.n === 2).title = "Unrelated snapshot change";
  if (hashEvidence(repo, evidence, unrelated) !== evidenceHash)
    die(
      "audit stale: unrelated snapshot data leaked into a path evidence hash",
    );
  const expiredPrompts = auditPlan(
    issueSnapshot,
    { byIssue: new Map() },
    readJson(health).verdicts,
    { repo, today: "2026-08-25", staleAfterDays: 14 },
  );
  if (expiredPrompts.map((entry) => entry.n).join() !== "1,2,4")
    die(
      "audit stale: expired verdicts were not queued for re-audit (and the closed one must stay out): " +
        JSON.stringify(expiredPrompts),
    );
  const { stubAuditAgent } = await import(join(HERE, "stub-audit-agent.mjs"));
  const result = validateCounterResults(work, stubAuditAgent(work));
  const heldResult = {
    planHash: work.planHash,
    results: JSON.parse(JSON.stringify(result.results)),
  };
  heldResult.results.find((entry) => entry.claimId === "health:1").verdict =
    "holds";
  const renewed = applyCounterResults(
    repo,
    issueSnapshot,
    readJson(health),
    readJson(findings).findings,
    work,
    heldResult,
    { today: "2026-08-11" },
  );
  if (renewed.health.verdicts.find((v) => v.n === 1).auditedAt !== "2026-08-11")
    die("audit: a counter hold did not renew auditedAt");
  if (
    result.results.length !== work.claims.length ||
    result.results.some((entry, i) => entry.claimId !== work.claims[i].id)
  )
    die("audit: runner result does not cover the plan one-for-one");
  if (
    !["holds", "contradicted", "unsupported"].every((verdict) =>
      result.results.some((entry) => entry.verdict === verdict),
    )
  )
    die("audit: offline agent did not exercise every counter-verdict");
  if (
    result.results.some(
      (entry) =>
        !entry.reason ||
        !entry.evidence ||
        !entry.evidence.type ||
        !entry.evidence.ref,
    )
  )
    die("audit: runner accepted an unanchored reason");
  // A partial result is not a rejected result: the claims the verifier did not answer are named as
  // `unanswered` and simply get no fresh verdict — nobody looked, and the room says so.
  const partial = validateCounterResults(work, stubAuditAgent(work, true));
  if (
    !partial.unanswered.length ||
    partial.results.length + partial.unanswered.length !== work.claims.length
  )
    die(
      "audit: a partial counter result was not split into results + unanswered",
    );
  try {
    validateCounterResults(work, {
      planHash: work.planHash,
      results: [
        {
          claimId: "not:in:plan",
          verdict: "holds",
          reason: "x",
          evidence: { type: "file", ref: "src/util/log.js" },
        },
      ],
    });
    die("audit: counter contract accepted a claim the plan does not contain");
  } catch (e) {
    if (!/does not contain/.test(e.message)) throw e;
  }
  // `today` is carried in the plan but stays out of its identity: a new day must not invalidate a
  // fill the agent already wrote (and with it every counter-verdict).
  r = run([
    ...planArgs.map((a) => (a === "2026-08-10" ? "2026-08-12" : a)),
    plan2,
  ]);
  if (r.status !== 0) die("audit: plan on another day exit " + r.status, r);
  if (
    readJson(plan2).planHash !== work.planHash ||
    readJson(plan2).today !== "2026-08-12"
  )
    die("audit: the calendar day leaked into the plan identity");
  r = run(["audit", "--repo", repo, "--run", plan]);
  if (r.status === 0 || !/unknown option: --run/.test(r.stderr || ""))
    die("audit: the offline engine grew an agent/network runner", r);
  const auditSource = readFileSync(join(HERE, "..", "lib/audit.mjs"), "utf-8");
  if (/codex exec|--agent-cmd/.test(auditSource))
    die("audit: the external Codex adapter leaked into the offline engine");
  const codexSkill = readFileSync(
    join(HERE, "..", "adapters/codex/forma-counterverify/SKILL.md"),
    "utf-8",
  );
  const decisions = readFileSync(
    join(HERE, "..", "DECISION_REGISTRY.md"),
    "utf-8",
  );
  if (
    !/name: forma-counterverify/.test(codexSkill) ||
    !/holds\|contradicted\|unsupported/.test(codexSkill) ||
    !/planHash/.test(codexSkill) ||
    !/--today/.test(codexSkill)
  )
    die(
      "audit: the default Codex adapter does not declare the current counter-verification contract",
    );
  if (
    !/\| D-08 \| Codex is the default counter-verification adapter, but runs outside Forma \|/.test(
      decisions,
    )
  )
    die("audit: the delegated Codex CLI decision is not recorded");

  // Agent results enter through the same validated apply boundary. A contradicted issue claim is
  // both a durable finding and a bad health verdict, so the shared pill turns red with this reason.
  const counter = join(tmp, "audit-counter.json");
  writeFileSync(counter, JSON.stringify(result));
  const beforeToctouHealth = readFileSync(health, "utf-8"),
    beforeToctouFindings = readFileSync(findings, "utf-8"),
    beforeToctouIssues = readFileSync(issues, "utf-8");
  const changedDuringAudit = readJson(issues);
  changedDuringAudit.issues.find((issue) => issue.n === 4).title =
    "Changed after the plan";
  writeFileSync(issues, JSON.stringify(changedDuringAudit, null, 2) + "\n");
  r = run([...applyArgs, "--apply", counter, "--counter-plan", plan]);
  writeFileSync(issues, beforeToctouIssues);
  if (
    r.status === 0 ||
    !/plan is stale/.test(r.stderr || "") ||
    readFileSync(health, "utf-8") !== beforeToctouHealth ||
    readFileSync(findings, "utf-8") !== beforeToctouFindings
  )
    die("audit: apply accepted a result after its plan inputs changed", r);
  r = run([...applyArgs, "--apply", counter, "--counter-plan", plan]);
  if (r.status !== 0) die("audit: counter apply exit " + r.status, r);
  const contradicted = result.results.find(
    (entry) => entry.claimId === "health:1",
  );
  const counterHealth = readJson(health).verdicts.find((v) => v.n === 1);
  if (
    !contradicted ||
    contradicted.verdict !== "contradicted" ||
    !counterHealth ||
    counterHealth.verdict !== "bad" ||
    counterHealth.why !== contradicted.reason
  )
    die(
      "audit: contradicted health claim did not become the pill's bad verdict and why",
    );
  if (
    !readJson(findings).findings.some(
      (f) =>
        f.id === "counter:health:1" &&
        f.severity === "bad" &&
        f.text === contradicted.reason,
    )
  )
    die("audit: contradicted claim did not become a durable finding");
  if (
    !readJson(findings).findings.some(
      (f) => f.id === "counter:health:2" && f.severity === "warn",
    )
  )
    die("audit: unsupported claim disappeared instead of becoming a warning");

  const manifest = join(repo, "forma.room.json"),
    roomHtml = join(repo, "control-room.html");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        today: "2026-08-10",
        programs: [
          {
            id: "audit",
            ghRepo: "acme/alpha",
            repo: ".",
            issues: "issues.json",
            model: "model.json",
            topology: "topology.json",
            health: "health.json",
            findings: "findings.json",
            blockedBy: { labels: ["needs-human"] },
          },
        ],
      },
      null,
      2,
    ),
  );
  r = run(["room", "--manifest", manifest, "--out", roomHtml]);
  if (r.status !== 0)
    die("audit: room after counter apply exit " + r.status, r);
  r = run([
    "check",
    "--repo",
    repo,
    "--model",
    model,
    "--topology",
    topology,
    "--issues",
    issues,
    "--health",
    health,
    "--findings",
    findings,
    "--room",
    roomHtml,
    "--manifest",
    manifest,
  ]);
  if (r.status !== 0)
    die("audit: re-derivation disagrees after counter apply", r);
  const goodHealth = readFileSync(health, "utf-8");
  const brokenHealth = readJson(health);
  brokenHealth.verdicts.find((v) => v.n === 1).evidence = [
    { type: "path", ref: "missing-counter-proof.js" },
  ];
  writeFileSync(health, JSON.stringify(brokenHealth, null, 2) + "\n");
  const staleRoom = join(repo, "stale-room.html");
  r = run(["room", "--manifest", manifest, "--out", staleRoom]);
  if (r.status !== 0)
    die("audit stale: unresolved old verdict stopped composition", r);
  const staleSeam = /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(
    readFileSync(staleRoom, "utf-8"),
  );
  if (!staleSeam) die("audit stale: generated room has no __ROOM__ seam");
  const staleProgram = JSON.parse(staleSeam[1]).programs[0],
    staleHealth = staleProgram.derived.health;
  const stale = staleHealth.verdicts.find((v) => v.n === 1);
  if (
    !stale ||
    !stale.stale ||
    stale.staleReason !== "evidence-changed" ||
    staleHealth.staleCount < 1
  )
    die(
      "audit stale: missing evidence was not derived as stale: " +
        JSON.stringify(staleHealth),
    );
  if (
    !staleProgram.derived.kanban["non-auditate"].includes(1) ||
    staleProgram.derived.kanban["premessa-falsa"].includes(1)
  )
    die("audit stale: stale verdict still colored the Kanban");
  r = run([
    "check",
    "--repo",
    repo,
    "--model",
    model,
    "--topology",
    topology,
    "--issues",
    issues,
    "--health",
    health,
    "--findings",
    findings,
    "--room",
    staleRoom,
    "--manifest",
    manifest,
  ]);
  if (r.status !== 0)
    die("audit stale: check rejected a correctly disclosed stale verdict", r);
  writeFileSync(health, goodHealth);

  const beforeCounterHealth = readFileSync(health, "utf-8"),
    beforeCounterFindings = readFileSync(findings, "utf-8");
  r = run([...planArgs, plan]);
  if (r.status !== 0)
    die("audit: fresh plan before rejected counter exit " + r.status, r);
  const badCounter = stubAuditAgent(readJson(plan));
  badCounter.results.find((entry) => entry.claimId === "health:1").evidence = {
    type: "file",
    ref: "missing-agent-proof.js",
  };
  writeFileSync(counter, JSON.stringify(badCounter));
  r = run([...applyArgs, "--apply", counter, "--counter-plan", plan]);
  // Item-by-item: the entry with the unresolved anchor is refused and NAMED in lastApply.rejected;
  // the other entries land. An abort that leaves no trace is what the reference dashboard had.
  if (r.status !== 0 || !/rejected counter health:1/.test(r.stderr || ""))
    die(
      "audit: a bad counter entry aborted the whole apply instead of being refused by name",
      r,
    );
  const afterBadCounter = readJson(health);
  if (
    !afterBadCounter.lastApply ||
    afterBadCounter.lastApply.at !== "2026-08-10" ||
    !afterBadCounter.lastApply.rejected.some(
      (x) =>
        x.kind === "counter" &&
        x.ref === "health:1" &&
        /does not exist in repo/.test(x.reason),
    ) ||
    afterBadCounter.lastApply.accepted < 1
  )
    die(
      "audit: lastApply does not record the refused counter entry: " +
        JSON.stringify(afterBadCounter.lastApply),
    );
  if (
    afterBadCounter.verdicts.find((v) => v.n === 1).why ===
      "missing-agent-proof.js" ||
    readFileSync(findings, "utf-8") === beforeCounterFindings
  )
    die(
      "audit: refused entry leaked, or accepted entries were dropped with it",
    );
  void beforeCounterHealth;

  const fill = join(tmp, "audit-fill.json");
  writeFileSync(
    fill,
    JSON.stringify({
      planHash: readJson(plan).planHash,
      verdicts: [
        {
          n: 4,
          verdict: "ok",
          why: "The committed helper is present.",
          evidence: [{ type: "path", ref: "src/util/log.js" }],
        },
      ],
      findings: [
        {
          id: "F-2",
          severity: "bad",
          text: "Parser behavior contradicts the issue.",
          evidence: { type: "issue", ref: "2" },
        },
      ],
    }),
  );
  r = run([...applyArgs, "--apply", fill, "--audit-plan", plan]);
  if (r.status !== 0) die("audit: apply exit " + r.status, r);
  const appliedVerdict = readJson(health).verdicts.find(
    (v) => v.n === 4 && v.verdict === "ok",
  );
  if (!appliedVerdict) die("audit: verdict was not written");
  if (
    appliedVerdict.auditedAt !== "2026-08-10" ||
    !/^[0-9a-f]{64}$/.test(appliedVerdict.evidenceHash)
  )
    die("audit: Forma did not stamp deterministic verdict provenance");
  const appliedFinding = readJson(findings).findings.find(
    (f) => f.id === "F-2" && f.severity === "bad",
  );
  if (!appliedFinding) die("audit: finding was not written");
  if (
    appliedFinding.auditedAt !== "2026-08-10" ||
    !/^[0-9a-f]{64}$/.test(appliedFinding.evidenceHash)
  )
    die(
      "audit: Forma did not stamp finding provenance — a finding that cannot expire is the reference dashboard's failure",
    );
  if (
    readJson(health).lastApply.rejected.length !== 0 ||
    readJson(health).lastApply.accepted !== 2
  )
    die(
      "audit: lastApply miscounted a clean fill: " +
        JSON.stringify(readJson(health).lastApply),
    );
  // signal and milestone evidence resolve by KEY against the snapshot and hash the WHOLE record, so a
  // new workflow run or a moved milestone marks the evidence changed — never an index, never a file.
  const withSignals = readJson(issues);
  withSignals.signals.workflows.ci = {
    state: "present",
    name: "ci",
    path: ".github/workflows/ci.yml",
    headBranch: "main",
    headSha: "0".repeat(40),
    event: "push",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-08-01T00:00:00Z",
    url: "https://github.com/acme/alpha/actions/runs/1",
  };
  const signalHash = hashEvidence(
    repo,
    [{ type: "signal", ref: "workflows/ci" }],
    withSignals,
  );
  const movedRun = JSON.parse(JSON.stringify(withSignals));
  movedRun.signals.workflows.ci.headSha = "f".repeat(40);
  if (
    signalHash !==
      hashEvidence(
        repo,
        [{ type: "signal", ref: "workflows/ci" }],
        withSignals,
      ) ||
    signalHash ===
      hashEvidence(repo, [{ type: "signal", ref: "workflows/ci" }], movedRun)
  )
    die(
      "audit evidence: signal hash is not deterministic or ignores a new run",
    );
  const refetched = JSON.parse(JSON.stringify(withSignals));
  refetched.fetchedAt = "2030-01-01T00:00:00Z";
  if (
    signalHash !==
    hashEvidence(repo, [{ type: "signal", ref: "workflows/ci" }], refetched)
  )
    die("audit evidence: fetchedAt leaked into a signal hash");
  const msHash = hashEvidence(
    repo,
    [{ type: "milestone", ref: withSignals.milestones[0].title }],
    withSignals,
  );
  const movedMs = JSON.parse(JSON.stringify(withSignals));
  movedMs.milestones[0].closed += 1;
  if (
    msHash ===
    hashEvidence(
      repo,
      [{ type: "milestone", ref: withSignals.milestones[0].title }],
      movedMs,
    )
  )
    die("audit evidence: milestone hash ignores a closed issue");
  for (const bad of [
    { type: "signal", ref: "workflows/nope" },
    { type: "milestone", ref: "no such milestone" },
    { type: "signal", ref: "workflows/ci" },
  ]) {
    let rejected = null;
    try {
      validateEvidence(
        repo,
        bad,
        "keyed",
        bad.ref === "workflows/ci" ? new Set([1]) : withSignals,
      );
    } catch (error) {
      rejected = error;
    }
    if (!rejected)
      die(
        "audit evidence: keyed evidence resolved where it must not: " +
          JSON.stringify(bad),
      );
  }

  const beforeHealth = readFileSync(health, "utf-8"),
    beforeFindings = readFileSync(findings, "utf-8");
  r = run([...planArgs, plan]);
  if (r.status !== 0)
    die("audit: fresh plan before rejected fill exit " + r.status, r);
  writeFileSync(
    fill,
    JSON.stringify({
      planHash: readJson(plan).planHash,
      verdicts: [
        {
          n: 4,
          verdict: "bad",
          why: "Unsupported.",
          evidence: [{ type: "path", ref: "src/util/log.js" }],
        },
      ],
      findings: [
        {
          id: "F-3",
          severity: "warn",
          text: "Would be a partial write.",
          evidence: { type: "path", ref: "src/core/engine.js" },
        },
      ],
    }),
  );
  r = run([...applyArgs, "--apply", fill, "--audit-plan", plan]);
  if (
    r.status !== 0 ||
    !/rejected verdict #4: verdict #4 was not in the plan/.test(r.stderr || "")
  )
    die("audit: an unplanned verdict was not refused by name", r);
  if (
    readJson(health).verdicts.find((v) => v.n === 4).verdict !== "ok" ||
    !readJson(findings).findings.some((f) => f.id === "F-3")
  )
    die(
      "audit: the refused verdict leaked, or the valid finding beside it was dropped",
    );
  if (
    !readJson(health).lastApply.rejected.some(
      (x) => x.kind === "verdict" && x.ref === "#4",
    )
  )
    die("audit: lastApply does not name the refused verdict");
  void beforeHealth;
  void beforeFindings;

  // ---- The brief: the judgement layer as typed claims that expire and earn colour only under a
  // hostile verdict. Applied through the same plan/fill/apply boundary as verdicts and findings.
  const brief = join(repo, "brief.json");
  const briefArgs = [...applyArgs, "--brief", brief];
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("brief: plan exit " + r.status, r);
  const briefPlanned = readJson(plan);
  if (
    !briefPlanned.brief ||
    !briefPlanned.brief.prompts.some((x) => x.kind === "thesis") ||
    briefPlanned.brief.caps.decide !== 5 ||
    !briefPlanned.output.brief
  )
    die(
      "brief: plan carries no brief prompts/caps/output contract: " +
        JSON.stringify(briefPlanned.brief),
    );
  const claimsFill = (claims) => {
    writeFileSync(
      fill,
      JSON.stringify({
        planHash: readJson(plan).planHash,
        verdicts: [],
        findings: [],
        brief: { claims },
      }),
    );
  };
  claimsFill([
    {
      id: "thesis",
      kind: "thesis",
      text: "Two of three issues are open and the engine still trims spaces only.",
      about: { milestone: "v1" },
      evidence: [
        { type: "milestone", ref: "v1" },
        { type: "path", ref: "src/core/engine.js" },
      ],
    },
    {
      id: "risk-1",
      kind: "risk",
      severity: "bad",
      text: "Trailing whitespace still breaks the engine.",
      about: { issue: 1 },
      evidence: [{ type: "issue", ref: "1" }],
    },
    {
      id: "risk-immortal",
      kind: "risk",
      severity: "warn",
      text: "Anchored to a closed issue only.",
      about: { issue: 3 },
      evidence: [{ type: "issue", ref: "3" }],
    },
    {
      id: "risk-readme",
      kind: "risk",
      severity: "warn",
      text: "Anchored to a path only.",
      about: { path: "src/util/log.js" },
      evidence: [{ type: "path", ref: "src/util/log.js" }],
    },
    {
      id: "decide-1",
      kind: "decide",
      text: "Decide whether #2 blocks v1.",
      about: { issue: 2 },
      evidence: [
        { type: "issue", ref: "2" },
        { type: "milestone", ref: "v1" },
      ],
    },
    {
      id: "inv-1",
      kind: "invariant",
      severity: "warn",
      class: "DOCUMENTATO",
      ifBroken: "A silent parse error ships.",
      text: "The parser never throws on empty input.",
      about: { path: "docs/DESIGN.md" },
      evidence: [{ type: "path", ref: "docs/DESIGN.md" }],
    },
    {
      id: "inv-bad",
      kind: "invariant",
      text: "An invariant with no class.",
      about: { path: "docs/DESIGN.md" },
      evidence: [{ type: "path", ref: "docs/DESIGN.md" }],
    },
    {
      id: "stamped",
      kind: "note",
      text: "Tries to stamp itself.",
      about: { issue: 1 },
      evidence: [{ type: "issue", ref: "1" }],
      writtenAt: "2020-01-01",
    },
    {
      id: "self-authored",
      kind: "note",
      text: "Tries to declare its own author engine.",
      about: { issue: 1 },
      evidence: [{ type: "issue", ref: "1" }],
      author: { engine: "codex" },
    },
    {
      id: "nowhere",
      kind: "note",
      text: "Subject not in snapshot.",
      about: { issue: 99 },
      evidence: [{ type: "issue", ref: "1" }],
    },
  ]);
  r = run([...briefArgs, "--apply", fill, "--audit-plan", plan, "--engine", "claude"]);
  if (r.status !== 0) die("brief: apply exit " + r.status, r);
  const written = readJson(brief),
    writtenIds = written.claims
      .map((c) => c.id)
      .sort()
      .join();
  if (writtenIds !== "decide-1,inv-1,risk-1,thesis")
    die("brief: accepted set is wrong: " + writtenIds);
  if (
    written.claims.some(
      (c) => !c.author || c.author.engine !== "claude",
    )
  )
    die(
      "brief: --engine did not stamp author.engine on newly written claims: " +
        JSON.stringify(written.claims.map((c) => [c.id, c.author])),
    );
  const briefApply = readJson(health).lastApply;
  const refusedIds = briefApply.rejected
    .filter((x) => x.kind === "brief")
    .map((x) => x.ref)
    .sort()
    .join();
  if (
    refusedIds !==
    "inv-bad,nowhere,risk-immortal,risk-readme,self-authored,stamped"
  )
    die(
      "brief: refusals are not named in lastApply: " +
        JSON.stringify(briefApply),
    );
  if (
    !briefApply.rejected.some(
      (x) => x.ref === "risk-immortal" && /anchor that can move/.test(x.reason),
    ) ||
    !briefApply.rejected.some(
      (x) =>
        x.ref === "stamped" &&
        /provenance is controlled by forma/.test(x.reason),
    ) ||
    !briefApply.rejected.some(
      (x) =>
        x.ref === "self-authored" &&
        /provenance is controlled by forma/.test(x.reason),
    )
  )
    die(
      "brief: refusal reasons are not the ones that matter: " +
        JSON.stringify(briefApply.rejected),
    );
  const thesis = written.claims.find((c) => c.id === "thesis");
  if (
    thesis.writtenAt !== "2026-08-10" ||
    !/^[0-9a-f]{64}$/.test(thesis.evidenceHash) ||
    thesis.verified
  )
    die(
      "brief: Forma did not stamp claim provenance, or invented a verification",
    );
  // Caps: a second thesis by a new id is refused; the same id is an update.
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("brief: re-plan exit " + r.status, r);
  claimsFill([
    {
      id: "thesis-2",
      kind: "thesis",
      text: "A second thesis.",
      about: { milestone: "v1" },
      evidence: [{ type: "milestone", ref: "v1" }],
    },
    {
      id: "thesis",
      kind: "thesis",
      text: "Rewritten thesis.",
      about: { milestone: "v1" },
      evidence: [{ type: "milestone", ref: "v1" }],
    },
  ]);
  r = run([...briefArgs, "--apply", fill, "--audit-plan", plan, "--engine", "claude"]);
  if (r.status !== 0) die("brief: cap apply exit " + r.status, r);
  if (
    readJson(brief).claims.filter((c) => c.kind === "thesis").length !== 1 ||
    readJson(brief).claims.find((c) => c.id === "thesis").text !==
      "Rewritten thesis." ||
    !readJson(health).lastApply.rejected.some(
      (x) => x.ref === "thesis-2" && /already holds 1 thesis/.test(x.reason),
    )
  )
    die("brief: the thesis cap did not hold, or the update by id was refused");
  // The counter-plan carries one claim per brief claim; a hostile `holds` grants colour on the
  // claim with its own date, `contradicted` lands as a red finding, an unanswered claim stays grey.
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("brief: counter plan exit " + r.status, r);
  const briefClaims = readJson(plan).claims.filter(
    (c) => c.kind === "brief-claim",
  );
  if (
    briefClaims
      .map((c) => c.id)
      .sort()
      .join() !== "brief:decide-1,brief:inv-1,brief:risk-1,brief:thesis" ||
    !briefClaims
      .find((c) => c.id === "brief:thesis")
      .where.some((w) => w.type === "gh" && /:milestone:v1$/.test(w.ref))
  )
    die(
      "brief: counter-plan does not carry the brief claims with gh anchors: " +
        JSON.stringify(briefClaims),
    );
  const briefCounter = {
    planHash: readJson(plan).planHash,
    results: [
      {
        claimId: "brief:thesis",
        verdict: "holds",
        reason: "The milestone counts match the sentence.",
        evidence: { type: "gh", ref: "acme/alpha:milestone:v1" },
      },
      {
        claimId: "brief:decide-1",
        verdict: "holds",
        reason: "Issue #2 is open and in v1.",
        evidence: { type: "gh", ref: "acme/alpha#2" },
      },
      {
        claimId: "brief:risk-1",
        verdict: "contradicted",
        reason: "The engine trims tabs too since the last commit.",
        evidence: { type: "file", ref: "src/core/engine.js" },
      },
      ...readJson(plan)
        .claims.filter((c) => c.kind !== "brief-claim" && c.id !== "health:1")
        .map((c) => ({
          claimId: c.id,
          verdict: "unsupported",
          reason: "not checked in this test",
          evidence: { type: "file", ref: "src/util/log.js" },
        })),
    ],
  };
  writeFileSync(counter, JSON.stringify(briefCounter));
  r = run([...briefArgs, "--apply", counter, "--counter-plan", plan, "--engine", "codex"]);
  if (r.status !== 0) die("brief: counter apply exit " + r.status, r);
  const verifiedBrief = readJson(brief);
  const vThesis = verifiedBrief.claims.find((c) => c.id === "thesis"),
    vRisk = verifiedBrief.claims.find((c) => c.id === "risk-1"),
    vInv = verifiedBrief.claims.find((c) => c.id === "inv-1");
  if (vThesis.verified.engine !== "codex")
    die(
      "brief: --engine did not stamp verified.engine on the counter apply: " +
        JSON.stringify(vThesis.verified),
    );
  if (
    !vThesis.verified ||
    vThesis.verified.verdict !== "holds" ||
    vThesis.verified.at !== "2026-08-10" ||
    vThesis.verified.evidence.type !== "milestone"
  )
    die(
      "brief: a hostile hold did not land on the claim with its date and evidence: " +
        JSON.stringify(vThesis.verified),
    );
  if (
    !vRisk.verified ||
    vRisk.verified.verdict !== "contradicted" ||
    !readJson(findings).findings.some(
      (f) => f.id === "counter:brief:risk-1" && f.severity === "bad",
    )
  )
    die("brief: a contradicted claim did not become a red finding");
  if (
    vInv.verified ||
    !readJson(health).lastApply.unanswered.includes("brief:inv-1") ||
    !readJson(health).lastApply.unanswered.includes("health:1")
  )
    die(
      "brief: unanswered claims were not named: " +
        JSON.stringify(readJson(health).lastApply),
    );
  // Derived: colour only on a fresh hold; contradicted / unverified are grey with the word; a
  // rewritten claim loses its verification; the subject issue moving marks the claim stale.
  const { deriveBrief } = await import(join(HERE, "..", "lib/roomderive.mjs"));
  const derivedBrief = deriveBrief(repo, readJson(issues), verifiedBrief, {
    today: "2026-08-10",
    staleAfterDays: 14,
  });
  const stateOf = (id) => derivedBrief.claims.find((c) => c.id === id).state;
  if (
    stateOf("thesis") !== "holds" ||
    !derivedBrief.claims.find((c) => c.id === "thesis").coloured ||
    stateOf("risk-1") !== "contradicted" ||
    stateOf("inv-1") !== "unverified" ||
    derivedBrief.claims.find((c) => c.id === "inv-1").coloured
  )
    die(
      "brief: derived states are wrong: " +
        JSON.stringify(derivedBrief.claims.map((c) => [c.id, c.state])),
    );
  if (
    derivedBrief.ready !== true ||
    derivedBrief.counts.holds !== 2 ||
    derivedBrief.counts.contradicted !== 1
  )
    die(
      "brief: readiness or counts wrong: " +
        JSON.stringify({
          ready: derivedBrief.ready,
          counts: derivedBrief.counts,
        }),
    );
  // Same-engine hold: an author and a verifier that are the SAME engine (or an unrecorded one)
  // must not colour the claim, even though forma's own freshness math would otherwise grant it.
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("brief: self-held re-plan exit " + r.status, r);
  claimsFill([
    {
      id: "risk-self",
      kind: "risk",
      severity: "warn",
      text: "A risk authored and (self-)verified by the same engine.",
      about: { issue: 1 },
      evidence: [{ type: "issue", ref: "1" }],
    },
  ]);
  r = run([...briefArgs, "--apply", fill, "--audit-plan", plan, "--engine", "claude"]);
  if (r.status !== 0) die("brief: self-held claim apply exit " + r.status, r);
  if (readJson(brief).claims.find((c) => c.id === "risk-self").author.engine !== "claude")
    die("brief: risk-self was not stamped with its authoring engine");
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("brief: self-held counter re-plan exit " + r.status, r);
  const selfCounter = {
    planHash: readJson(plan).planHash,
    results: readJson(plan)
      .claims.filter((c) => c.kind === "brief-claim" && c.id === "brief:risk-self")
      .map((c) => ({
        claimId: c.id,
        verdict: "holds",
        reason: "Same engine checking its own claim.",
        evidence: { type: "file", ref: "src/core/engine.js" },
      })),
  };
  writeFileSync(counter, JSON.stringify(selfCounter));
  r = run([...briefArgs, "--apply", counter, "--counter-plan", plan, "--engine", "claude"]);
  if (r.status !== 0) die("brief: self-held counter apply exit " + r.status, r);
  const selfBrief = readJson(brief);
  const riskSelf = selfBrief.claims.find((c) => c.id === "risk-self");
  if (riskSelf.verified.engine !== "claude" || riskSelf.verified.verdict !== "holds")
    die("brief: self-held verdict was not recorded: " + JSON.stringify(riskSelf.verified));
  const selfDerived = deriveBrief(repo, readJson(issues), selfBrief, {
    today: "2026-08-10",
    staleAfterDays: 14,
  });
  const selfState = selfDerived.claims.find((c) => c.id === "risk-self");
  if (selfState.state === "holds" || selfState.coloured)
    die(
      "brief: a same-engine hold was recorded but still rendered as coloured: " +
        JSON.stringify(selfState),
    );

  const movedIssues = readJson(issues);
  movedIssues.issues.find((it) => it.n === 2).updatedAt =
    "2026-08-11T00:00:00Z";
  const movedBrief = deriveBrief(repo, movedIssues, verifiedBrief, {
    today: "2026-08-12",
    staleAfterDays: 14,
  });
  if (
    movedBrief.claims.find((c) => c.id === "decide-1").state !== "stale" ||
    movedBrief.claims.find((c) => c.id === "decide-1").staleReason !==
      "issue-changed" ||
    movedBrief.ready !== false
  )
    die(
      "brief: a moved subject did not stale the decision or un-ready the brief",
    );
  const oldVerdict = deriveBrief(repo, readJson(issues), verifiedBrief, {
    today: "2026-08-30",
    staleAfterDays: 14,
  });
  if (oldVerdict.claims.find((c) => c.id === "thesis").state !== "stale")
    die("brief: an aged claim stayed coloured");
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("brief: rewrite plan exit " + r.status, r);
  claimsFill([
    {
      id: "thesis",
      kind: "thesis",
      text: "Rewritten again, so the old hold is void.",
      about: { milestone: "v1" },
      evidence: [{ type: "milestone", ref: "v1" }],
    },
  ]);
  r = run([...briefArgs, "--apply", fill, "--audit-plan", plan]);
  if (r.status !== 0) die("brief: rewrite apply exit " + r.status, r);
  if (readJson(brief).claims.find((c) => c.id === "thesis").verified)
    die(
      "brief: a rewritten claim kept a verification the verifier never gave it",
    );
  // A claim whose evidence no longer resolves is a fatal read error for `check` (never a silent
  // grey), while an aged one is only reported. Composition and the gate agree on the brief.
  const briefManifest = join(repo, "forma.brief.room.json"),
    briefRoom = join(repo, "brief-room.html");
  writeFileSync(
    briefManifest,
    JSON.stringify(
      {
        today: "2026-08-10",
        programs: [
          {
            id: "audit",
            ghRepo: "acme/alpha",
            repo: ".",
            issues: "issues.json",
            model: "model.json",
            topology: "topology.json",
            health: "health.json",
            findings: "findings.json",
            brief: { path: "brief.json" },
            blockedBy: { labels: ["needs-human"] },
          },
        ],
      },
      null,
      2,
    ),
  );
  r = run(["room", "--manifest", briefManifest, "--out", briefRoom]);
  if (r.status !== 0) die("brief: room exit " + r.status, r);
  r = run([
    "check",
    "--repo",
    repo,
    "--model",
    model,
    "--topology",
    topology,
    "--issues",
    issues,
    "--health",
    health,
    "--findings",
    findings,
    "--room",
    briefRoom,
    "--manifest",
    briefManifest,
  ]);
  if (r.status !== 0) die("brief: check disagrees with the composed brief", r);
  const briefSeam = JSON.parse(
    /window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(
      readFileSync(briefRoom, "utf-8"),
    )[1],
  ).programs[0];
  if (
    !briefSeam.derived.brief ||
    briefSeam.derived.brief.claims.length !== 5 ||
    briefSeam.derived.brief.thesis.state !== "unverified"
  )
    die("brief: composed room does not carry the derived brief");
  const goodBrief = readFileSync(brief, "utf-8"),
    brokenBrief = readJson(brief);
  brokenBrief.claims.find((c) => c.id === "inv-1").evidence = [
    { type: "path", ref: "docs/NOPE.md" },
  ];
  writeFileSync(brief, JSON.stringify(brokenBrief, null, 2) + "\n");
  r = run([
    "check",
    "--repo",
    repo,
    "--model",
    model,
    "--topology",
    topology,
    "--issues",
    issues,
    "--health",
    health,
    "--findings",
    findings,
    "--room",
    briefRoom,
    "--manifest",
    briefManifest,
  ]);
  if (r.status === 0 || !/brief claim inv-1/.test(r.stderr || ""))
    die("brief: check accepted a claim whose evidence does not resolve", r);
  writeFileSync(brief, goodBrief);
  // "What changed in the brief": the previous brief is a DECLARED git ref of the file, diffed at
  // render — added / removed / rewritten / re-verdicted; outside git, or with a bad ref, it says why.
  const { deriveBriefDelta } = await import(
    join(HERE, "..", "lib/roomderive.mjs")
  );
  const outsideGit = deriveBriefDelta(brief, "abcdef0", readJson(brief));
  if (
    !outsideGit ||
    outsideGit.resolvable !== false ||
    !/git repository/.test(outsideGit.reason)
  )
    die(
      "brief delta: a brief outside git did not say so: " +
        JSON.stringify(outsideGit),
    );
  const gitDir = join(tmp, "brief-git");
  mkdirSync(gitDir, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "forma",
    GIT_AUTHOR_EMAIL: "forma@example.invalid",
    GIT_COMMITTER_NAME: "forma",
    GIT_COMMITTER_EMAIL: "forma@example.invalid",
  };
  const g = (args) =>
    execFileSync("git", ["-C", gitDir, ...args], {
      encoding: "utf-8",
      env: gitEnv,
    }).trim();
  g(["init", "-q"]);
  const gitBrief = join(gitDir, "c4-brief.json");
  const v1 = { claims: readJson(brief).claims.filter((c) => c.id !== "inv-1") };
  writeFileSync(gitBrief, JSON.stringify(v1, null, 2) + "\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "brief v1"]);
  const previousSha = g(["rev-parse", "HEAD"]);
  const v2 = JSON.parse(JSON.stringify(readJson(brief)));
  v2.claims.find((c) => c.id === "risk-1").text = "Rewritten risk.";
  v2.claims = v2.claims.filter((c) => c.id !== "decide-1");
  writeFileSync(gitBrief, JSON.stringify(v2, null, 2) + "\n");
  const delta = deriveBriefDelta(gitBrief, previousSha, v2);
  if (
    !delta.resolvable ||
    delta.added.map((c) => c.id).join() !== "inv-1" ||
    delta.removed.map((c) => c.id).join() !== "decide-1" ||
    delta.changed.map((c) => c.id).join() !== "risk-1" ||
    delta.unchanged !== 2
  )
    die("brief delta: wrong diff: " + JSON.stringify(delta));
  const badRef = deriveBriefDelta(gitBrief, "0".repeat(40), v2);
  if (badRef.resolvable !== false || !/cannot be read/.test(badRef.reason))
    die("brief delta: an unreadable ref did not say so");
  // The publication gate: a decision without a fresh hostile hold does not go out; a held one does.
  const briefPresentable = (file) =>
    spawnSync(
      process.execPath,
      [
        join(HERE, "..", "scripts", "room-presentable.mjs"),
        "--room",
        file,
        "--manifest",
        briefManifest,
      ],
      { encoding: "utf-8" },
    );
  r = run(["room", "--manifest", briefManifest, "--out", briefRoom]);
  if (r.status !== 0) die("brief: room for presentable exit " + r.status, r);
  let bp = briefPresentable(briefRoom);
  if (
    bp.status !== 0 ||
    !/no decision goes out without a fresh hostile hold/.test(bp.stdout)
  )
    die(
      "brief: presentable refused a room whose only decision is held: " +
        bp.stdout +
        bp.stderr,
    );
  const unheld = readJson(brief);
  delete unheld.claims.find((c) => c.id === "decide-1").verified;
  writeFileSync(brief, JSON.stringify(unheld, null, 2) + "\n");
  r = run(["room", "--manifest", briefManifest, "--out", briefRoom]);
  if (r.status !== 0)
    die("brief: room with unheld decision exit " + r.status, r);
  bp = briefPresentable(briefRoom);
  if (
    bp.status === 0 ||
    !/FAIL no decision goes out without a fresh hostile hold.*decide-1 \(unverified\)/.test(
      bp.stdout,
    )
  )
    die(
      "brief: presentable published a decision nobody verified: " + bp.stdout,
    );
  if (
    !/decide-1/.test(readFileSync(briefRoom, "utf-8")) ||
    !/briefUnverified|not verified/.test(readFileSync(briefRoom, "utf-8"))
  )
    die(
      "brief: the composed room does not carry the claim or the not-verified word",
    );
  writeFileSync(brief, goodBrief);
  // A decision that has been TAKEN must be able to leave the brief. Upsert-only would let the
  // judgement layer only grow — the rot it exists to prevent — and an anchor that git has since
  // discarded (a squash-merged head) would keep the gate red forever. Explicit, never by omission.
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("brief: re-plan before retire exit " + r.status, r);
  claimsFill([
    { id: "decide-1", drop: true },
    { id: "ghost", drop: true },
  ]);
  r = run([...briefArgs, "--apply", fill, "--audit-plan", plan]);
  if (r.status !== 0) die("brief: retire apply exit " + r.status, r);
  if (readJson(brief).claims.some((c) => c.id === "decide-1"))
    die("brief: a retired claim survived the drop");
  if (
    !readJson(health).lastApply.rejected.some(
      (x) => x.ref === "ghost" && /no such claim/.test(x.reason),
    )
  )
    die("brief: retiring an unknown id was not refused");
  writeFileSync(brief, goodBrief);

  // `room update --counter` owns the deterministic half of unattended operation. The external
  // adapter writes the result; update regenerates the plan, refuses stale/missing output, applies
  // it per active programme, then composes the briefing (#69).
  const updateManifest = readJson(manifest);
  updateManifest.staleAfterDays = 7;
  updateManifest.programs[0].auditPlan = plan;
  updateManifest.programs[0].counterResults = counter;
  writeFileSync(manifest, JSON.stringify(updateManifest, null, 2) + "\n");
  r = run([...applyArgs, "--stale-after-days", "7", "--plan", plan]);
  if (r.status !== 0) die("audit update: fresh plan exit " + r.status, r);
  const updateResult = stubAuditAgent(readJson(plan));
  const updateContradiction = updateResult.results.find(
    (entry) => entry.claimId === "health:1",
  );
  updateContradiction.verdict = "contradicted";
  updateContradiction.reason = "Update pipeline found a contradiction.";
  writeFileSync(counter, JSON.stringify(updateResult, null, 2) + "\n");
  const updatedRoom = join(repo, "updated-room.html");
  r = run([
    "room",
    "update",
    "--manifest",
    manifest,
    "--out",
    updatedRoom,
    "--skip-verify",
    "--counter",
  ]);
  if (r.status !== 0)
    die("audit update: counter-verification exit " + r.status, r);
  if (readJson(plan).staleAfterDays !== 7)
    die("audit update: counter plan ignored manifest.staleAfterDays");
  if (
    readJson(health).verdicts.find((v) => v.n === 1).why !==
    updateContradiction.reason
  )
    die("audit update: counter result did not reach health before composition");
  if (!readFileSync(updatedRoom, "utf-8").includes(updateContradiction.reason))
    die("audit update: recomposed briefing does not surface the contradiction");
  const beforeMissingResult = readFileSync(health, "utf-8");
  renameSync(counter, counter + ".away");
  r = run([
    "room",
    "update",
    "--manifest",
    manifest,
    "--out",
    updatedRoom,
    "--skip-verify",
    "--counter",
  ]);
  renameSync(counter + ".away", counter);
  if (r.status === 0 || !/counter result missing/.test(r.stderr || ""))
    die("audit update: missing counter result did not fail loud", r);
  if (readFileSync(health, "utf-8") !== beforeMissingResult)
    die("audit update: missing result changed health");

  // R2 (#123 follow-up): `room update --fill`/`--counter` spawn `audit.mjs --apply` as
  // subprocesses; --author-engine/--verifier-engine must reach them, or a scheduled reapply
  // silently stamps no engine at all and every prior hold becomes self-held on the next run.
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("engine fwd: re-plan exit " + r.status, r);
  claimsFill([
    {
      id: "engine-fwd",
      kind: "note",
      text: "Exercises room update --fill/--counter engine forwarding.",
      about: { issue: 1 },
      evidence: [{ type: "issue", ref: "1" }],
    },
  ]);
  const fwdManifest = readJson(briefManifest);
  fwdManifest.programs[0].auditPlan = plan;
  fwdManifest.programs[0].auditFill = fill;
  writeFileSync(briefManifest, JSON.stringify(fwdManifest, null, 2) + "\n");
  r = run([
    "room", "update", "--manifest", briefManifest, "--out", briefRoom,
    "--skip-verify", "--fill", "--author-engine", "fwd-writer",
  ]);
  if (r.status !== 0) die("engine fwd: room update --fill exit " + r.status, r);
  const fwdClaim = readJson(brief).claims.find((c) => c.id === "engine-fwd");
  if (!fwdClaim || !fwdClaim.author || fwdClaim.author.engine !== "fwd-writer")
    die(
      "engine fwd: room update --fill did not forward --author-engine to audit --apply: " +
        JSON.stringify(fwdClaim),
    );
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("engine fwd: counter re-plan exit " + r.status, r);
  const fwdCounter = {
    planHash: readJson(plan).planHash,
    results: readJson(plan)
      .claims.filter((c) => c.kind === "brief-claim" && c.id === "brief:engine-fwd")
      .map((c) => ({
        claimId: c.id,
        verdict: "holds",
        reason: "forwarding check",
        evidence: { type: "file", ref: "src/core/engine.js" },
      })),
  };
  writeFileSync(counter, JSON.stringify(fwdCounter));
  fwdManifest.programs[0].counterResults = counter;
  writeFileSync(briefManifest, JSON.stringify(fwdManifest, null, 2) + "\n");
  r = run([
    "room", "update", "--manifest", briefManifest, "--out", briefRoom,
    "--skip-verify", "--counter", "--verifier-engine", "fwd-verifier",
  ]);
  if (r.status !== 0) die("engine fwd: room update --counter exit " + r.status, r);
  const fwdVerified = readJson(brief).claims.find(
    (c) => c.id === "engine-fwd",
  ).verified;
  if (!fwdVerified || fwdVerified.engine !== "fwd-verifier")
    die(
      "engine fwd: room update --counter did not forward --verifier-engine to audit --apply: " +
        JSON.stringify(fwdVerified),
    );
  writeFileSync(brief, goodBrief);

  // Ritual order (Codex review of #123): `room update --fill` always re-plans from the CURRENT
  // state before applying, so a `--counter` in the SAME invocation can only ever target a plan
  // this process re-plans again right after — never the one a verifier actually saw. Combining
  // the two flags is rejected up front, naming the two-step order instead of failing deep inside
  // audit.mjs with a stale-planHash error.
  const ritualManifest = readJson(briefManifest);
  ritualManifest.programs[0].auditPlan = plan;
  ritualManifest.programs[0].auditFill = fill;
  ritualManifest.programs[0].counterResults = counter;
  writeFileSync(briefManifest, JSON.stringify(ritualManifest, null, 2) + "\n");
  r = run([
    "room",
    "update",
    "--manifest",
    briefManifest,
    "--out",
    briefRoom,
    "--skip-verify",
    "--fill",
    "--counter",
    "--author-engine",
    "claude",
    "--verifier-engine",
    "codex",
  ]);
  if (r.status === 0)
    die("ritual order: combined --fill --counter unexpectedly succeeded");
  if (
    !/--fill and --counter cannot run together/.test(r.stderr || "") ||
    !/--skip-verify --fill --author-engine/.test(r.stderr || "") ||
    !/--skip-verify --counter --verifier-engine/.test(r.stderr || "")
  )
    die(
      "ritual order: combined --fill --counter did not name the two-step order: " +
        r.status +
        " " +
        r.stderr,
    );
  // The two-step order it names actually works end to end: fill lands (author-engine stamped),
  // the verifier counter-verifies the REGENERATED plan, and the counter result applies clean.
  r = run([...briefArgs, "--plan", plan]);
  if (r.status !== 0) die("ritual order: initial plan exit " + r.status, r);
  claimsFill([
    {
      id: "ritual-note",
      kind: "note",
      text: "Exercises the documented two-step fill-then-counter ritual order.",
      about: { issue: 1 },
      evidence: [{ type: "issue", ref: "1" }],
    },
  ]);
  r = run([
    "room", "update", "--manifest", briefManifest, "--out", briefRoom,
    "--skip-verify", "--fill", "--author-engine", "claude",
  ]);
  if (r.status !== 0) die("ritual order: step 1 (room update --fill) exit " + r.status, r);
  const ritualClaim = readJson(brief).claims.find((c) => c.id === "ritual-note");
  if (!ritualClaim || !ritualClaim.author || ritualClaim.author.engine !== "claude")
    die(
      "ritual order: room update --fill did not stamp --author-engine: " +
        JSON.stringify(ritualClaim),
    );
  r = run([...briefArgs, "--plan", plan]); // the verifier re-plans to see the brief just written
  if (r.status !== 0) die("ritual order: verifier re-plan exit " + r.status, r);
  const ritualCounter = {
    planHash: readJson(plan).planHash,
    results: readJson(plan)
      .claims.filter(
        (c) => c.kind === "brief-claim" && c.id === "brief:ritual-note",
      )
      .map((c) => ({
        claimId: c.id,
        verdict: "holds",
        reason: "ritual order hold",
        evidence: { type: "file", ref: "src/core/engine.js" },
      })),
  };
  writeFileSync(counter, JSON.stringify(ritualCounter));
  r = run([
    "room", "update", "--manifest", briefManifest, "--out", briefRoom,
    "--skip-verify", "--counter", "--verifier-engine", "codex",
  ]);
  if (r.status !== 0) die("ritual order: step 2 (room update --counter) exit " + r.status, r);
  const ritualVerified = readJson(brief).claims.find(
    (c) => c.id === "ritual-note",
  ).verified;
  if (!ritualVerified || ritualVerified.engine !== "codex" || ritualVerified.verdict !== "holds")
    die(
      "ritual order: room update --counter did not land the fresh hold: " +
        JSON.stringify(ritualVerified),
    );
  writeFileSync(brief, goodBrief);

  console.log(
    "  ok audit — deterministic offline plan; item-by-item apply that names every refusal in lastApply; findings and keyed signal/milestone evidence expire",
  );
  console.log(
    "  ok brief — claims need a subject and an anchor that can move; caps hold; colour only under a fresh hostile hold; a rewritten claim loses it; a taken decision can be retired; check refuses an unresolvable claim",
  );
}

// Frontmatter is the one document lifecycle source. Superseded UI names and duplicate inline
// statuses are archaeology, not current contracts (#58).
{
  const findings = readFileSync(
    join(HERE, "..", "lib/schema/c4-findings.schema.json"),
    "utf-8",
  );
  const adr = readFileSync(
    join(HERE, "..", "docs/adr/0004-control-room-as-a-forma-rendering.md"),
    "utf-8",
  );
  const scope = readFileSync(join(HERE, "..", "docs/SCOPE-room.md"), "utf-8");
  if (/\bseg\b|superseded/i.test(findings))
    die("doc-prune: findings schema still carries a rejected UI shape");
  if (/^[- ]*\*\*Status:\*\*/m.test(adr))
    die("doc-prune: ADR-0004 duplicates its frontmatter status in the body");
  if (/^Status:\s*\*\*open\*\*/m.test(scope))
    die("doc-prune: SCOPE-room duplicates a stale open status in the body");
  if (
    !/### Success metric[\s\S]*room update[\s\S]*1:1[\s\S]*room-presentable[\s\S]*forma check/.test(
      scope,
    )
  )
    die("success-metric: SCOPE-room has no checkable reconciliation condition");
  if (
    /Parametricity across repos is not proven|A second target repo proving/.test(
      scope,
    )
  )
    die(
      "success-metric: SCOPE-room still calls the completed portfolio proof future work",
    );
  console.log(
    "  ok doc-prune — schemas and governance docs carry only the current shape",
  );
}

// One committer is the solo tier. Governance may keep the external standard as a reference, but
// required CI and its enforcement prose must not claim the retired enterprise/private gate (#60).
{
  const profile = readFileSync(
    join(HERE, "..", "standards/doc-profile"),
    "utf-8",
  );
  const governance = readFileSync(
    join(HERE, "..", "docs/GOVERNANCE.md"),
    "utf-8",
  );
  const agents = readFileSync(join(HERE, "..", "AGENTS.md"), "utf-8");
  const decisions = readFileSync(
    join(HERE, "..", "DECISION_REGISTRY.md"),
    "utf-8",
  );
  if (!/^tier_floor:\s*solo$/m.test(profile))
    die("governance-solo: standards/doc-profile is not pinned to solo");
  if (
    /enterprise column|documentation gates.*blocks|docs-gate.*CI/i.test(
      governance,
    )
  )
    die(
      "governance-solo: GOVERNANCE still claims enterprise/private CI grading",
    );
  if (
    /engines that grade them live in `arbiter` and run in the `docs` CI job/.test(
      agents,
    )
  )
    die("governance-solo: AGENTS still requires the removed private CI job");
  if (
    !/\| D-03 \| Documentation is graded on the \*\*solo\*\*/.test(decisions) ||
    /docs-gate.*CI job/.test(decisions)
  )
    die("governance-solo: D-03 does not describe its actual solo enforcement");
  console.log(
    "  ok governance-solo — policy, profile and CI all describe the solo tier",
  );
}

// I19: the shared schema contract with arbiter. The property under test is not that the gate
// passes today but that it CANNOT pass once a shared shape moves on one side — tampered in both
// directions, the way every other derivation in this suite is proven non-vacuous.
{
  const contractPath = join(HERE, "..", "lib/schema/CONTRACT.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf-8"));
  const owned = contract.schemas.filter((s) => s.owner === "forma");
  if (owned.length === 0)
    die(
      "arbiter-contract: the manifest declares no forma-owned schema, so forma gates nothing",
    );
  for (const entry of owned) {
    const real = join(HERE, "..", entry.ownerPath);
    const actual = createHash("sha256")
      .update(readFileSync(real))
      .digest("hex");
    if (actual !== entry.sha256)
      die(`arbiter-contract: ${entry.ownerPath} does not match its pin`);
  }

  const gate = (dir) =>
    spawnSync(
      process.execPath,
      [
        join(HERE, "..", "scripts/check-arbiter-contract.mjs"),
        "--dir",
        dir,
        "--sibling",
        join(dir, "no-sibling"),
      ],
      { encoding: "utf-8" },
    );

  // A scratch copy so the tamper never touches the real tree.
  const scratch = mkdtempSync(join(tmpdir(), "forma-contract-"));
  mkdirSync(join(scratch, "lib/schema/vendor"), { recursive: true });
  for (const entry of contract.schemas) {
    if (entry.owner !== "forma") continue;
    mkdirSync(dirname(join(scratch, entry.ownerPath)), { recursive: true });
    copyFileSync(
      join(HERE, "..", entry.ownerPath),
      join(scratch, entry.ownerPath),
    );
  }
  copyFileSync(contractPath, join(scratch, "lib/schema/CONTRACT.json"));
  if (gate(scratch).status !== 0)
    die("arbiter-contract: the untampered scratch copy should pass");

  const victim = join(scratch, owned[0].ownerPath);
  writeFileSync(
    victim,
    readFileSync(victim, "utf-8").replace('"title"', '"title_tampered"'),
  );
  const red = gate(scratch);
  if (red.status === 0)
    die(
      "arbiter-contract: editing a forma-owned shared schema did not turn the gate red",
    );
  if (!/re-pin in BOTH/.test(red.stderr))
    die("arbiter-contract: the failure does not name the remedy");

  rmSync(scratch, { recursive: true, force: true });
  console.log(
    "  ok arbiter-contract — a shared shape cannot move on one side and stay green",
  );
}

// §critical-path — CPM over the issue-blocking DAG (#2480 wave 3).
//
// An edge means `from` is blocked by `to`, so `to` is the PREDECESSOR. The six-field float model
// answers two questions a `blocked` boolean cannot: what is on the critical path, and how much can
// a given issue slip before the finish moves. Durations are a NAMED heuristic, never an estimate
// forma invented — that naming is asserted here, because an unlabelled heuristic read as a
// measurement is the failure this whole programme is about.
{
  const snap = (issues, edges, supported = true) => ({
    issues: issues.map(([n, state]) => ({ n, state })),
    dependencies: { supported, complete: true, edges },
  });
  const edge = (from, to) => ({
    from: { repo: "o/r", number: from, url: "u", state: "OPEN" },
    to: { repo: "o/r", number: to, url: "u", state: "OPEN" },
    source: "native",
  });
  const at = (cp, n) => cp.nodes.find((node) => node.n === n);

  // Cannot answer is not the same claim as no critical path (I6/I7).
  if (deriveCriticalPath({ supported: false, edges: [] }, snap([], [])) !== null)
    die("critical-path: an unsupported dependency snapshot must return null, not an empty path");

  // 3 -> 2 -> 1 : a straight chain of three open issues is entirely critical.
  const chain = deriveCriticalPath(
    { supported: true, edges: [edge(1, 2), edge(2, 3)] },
    snap([[1, "OPEN"], [2, "OPEN"], [3, "OPEN"]], []),
  );
  if (chain.projectDurationDays !== 3)
    die("critical-path: a three-open-issue chain must span 3 days, got " + chain.projectDurationDays);
  if (JSON.stringify(chain.criticalPath) !== JSON.stringify([3, 2, 1]))
    die("critical-path: the chain must be reported predecessor-first, got " + JSON.stringify(chain.criticalPath));
  if (chain.nodes.some((node) => !node.isCritical))
    die("critical-path: every node of a single chain is on the critical path");
  if (chain.nodes.some((node) => node.totalFloat !== 0))
    die("critical-path: a node on the critical path has zero total float by definition");
  if (chain.durationModel !== "open-issue-uniform-1d")
    die("critical-path: the duration heuristic must be named in the output, got " + chain.durationModel);

  // A closed blocker is finished: it cannot extend the REMAINING path.
  const withClosed = deriveCriticalPath(
    { supported: true, edges: [edge(1, 2), edge(2, 3)] },
    snap([[1, "OPEN"], [2, "OPEN"], [3, "CLOSED"]], []),
  );
  if (withClosed.projectDurationDays !== 2)
    die("critical-path: a CLOSED blocker must contribute 0 days, got " + withClosed.projectDurationDays);
  if (at(withClosed, 3).duration !== 0)
    die("critical-path: a CLOSED issue must have duration 0");

  // Diamond: 1 blocked by 2 and 3; both blocked by 4. The short arm carries float.
  //   4 -> 2 -> 1
  //   4 -> 3 -> 1   with 3 CLOSED, so the 3-arm is shorter and must float.
  const diamond = deriveCriticalPath(
    { supported: true, edges: [edge(1, 2), edge(1, 3), edge(2, 4), edge(3, 4)] },
    snap([[1, "OPEN"], [2, "OPEN"], [3, "CLOSED"], [4, "OPEN"]], []),
  );
  if (!at(diamond, 2).isCritical)
    die("critical-path: the longer arm of a diamond is critical");
  if (at(diamond, 3).isCritical)
    die("critical-path: the shorter arm of a diamond must NOT be critical");
  if (at(diamond, 3).totalFloat !== 1)
    die("critical-path: the shorter arm must carry exactly 1 day of total float, got " + at(diamond, 3).totalFloat);
  if (at(diamond, 1).isCritical !== true || at(diamond, 4).isCritical !== true)
    die("critical-path: the join and the fork of a diamond are both critical");

  // Free float is not total float: it is the slack that does not disturb any successor.
  if (typeof at(diamond, 3).freeFloat !== "number")
    die("critical-path: every node reports free float, not only total float");

  // A cycle cannot be scheduled. It must be reported and excluded, never hang the derivation.
  const cyclic = deriveCriticalPath(
    { supported: true, edges: [edge(1, 2), edge(2, 1)] },
    snap([[1, "OPEN"], [2, "OPEN"]], []),
  );
  if (!cyclic.cycles.length)
    die("critical-path: a dependency cycle must be reported, not silently scheduled");
  if (cyclic.nodes.some((node) => node.n === 1 || node.n === 2))
    die("critical-path: nodes inside a cycle must be excluded from the schedule");

  // An endpoint this snapshot does not own has no duration we can know. Excluded, and VISIBLY so.
  const foreign = deriveCriticalPath(
    { supported: true, edges: [edge(1, 2), { ...edge(1, 99), to: { repo: "other/repo", number: 99, url: "u", state: "OPEN" } }] },
    snap([[1, "OPEN"], [2, "OPEN"]], []),
  );
  if (foreign.excludedForeign.length !== 1)
    die("critical-path: an edge leaving this snapshot must be counted as excluded, not dropped in silence");

  // Determinism: the same inputs in a different edge order give byte-identical output (I12).
  const forward = deriveCriticalPath(
    { supported: true, edges: [edge(1, 2), edge(2, 3), edge(1, 3)] },
    snap([[1, "OPEN"], [2, "OPEN"], [3, "OPEN"]], []),
  );
  const shuffled = deriveCriticalPath(
    { supported: true, edges: [edge(1, 3), edge(2, 3), edge(1, 2)] },
    snap([[3, "OPEN"], [1, "OPEN"], [2, "OPEN"]], []),
  );
  if (JSON.stringify(forward) !== JSON.stringify(shuffled))
    die("critical-path: edge order changed the derivation — it is not deterministic");

  // No edges at all is a real answer (an empty schedule), not "cannot answer".
  const empty = deriveCriticalPath({ supported: true, edges: [] }, snap([[1, "OPEN"]], []));
  if (empty === null || empty.nodes.length !== 0 || empty.projectDurationDays !== 0)
    die("critical-path: a supported snapshot with no edges is an empty schedule, not null");

  console.log(
    "  ok critical-path — six-field float over the blocking DAG, cycles excluded, heuristic named",
  );
}

// §milestone-path — CPM over arbiter's milestone DAG, and reconciliation (#2480 wave 6).
//
// This is the mutual-extension seam: arbiter owns the plan and emits a machine projection because
// forma has ZERO dependencies and cannot parse YAML. forma derives; it does not restate.
//
// Two rules govern the shape of the answer, and both exist to stop a number reading as more than
// it is:
//   1. Milestone estimates and the issue heuristic are NEVER blended into one figure. A measured
//      estimate_days and a guessed 1-day-per-open-issue mixed together produce something that looks
//      authoritative and is not, so the two paths stay separate and each names its own model.
//   2. A milestone with no estimate is NAMED, and its presence makes the total an explicit LOWER
//      BOUND rather than silently contributing zero.
{
  const proj = (milestones) => ({ schema: "arbiter-milestones-v1", milestones });
  const ms = (id, over = {}) => ({
    id,
    title: `Milestone ${id}`,
    depends_on: [],
    horizon: "next",
    status: "planned",
    ...over,
  });

  // Cannot answer is not the same claim as no path (I6/I7).
  if (deriveMilestonePath(null) !== null)
    die("milestone-path: absent projection must return null, not an empty path");

  const straight = deriveMilestonePath(
    proj([
      ms("MS-01", { estimate_days: 10 }),
      ms("MS-02", { estimate_days: 5, depends_on: ["MS-01"] }),
    ]),
  );
  if (straight.projectDurationDays !== 15)
    die("milestone-path: 10 + 5 in series must span 15 days, got " + straight.projectDurationDays);
  if (straight.durationModel !== "arbiter-estimate-days")
    die("milestone-path: the duration model must be named, got " + straight.durationModel);
  if (straight.isLowerBound !== false)
    die("milestone-path: a fully estimated plan is not a lower bound");
  if (JSON.stringify(straight.criticalPath) !== JSON.stringify(["MS-01", "MS-02"]))
    die("milestone-path: chain must be predecessor-first, got " + JSON.stringify(straight.criticalPath));

  // An unestimated milestone must be NAMED and must make the total honest about being a floor.
  const partial = deriveMilestonePath(
    proj([ms("MS-01", { estimate_days: 10 }), ms("MS-02", { depends_on: ["MS-01"] })]),
  );
  if (!partial.unestimated.includes("MS-02"))
    die("milestone-path: an unestimated milestone must be named, not silently zero");
  if (partial.isLowerBound !== true)
    die("milestone-path: any unestimated node makes the total a LOWER BOUND and must say so");

  // A cycle cannot be scheduled: reported, excluded, never hung on.
  const cyclic = deriveMilestonePath(
    proj([
      ms("MS-01", { estimate_days: 1, depends_on: ["MS-02"] }),
      ms("MS-02", { estimate_days: 1, depends_on: ["MS-01"] }),
    ]),
  );
  if (!cyclic.cycles.length)
    die("milestone-path: a milestone cycle must be reported, not silently scheduled");

  // Determinism (I12): declaration order must not change the answer.
  const forward = deriveMilestonePath(
    proj([ms("MS-01", { estimate_days: 3 }), ms("MS-02", { estimate_days: 4, depends_on: ["MS-01"] })]),
  );
  const reversed = deriveMilestonePath(
    proj([ms("MS-02", { estimate_days: 4, depends_on: ["MS-01"] }), ms("MS-01", { estimate_days: 3 })]),
  );
  if (JSON.stringify(forward) !== JSON.stringify(reversed))
    die("milestone-path: declaration order changed the derivation");

  // ── Reconciliation: the SSOT's CLAIM against what GitHub actually holds ──
  //
  // MILESTONES.yml states that GitHub milestones are a PROJECTION of it and that drift is a
  // finding, never silently resolved in either direction. Drift is exactly this comparison, and it
  // is why the projection has to carry `members` at all.
  const snapshot = {
    issues: [
      { n: 1, ms: "Milestone MS-01" },
      { n: 2, ms: "Milestone MS-01" },
      { n: 9, ms: "Milestone MS-01" },
      { n: 3, ms: null },
    ],
    milestones: [{ title: "Milestone MS-01", open: 3, closed: 0 }],
  };
  const rec = deriveMilestoneReconciliation(
    proj([ms("MS-01", { members: { issues: [1, 2, 7] } })]),
    snapshot,
  );
  const d1 = rec.drift.find((entry) => entry.id === "MS-01");
  if (!d1) die("reconciliation: expected a drift entry for MS-01");
  if (!d1.claimedNotInGithub.includes(7))
    die("reconciliation: issue 7 is claimed by the SSOT but GitHub does not file it there");
  if (!d1.githubNotClaimed.includes(9))
    die("reconciliation: issue 9 sits under the milestone in GitHub but the SSOT does not claim it");

  // The drift a title-only join could never see: an issue filed under the WRONG milestone.
  if (d1.claimedNotInGithub.includes(1) || d1.githubNotClaimed.includes(1))
    die("reconciliation: issue 1 agrees on both sides and must not be reported as drift");

  // A milestone with no GitHub counterpart at all is its own, distinct finding.
  const orphan = deriveMilestoneReconciliation(proj([ms("MS-77", { members: { issues: [5] } })]), snapshot);
  if (!orphan.drift.some((entry) => entry.id === "MS-77" && entry.reason === "no-github-milestone"))
    die("reconciliation: a milestone GitHub has never heard of must be named as such");

  // Agreement is silence: no drift entry when both sides match exactly.
  const clean = deriveMilestoneReconciliation(
    proj([ms("MS-01", { members: { issues: [1, 2, 9] } })]),
    snapshot,
  );
  if (clean.drift.length !== 0)
    die("reconciliation: a milestone whose claim matches GitHub must produce no drift, got " + JSON.stringify(clean.drift));

  console.log(
    "  ok milestone-path — estimates never blended with the heuristic, unestimated named, drift both ways",
  );
}

// §one-cpm — the milestone comment promises code-point order (#133 S4). Both `nodes` and the
// `criticalPath` tie-break must sort ids the way `codepointCompare` does, not the numeric `a - b`
// the code inherited from the issue path (NaN on a string id, which V8's stable sort then leaves in
// whatever order the traversal happened to visit).
//
// M10/M2/M1 in a straight chain does NOT expose the bug for `nodes`/`criticalPath`: these three
// ASCII ids happen to compare the same under UTF-16 code-unit order as under `codepointCompare`, and
// a chain has no tie to break either way. Both assertions below already hold today — kept as
// characterization of the promised behaviour, not as the RED. The cyclic fixture that follows is the
// one that actually fails today: `cycleGroups` reports the cycle in BFS-discovery order (M1, M2,
// M10) instead of code-point order (M1, M10, M2), because its `.sort((a, b) => a - b)` is a no-op
// on strings.
{
  const proj = (milestones) => ({ schema: "arbiter-milestones-v1", milestones });
  const ms = (id, over = {}) => ({ id, title: `Milestone ${id}`, depends_on: [], horizon: "next", status: "planned", estimate_days: 1, ...over });

  const chain = deriveMilestonePath(
    proj([ms("M10", { depends_on: ["M2"] }), ms("M2", { depends_on: ["M1"] }), ms("M1")]),
  );
  const codepointOrder = ["M1", "M10", "M2"];
  if (JSON.stringify(chain.nodes.map((n) => n.id)) !== JSON.stringify(codepointOrder))
    die("one-cpm: milestone nodes must be ordered by codepointCompare, got " + JSON.stringify(chain.nodes.map((n) => n.id)));
  if (JSON.stringify(chain.criticalPath) !== JSON.stringify(["M1", "M2", "M10"]))
    die("one-cpm: milestone criticalPath must be predecessor-first in codepoint order, got " + JSON.stringify(chain.criticalPath));

  // M1 -> M2 -> M10 -> M1: a 3-cycle. BFS from M1 (the codepoint-smallest) discovers M2 then M10,
  // which is NOT codepoint order (M10 < M2). Today's numeric comparator leaves that discovery order
  // untouched; the fix must re-sort the group by codepointCompare.
  const cyclic = deriveMilestonePath(
    proj([ms("M1", { depends_on: ["M10"] }), ms("M2", { depends_on: ["M1"] }), ms("M10", { depends_on: ["M2"] })]),
  );
  if (cyclic.cycles.length !== 1 || JSON.stringify(cyclic.cycles[0]) !== JSON.stringify(["M1", "M10", "M2"]))
    die("one-cpm: a milestone cycle must be reported in codepoint order, got " + JSON.stringify(cyclic.cycles));

  console.log("  ok one-cpm — milestone order and cycle tie-break follow codepointCompare, not a-b");
}

// §one-cpm-astral — criticalChain's tie-break must compare true Unicode scalar values, not UTF-16
// code units (Codex round 1 MEDIUM, #133 S4). An astral id (U+10000, a surrogate PAIR starting with
// the high surrogate U+D800) and a BMP private-use id (U+E000, one code unit) are the textbook case
// codepoint-compare already carries a unit test for: U+D800 < U+E000 as code UNITS, so a naive
// default sort puts the astral id first, but U+10000 > U+E000 as scalar values, so codepointCompare
// puts the private-use id first. Two independent, equally-critical milestones (same estimate, no
// dependency between them) are both heads with zero total float, so the chain's start is exactly
// the tie `criticalChain`'s `heads.sort(cmp)[0]` has to break.
{
  const proj = (milestones) => ({ schema: "arbiter-milestones-v1", milestones });
  const astral = "M" + String.fromCodePoint(0x10000);
  const pua = "M" + String.fromCodePoint(0xe000);
  if ([astral, pua].sort()[0] !== astral)
    die("one-cpm-astral: fixture assumption broke — default UTF-16 sort no longer puts the astral id first");
  if (codepointCompare(pua, astral) !== -1)
    die("one-cpm-astral: fixture assumption broke — codepointCompare no longer ranks the private-use id first");

  const tie = deriveMilestonePath(
    proj([
      { id: astral, title: "a", depends_on: [], horizon: "next", status: "planned", estimate_days: 5 },
      { id: pua, title: "b", depends_on: [], horizon: "next", status: "planned", estimate_days: 5 },
    ]),
  );
  if (JSON.stringify(tie.criticalPath) !== JSON.stringify([pua]))
    die("one-cpm-astral: the tie-break must follow codepointCompare (private-use first), got " + JSON.stringify(tie.criticalPath));

  console.log("  ok one-cpm-astral — criticalChain's tie-break is code-point order, not UTF-16 code-unit order");
}

// §one-cpm-characterization — the issue-DAG `criticalPath` output, captured on a diamond fixture
// BEFORE the CPM core is shared with the milestone path (#133 S4). This is a characterization test:
// it is expected to already be green, and its job is to fail loudly if the refactor changes so much
// as a field order in an output `check.mjs` compares byte-for-byte against what `room` wrote.
{
  const edge = (from, to) => ({
    from: { repo: "o/r", number: from, url: "u", state: "OPEN" },
    to: { repo: "o/r", number: to, url: "u", state: "OPEN" },
    source: "native",
  });
  const snap = (issues, edges, supported = true) => ({
    issues: issues.map(([n, state]) => ({ n, state })),
    dependencies: { supported, complete: true, edges },
  });
  const diamond = deriveCriticalPath(
    { supported: true, edges: [edge(1, 2), edge(1, 3), edge(2, 4), edge(3, 4)] },
    snap([[1, "OPEN"], [2, "OPEN"], [3, "CLOSED"], [4, "OPEN"]], []),
  );
  const expected = '{"durationModel":"open-issue-uniform-1d","projectDurationDays":3,"nodes":[{"n":1,"duration":1,"earlyStart":2,"earlyFinish":3,"lateStart":2,"lateFinish":3,"totalFloat":0,"freeFloat":0,"isCritical":true},{"n":2,"duration":1,"earlyStart":1,"earlyFinish":2,"lateStart":1,"lateFinish":2,"totalFloat":0,"freeFloat":0,"isCritical":true},{"n":3,"duration":0,"earlyStart":1,"earlyFinish":1,"lateStart":2,"lateFinish":2,"totalFloat":1,"freeFloat":1,"isCritical":false},{"n":4,"duration":1,"earlyStart":0,"earlyFinish":1,"lateStart":0,"lateFinish":1,"totalFloat":0,"freeFloat":0,"isCritical":true}],"criticalPath":[4,2,1],"cycles":[],"excludedForeign":[]}';
  if (JSON.stringify(diamond) !== expected)
    die("one-cpm-characterization: issue criticalPath output changed shape, got " + JSON.stringify(diamond));

  console.log("  ok one-cpm-characterization — issue criticalPath output pinned before the CPM refactor");
}

// §ontology-lenses — use cases and runbook coverage, the two surfaces wave 8 gave a home (#2480).
//
// Both arrive as arbiter projections, and the discipline is the one the milestone seam established:
// forma derives what it can SEE and restates nothing arbiter already decided. Two properties are
// computed here because they are questions about the SET, which no row can answer alone — and one
// property is deliberately NOT computed, because arbiter already proved it.
{
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
}

// §lenses — the declared lens partition, and I20: one home per derived surface (#2480 wave 7).
//
// ADR-0008 named six lenses and said the partition "is only real if it is enforced". A partition
// that lives in ~400 lines of DOM code is a convention: two views read `derived.commitDrift`, one
// of them says so in a comment, and nothing goes red. So the partition is DECLARED in lib/lenses.mjs
// and MEASURED out of the viewer, and the two must agree exactly — an unread declaration is a lie
// in the other direction, so the check refuses that too.
{
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
}

// Transactional room update: every writer stays staged until the whole portfolio and its composed
// briefing are valid. A staged read must still retain logical provenance for brief history and
// model evidence handed to a counter-verifier after staging disappears.
{
  const recovery = join(tmp, "room-update-recovery"),
    alpha = join(recovery, "alpha"),
    beta = join(recovery, "beta"),
    manifest = join(recovery, "forma.room.json"),
    room = join(recovery, "room.html");
  cpSync(FIX("room/alpha"), alpha, { recursive: true });
  cpSync(FIX("room/alpha"), beta, { recursive: true });
  writeFileSync(join(alpha, "brief.json"), '{"claims":[]}\n');
  writeFileSync(join(beta, "brief.json"), '{"claims":[]}\n');
  const git = (args) =>
    execFileSync("git", ["-C", alpha, ...args], {
      encoding: "utf-8",
      env: { ...process.env, GIT_AUTHOR_NAME: "Forma", GIT_AUTHOR_EMAIL: "forma@example.test", GIT_COMMITTER_NAME: "Forma", GIT_COMMITTER_EMAIL: "forma@example.test" },
    }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "brief before update"]);
  const previous = git(["rev-parse", "HEAD"]);
  const programs = ["alpha", "beta"].map((id) => ({
    id,
    ghRepo: "acme/alpha",
    repo: id,
    issues: `${id}/issues.json`,
    health: `${id}/health.json`,
    findings: `${id}/findings.json`,
    brief: { path: `${id}/brief.json`, ...(id === "alpha" ? { previous } : {}) },
    auditPlan: `${id}/plan.json`,
    auditFill: `${id}/fill.json`,
  }));
  writeFileSync(manifest, JSON.stringify({ today: "2026-08-10", programs }, null, 2));
  const auditPlan = (id) =>
    run([
      "audit", "--repo", join(recovery, id), "--issues", join(recovery, id, "issues.json"),
      "--health", join(recovery, id, "health.json"), "--findings", join(recovery, id, "findings.json"),
      "--brief", join(recovery, id, "brief.json"), "--today", "2026-08-10", "--blocked-labels", "[]",
      "--plan", join(recovery, id, "plan.json"),
    ]);
  if (auditPlan("alpha").status !== 0 || auditPlan("beta").status !== 0)
    die("recovery: could not make audit plans");
  const thesis = {
    id: "thesis", kind: "thesis", text: "The staged brief is the composed brief.",
    about: { path: "src/core/engine.js" }, evidence: [{ type: "path", ref: "src/core/engine.js" }],
  };
  writeFileSync(join(alpha, "fill.json"), JSON.stringify({ planHash: readJson(join(alpha, "plan.json")).planHash, verdicts: [], findings: [], brief: { claims: [thesis] } }));
  writeFileSync(join(beta, "fill.json"), JSON.stringify({ planHash: "stale", verdicts: [], findings: [] }));
  const beforeAbort = readFileSync(join(alpha, "brief.json"), "utf-8");
  let r = run(["room", "update", "--manifest", manifest, "--out", room, "--skip-verify", "--fill"]);
  if (r.status === 0 || readFileSync(join(alpha, "brief.json"), "utf-8") !== beforeAbort)
    die("recovery: a later programme failure leaked an earlier staged brief", r);
  writeFileSync(join(beta, "fill.json"), JSON.stringify({ planHash: readJson(join(beta, "plan.json")).planHash, verdicts: [], findings: [] }));
  r = run(["room", "update", "--manifest", manifest, "--out", room, "--skip-verify", "--fill"]);
  if (r.status !== 0 || !readFileSync(room, "utf-8").includes(thesis.text))
    die("recovery: successful update did not compose the staged brief", r);
  const rendered = JSON.parse(/window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(readFileSync(room, "utf-8"))[1]).programs.find((p) => p.id === "alpha");
  if (!rendered.derived.briefDelta || !rendered.derived.briefDelta.resolvable || !rendered.derived.briefDelta.added.some((claim) => claim.id === "thesis"))
    die("recovery: staged brief lost its logical previous-path provenance");

  const stagedModel = join(recovery, "model.forma-room.tmp"),
    logicalPlan = join(recovery, "logical-plan.json"), stagedPlan = join(recovery, "staged-plan.json"),
    self = join(HERE, "..");
  copyFileSync(join(self, "docs/architecture/c4-model.json"), stagedModel);
  const auditArgs = ["audit", "--repo", self, "--issues", join(self, "docs/architecture/c4-issues.json"), "--health", join(self, "docs/architecture/c4-health.json"), "--findings", join(self, "docs/architecture/c4-findings.json"), "--topology", join(self, "docs/architecture/c4-topology.json"), "--today", "2026-08-17", "--blocked-labels", "[]"];
  if (run([...auditArgs, "--model", join(self, "docs/architecture/c4-model.json"), "--plan", logicalPlan]).status !== 0 ||
      run([...auditArgs, "--model", stagedModel, "--model-ref", join(self, "docs/architecture/c4-model.json"), "--plan", stagedPlan]).status !== 0)
    die("recovery: could not make logical and staged model plans");
  if (readJson(logicalPlan).planHash !== readJson(stagedPlan).planHash || readFileSync(stagedPlan, "utf-8").includes("model.forma-room.tmp"))
    die("recovery: staged model leaked into counter-plan evidence or hash");

  const cold = join(recovery, "cold"), coldManifest = join(recovery, "cold.json"), coldRoom = join(recovery, "cold.html");
  cpSync(FIX("room/alpha"), cold, { recursive: true });
  rmSync(join(cold, "health.json"));
  rmSync(join(cold, "findings.json"));
  mkdirSync(join(cold, "docs/architecture"), { recursive: true });
  writeFileSync(join(cold, "docs/architecture/c4-brief.json"), '{"claims":[]}\n');
  writeFileSync(coldManifest, JSON.stringify({ today: "2026-08-10", programs: [{ id: "cold", ghRepo: "acme/alpha", repo: "cold", issues: "cold/issues.json", health: "cold/health.json", findings: "cold/findings.json", auditPlan: "cold/plan.json", auditFill: "cold/fill.json" }] }));
  r = run(["audit", "--repo", cold, "--issues", join(cold, "issues.json"), "--health", join(cold, "health.json"), "--findings", join(cold, "findings.json"), "--today", "2026-08-10", "--blocked-labels", "[]", "--plan", join(cold, "plan.json")]);
  writeFileSync(join(cold, "fill.json"), JSON.stringify({ planHash: readJson(join(cold, "plan.json")).planHash, verdicts: [], findings: [] }));
  r = run(["room", "update", "--manifest", coldManifest, "--out", coldRoom, "--skip-verify", "--fill"]);
  if (r.status !== 0 || !existsSync(join(cold, "health.json")) || !existsSync(join(cold, "findings.json")))
    die("recovery: first audit could not create declared absent overlays", r);
  const coldRendered = JSON.parse(/window\.__ROOM__ = ([\s\S]*?);\s*<\/script>/.exec(readFileSync(coldRoom, "utf-8"))[1]).programs[0];
  if (coldRendered.brief !== null)
    die("recovery: an undeclared default brief leaked into the composed room");
  console.log("  ok recovery — staged facts roll back together, compose retains logical provenance, and absent overlays bootstrap");
}

// Production recovery: aliased output paths must collide before any verifier can write, and the
// package guard must cover the current 43-file runtime surface.
{
  const target = join(tmp, "allowlist-target.json"), alias = join(tmp, "allowlist-alias.json");
  writeFileSync(target, "{}\n"); symlinkSync(target, alias);
  if (canonicalPath(target) !== canonicalPath(alias)) die("release: canonicalPath missed a symlink alias");
  const guard = spawnSync(process.execPath, [join(HERE, "..", "scripts", "check-clean.mjs")], { encoding: "utf-8" });
  if (guard.status !== 0 || !/43 reviewed runtime files, clean/.test(guard.stderr || "")) die("release: current 43-file runtime allowlist is not clean", guard);
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: join(HERE, ".."), encoding: "utf-8" });
  const packJson = (packed.stdout || "").slice((packed.stdout || "").indexOf("[\n"));
  let packMeta;
  try { packMeta = JSON.parse(packJson)[0]; } catch { packMeta = null; }
  if (packed.status !== 0 || !packMeta || packMeta.entryCount !== 43 || !packMeta.files.some(({ path }) => path === "lib/roomupdate.mjs"))
    die("release: npm pack effective file set is not the reviewed 43-file runtime surface", packed);
  console.log("  ok production-recovery — symlink aliases canonicalize and the reviewed 43-file runtime allowlist is enforced");
}

// #140 S3 F7: evidence hashing/staleness primitives live in lib/evidence.mjs, not lib/audit.mjs —
// roomderive.mjs/roomdocs.mjs/verify.mjs/check.mjs/room-presentable.mjs must import them from
// there, never reach back into the audit plan/apply channel for functions that have nothing to
// do with it.
{
  const evidenceImporters = [
    "lib/roomderive.mjs",
    "lib/roomdocs.mjs",
    "lib/verify.mjs",
    "lib/check.mjs",
    "scripts/room-presentable.mjs",
  ];
  for (const rel of evidenceImporters) {
    const src = readFileSync(join(HERE, "..", rel), "utf-8");
    if (/from ['"](\.\.\/lib\/|\.\/)?audit\.mjs['"]/.test(src))
      die(`import-graph: ${rel} must not import from audit.mjs (evidence primitives moved to evidence.mjs)`);
    if (!/from ['"](\.\.\/lib\/|\.\/)?evidence\.mjs['"]/.test(src))
      die(`import-graph: ${rel} must import evidence primitives from evidence.mjs`);
  }
  console.log("  ok import-graph — roomderive/roomdocs/verify/check/room-presentable import evidence primitives from evidence.mjs, not audit.mjs");
}

// F2 unit pin: `codepointCompare` must order true Unicode SCALAR values, not UTF-16 code units.
// Plain `<`/`>` on strings compares code units, which puts every astral character (a surrogate
// pair, U+10000 and up) before any BMP character in U+E000..U+FFFF — backwards from scalar order.
// Also pins that it does not reproduce ICU's NUL-ignoring defect (`("r"+NUL+"2").localeCompare("r2")
// === 0`, the exact case the audit measured against `verify.mjs`'s edge sort).
{
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
}

// F2: `localeCompare` is locale-dependent — sorting non-ASCII, mixed-case ids/titles under a
// Swedish collation locale gives a different order than under `C`. Every site the audit named
// (`deriveMilestones`, `deriveUseCases`, `deriveRunbooks`, `deriveMilestonePath`,
// `deriveMilestoneReconciliation`) must sort by codepoint, so the JSON they emit is byte-identical
// regardless of the runtime locale — reverting any one of the five back to `localeCompare` must
// fail this probe.
{
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
}

// F2 (verify.mjs edge sort): one issue blocked by four external endpoints sharing the same
// number, whose repo names differ only by case/diacritic. The sort key's deciding component is
// that diacritic-sensitive string, so `dependencies.edges` must come out byte-identical across
// locales — reverting `verify.mjs`'s edge sort to `localeCompare` must fail this probe.
{
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
}

// §s2-fail-closed (audit 2026-09-14, S2) — five silent-default paths that used to fail open now
// fail closed: an opt-in-by-presence arbiter path that names nothing, a schema keyword the engine
// silently ignores, an unmeasured issue↔code link presented as a measured zero, a transport failure
// mistaken for "dependency fields unsupported", and a source directory the coverage scanner cannot
// even read.

// F3a: `arbiter.milestones` is opt-in BY PRESENCE — an empty string names no projection but is not
// absent either, and the schema's own `minLength: 1` must reject it, not read it as undeclared.
{
  const roomSchema = new URL("../lib/schema/forma.room.schema.json", import.meta.url);
  const manifest = {
    today: "2026-01-01",
    programs: [{ id: "p", ghRepo: "acme/p", repo: ".", issues: "issues.json", arbiter: { milestones: "" } }],
  };
  const errs = validateModel(manifest, roomSchema);
  if (!errs.length || !errs.some((e) => /milestones/.test(e)))
    die("S2 F3a: an empty-string arbiter.milestones must fail manifest validation, got " + JSON.stringify(errs));
  console.log("  ok s2-fail-closed-1 — empty-string arbiter.milestones fails schema validation");
}

// F3b: an unsupported JSON-Schema keyword (patternProperties, oneOf, allOf, external $ref, tuple
// items, dependencies…) must make validateModel refuse the SCHEMA, not silently under-validate the
// model against it. The five shipped schemas must trip no guard — the supported set is complete.
{
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
}

// F4/D-5: a programme whose repo is not a git checkout gets `linked.error` from linkIssuesToNodes.
// deriveAll must carry that error into `derived.link.error` and turn `coverage` into an unmeasured
// null — not a measured "0% linked" the briefing would show as if it had counted something.
{
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
}

// F5: a transport failure (auth, network, rate limit) on the dependency-enabled GraphQL query must
// not be mistaken for "this API has no dependency fields" — that class alone may retry without
// dependencies. A transport failure must fail `verify` outright and leave every file untouched.
{
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
}

// F14: SOURCE COVERAGE must fail loud on a directory it cannot read, not treat it as though it
// held no recognised files (fail open). Skipped under uid 0, where chmod 000 does not deny reads.
{
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
}

// §s2-round1 (Codex review of #127, round 1) — five more silent-default paths found in the S2 fix
// itself: portfolio link coverage skipped the same `linked.error` guard the per-programme path
// uses, an unrelated auth/transport error matched the "unsupported field" regex by wording alone,
// tuple-form `items` was neither rejected nor validated, an unreadable directory entry was
// skipped silently instead of failing the coverage scan, and string length was counted in UTF-16
// units instead of code points.

// HIGH-1: derivePortfolio must gate `linkCoverage` on `!linked.error` exactly like deriveAll's own
// per-programme `coverage` does (roomderive.mjs:827) — an unreadable git history is unmeasured,
// never a measured 0%.
{
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
}

// #132: `link.error` gates coverage/linkCoverage already (S2/S2R1 above), but deriveCheckpoints and
// the portfolio's workPerNode/blocked-nodes/landing still read the empty byIssue/datesByIssue maps
// as if they were measured, presenting per-node work, landing and checkpoint completion as zero
// instead of unknown (I6). Same not-a-checkout fixture as s2-fail-closed-3/s2-round1-1, root-proof.
{
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
}

// #132 round 1 (Codex review, HIGH): the landing chart only mounted when `summary.closed` was
// nonzero, so an all-open programme with an unreadable git history never showed the honest null
// this fix computes — the data said "not measured" but the screen said nothing. Composed through
// the real `forma room` + `forma check --room` chain (not just deriveAll/derivePortfolio), and the
// shipped viewer source is lifted and RUN against that exact data, so the assertion is on what a
// reader would actually see, not just on the JSON the viewer reads. This test fails without the
// `landingEntry`/mount-condition fix: the lifted `mountLanding` would leave `ev` empty.
{
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
}

// HIGH-2: an auth/permission error worded like GitHub's real "Resource not accessible by
// integration" must NOT be read as "dependency fields unsupported" — only a field-specific
// GraphQL error naming blockedBy/blocking may enable the no-dependencies fallback.
{
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
}

// HIGH-3: tuple-form `items: [...]` must be rejected as an unsupported schema keyword, not
// silently allowed through as if it were the single-schema form.
{
  const badSchema = join(tmp, "s2r1-tuple-items.schema.json");
  writeFileSync(badSchema, JSON.stringify({ type: "array", items: [{ type: "string" }, { type: "number" }] }));
  const errs = validateModel(["a", 1], new URL("file://" + badSchema));
  if (!errs.length || !errs.some((e) => /unsupported schema keyword "items"/.test(e)))
    die("S2R1 HIGH-3: tuple-form items must be refused as an unsupported schema keyword, got " + JSON.stringify(errs));
  console.log("  ok s2-round1-3 — tuple-form items is refused, not silently allowlisted");
}

// MEDIUM-4: SOURCE COVERAGE must fail on a directory entry it cannot `statSync`, not skip it
// silently. A dangling symlink reproduces this without chmod (root-proof).
{
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
}

// MEDIUM-5: minLength/maxLength must count Unicode code points, not UTF-16 code units — an astral
// character (surrogate pair) is one character, not two.
{
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
}

// F13 — `forma serve` (the static doc viewer, distinct from `room --serve`) must bind loopback
// only and answer a malformed URI with 400 instead of dying: `decodeURIComponent` throws on a lone
// `%` escape and used to take the whole process down with it.
{
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
}

// F12 — an unknown flag must fail loud (exit 1), not be silently ignored. `room.mjs`/`audit.mjs`
// already reject unknown flags; gen/check/verify/init/serve did not.
{
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
}

// Codex round 1 HIGH — parseArgs({strict:true}) only rejects an UNKNOWN flag; the retained raw
// `process.argv.indexOf('--key')` readers never matched a `--key=value` token, so a KNOWN flag
// given in that form was silently ignored and fell back to its default. `forma check
// --repo=/bad --model=/bad --topology=/bad` therefore graded the CURRENT repo (cwd), not /bad.
{
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
}

// Codex round 1 MEDIUM — `room update` still parsed and forwarded `--limit`, though the flag was
// removed from `verify`; strict parsing was added everywhere else but not here.
{
  const SCRATCH_OUT = join(tmp, "limit-strict-out.html");
  const r = run(["room", "update", "--manifest", "forma.room.json", "--out", SCRATCH_OUT, "--skip-verify", "--limit", "5"]);
  if (r.status === 0) die("limit-strict: room update --limit must exit 1 (the flag was removed, not just unforwarded)", r);
  console.log("  ok limit-strict — room update --limit is an unknown flag now, not a silently-accepted dead one");
}

// Codex round 1 LOW — the DRILL label must be a real localization (it differs from en), and must
// actually be rendered through STR.drillLabel rather than sitting in the table unread.
// (F20's read-only-install case is not covered by a test — see HANDOFF.md.)
{
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
}

// S7 doc drift — ARCHITECTURE.md's Level 3 module table must name every lib/*.mjs module, and its
// stated count must match the real file count. This is a source-of-truth check on the table only
// (sliced between the two known headings), not a whole-file grep, so a basename mentioned in prose
// elsewhere does not pass this test falsely.
{
  const archPath = join(HERE, "..", "docs/architecture/ARCHITECTURE.md");
  const arch = readFileSync(archPath, "utf-8");
  const heading = "### Level 3: engine modules";
  const start = arch.indexOf(heading);
  if (start === -1) die("architecture-module-table: missing the '" + heading + "' heading");
  const end = arch.indexOf("\n## ", start);
  const section = arch.slice(start, end === -1 ? undefined : end);
  const countMatch = section.match(/The (\d+) top-level `lib\/\*\.mjs` modules/);
  if (!countMatch) die("architecture-module-table: missing the 'The N top-level lib/*.mjs modules' sentence");
  const modules = readdirSync(join(HERE, "..", "lib"))
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  // Only real Markdown table rows count (`| \`name.mjs\` | …`), so a prose mention cannot stand in
  // for a missing row.
  const rows = new Set(
    [...section.matchAll(/^\|\s*`([^`]+\.mjs)`\s*\|/gm)].map((m) => m[1]),
  );
  const missing = modules.filter((f) => !rows.has(f));
  if (missing.length) die("architecture-module-table: missing rows for " + missing.join(", "));
  if (Number(countMatch[1]) !== modules.length)
    die(
      "architecture-module-table: stated count " + countMatch[1] + " does not match the actual " + modules.length + " lib/*.mjs modules",
    );
  console.log("  ok architecture-module-table — every lib/*.mjs module is in ARCHITECTURE.md's table, count matches");
}

console.log(
  // gen/overlays/viewer/model moved to test/*.test.mjs (S5 PR1, #144); this file now covers the rest.
  "OK — arbiter-contract, room, rtm, views, scan, serve, serve-cli, strict-flags, equals-flags, limit-strict, drill-label, markdown, strings, rtm-dogfood, lenses, codepoint-compare, locale, s2-fail-closed, s2-round1, architecture-module-table all green.",
);
