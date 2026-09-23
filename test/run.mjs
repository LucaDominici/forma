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
  deriveAll,
  deriveCriticalPath,
  deriveMilestonePath,
  deriveMilestoneReconciliation,
  deriveUseCases,
  deriveRunbooks,
  derivePortfolio,
} from "../lib/roomderive.mjs";
import { codepointCompare } from "../lib/evidence.mjs";
import { canonicalPath } from "../lib/roomload.mjs";
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
  // gen/overlays/viewer/model moved to test/*.test.mjs (S5 PR1); room/briefing/repo moved to
  // test/*.test.mjs (S5 PR2); this file now covers the rest.
  "OK — arbiter-contract, serve-cli, strict-flags, equals-flags, limit-strict, drill-label, lenses, codepoint-compare, locale, s2-fail-closed, s2-round1, architecture-module-table all green.",
);
