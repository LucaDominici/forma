#!/usr/bin/env node
// Repository-level contracts: the Claude adapter skill, the release pipeline, public CI, the Pages
// dogfood, and the self-model-freshness gate.
import test, { describe } from "node:test";

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  });
});
