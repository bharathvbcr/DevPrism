import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoBenchArgs } from "./cargo-args";
import { notMeasured } from "./stats";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "../..");
const repo = path.resolve(desktop, "../..");
const resultsDir = path.join(repo, "bench-results");
const manifest = path.join(desktop, "src-tauri/Cargo.toml");

const argv = process.argv.slice(2);
const smoke = argv.includes("--smoke") || process.env.BENCH_SMOKE === "1";
const skipRust = argv.includes("--skip-rust");
if (smoke) process.env.BENCH_SMOKE = "1";

function text(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

const rustJson = path.join(resultsDir, "rust-partial.json");
const pdfPath = path.join(resultsDir, "thirty-page.pdf");
const uiJson = path.join(resultsDir, "ui-partial.json");
const baselinePath = path.join(resultsDir, "baseline-2026-10.json");

await mkdir(resultsDir, { recursive: true });

let rustExit = 0;
if (!skipRust) {
  const env = {
    ...process.env,
    TECTONIC_DEP_BACKEND: "vcpkg",
    VCPKG_ROOT: `${process.env.HOME ?? ""}/vcpkg`,
    PKG_CONFIG_PATH:
      "/opt/homebrew/opt/icu4c@78/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig",
    CXXFLAGS: "-std=c++17 -I/opt/homebrew/opt/harfbuzz/include",
    CFLAGS: "-I/opt/homebrew/opt/harfbuzz/include",
    DEVPRISM_BENCH_RUST_JSON: rustJson,
    DEVPRISM_BENCH_PDF: pdfPath,
  };
  const cargoArgs = cargoBenchArgs(manifest, smoke);
  rustExit = await run("cargo", cargoArgs, repo, env);
}

const rust = await readJson(rustJson);
const { measureKeystroke } = await import("./measure-keystroke");
const { measureManvi } = await import("./measure-manvi");
const { measureRaster } = await import("./measure-raster");
const keystroke = await measureKeystroke();
const manvi = await measureManvi();
const raster = await measureRaster(pdfPath, smoke);
await rm(uiJson, { force: true });

const vitestCandidates = [
  path.join(repo, "node_modules/vitest/vitest.mjs"),
  path.join(desktop, "node_modules/vitest/vitest.mjs"),
];
const vitest = vitestCandidates.find((candidate) => existsSync(candidate));
let uiExit = 1;
if (!vitest) {
  uiExit = 1;
} else {
  uiExit = await run(
    "bun",
    [
      vitest,
      "bench",
      "scripts/bench/ui.bench.tsx",
      "--config",
      "vitest.config.ts",
    ],
    desktop,
    {
      ...process.env,
      DEVPRISM_BENCH_UI_JSON: uiJson,
      BENCH_SMOKE: smoke ? "1" : "",
    },
  );
}
const ui = (await readJson(uiJson)) as {
  store?: unknown;
  renders?: unknown;
} | null;

const baseline = {
  schema: 1,
  measured_at: new Date().toISOString(),
  machine: {
    cpu: text("sysctl", ["-n", "machdep.cpu.brand_string"]),
    model: text("sysctl", ["-n", "hw.model"]),
    arch: text("uname", ["-m"]),
  },
  os: {
    name: text("uname", ["-s"]),
    product_version: text("sw_vers", ["-productVersion"]),
    build: text("sw_vers", ["-buildVersion"]),
  },
  git_head_at_measurement: text("git", ["-C", repo, "rev-parse", "HEAD"]),
  statistic:
    "minimum of same-config reruns after one excluded warmup. spread is max minus min of those reruns. The mean is not the reported figure. Smoke uses one sample and is not a noise floor.",
  smoke,
  rust_exit: rustExit,
  ui_exit: uiExit,
  commands: {
    all: "bun run --filter=@devprism/desktop bench",
    from_desktop: "bun run bench",
    ci_smoke:
      "BENCH_SMOKE=1 bun run --filter=@devprism/desktop bench -- --smoke --skip-rust",
  },
  typst_in_process:
    rust ??
    notMeasured(`cargo bench did not write ${rustJson} (exit ${rustExit})`),
  raster_first_page: raster.first_page,
  raster_full: raster.full_reraster,
  retained_canvas_bytes: raster.retained_canvas_bytes,
  store_50kb:
    ui?.store ??
    notMeasured(
      vitest
        ? `vitest bench did not write ${uiJson} (exit ${uiExit})`
        : "vitest.mjs was not found; bun install was not run",
    ),
  claude_output_events_per_second: notMeasured(
    "No golden NDJSON fixture is in this commit. claude-output is produced by the agent bridges, and a rate was not invented from a synthetic stream.",
  ),
  keystroke,
  renders_per_keystroke:
    ui?.renders ?? notMeasured("the render bench did not write a result"),
  manvi_cold_turn: manvi.sequence,
  manvi_version_probe: manvi.version_probe,
  ipc_shape_note:
    "Payload bytes are the JSON number array produced by serde_json of TypstCompileResult.pdf_bytes (career_typst_compile). typst_compile_document's tauri::ipc::Response was not measured. This commit is before the binary-IPC parity change.",
};

if (smoke) {
  console.log(JSON.stringify(baseline, null, 2));
  console.log("smoke results were not written over baseline-2026-10.json");
} else {
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`wrote ${baselinePath}`);
}

await rm(pdfPath, { force: true });
await rm(rustJson, { force: true });
await rm(uiJson, { force: true });

if (rustExit !== 0 || uiExit !== 0) process.exitCode = 1;
