import { create } from "zustand";
import { persist } from "zustand/middleware";

export type EditorViewMode = "source" | "rich";

interface EditorViewModeState {
  /** How .tex files are edited: LaTeX source (CodeMirror) or the ScholarDoc rich (Word-like) editor. */
  mode: EditorViewMode;
  setMode: (mode: EditorViewMode) => void;
  toggle: () => void;
}

export const useEditorViewModeStore = create<EditorViewModeState>()(
  persist(
    (set) => ({
      mode: "source",
      setMode: (mode) => set({ mode }),
      toggle: () =>
        set((s) => ({ mode: s.mode === "source" ? "rich" : "source" })),
    }),
    { name: "devprism.editor-view-mode" },
  ),
);
