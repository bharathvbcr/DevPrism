import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "@/stores/document-store";

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const state = useDocumentStore.getState();
        state.setIsSaving(true);
        state.saveCurrentFile().finally(() => {
          setTimeout(() => state.setIsSaving(false), 500);
        });
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        invoke("create_new_window").catch(console.error);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
