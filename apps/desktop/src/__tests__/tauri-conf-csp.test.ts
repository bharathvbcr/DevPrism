import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Validates tauri.conf.json CSP (Content Security Policy) configuration.
 *
 * Background: Tauri 2 injects nonces into CSP directives at build time.
 * Per CSP spec, when a nonce is present, 'unsafe-inline' is ignored by the browser.
 * This means dynamically injected <style> tags (e.g., from CodeMirror's style-mod)
 * get blocked in production builds, causing invisible editor text.
 *
 * The fix: `dangerousDisableAssetCspModification` prevents Tauri from adding nonces,
 * so 'unsafe-inline' remains effective for runtime style injection.
 */
describe("tauri.conf.json CSP configuration", () => {
  const confPath = resolve(__dirname, "../../src-tauri/tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf-8"));
  const security = conf.app?.security;
  const csp = security?.csp ?? "";

  it("should have dangerousDisableAssetCspModification enabled so runtime style injection works", () => {
    expect(security?.dangerousDisableAssetCspModification).toBe(true);
  });

  it("should include 'unsafe-inline' in style-src for CodeMirror dynamic styles", () => {
    const styleSrc = csp.match(/style-src\s+([^;]+)/)?.[1] ?? "";
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it("should include ipc: in connect-src for Tauri IPC in production", () => {
    const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? "";
    expect(connectSrc).toContain("ipc:");
  });

  it("should include data: in font-src for base64-encoded fonts", () => {
    const fontSrc = csp.match(/font-src\s+([^;]+)/)?.[1] ?? "";
    expect(fontSrc).toContain("data:");
  });
});

describe("Tauri default capabilities", () => {
  const capabilityPath = resolve(
    __dirname,
    "../../src-tauri/capabilities/default.json",
  );
  const capability = JSON.parse(readFileSync(capabilityPath, "utf-8"));
  const permissions = capability.permissions as Array<
    string | { allow?: unknown[] }
  >;

  it("does not grant broad renderer filesystem access to the full home directory", () => {
    const serialized = JSON.stringify(permissions);
    expect(serialized).not.toContain('"$HOME/**"');
  });

  it("does not allow arbitrary renderer shell process control", () => {
    expect(permissions).not.toContain("shell:allow-spawn");
    expect(permissions).not.toContain("shell:allow-stdin-write");
    expect(permissions).not.toContain("shell:allow-kill");
  });
});

describe("Tauri command registration", () => {
  const libPath = resolve(__dirname, "../../src-tauri/src/lib.rs");
  const libSource = readFileSync(libPath, "utf-8");
  const invokeBlock = libSource.match(
    /\.invoke_handler\(tauri::generate_handler!\[\s*([\s\S]*?)\s*\]\)/,
  )?.[1];

  it("does not expose the retired legacy agent CLI installer commands", () => {
    expect(invokeBlock).toBeTruthy();
    expect(invokeBlock).not.toContain("check_agent_cli_status");
    expect(invokeBlock).not.toContain("install_agent_cli");
    expect(invokeBlock).not.toContain("login_agent_cli");
  });
});
