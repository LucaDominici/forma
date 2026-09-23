#!/usr/bin/env node
// Repository-level contracts: the Claude adapter skill, the release pipeline, public CI, the Pages
// dogfood, and the self-model-freshness gate.
import test, { describe } from "node:test";

import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  rmSync,
  readdirSync,
  mkdtempSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { HERE, freshTmp, run, die } from "./helpers.mjs";

const tmp = freshTmp();

describe("repo", () => {
  // The shipped Claude adapter is executable guidance, not brochure copy: its init→update sequence
  // must work on a fresh map-less checkout and tell the agent to link the artifact it produced (#73).
  test("repo: claude-skill", async () => {
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
  });

  // Publishing must follow the same chain for every future release: conventional commits become a
  // reviewable Release Please PR, and only a matching immutable tag reaches npm through the existing
  // OIDC publisher. This is intentionally static: it protects the CI contract without publishing.
  test("repo: release", async () => {
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
  });

  // A public repository's required CI must be runnable by a fork with its default token. Depending
  // on a private sibling is a permanent red, not a documentation verdict (#55 / D-7).
  test("repo: ci-public", async () => {
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
  });

  // The Control Room is validated by dogfood over real local work, not by publishing forma's quiet
  // self-portrait as a second Pages demo (#56). The architecture explorer remains the public demo.
  test("repo: dogfood", async () => {
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
  });

  // F5 (2026-09-14 visual verification): forma's own self-model must not go stale in the tree —
  // the `forma` node's curated version has to track the published package, and the historical "not
  // built" prose for the Control Room (shipped in #120/#121) may not survive a regen.
  test("repo: self-model-fresh", async () => {
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
        `self-model-fresh: c4-status.json claims ${status.nodes.forma.statusWord}, package.json is v${pkg.version} — see PUBLISH.md step 4`,
      );
    if (/not built/i.test(status.nodes.boards.current))
      die(
        "self-model-fresh: the boards node still claims the Control Room is not built (#120/#121 shipped it)",
      );
    const formaNode = model.nodes.find((n) => n.id === "forma");
    if (formaNode.statusWord !== "v" + pkg.version)
      die(
        "self-model-fresh: gen did not re-decorate the committed model from the edited status overlay — see PUBLISH.md step 4",
      );
    let r = run(["check"]);
    if (r.status !== 0)
      die("self-model-fresh: forma check must pass on its own regenerated model", r);
    console.log(
      "  ok self-model-fresh — forma's self-model version and Control Room status track the shipped package",
    );
  });

  // Frontmatter is the one document lifecycle source. Superseded UI names and duplicate inline
  // statuses are archaeology, not current contracts (#58).
  test("repo: doc-prune", async () => {
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
  });

  // One committer is the solo tier. Governance may keep the external standard as a reference, but
  // required CI and its enforcement prose must not claim the retired enterprise/private gate (#60).
  test("repo: governance-solo", async () => {
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
  });

  // I19: the shared schema contract with arbiter. The property under test is not that the gate
  // passes today but that it CANNOT pass once a shared shape moves on one side — tampered in both
  // directions, the way every other derivation in this suite is proven non-vacuous.
  test("repo: arbiter-contract", async () => {
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
  });

  // #140 S3 F7: evidence hashing/staleness primitives live in lib/evidence.mjs, not lib/audit.mjs —
  // roomderive.mjs/roomdocs.mjs/verify.mjs/check.mjs/room-presentable.mjs must import them from
  // there, never reach back into the audit plan/apply channel for functions that have nothing to
  // do with it.
  test("repo: import-graph", async () => {
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
  });

  // S7 doc drift — ARCHITECTURE.md's Level 3 module table must name every lib/*.mjs module, and its
  // stated count must match the real file count. This is a source-of-truth check on the table only
  // (sliced between the two known headings), not a whole-file grep, so a basename mentioned in prose
  // elsewhere does not pass this test falsely.
  test("repo: architecture-module-table", async () => {
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
  });
});
