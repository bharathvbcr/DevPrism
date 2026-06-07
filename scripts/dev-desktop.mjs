import { spawn } from "node:child_process";
import { join } from "node:path";

const env = { ...process.env };

if (process.platform === "win32") {
  env.VCPKG_ROOT ||= join(env.USERPROFILE ?? "", "vcpkg");
  env.TECTONIC_DEP_BACKEND ||= "vcpkg";
  env.VCPKGRS_TRIPLET ||= "x64-windows-static-md-release";
  env.CXXFLAGS = [env.CXXFLAGS, "/std:c++17"].filter(Boolean).join(" ");
}

const child =
  process.platform === "win32"
    ? spawn(
        process.env.ComSpec ?? "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          "corepack pnpm --filter=@claude-prism/desktop tauri dev",
        ],
        {
          env,
          stdio: "inherit",
        },
      )
    : spawn("pnpm", ["--filter=@claude-prism/desktop", "tauri", "dev"], {
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
