#!/usr/bin/env node
// §7 enrich, WP-A overlays (status/apply/verify), the offline agent stub.
import test, { describe } from "node:test";

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";

import { join, dirname } from "node:path";

import { validateModel } from "../lib/validate.mjs";

import { deriveDependencies } from "../lib/roomderive.mjs";

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

describe("overlays", () => {
  test("overlays: enrich", async () => {
    const REPO = FIX("mini"),
      topo = join(tmp, "en-topo.json"),
      model = join(tmp, "en-model.json");
    run(["init", "--repo", REPO, "--out", topo, "--force"]);
    run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    const holes = readJson(model).nodes.filter(
      (n) => n.descSource === "fallback" && n.kind === "leaf",
    );
    if (!holes.length)
      die("§7 precondition: mini has no fallback leaf holes to enrich");
    let r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      model,
      "--enrich",
      "--enricher",
      "echo",
    ]);
    if (r.status !== 0) die("§7 enrich gen exit " + r.status, r);
    const enr = readJson(model);
    const hole = enr.nodes.find((n) => n.id === holes[0].id);
    if (
      !(
        hole.descSource === "llm" &&
        hole.descInputHash &&
        hole.func === "Auto-described (test enricher)."
      )
    )
      die("§7: hole not enriched (want llm + hash + func)");
    if (
      enr.nodes.some(
        (n) =>
          n.func === "Auto-described (test enricher)." && n.descSource !== "llm",
      )
    )
      die("§7: enricher wrote to a non-hole node");
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("§7: check after enrich (no network expected)", r);
    // sticky: a plain regen (no --enrich) preserves the cached llm prose on unchanged inputs
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("§7 regen exit " + r.status, r);
    if (
      readJson(model).nodes.find((n) => n.id === holes[0].id).descSource !== "llm"
    )
      die("§7: cache-merge did not preserve enrichment across a plain regen");

    // R5: stale prose survives a failed refill — a network outage must never make a box worse.
    const corrupt = readJson(model);
    corrupt.nodes.find((n) => n.id === holes[0].id).descInputHash = "stale";
    writeFileSync(model, JSON.stringify(corrupt, null, 2) + "\n");
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("R5 regen exit " + r.status, r);
    let n5 = readJson(model).nodes.find((n) => n.id === holes[0].id);
    if (
      !(n5.descSource === "llm" && n5.func === "Auto-described (test enricher).")
    )
      die("R5: stale llm prose dropped on a plain regen");
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0)
      die("R5: stale enrichment must stay advisory, not a gate failure", r);
    if (!/enrichment stale/.test(r.stderr || ""))
      die("R5: check did not warn about the stale enrichment");
    // enricher unreachable (unknown provider ⇒ same code path, zero network): prose still stands
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
      "nope",
    ]);
    if (r.status !== 0) die("R5: a failing enricher must not abort gen", r);
    n5 = readJson(model).nodes.find((n) => n.id === holes[0].id);
    if (n5.func !== "Auto-described (test enricher).")
      die("R5: prose lost when the enricher was unreachable");
    // ...and a working enricher DOES refresh it (stale entries must stay refillable)
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
      "echo",
    ]);
    if (r.status !== 0) die("R5 refill exit " + r.status, r);
    n5 = readJson(model).nodes.find((n) => n.id === holes[0].id);
    if (n5.descInputHash === "stale")
      die(
        "R5: a stale hash was never refreshed — the node is stuck stale forever",
      );
    console.log(
      `  ok enrich — §7 filled ${holes.length} hole(s) offline; cache-merge sticky; R5 stale prose survives + refills`,
    );
  });
  test("overlays: status-overlay", async () => {
    const repo = join(tmp, "overlay-repo");
    cpSync(FIX("mini"), repo, { recursive: true });
    const topo = join(tmp, "ov-topo.json"),
      model = join(tmp, "ov-model.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("overlay init exit " + r.status, r);
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("overlay gen exit " + r.status, r);
    const target = readJson(model).nodes.find((n) => n.kind === "container");
    const ovFile = join(repo, "docs/architecture/c4-status.json");
    mkdirSync(dirname(ovFile), { recursive: true });
    const overlay = (patch) =>
      writeFileSync(
        ovFile,
        JSON.stringify({ nodes: { [target.id]: patch } }, null, 2),
      );
    // the default path is picked up with no flag at all
    overlay({
      status2: "in-progress",
      completion: 60,
      statusWord: "v2 in corso",
      current: "Live on ACA.",
      target: "Multi-surface.",
      verify: { source: "ADR-040" },
      issues: ["#534"],
    });
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("overlay gen (decorated) exit " + r.status, r);
    const dec = readJson(model).nodes.find((n) => n.id === target.id);
    if (
      !(
        dec.status2 === "in-progress" &&
        dec.completion === 60 &&
        dec.statusWord === "v2 in corso" &&
        dec.current === "Live on ACA."
      )
    )
      die("WP-A1: overlay did not decorate the node: " + JSON.stringify(dec));
    if (dec.func !== target.func)
      die("WP-A1: overlay must not touch func (docs own it)");
    if (readJson(model).source.statusPath !== "docs/architecture/c4-status.json")
      die("WP-A1: statusPath not recorded in the model");
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("WP-A1: check should PASS with a valid overlay", r);
    // `current` is no longer stuffed with "Exists: <path>" — undecorated nodes leave it to func
    if (readJson(model).nodes.some((n) => /^Exists: /.test(n.current || "")))
      die('WP-A1: the "Exists: <path>" filler is back in current');
    // form errors fail LOUD at gen: forbidden field, bad enum, malformed issue, unknown id
    for (const [label, patch] of [
      ["func", { func: "nope" }],
      ["status2", { status2: "almost" }],
      ["completion", { completion: 140 }],
      ["issues", { issues: ["bug-12"] }],
    ]) {
      overlay(patch);
      r = run([
        "gen",
        "--repo",
        repo,
        "--topology",
        topo,
        "--out",
        join(tmp, "ov-bad.json"),
      ]);
      if (r.status === 0)
        die(`WP-A1: an invalid ${label} in the overlay must fail gen`);
    }
    writeFileSync(
      ovFile,
      JSON.stringify({ nodes: { ghost__node: { statusWord: "x" } } }, null, 2),
    );
    r = run([
      "gen",
      "--repo",
      repo,
      "--topology",
      topo,
      "--out",
      join(tmp, "ov-bad.json"),
    ]);
    if (r.status === 0)
      die("WP-A1: an unknown node id in the overlay must fail gen");
    // and the gate catches it even without a regen (the model still points at the overlay)
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status === 0)
      die(
        "WP-A1: check stayed green on an overlay decorating a node that does not exist",
      );
    console.log(
      "  ok status-overlay — WP-A1 decorates by id, refuses func/bad enums/orphan ids; gate catches a stale overlay",
    );
  });
  test("overlays: status-apply", async () => {
    const repo = join(tmp, "sa-repo");
    cpSync(FIX("mini"), repo, { recursive: true });
    const topo = join(tmp, "sa-topo.json"),
      model = join(tmp, "sa-model.json");
    const ovFile = join(repo, "docs/architecture/c4-status.json");
    const fill = join(tmp, "sa-fill.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("A7 init exit " + r.status, r);
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("A7 gen exit " + r.status, r);
    const cont = readJson(model).nodes.find((n) => n.kind === "container");
    if (!cont) die("A7: no container in the model");
    if (cont.status2 !== "unknown")
      die(
        "A7 precondition: mini should have no verdict before the apply, got " +
          cont.status2,
      );

    // mini has no docs/architecture/ at all: the FIRST apply is the one that creates the overlay
    writeFileSync(
      fill,
      JSON.stringify({
        nodes: {
          [cont.id]: {
            status2: "in-progress",
            completion: 40,
            current: "Two of five modules landed.",
          },
        },
      }),
    );
    r = run([
      "gen",
      "--repo",
      repo,
      "--topology",
      topo,
      "--out",
      model,
      "--status-apply",
      fill,
    ]);
    if (r.status !== 0) die("A7 apply exit " + r.status, r);
    const dec = readJson(model).nodes.find((n) => n.id === cont.id);
    if (!(dec.status2 === "in-progress" && dec.completion === 40))
      die("A7: applied state did not reach the model: " + JSON.stringify(dec));
    if (!readJson(ovFile).nodes[cont.id])
      die("A7: --status-apply did not write the curated overlay file");
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("A7: check must pass on an applied overlay", r);

    // merge, not overwrite: a second apply touching another field keeps the first
    writeFileSync(
      fill,
      JSON.stringify({ nodes: { [cont.id]: { statusWord: "40%" } } }),
    );
    r = run([
      "gen",
      "--repo",
      repo,
      "--topology",
      topo,
      "--out",
      model,
      "--status-apply",
      fill,
    ]);
    if (r.status !== 0) die("A7 merge exit " + r.status, r);
    const merged = readJson(ovFile).nodes[cont.id];
    if (!(merged.statusWord === "40%" && merged.status2 === "in-progress"))
      die(
        "A7: the second apply overwrote the first instead of merging: " +
          JSON.stringify(merged),
      );

    // every refusal must leave the committed overlay byte-identical
    const before = readFileSync(ovFile, "utf-8");
    for (const [label, patch] of [
      ["a bad enum", { status2: "almost" }],
      ["an out-of-range completion", { completion: 140 }],
      ["func", { func: "nope" }],
      ["a malformed issue", { issues: ["bug-12"] }],
      ["a non-object patch", "done"],
    ]) {
      writeFileSync(fill, JSON.stringify({ nodes: { [cont.id]: patch } }));
      r = run([
        "gen",
        "--repo",
        repo,
        "--topology",
        topo,
        "--out",
        join(tmp, "sa-bad.json"),
        "--status-apply",
        fill,
      ]);
      if (r.status === 0) die(`A7: --status-apply accepted ${label}`);
      if (readFileSync(ovFile, "utf-8") !== before)
        die(
          `A7: --status-apply wrote to the overlay before rejecting ${label} — a committed file was corrupted`,
        );
    }
    writeFileSync(
      fill,
      JSON.stringify({ nodes: { ghost__node: { statusWord: "x" } } }),
    );
    r = run([
      "gen",
      "--repo",
      repo,
      "--topology",
      topo,
      "--out",
      join(tmp, "sa-bad.json"),
      "--status-apply",
      fill,
    ]);
    if (r.status === 0)
      die("A7: --status-apply accepted an id the model does not have");
    if (readFileSync(ovFile, "utf-8") !== before)
      die(
        "A7: --status-apply wrote to the overlay before rejecting an unknown id",
      );

    // and the two other holes this branch closes. `sa-repo` is a plain copy with no git remote, so
    // it must carry NO ghRepo — a fabricated one would send `forma verify` at the wrong repository.
    if ("ghRepo" in readJson(topo).meta)
      die(
        "A7: init invented a ghRepo for a directory with no git remote: " +
          JSON.stringify(readJson(topo).meta.ghRepo),
      );
    const selfTopo = join(tmp, "sa-self-topo.json");
    r = run(["init", "--repo", join(HERE, ".."), "--out", selfTopo, "--force"]);
    if (r.status !== 0) die("A7 self init exit " + r.status, r);
    if (!/^[\w.-]+\/[\w.-]+$/.test(readJson(selfTopo).meta.ghRepo || ""))
      die(
        "A7: init did not seed meta.ghRepo from the git remote, got " +
          JSON.stringify(readJson(selfTopo).meta.ghRepo),
      );
    const cats = [
      ...new Set(
        readJson(model)
          .nodes.filter((n) => n.kind === "leaf")
          .map((n) => n.category),
      ),
    ];
    if (cats.includes("container"))
      die(
        "A7: leaf category is still the parent's KIND — the viewer collapses every leaf into one box: " +
          JSON.stringify(cats),
      );
    console.log(
      `  ok status-apply — WP-A7 fill → curated overlay; merges, refuses without writing; init seeds ghRepo; leaf categories ${JSON.stringify(cats)}`,
    );
  });
  test("overlays: verify", async () => {
    const repo = join(tmp, "verify-repo");
    cpSync(FIX("mini"), repo, { recursive: true });
    const topo = join(tmp, "vf-topo.json"),
      model = join(tmp, "vf-model.json");
    let r = run(["init", "--repo", repo, "--out", topo, "--force"]);
    if (r.status !== 0) die("verify init exit " + r.status, r);
    // the overlay is how issues reach the model (WP-A1): one node on a closed issue, one on an open one
    const t = readJson(topo);
    const [c1, c2] = t.nodes.filter((n) => n.kind === "container");
    mkdirSync(join(repo, "docs/architecture"), { recursive: true });
    writeFileSync(
      join(repo, "docs/architecture/c4-status.json"),
      JSON.stringify(
        {
          nodes: {
            [c1.id]: {
              issues: ["#7"],
              current: "Was in progress.",
              statusWord: "NEXT",
            },
            [c2.id]: {
              issues: ["#8"],
              current: "Still open.",
              statusWord: "NEXT",
            },
          },
        },
        null,
        2,
      ),
    );
    r = run(["gen", "--repo", repo, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("verify gen exit " + r.status, r);
    const GH = process.execPath + " " + join(HERE, "stub-gh.mjs") + " multi";
    const SIGNALS = ["--workflow", "ci=.github/workflows/ci.yml", "--release"];
    const openBefore = JSON.stringify(
      readJson(model).nodes.find((n) => n.id === c2.id),
    );
    r = run([
      "verify",
      "--repo",
      repo,
      "--model",
      model,
      "--gh-repo",
      "acme/thing",
      "--gh-cmd",
      GH,
      ...SIGNALS,
    ]);
    if (r.status !== 0) die("WP-A5: verify exit " + r.status, r);
    let v = readJson(model);
    const snapshot = readJson(join(repo, "docs/architecture/c4-issues.json"));
    const done = v.nodes.find((n) => n.id === c1.id),
      open = v.nodes.find((n) => n.id === c2.id);
    if (
      snapshot.issues.map((it) => it.n).join() !== "7,8,9" ||
      snapshot.collection.pagination !== "gh api graphql --paginate --slurp"
    )
      die("verify: GraphQL pagination did not publish both pages");
    if (
      !Array.isArray(snapshot.milestones) ||
      snapshot.milestones.map((milestone) => milestone.title).join() !== "v1" ||
      snapshot.collection.milestonesComplete !== false ||
      !/zero issues/.test(snapshot.collection.milestonesReason)
    )
      die(
        "verify: issue-derived milestones were changed or presented as complete",
      );
    const issueSchema = new URL(
      "../lib/schema/c4-issues.schema.json",
      import.meta.url,
    );
    for (const field of ["milestonesComplete", "milestonesReason"]) {
      const incomplete = JSON.parse(JSON.stringify(snapshot));
      delete incomplete.collection[field];
      if (
        !validateModel(incomplete, issueSchema).some((error) =>
          error.includes(field),
        )
      )
        die("verify schema: missing collection." + field + " was accepted");
    }
    const native = snapshot.dependencies.edges.find(
      (edge) =>
        edge.source === "native" &&
        edge.from.number === 8 &&
        edge.to.number === 7,
    );
    const prose = snapshot.dependencies.edges.find(
      (edge) =>
        edge.source === "prose" && edge.from.number === 9 && edge.to.number === 8,
    );
    if (
      !snapshot.dependencies.complete ||
      !native ||
      native.from.repo !== "acme/thing" ||
      !native.from.url ||
      native.to.state !== "CLOSED" ||
      !prose ||
      !prose.fingerprint ||
      !/Depends on #8/.test(prose.quote)
    )
      die(
        "verify: native dependency or prose candidate missing: " +
          JSON.stringify(snapshot.dependencies),
      );
    if (
      snapshot.dependencies.edges.some(
        (edge) => edge.from.number === 7 && edge.to.number === 8,
      )
    )
      die('verify: naked "Related #8" became a dependency');
    const { applyDependencyConfirmations } = await import(
      join(HERE, "..", "lib/audit.mjs")
    );
    const confirmed = applyDependencyConfirmations(
      repo,
      [],
      [
        {
          fingerprint: prose.fingerprint,
          evidence: [{ type: "issue", ref: "9" }],
        },
      ],
      snapshot,
      { today: "2026-08-10" },
    ).dependencyConfirmations;
    const confirmedDependencies = deriveDependencies(repo, snapshot, {
      dependencyConfirmations: confirmed,
    });
    if (
      !confirmedDependencies.edges.some(
        (edge) => edge.source === "prose" && edge.from.number === 9,
      ) ||
      !confirmedDependencies.activeBlocked.includes(9)
    )
      die(
        "verify: an evidence-gated prose confirmation did not activate its candidate",
      );
    const changedCandidate = JSON.parse(JSON.stringify(snapshot));
    changedCandidate.dependencies.edges.find(
      (edge) => edge.source === "prose",
    ).fingerprint = "0".repeat(64);
    const staleDependencies = deriveDependencies(repo, changedCandidate, {
      dependencyConfirmations: confirmed,
    });
    if (
      staleDependencies.edges.some((edge) => edge.source === "prose") ||
      !staleDependencies.staleConfirmations.includes(prose.fingerprint)
    )
      die("verify: changed prose candidate kept an old confirmation active");
    const ci = snapshot.signals.workflows.ci;
    if (
      !ci ||
      ci.state !== "present" ||
      ci.headBranch !== "main" ||
      ci.event !== "push"
    )
      die("verify: workflow branch/event signal was not retained");
    if (
      snapshot.signals.release.listState !== "present" ||
      !snapshot.signals.release.resolvableTag.sha
    )
      die("verify: resolvable release signal missing");
    // #43: this used to assert completion === 100, which encoded the defect rather than preventing
    // it — a closed issue justifies a VERDICT, never a percentage, and the number it wrote carried
    // no citation, so the publication gate read it as a measurement.
    if (done.status2 !== "done")
      die("WP-A5: node on a CLOSED issue not marked done");
    if (done.completion != null)
      die(
        "WP-A5: a closed issue produced a percentage (" +
          done.completion +
          "%) — nothing here measured anything",
      );
    // the badge renders statusWord over the verdict, so a curated word must not outlive it
    if (done.statusWord != null)
      die(
        'WP-A5: badge still reads "' +
          done.statusWord +
          '" on a node verified done',
      );
    if (
      !/^Closed with evidence \(#7 CLOSED, gh .*\)\. Was in progress\.$/.test(
        done.current,
      )
    )
      die("WP-A5: evidence prefix missing/malformed: " + done.current);
    if (JSON.stringify(open) !== openBefore)
      die("WP-A5: node on an OPEN issue was modified: " + JSON.stringify(open));
    if (!(v.meta.verifiedAt && v.meta.verifyMethod === "gh live"))
      die("WP-A5: fact base not stamped");
    // structure is untouched and the gate is unaffected, before and after
    r = run(["check", "--repo", repo, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("WP-A5: check must stay green after verify", r);
    // idempotent: a second run must not stack evidence prefixes
    r = run([
      "verify",
      "--repo",
      repo,
      "--model",
      model,
      "--gh-repo",
      "acme/thing",
      "--gh-cmd",
      GH,
      ...SIGNALS,
    ]);
    if (r.status !== 0) die("WP-A5: second verify exit " + r.status, r);
    v = readJson(model);
    if (
      (
        String(v.nodes.find((n) => n.id === c1.id).current).match(
          /Closed with evidence/g,
        ) || []
      ).length !== 1
    )
      die("WP-A5: evidence prefix stacked on re-run");
    // gh missing → loud failure, model byte-identical
    const before = readFileSync(model, "utf-8");
    r = run([
      "verify",
      "--repo",
      repo,
      "--model",
      model,
      "--gh-repo",
      "acme/thing",
      "--gh-cmd",
      "forma-no-such-gh-binary",
    ]);
    if (r.status === 0) die("WP-A5: a missing gh must fail loud");
    if (readFileSync(model, "utf-8") !== before)
      die("WP-A5: model was modified despite the gh failure");

    // Optional repository signals degrade independently: issue pagination still succeeds and the
    // snapshot remains usable, with an explicit unknown reason for each failed channel.
    const signalRepo = join(tmp, "verify-signals"),
      signalIssues = join(signalRepo, "issues.json");
    mkdirSync(signalRepo, { recursive: true });
    r = run([
      "verify",
      "--repo",
      signalRepo,
      "--issues",
      signalIssues,
      "--gh-repo",
      "acme/thing",
      "--gh-cmd",
      process.execPath + " " + join(HERE, "stub-gh.mjs") + " fail-signals",
      ...SIGNALS,
    ]);
    if (r.status !== 0 || !existsSync(signalIssues))
      die("verify: a signal failure aborted the complete issue snapshot", r);
    const degraded = readJson(signalIssues);
    if (
      degraded.signals.workflows.ci.state !== "unknown" ||
      degraded.signals.release.listState !== "unknown" ||
      degraded.collection.signalsUnknown !== 2
    )
      die("verify: failed signals did not degrade to explicit unknowns");

    // A relation count larger than its fetched nodes, and an API with no dependency fields, both
    // mean unknown completeness — neither may collapse to "zero blockers".
    for (const mode of ["truncated", "unsupported"]) {
      const depRepo = join(tmp, "verify-" + mode),
        depIssues = join(depRepo, "issues.json");
      mkdirSync(depRepo, { recursive: true });
      r = run([
        "verify",
        "--repo",
        depRepo,
        "--issues",
        depIssues,
        "--gh-repo",
        "acme/thing",
        "--gh-cmd",
        process.execPath + " " + join(HERE, "stub-gh.mjs") + " " + mode,
      ]);
      if (r.status !== 0)
        die(
          "verify: " + mode + " dependency channel aborted the issue snapshot",
          r,
        );
      const depSnapshot = readJson(depIssues);
      if (depSnapshot.dependencies.complete !== false)
        die("verify: " + mode + " dependencies were presented as complete");
      if (
        mode === "truncated" &&
        (!depSnapshot.dependencies.supported ||
          depSnapshot.collection.truncatedRelations !== 1)
      )
        die("verify: relation totalCount truncation was not disclosed");
      if (
        mode === "unsupported" &&
        (depSnapshot.dependencies.supported || !depSnapshot.dependencies.reason)
      )
        die(
          "verify: unsupported dependency API was presented as an empty supported result",
        );
    }

    // R4-1: the issue fact base is useful without a C4 map. Auto-detect absence instead of making a
    // caller know a second flag, and prove the update orchestrator no longer skips that programme.
    const mapless = join(tmp, "verify-mapless"),
      maplessIssues = join(mapless, "issues.json");
    mkdirSync(mapless, { recursive: true });
    r = run([
      "verify",
      "--repo",
      mapless,
      "--issues",
      maplessIssues,
      "--gh-repo",
      "acme/thing",
      "--gh-cmd",
      GH,
    ]);
    if (r.status !== 0) die("WP-A5: model-less verify exit " + r.status, r);
    if (
      readJson(maplessIssues)
        .issues.map((it) => it.n)
        .join() !== "7,8,9"
    )
      die("WP-A5: model-less verify did not write the complete stub snapshot");
    if (existsSync(join(mapless, "docs/architecture/c4-model.json")))
      die("WP-A5: model-less verify invented a model");

    const maplessManifest = join(mapless, "forma.room.json"),
      maplessRoom = join(mapless, "room.html");
    writeFileSync(
      maplessManifest,
      JSON.stringify(
        {
          today: "2026-08-17",
          programs: [
            {
              id: "mapless",
              ghRepo: "acme/thing",
              repo: ".",
              issues: "issues.json",
            },
          ],
        },
        null,
        2,
      ),
    );
    rmSync(maplessIssues);
    r = run([
      "room",
      "update",
      "--manifest",
      maplessManifest,
      "--out",
      maplessRoom,
      "--gh-cmd",
      GH,
    ]);
    if (r.status !== 0)
      die("WP-A5: room update skipped or failed its map-less programme", r);
    if (!existsSync(maplessIssues) || !existsSync(maplessRoom))
      die(
        "WP-A5: room update did not refresh then compose the map-less programme",
      );
    if (
      /left as-is|snapshot refresh needs/.test(
        (r.stdout || "") + (r.stderr || ""),
      )
    )
      die("WP-A5: room update still reports the map-less programme as skipped");
    const roomBeforeFailedUpdate = readFileSync(maplessRoom, "utf-8");
    const issuesBeforeFailedUpdate = readFileSync(maplessIssues, "utf-8");
    r = run([
      "room",
      "update",
      "--manifest",
      maplessManifest,
      "--out",
      maplessRoom,
      "--gh-cmd",
      "forma-no-such-gh-binary",
    ]);
    if (
      r.status === 0 ||
      readFileSync(maplessRoom, "utf-8") !== roomBeforeFailedUpdate ||
      readFileSync(maplessIssues, "utf-8") !== issuesBeforeFailedUpdate
    )
      die("WP-A5: failed verify changed a published room or input snapshot", r);

    // Recovery: two active programmes may not publish to one snapshot, overlay or output, including
    // aliases. The guard must fail before --skip-verify can compose or alter any target.
    const collisionManifest = join(mapless, "collision.room.json"), collisionRoom = join(mapless, "collision.html");
    writeFileSync(collisionRoom, "previous collision artifact\n");
    writeFileSync(collisionManifest, JSON.stringify({
      today: "2026-08-17",
      programs: [
        { id: "first", ghRepo: "acme/thing", repo: ".", issues: "issues.json" },
        { id: "second", ghRepo: "acme/thing", repo: ".", issues: "issues.json" },
      ],
    }, null, 2) + "\n");
    const collisionBefore = readFileSync(collisionRoom, "utf-8");
    r = run(["room", "update", "--manifest", collisionManifest, "--out", collisionRoom, "--skip-verify"]);
    if (r.status === 0 || !/write target collision/.test(r.stderr || "") || readFileSync(collisionRoom, "utf-8") !== collisionBefore)
      die("production recovery: duplicate write target was not rejected before publication", r);
    console.log(
      "  ok verify — WP-A5 closed→done with dated evidence, open untouched, idempotent, gh failure leaves the model intact",
    );
  });
  test("overlays: enrich-agent", async () => {
    // mini has both: undocumented leaves (real holes, with a source path to offer the agent) and
    // leaves carrying a leading comment (descSource docstring — must be refused by --enrich-apply)
    const REPO = FIX("mini"),
      topo = join(tmp, "ag-topo.json"),
      model = join(tmp, "ag-model.json");
    run(["init", "--repo", REPO, "--out", topo, "--force"]);
    let r = run([
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
    if (r.status !== 0) die("WP-A6: agent plan gen exit " + r.status, r);
    const plan = readJson(join(tmp, "enrich-plan.json"));
    if (!plan.entries.length)
      die("WP-A6: the plan has no entries (fixture has no holes?)");
    // F2: holes are leaves, components AND containers. Containers were excluded on the theory that
    // the topology describes them; on an init-seeded repo they are the boxes still on a fallback.
    const holeIds = readJson(model)
      .nodes.filter(
        (n) =>
          n.descSource === "fallback" &&
          (n.kind === "leaf" || n.kind === "component" || n.kind === "container"),
      )
      .map((n) => n.id)
      .sort();
    if (
      !holeIds.some(
        (id) =>
          readJson(model).nodes.find((n) => n.id === id).kind === "container",
      )
    )
      die(
        "F2: precondition — this fixture has no undescribed container to plan for",
      );
    if (
      JSON.stringify(plan.entries.map((e) => e.id).sort()) !==
      JSON.stringify(holeIds)
    )
      die("WP-A6: plan entries do not match the model holes");
    if (!plan.entries.every((e) => e.prompt && e.descInputHash))
      die("WP-A6: plan entry missing prompt/descInputHash");
    if (
      !plan.entries.some((e) =>
        /Read the file at .+ if you need certainty\./.test(e.prompt),
      )
    )
      die(
        "WP-A6: the agent prompt never offers the source path (that is the point of agent mode)",
      );
    // F2: a container's prompt must not be self-referential — containerOf(container) is itself, so
    // unguarded it says "auth belongs to the container auth" and calls its own children siblings.
    const cHole = readJson(model).nodes.find(
      (n) => n.kind === "container" && holeIds.includes(n.id),
    );
    const cPrompt = plan.entries.find((e) => e.id === cHole.id).prompt;
    if (new RegExp('belongs to the container "' + cHole.name + '"').test(cPrompt))
      die("F2: the container prompt says it belongs to itself:\n" + cPrompt);
    if (/Sibling modules/.test(cPrompt))
      die(
        "F2: the container prompt calls its own children siblings:\n" + cPrompt,
      );
    if (!/Read the sources under .+\/ if you need certainty\./.test(cPrompt))
      die(
        "F2: the container prompt has no filesystem pointer (its evidence is a glob, not a path):\n" +
          cPrompt,
      );
    // the model is still written with its deterministic fallbacks — the plan is additive
    if (!holeIds.length)
      die("WP-A6: gen must still write the model when planning");

    const fill = join(tmp, "enrich-fill.json");
    writeFileSync(
      fill,
      JSON.stringify({
        fills: [
          { id: holeIds[0], func: "Written by the agent, not a REST call." },
        ],
      }),
    );
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      model,
      "--enrich-apply",
      fill,
    ]);
    if (r.status !== 0) die("WP-A6: --enrich-apply exit " + r.status, r);
    let applied = readJson(model).nodes.find((n) => n.id === holeIds[0]);
    if (
      !(
        applied.func === "Written by the agent, not a REST call." &&
        applied.descSource === "llm" &&
        applied.descInputHash
      )
    )
      die("WP-A6: fill not applied with provenance: " + JSON.stringify(applied));
    // sticky across a plain regen, like any other enrichment
    r = run(["gen", "--repo", REPO, "--topology", topo, "--out", model]);
    if (r.status !== 0) die("WP-A6 regen exit " + r.status, r);
    if (
      readJson(model).nodes.find((n) => n.id === holeIds[0]).descSource !== "llm"
    )
      die("WP-A6: applied prose lost on regen");
    r = run(["check", "--repo", REPO, "--model", model, "--topology", topo]);
    if (r.status !== 0) die("WP-A6: check after agent enrichment", r);
    // a fill aimed at a documented node is an error, never a silent overwrite
    const documented = readJson(model).nodes.find(
      (n) => n.descSource === "docstring",
    );
    writeFileSync(
      fill,
      JSON.stringify({
        fills: [{ id: documented.id, func: "should be refused" }],
      }),
    );
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      join(tmp, "ag-bad.json"),
      "--enrich-apply",
      fill,
    ]);
    if (r.status === 0)
      die("WP-A6: --enrich-apply overwrote a docstring-described node");
    writeFileSync(
      fill,
      JSON.stringify({ fills: [{ id: "no__such__node", func: "x" }] }),
    );
    r = run([
      "gen",
      "--repo",
      REPO,
      "--topology",
      topo,
      "--out",
      join(tmp, "ag-bad.json"),
      "--enrich-apply",
      fill,
    ]);
    if (r.status === 0) die("WP-A6: --enrich-apply accepted an unknown node id");
    console.log(
      `  ok enrich-agent — WP-A6 plan (${plan.entries.length} holes) → fill → apply, offline; refuses documented nodes and unknown ids`,
    );
  });
});
