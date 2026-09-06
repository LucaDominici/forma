#!/usr/bin/env node
// Cross-platform syntax check: node --check over bin + lib.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Walk lib/ and scripts/ rather than naming files: the hand-written list had drifted and left
// every script except lint.mjs itself unchecked — palette, presentable, room-presentable,
// check-clean, gen-doc-index and check-arbiter-contract were all syntax-unverified.
const mjs = (dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => dir + "/" + f);
const files = [
  "bin/forma.mjs",
  ...mjs("lib"),
  ...mjs("scripts"),
  "test/run.mjs",
];
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", join(ROOT, f)]);
  } catch (e) {
    bad++;
    console.error("SYNTAX ERROR: " + f + "\n" + (e.stderr || e.message));
  }
}
if (bad) {
  console.error(`lint: ${bad} file(s) failed`);
  process.exit(1);
}
console.log(`lint OK — ${files.length} files`);
