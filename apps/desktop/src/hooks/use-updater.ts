import { useEffect, useRef } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 5_000; // 5 seconds after mount

export function useUpdater() {
  const checking = useRef(false);

  useEffect(() => {
    async function checkForUpdate() {
      if (checking.current) return;
      checking.current = true;

      try {
        const update = await check();
        if (!update) return;

        toast(`Update available: v${update.version}`, {
          description: update.body || "A new version is ready to install.",
          duration: Infinity,
          action: {
            label: "Update",
            onClick: () => installUpdate(update),
          },
        });
      } catch (err) {
        console.error("Update check failed:", err);
      } finally {
        checking.current = false;
      }
    }

    const initialTimer = setTimeout(checkForUpdate, INITIAL_DELAY_MS);
    const interval = setInterval(checkForUpdate, CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, []);
}

async function installUpdate(update: Awaited<ReturnType<typeof check>>) {
  if (!update) return;

  const toastId = toast.loading("Downloading update...", {
    duration: Infinity,
  });

  try {
    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            const pct = Math.round((downloaded / contentLength) * 100);
            toast.loading(`Downloading update... ${pct}%`, { id: toastId });
          }
          break;
        case "Finished":
          toast.loading("Installing...", { id: toastId });
          break;
      }
    });

    toast.success("Update complete. Restarting...", { id: toastId, duration: 2000 });
    setTimeout(() => relaunch(), 2000);
  } catch (err) {
    toast.error(`Update failed: ${err}`, { id: toastId, duration: 5000 });
  }
}
