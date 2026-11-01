#!/usr/bin/env bun
/**
 * Standalone E2E Test Suite Runner for DevPrism.
 * Executes the full 184-test 4-tier opaque-box test suite via Vitest.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(__dirname, "../..");
const desktopDir = path.join(projectRoot, "apps/desktop");

console.log(
  "===============================================================================",
);
console.log(" DevPrism E2E Test Suite Runner (16 Features across 4 Tiers)");
console.log(
  "===============================================================================",
);
console.log(`Project root: ${projectRoot}`);
console.log(`Desktop directory: ${desktopDir}\n`);

const vitestArgs = ["run", "test", "src/__tests__/e2e"];
console.log(`Executing: bun ${vitestArgs.join(" ")} in apps/desktop...\n`);

const result = spawnSync("bun", vitestArgs, {
  cwd: desktopDir,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
  },
});

if (result.status === 0) {
  console.log(
    "\n===============================================================================",
  );
  console.log(
    " ✅ All E2E test suites passed successfully (184 tests across Tiers 1-4).",
  );
  console.log(
    "===============================================================================",
  );
  process.exit(0);
} else {
  console.error(
    "\n===============================================================================",
  );
  console.error(` ❌ E2E test suite failed with exit code ${result.status}`);
  console.error(
    "===============================================================================",
  );
  process.exit(result.status ?? 1);
}
