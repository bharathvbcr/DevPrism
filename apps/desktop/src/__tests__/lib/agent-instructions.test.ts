import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = resolve(
  process.cwd(),
  "../../scripts/verify-agent-instructions.js",
);
const fixtures: string[] = [];

afterEach(() => {
  for (const cwd of fixtures.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function verify(content: string, args: string[]) {
  const cwd = mkdtempSync(resolve(tmpdir(), "devprism-agent-instructions-"));
  fixtures.push(cwd);
  execFileSync("git", ["init", "--quiet", cwd], { timeout: 5000 });
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    writeFileSync(resolve(cwd, name), content);
  }
  execFileSync("git", ["add", "AGENTS.md", "CLAUDE.md"], {
    cwd,
    timeout: 5000,
  });
  return spawnSync(process.execPath, [verifier, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
}

describe.each([
  { mode: "staged", args: [] },
  { mode: "all", args: ["--all"] },
])("agent instructions ($mode)", ({ args }) => {
  it.each(["devmap", "dev map"])("accepts guides managed by %s", (owner) => {
    const result = verify(
      `<!-- Managed by ${owner}: keep this file in sync with the repo map. -->\nRepo map: .devcouncil/repo_map.json\n`,
      args,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "devmap",
    "dev map",
  ])("rejects a %s guide without a map reference", (owner) => {
    const result = verify(`<!-- Managed by ${owner} -->\n`, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Map reference");
  });

  it("still requires sections in unmanaged guides", () => {
    const result = verify("Repo map: .devcouncil/repo_map.json\n", args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Must Use Map section");
  });

  it("accepts complete handwritten guides", () => {
    const result = verify(
      "## Repo Map\n.devcouncil/repo_map.json\n## Must Use Map\n",
      args,
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
