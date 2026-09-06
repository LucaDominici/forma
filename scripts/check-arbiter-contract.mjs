#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// scripts/check-arbiter-contract.mjs — the forma half of the shared schema contract (I19).
//
// forma and arbiter are extensions of each other, not neighbours that happen to agree today:
// arbiter owns the governance ontology, forma owns the C4 model shape, and each vendors what the
// other owns. lib/schema/CONTRACT.json is the pin, and BOTH repos gate it — this script is forma's
// half, scripts/check-forma-contract.mjs is arbiter's. Editing a shared schema without re-pinning
// turns the owning repo red at once; letting a vendored copy drift turns the consuming repo red.
//
// Zero dependencies, no network, deterministic (I1/I2/I12): hashes of files already on disk.
//
// Usage: node scripts/check-arbiter-contract.mjs [--dir <repo>] [--sibling <path-to-arbiter>]
// Exit: 0 pass, 1 violation, 2 error.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CONTRACT_REL = join("lib", "schema", "CONTRACT.json");
const VENDOR_DIR = join("lib", "schema", "vendor");
const THIS_REPO = "forma";
const SIBLING_REPO = "arbiter";

export function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function checkContract(root, siblingRoot) {
  const violations = [];
  const notes = [];
  const contractPath = join(root, CONTRACT_REL);
  const contract = JSON.parse(readFileSync(contractPath, "utf-8"));

  for (const entry of contract.schemas) {
    if (entry.owner === THIS_REPO) {
      const owned = join(root, entry.ownerPath);
      if (!existsSync(owned)) {
        violations.push(
          `${entry.id}: owned schema ${entry.ownerPath} is missing`,
        );
        continue;
      }
      const actual = sha256Of(owned);
      if (actual !== entry.sha256) {
        violations.push(
          `${entry.id}: ${entry.ownerPath} hashes ${actual.slice(0, 12)}… but the contract pins ` +
            `${entry.sha256.slice(0, 12)}… — re-pin in BOTH repos' CONTRACT.json, or revert the edit`,
        );
      }
    }
    if ((entry.consumers || []).includes(THIS_REPO)) {
      const vendored = join(root, VENDOR_DIR, `${entry.id}.schema.json`);
      if (!existsSync(vendored)) {
        violations.push(
          `${entry.id}: declared vendored by ${THIS_REPO} but ${VENDOR_DIR}/${entry.id}.schema.json is absent`,
        );
        continue;
      }
      const actual = sha256Of(vendored);
      if (actual !== entry.sha256) {
        violations.push(
          `${entry.id}: vendored copy hashes ${actual.slice(0, 12)}… but the contract pins ` +
            `${entry.sha256.slice(0, 12)}… — the copy drifted from the shape ${entry.owner} owns`,
        );
      }
    }
  }

  // The cross-checkout half needs both repos on disk. Absent, it SKIPS out loud: a check that
  // quietly does nothing is exactly the silence I9 forbids.
  if (
    !siblingRoot ||
    !existsSync(join(siblingRoot, "schemas", "CONTRACT.json"))
  ) {
    notes.push(
      `SKIP cross-checkout half: no ${SIBLING_REPO} checkout beside this one. Owner-side pins were ` +
        `still verified; ${SIBLING_REPO}'s own gate verifies its half.`,
    );
    return { violations, notes };
  }
  const siblingContract = join(siblingRoot, "schemas", "CONTRACT.json");
  if (
    readFileSync(siblingContract, "utf-8") !==
    readFileSync(contractPath, "utf-8")
  ) {
    violations.push(
      `the two copies of CONTRACT.json differ (${CONTRACT_REL} vs ${SIBLING_REPO}/schemas/CONTRACT.json) — ` +
        `the contract is only a contract while both sides hold the same text`,
    );
  }
  for (const entry of contract.schemas) {
    if (entry.owner !== SIBLING_REPO) continue;
    const real = join(siblingRoot, entry.ownerPath);
    if (!existsSync(real)) {
      violations.push(
        `${entry.id}: ${SIBLING_REPO}/${entry.ownerPath} is missing`,
      );
      continue;
    }
    const actual = sha256Of(real);
    if (actual !== entry.sha256) {
      violations.push(
        `${entry.id}: ${SIBLING_REPO}'s live ${entry.ownerPath} hashes ${actual.slice(0, 12)}… but the ` +
          `contract pins ${entry.sha256.slice(0, 12)}… — ${SIBLING_REPO} changed a shared shape without re-pinning`,
      );
    }
  }
  notes.push(`cross-checkout half ran against ${siblingRoot}`);
  return { violations, notes };
}

function main() {
  const argv = process.argv.slice(2);
  const dirIdx = argv.indexOf("--dir");
  const root =
    dirIdx === -1 ? resolve(scriptDir, "..") : resolve(argv[dirIdx + 1]);
  const sibIdx = argv.indexOf("--sibling");
  const sibling =
    sibIdx === -1
      ? resolve(root, "..", SIBLING_REPO)
      : resolve(argv[sibIdx + 1]);

  if (!existsSync(join(root, CONTRACT_REL))) {
    process.stderr.write(
      `check-arbiter-contract: ERROR — ${CONTRACT_REL} not found under ${root}\n`,
    );
    return 2;
  }
  let result;
  try {
    result = checkContract(root, sibling);
  } catch (err) {
    process.stderr.write(`check-arbiter-contract: ERROR — ${err.message}\n`);
    return 2;
  }
  for (const n of result.notes)
    process.stdout.write(`  check-arbiter-contract: ${n}\n`);
  if (result.violations.length > 0) {
    process.stderr.write(
      `check-arbiter-contract: FAIL — ${result.violations.length} violation(s)\n`,
    );
    for (const v of result.violations) process.stderr.write(`  - ${v}\n`);
    return 1;
  }
  process.stdout.write(
    `check-arbiter-contract: PASS — schema contract holds with ${SIBLING_REPO}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
