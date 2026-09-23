#!/usr/bin/env node
// One-off parity harness for #144 slice S5 (test/run.mjs -> node:test). NOT a permanent script —
// lives in evidence/, not scripts/. Confirms every `ok` line printed by `node test/run.mjs` at the
// pre-split baseline (aa3ee64, captured in baseline-ok-lines.txt) is still printed by the split
// suite, whether from a new test/*.test.mjs file or from what remains of test/run.mjs. A block with
// no ok line has no baseline entry and is not covered by this script; PR bodies list those by hand.
//
// Usage: node .arbiter/evidence/s5-parity/parity.mjs
// Exit: 0 if every baseline line is still emitted, 1 if any is missing.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", ".."); // worktree root

const okLines = (stdout) =>
  stdout
    .split("\n")
    .map((l) => l.replace(/^#?\s*/, ""))
    .filter((l) => l.startsWith("ok "));

// readdirSync + filter rather than fs.globSync — glob wasn't stable until Node 22, and CI's
// matrix still runs 18/20 (see .github/workflows/ci.yml).
const nodeTestFiles = readdirSync(join(ROOT, "test"))
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => join(ROOT, "test", f));
const splitRun = spawnSync(process.execPath, ["--test", ...nodeTestFiles], {
  encoding: "utf-8",
  cwd: ROOT,
});
const legacyRun = spawnSync(process.execPath, [join(ROOT, "test", "run.mjs")], {
  encoding: "utf-8",
  cwd: ROOT,
});
const emitted = new Set([
  ...okLines(splitRun.stdout),
  ...okLines(legacyRun.stdout),
]);

const raw = readFileSync(join(HERE, "baseline-ok-lines.txt"), "utf-8");
const baseline = raw
  .split("\n")
  .filter(Boolean)
  .map((l) => l.replace(/\\u\{([0-9a-f]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16))));

const missing = baseline.filter((l) => !emitted.has(l));
if (missing.length) {
  console.error(`S5 PARITY REGRESSION — ${missing.length}/${baseline.length} baseline ok line(s) no longer emitted:`);
  missing.forEach((l) => console.error("  " + l));
  process.exit(1);
}
console.log(`S5 parity OK — all ${baseline.length} baseline ok line(s) still emitted.`);
