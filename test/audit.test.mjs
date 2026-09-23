#!/usr/bin/env node
// The audit/brief channel: offline plan authoring, agent fill, and validation before either
// evidence overlay is replaced.
import test, { describe } from "node:test";

import { execFileSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, renameSync } from "node:fs";
import { join } from "node:path";

import { HERE, FIX, freshTmp, run, die, readJson } from "./helpers.mjs";

const tmp = freshTmp();

describe("audit", () => {
  // The audit channel is the producer for both evidence overlays: plan offline, let an agent fill
  // the JSON contract, then validate everything before either file is replaced (#65).
  test("audit: audit/brief", async () => {
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
  });
});
