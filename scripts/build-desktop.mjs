import { spawn } from "node:child_process";
import { join } from "node:path";

import { buildManvi } from "./build-manvi.mjs";

const env = { ...process.env };

function appendEnvFlag(name, flag) {
  const current = env[name] ?? "";
  env[name] = current.includes(flag)
    ? current
    : [current, flag].filter(Boolean).join(" ");
}

if (process.platform === "win32") {
  env.VCPKG_ROOT ||= join(env.USERPROFILE ?? "", "vcpkg");
  env.TECTONIC_DEP_BACKEND = "vcpkg";
  env.VCPKGRS_TRIPLET = "x64-windows-static-release";
  env.VCPKG_DEFAULT_TRIPLET = env.VCPKGRS_TRIPLET;
  appendEnvFlag("RUSTFLAGS", "-Ctarget-feature=+crt-static");
  env.CXXFLAGS = [env.CXXFLAGS, "/std:c++17"].filter(Boolean).join(" ");
}

if (process.platform === "darwin") {
  env.VCPKG_ROOT ||= join(env.HOME ?? "", "vcpkg");
  env.TECTONIC_DEP_BACKEND ||= "vcpkg";
  env.CXXFLAGS = [env.CXXFLAGS, "-std=c++17"].filter(Boolean).join(" ");
  env.CFLAGS ||= "";
}

// Build the sidecar before Tauri bundles, since `externalBin` is resolved at
// bundle time. Declaring it when the binary is absent fails the whole build, so
// the config fragment that declares it is merged only on success.
let manviBinary = null;
try {
  manviBinary = buildManvi();
} catch (err) {
  console.error(`[manvi] ${err.message}`);
  process.exit(1);
}

const args = ["--filter=@devprism/desktop", "tauri", "build"];

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  args.push("--config", "src-tauri/tauri.local-build.conf.json");
}

if (manviBinary) {
  // tauri.manvi.conf.json declares `bundle.externalBin`. It is a separate file
  // rather than an entry in tauri.conf.json because Tauri fails the bundle when
  // an externalBin is declared and its binary is missing, and this repository
  // must stay buildable without a manvi checkout. (Tauri validates the config
  // against a strict schema, so that file carries no comment of its own —
  // unknown keys, `$comment` included, are rejected.)
  args.push("--config", "src-tauri/tauri.manvi.conf.json");
}

const child =
  process.platform === "win32"
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `corepack pnpm ${args.join(" ")}`],
        {
          env,
          stdio: "inherit",
        },
      )
    : spawn("pnpm", args, {
        env,
        stdio: "inherit",
      });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
