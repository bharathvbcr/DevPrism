import { spawn } from "node:child_process";
import { join } from "node:path";

import { buildManvi } from "./build-manvi.mjs";

try {
  // A missing checkout warns and returns null. The app still launches, and a
  // chat turn then uses `manvi` on PATH or fails with the resolver's message.
  buildManvi({ ifStale: true });
} catch (err) {
  console.error(`[manvi] ${err.message}`);
  process.exit(1);
}

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

const child =
  process.platform === "win32"
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "bun run --filter=@devprism/desktop tauri dev"],
        {
          env,
          stdio: "inherit",
        },
      )
    : spawn("bun", ["run", "--filter=@devprism/desktop", "tauri", "dev"], {
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
