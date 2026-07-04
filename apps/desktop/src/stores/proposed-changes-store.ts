import { create } from "zustand";
import { useDocumentStore } from "./document-store";
import { writeTexFileContent } from "@/lib/tauri/fs";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("proposed-changes");

export interface ProposedChange {
  id: string; // tool_use_id
  filePath: string; // relativePath
  absolutePath: string;
  oldContent: string; // content before Claude's edit
  newContent: string; // content after Claude's edit (from disk)
  toolName: string; // "Edit" | "Write" | "MultiEdit"
  timestamp: number;
}

interface ProposedChangesState {
  changes: ProposedChange[];

  // Actions
  addChange: (change: Omit<ProposedChange, "timestamp">) => void;
  resolveChange: (id: string) => void;
  keepChange: (id: string) => Promise<void>;
  undoChange: (id: string) => Promise<void>;
  keepAll: () => Promise<void>;
  undoAll: () => Promise<void>;
  getChangeForFile: (relativePath: string) => ProposedChange | undefined;
}

export const useProposedChangesStore = create<ProposedChangesState>()(
  (set, get) => ({
    changes: [],

    addChange: (change) => {
      log.debug(`Adding change: ${change.toolName} on ${change.filePath}`);
      set((state) => {
        // If there's already a pending change for the same file, merge them:
        // keep the original oldContent (true baseline), use the new newContent and id
        const existingIdx = state.changes.findIndex(
          (c) => c.filePath === change.filePath,
        );
        if (existingIdx >= 0) {
          const existing = state.changes[existingIdx];
          const merged: ProposedChange = {
            ...change,
            oldContent: existing.oldContent, // preserve original baseline
            timestamp: Date.now(),
          };
          const newChanges = [...state.changes];
          newChanges[existingIdx] = merged;
          return { changes: newChanges };
        }
        return {
          changes: [...state.changes, { ...change, timestamp: Date.now() }],
        };
      });
    },

    resolveChange: (id) => {
      set((state) => ({
        changes: state.changes.filter((c) => c.id !== id),
      }));
    },

    keepChange: async (id) => {
      const change = get().changes.find((c) => c.id === id);
      if (!change) return;

      // The caller (editor) already set the correct content via setContent().
      // Write the document store content to disk to stay in sync
      // (handles partial chunk resolution where finalContent differs from disk).
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.relativePath === change.filePath);
      if (file?.content != null) {
        try {
          await writeTexFileContent(change.absolutePath, file.content);
        } catch (err) {
          // Keep the change pending so the UI and disk don't silently diverge.
          log.error("Failed to write kept change; leaving it pending", {
            error: String(err),
            file: change.filePath,
          });
          return;
        }
      }

      // Remove from pending only after the write succeeds.
      set((state) => ({
        changes: state.changes.filter((c) => c.id !== id),
      }));
    },

    undoChange: async (id) => {
      const change = get().changes.find((c) => c.id === id);
      if (!change) return;

      log.info(`Undoing change on ${change.filePath}`);
      // Drift check: if the file diverged from what Claude wrote, an intervening
      // (inline) edit is about to be discarded — surface it rather than clobber
      // silently.
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.relativePath === change.filePath);
      if (file?.content != null && file.content !== change.newContent) {
        log.warn(
          "Undoing a change whose file was edited since; that edit will be discarded",
          {
            file: change.filePath,
          },
        );
      }

      // Restore oldContent to disk; keep the change pending if the write fails.
      try {
        await writeTexFileContent(change.absolutePath, change.oldContent);
      } catch (err) {
        log.error("Failed to undo change; leaving it pending", {
          error: String(err),
          file: change.filePath,
        });
        return;
      }

      // Reload the file in document store (will pick up oldContent from disk).
      await useDocumentStore.getState().reloadFile(change.filePath);

      set((state) => ({
        changes: state.changes.filter((c) => c.id !== id),
      }));
    },

    keepAll: async () => {
      const { changes } = get();
      const files = useDocumentStore.getState().files;
      // Persist each file's current content (which includes any accepted inline
      // edits) to disk — the old implementation only reloaded from disk, silently
      // reverting inline edits that were never written. Keep failed writes pending.
      const failed = new Set<string>();
      for (const change of changes) {
        const file = files.find((f) => f.relativePath === change.filePath);
        if (file?.content != null) {
          try {
            await writeTexFileContent(change.absolutePath, file.content);
          } catch (err) {
            failed.add(change.id);
            log.error(
              "Failed to write kept change in keepAll; leaving it pending",
              {
                error: String(err),
                file: change.filePath,
              },
            );
          }
        }
      }
      set((state) => ({
        changes: state.changes.filter((c) => failed.has(c.id)),
      }));
    },

    undoAll: async () => {
      const { changes } = get();
      log.info(`Undoing all ${changes.length} changes`);
      const failed = new Set<string>();
      for (const change of changes) {
        try {
          await writeTexFileContent(change.absolutePath, change.oldContent);
          await useDocumentStore.getState().reloadFile(change.filePath);
        } catch (err) {
          failed.add(change.id);
          log.error("Failed to undo change in undoAll; leaving it pending", {
            error: String(err),
            file: change.filePath,
          });
        }
      }
      set((state) => ({
        changes: state.changes.filter((c) => failed.has(c.id)),
      }));
    },

    getChangeForFile: (relativePath) => {
      return get().changes.find((c) => c.filePath === relativePath);
    },
  }),
);
