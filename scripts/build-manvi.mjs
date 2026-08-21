// Build the manvi sidecar and place it where Tauri's `externalBin` expects.
//
// manvi is a separate Go program that carries DevPrism's policy gate and its
// local-model context planner. It lives in its own repository, so this script
// has to find it before it can build it — and what it does when it cannot is
// the most important decision here. See `locateSource`.
//
// Tauri looks for `binaries/manvi-<target-triple>{.exe}` at bundle time and
// installs it beside the app executable under the plain name `manvi`, which is
// where native_agent/manvi_sidecar.rs looks for it.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "apps/desktop/src-tauri/binaries");

/// Rust target triple -> the Go toolchain's own spelling.
const GO_TARGETS = {
  "aarch64-apple-darwin": { GOOS: "darwin", GOARCH: "arm64" },
  "x86_64-apple-darwin": { GOOS: "darwin", GOARCH: "amd64" },
  "x86_64-unknown-linux-gnu": { GOOS: "linux", GOARCH: "amd64" },
  "aarch64-unknown-linux-gnu": { GOOS: "linux", GOARCH: "arm64" },
  "x86_64-pc-windows-msvc": { GOOS: "windows", GOARCH: "amd64" },
  "aarch64-pc-windows-msvc": { GOOS: "windows", GOARCH: "arm64" },
};

/// The triple being built for.
///
/// `tauri build --target X` is authoritative when given; otherwise the host, as
/// rustc reports it. Parsing rustc rather than mapping process.platform means
/// the sidecar's triple cannot disagree with the app's, which is the failure
/// that produces a bundle Tauri refuses at the last step of a long build.
export function targetTriple(argv = process.argv) {
  const flag = argv.indexOf("--target");
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  if (process.env.DEVPRISM_TARGET_TRIPLE)
    return process.env.DEVPRISM_TARGET_TRIPLE;

  const probe = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(
      "could not run `rustc -vV` to determine the host target triple",
    );
  }
  const host = /^host:\s*(\S+)$/m.exec(probe.stdout ?? "");
  if (!host) throw new Error("`rustc -vV` did not report a host triple");
  return host[1];
}

/// Find the manvi source tree.
///
/// It is not vendored into this repository, so it is either pointed at
/// explicitly or found next door in a developer's checkout. CI has neither.
export function locateSource() {
  const explicit = process.env.MANVI_SRC;
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(join(p, "go.mod"))) {
      // An explicit setting that does not resolve is an error, never a silent
      // fallthrough to the sibling guess: someone set it on purpose.
      throw new Error(`MANVI_SRC=${explicit} does not contain a go.mod`);
    }
    return p;
  }
  for (const candidate of [
    join(repoRoot, "../Dev_Harness/manvi"),
    join(repoRoot, "../manvi"),
  ]) {
    const p = resolve(candidate);
    if (existsSync(join(p, "go.mod"))) return p;
  }
  return null;
}

function haveGo() {
  return spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
}

/// Build the sidecar. Returns the output path, or null when it was skipped.
export function buildManvi({ triple = targetTriple(), quiet = false } = {}) {
  const log = (msg) => {
    if (!quiet) console.log(`[manvi] ${msg}`);
  };

  const goTarget = GO_TARGETS[triple];
  if (!goTarget) {
    return skip(`no Go target mapping for ${triple}`, log);
  }
  const source = locateSource();
  if (!source) {
    return skip(
      "manvi source not found (set MANVI_SRC, or check out Dev_Harness beside this repo)",
      log,
    );
  }
  if (!haveGo()) {
    return skip("no Go toolchain on PATH", log);
  }

  mkdirSync(outDir, { recursive: true });
  const suffix = goTarget.GOOS === "windows" ? ".exe" : "";
  const out = join(outDir, `manvi-${triple}${suffix}`);

  log(`building ${triple} from ${source}`);
  execFileSync(
    "go",
    ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "./cmd/manvi"],
    {
      cwd: source,
      stdio: "inherit",
      env: {
        ...process.env,
        GOOS: goTarget.GOOS,
        GOARCH: goTarget.GOARCH,
        // manvi is built to be a single static binary with no cgo, which is
        // what makes cross-compiling every release target from one machine
        // work at all. Setting it explicitly keeps a developer's CGO_ENABLED=1
        // environment from silently producing a binary that only runs here.
        CGO_ENABLED: "0",
      },
    },
  );

  log(`built ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  return out;
}

/// Report a skip.
///
/// Skipping is the default rather than a hard failure because DevPrism's own
/// CI has no manvi checkout, and breaking every release build on a component
/// the app degrades gracefully without would be the wrong trade. But it is
/// never quiet: a bundle without the sidecar runs its tools past no policy
/// gate at all and plans context with the byte-budget fallback, and nobody
/// should discover that from behaviour.
///
/// Set DEVPRISM_MANVI_REQUIRED=1 to make it an error instead — which is what a
/// release build should do.
function skip(reason, log) {
  const required = process.env.DEVPRISM_MANVI_REQUIRED === "1";
  const message =
    `manvi sidecar NOT bundled: ${reason}.\n` +
    "         The app will still run: policy checks and context planning fall back\n" +
    "         to their built-in behaviour. Tool calls will not be gated by manvi's\n" +
    "         write/command rules. Set DEVPRISM_MANVI_REQUIRED=1 to fail instead.";
  if (required) {
    throw new Error(message);
  }
  log(`WARNING: ${message}`);
  return null;
}

// Run directly: `node scripts/build-manvi.mjs [--target <triple>]`
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const built = buildManvi();
    process.exit(built ? 0 : 0);
  } catch (err) {
    console.error(`[manvi] ${err.message}`);
    process.exit(1);
  }
}
