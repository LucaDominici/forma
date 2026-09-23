#!/usr/bin/env node
// The critical-path/milestone-path derivations, one-cpm edge cases, and recovery from a broken
// or missing evidence overlay.
import test, { describe } from "node:test";

import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

import {
  deriveCriticalPath,
  deriveMilestonePath,
  deriveMilestoneReconciliation,
} from "../lib/roomderive.mjs";
import { codepointCompare } from "../lib/evidence.mjs";
import { canonicalPath } from "../lib/roomload.mjs";

import { HERE, FIX, freshTmp, run, die, readJson } from "./helpers.mjs";

const tmp = freshTmp();

describe("plan", () => {
  // §critical-path — CPM over the issue-blocking DAG (#2480 wave 3).
  //
  // An edge means `from` is blocked by `to`, so `to` is the PREDECESSOR. The six-field float model
  // answers two questions a `blocked` boolean cannot: what is on the critical path, and how much can
  // a given issue slip before the finish moves. Durations are a NAMED heuristic, never an estimate
  // forma invented — that naming is asserted here, because an unlabelled heuristic read as a
  // measurement is the failure this whole programme is about.
  test("plan: critical-path", async () => {
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
  });

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
  test("plan: milestone-path", async () => {
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
  });

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
  test("plan: one-cpm", async () => {
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
  });

  // §one-cpm-astral — criticalChain's tie-break must compare true Unicode scalar values, not UTF-16
  // code units (Codex round 1 MEDIUM, #133 S4). An astral id (U+10000, a surrogate PAIR starting with
  // the high surrogate U+D800) and a BMP private-use id (U+E000, one code unit) are the textbook case
  // codepoint-compare already carries a unit test for: U+D800 < U+E000 as code UNITS, so a naive
  // default sort puts the astral id first, but U+10000 > U+E000 as scalar values, so codepointCompare
  // puts the private-use id first. Two independent, equally-critical milestones (same estimate, no
  // dependency between them) are both heads with zero total float, so the chain's start is exactly
  // the tie `criticalChain`'s `heads.sort(cmp)[0]` has to break.
  test("plan: one-cpm-astral", async () => {
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
  });

  // §one-cpm-characterization — the issue-DAG `criticalPath` output, captured on a diamond fixture
  // BEFORE the CPM core is shared with the milestone path (#133 S4). This is a characterization test:
  // it is expected to already be green, and its job is to fail loudly if the refactor changes so much
  // as a field order in an output `check.mjs` compares byte-for-byte against what `room` wrote.
  test("plan: one-cpm-characterization", async () => {
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
  });

  // Transactional room update: every writer stays staged until the whole portfolio and its composed
  // briefing are valid. A staged read must still retain logical provenance for brief history and
  // model evidence handed to a counter-verifier after staging disappears.
  test("plan: recovery", async () => {
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
  });

  // Production recovery: aliased output paths must collide before any verifier can write, and the
  // package guard must cover the current 43-file runtime surface.
  test("plan: production-recovery", async () => {
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
  });
});
