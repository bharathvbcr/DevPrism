import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "available"; version: string; notes?: string }
  | { state: "downloading"; percent: number }
  | { state: "installing" }
  | { state: "ready" }
  | { state: "error"; message: string };

interface UpdateStoreState {
  status: UpdateStatus;
  /** Timestamp of the last completed check (success or failure). */
  lastCheckedAt: number | null;
  checkForUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

// The Update object is not serializable state; keep it module-side.
let pendingUpdate: Update | null = null;

/**
 * Shared updater state.
 *
 * The status used to live inside a single component's useState, which made a
 * manual "check for updates" affordance impossible: nothing else could read
 * or drive it, and errors were invisible outside that one mount.
 */
export const useUpdateStore = create<UpdateStoreState>((set) => ({
  status: { state: "idle" },
  lastCheckedAt: null,

  checkForUpdate: async () => {
    set({ status: { state: "checking" } });
    try {
      const update = await check();
      if (!update) {
        pendingUpdate = null;
        set({
          status: { state: "up-to-date" },
          lastCheckedAt: Date.now(),
        });
        return;
      }
      pendingUpdate = update;
      set({
        status: {
          state: "available",
          version: update.version,
          notes: update.body ?? undefined,
        },
        lastCheckedAt: Date.now(),
      });
    } catch (err) {
      set({
        status: { state: "error", message: String(err) },
        lastCheckedAt: Date.now(),
      });
    }
  },

  installUpdate: async () => {
    const update = pendingUpdate;
    if (!update) return;

    try {
      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            set({ status: { state: "downloading", percent: 0 } });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              set({
                status: {
                  state: "downloading",
                  percent: Math.round((downloaded / contentLength) * 100),
                },
              });
            }
            break;
          case "Finished":
            set({ status: { state: "installing" } });
            break;
        }
      });

      set({ status: { state: "ready" } });
      setTimeout(() => relaunch(), 1500);
    } catch (err) {
      set({ status: { state: "error", message: String(err) } });
    }
  },
}));
