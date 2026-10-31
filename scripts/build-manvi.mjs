// Build the manvi sidecar and place it where Tauri's `externalBin` expects.
//
// manvi is the chat turn driver (`manvi run`). It lives in its own repository,
// so this script has to find it before it can build it — and what it does when
// it cannot is the most important decision here. See `locateSource`.
//
// Tauri looks for `binaries/manvi-<target-triple>{.exe}` at bundle time and
// installs it beside the app executable under the plain name `manvi`, which is
// where native_agent/manvi_sidecar.rs looks for it.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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

/// The directory `go build ./cmd/manvi` must run in.
///
/// A checkout is either the Go module itself (`go.mod` beside `cmd/manvi`)
/// or the Manvi repository, whose module lives one level down in `manvi/`.
function moduleRoot(dir) {
  if (!existsSync(dir)) return null;
  if (existsSync(join(dir, "go.mod"))) return dir;
  const nested = join(dir, "manvi");
  if (existsSync(join(nested, "go.mod"))) return nested;
  return null;
}

/// Find the manvi source tree.
///
/// It is not vendored into this repository, so it is either pointed at
/// explicitly or found next door in a developer's checkout. CI has neither.
export function locateSource() {
  const explicit = process.env.MANVI_SRC;
  if (explicit) {
    const root = moduleRoot(resolve(explicit));
    if (!root) {
      // An explicit setting that does not resolve is an error, never a silent
      // fallthrough to the sibling guess: someone set it on purpose.
      throw new Error(`MANVI_SRC=${explicit} does not contain a go.mod`);
    }
    return root;
  }
  for (const candidate of [
    join(repoRoot, "../Dev_Harness/manvi"),
    join(repoRoot, "../manvi"),
    join(repoRoot, "../Manvi"),
  ]) {
    const root = moduleRoot(resolve(candidate));
    if (root) return root;
  }
  return null;
}

function haveGo() {
  return spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
}

/// True when a `.go` file, `go.mod`, or `go.sum` under `dir` is newer than
/// `mtimeMs`. A directory that cannot be read counts as newer: skipping a
/// rebuild because the walk failed would leave a stale sidecar looking current.
function goSourcesNewerThan(dir, mtimeMs) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (
        entry.name === "vendor" ||
        entry.name === ".git" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (
        !entry.name.endsWith(".go") &&
        entry.name !== "go.mod" &&
        entry.name !== "go.sum"
      ) {
        continue;
      }
      try {
        if (statSync(path).mtimeMs > mtimeMs) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/// Build the sidecar. Returns the output path, or null when it was skipped.
///
/// `ifStale` skips the compile when this target's binary is already newer
/// than the Manvi Go sources. Release builds leave it false and always
/// rebuild. `bun run dev:desktop` sets it so a second launch does not pay
/// for a compile that would produce the same binary.
export function buildManvi({
  triple = targetTriple(),
  quiet = false,
  ifStale = false,
} = {}) {
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

  if (ifStale && existsSync(out) && !goSourcesNewerThan(source, statSync(out).mtimeMs)) {
    log(`sidecar is current (${out})`);
    return out;
  }

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
/// CI has no manvi checkout, and breaking every release build on a missing
/// checkout would be the wrong trade. The app still launches. A chat turn
/// fails closed until a binary is beside the executable, on PATH, or named by
/// DEVPRISM_MANVI_BIN.
///
/// Set DEVPRISM_MANVI_REQUIRED=1 to make it an error instead — which is what a
/// release build should do.
function skip(reason, log) {
  const required = process.env.DEVPRISM_MANVI_REQUIRED === "1";
  const message =
    `manvi sidecar NOT bundled: ${reason}.\n` +
    "         The app will still launch. A chat turn fails until `manvi` is on\n" +
    "         PATH or DEVPRISM_MANVI_BIN names a binary.\n" +
    "         Set DEVPRISM_MANVI_REQUIRED=1 to fail this build instead.";
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
