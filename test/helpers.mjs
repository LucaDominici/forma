// Shared plumbing for the node:test files split out of the former test/run.mjs (S5, #144).
// Each test file spawns `forma` as a subprocess (BIN) against its own fixtures (FIX) and its own
// tmpdir (freshTmp), so files can run standalone or together, in any order, in parallel.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BIN = join(HERE, "..", "bin", "forma.mjs");
export const FIX = (n) => join(HERE, "fixtures", n);
// ponytail: each importer gets its own tmpdir (call freshTmp()), not a shared module-level one —
// node:test runs files in separate processes, so a shared dir was only ever a per-file concern.
export const freshTmp = () => mkdtempSync(join(tmpdir(), "forma-test-"));
export const run = (args) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf-8" });
// `die` throws instead of exiting: node:test reports the failing test and keeps running the rest,
// where the old process.exit(1) killed the whole suite on the first red (audit F10).
export const die = (m, r) => {
  throw new Error(m + (r ? "\n" + (r.stdout || "") + (r.stderr || "") : ""));
};
export const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
// strip the volatile fields so two gen runs on the same tree can be compared byte-for-byte
export const stripVolatile = (x) => {
  const c = JSON.parse(JSON.stringify(x));
  delete c.generatedAt;
  if (c.source) {
    delete c.source.commit;
    delete c.source.branch;
  }
  return JSON.stringify(c);
};
// every JSON path where two objects differ (R2: gen x2 must diverge on exactly one)
export const diffPaths = (a, b, at = "") => {
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
