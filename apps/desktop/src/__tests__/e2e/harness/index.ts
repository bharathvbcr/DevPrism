/**
 * Unified E2E Test Harness index.
 */

export * from "./tauri-opaque-bridge";
export * from "./assertions";

import { OpaqueTauriBridge } from "./tauri-opaque-bridge";

export const globalOpaqueBridge = new OpaqueTauriBridge();

/**
 * Creates an isolated bridge instance for independent test cases.
 */
export function createIsolatedHarness(): OpaqueTauriBridge {
  return new OpaqueTauriBridge();
}
