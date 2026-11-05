import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { collectSamples, measured, notMeasured } from "./stats";

async function executableOnPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = `${dir}/${name}`;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function versionOnce(binary: string): number {
  const started = performance.now();
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });
  const ms = performance.now() - started;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `manvi --version exited ${result.status}: ${(result.stderr || result.stdout || "").slice(0, 400)}`,
    );
  }
  const text = (result.stdout || "").trim();
  if (!text) throw new Error("manvi --version printed nothing");
  versionOnce.text = text;
  return ms;
}

versionOnce.text = "";

/**
 * The cold turn is `manvi --version`, then `manvi run ... --mcp devprism`,
 * then the devprism binary serving `--mcp`. This function does not start
 * `manvi run`: that call needs a model and a devprism MCP server, and a
 * failed model turn is not the sequence's wall time.
 */
export async function measureManvi() {
  const manvi = await executableOnPath("manvi");
  const devprism = await executableOnPath("devprism");
  if (!manvi) {
    return {
      sequence: notMeasured(
        "manvi is not an executable file on PATH. A shell function named manvi was not treated as the binary. No wall time was recorded.",
      ),
      version_probe: notMeasured("manvi is not an executable file on PATH."),
    };
  }
  let version: ReturnType<typeof measured> | ReturnType<typeof notMeasured>;
  try {
    const { summary, warmup, smoke } = await collectSamples(() =>
      versionOnce(manvi),
    );
    version = measured(summary, warmup, {
      smoke,
      unit: "ms",
      command: "manvi --version",
      binary: manvi,
      version_text: versionOnce.text,
      counts_as_turn_start: false,
    });
  } catch (error) {
    version = notMeasured(
      error instanceof Error ? error.message : String(error),
      {
        command: "manvi --version",
        binary: manvi,
        counts_as_turn_start: false,
      },
    );
  }
  const sequence = notMeasured(
    devprism
      ? "manvi and devprism are both on PATH, but manvi run was not started. A model turn that fails before the MCP server is spawned is not the cold-start wall time, and this harness does not call a provider."
      : "devprism is not an executable file on PATH, so the sequence (manvi --version, then manvi run --mcp devprism, then devprism --mcp) cannot finish. /Applications/DevPrism.app was not used: it is not this commit. manvi run was not started.",
    {
      manvi,
      devprism,
      version_probe_is_not_the_sequence: true,
    },
  );
  return { sequence, version_probe: version };
}
