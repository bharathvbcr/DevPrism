import { useEffect } from "react";
import { useUpdateStore } from "@/stores/update-store";

export type { UpdateStatus } from "@/stores/update-store";

/**
 * Auto-checking updater hook. State lives in `useUpdateStore` so Settings can
 * show version/update status and drive manual checks against the same state
 * the startup notification uses.
 */
export function useUpdater() {
  const status = useUpdateStore((s) => s.status);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const installUpdate = useUpdateStore((s) => s.installUpdate);

  // Auto-check on mount
  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

  return { status, checkForUpdate, installUpdate };
}
