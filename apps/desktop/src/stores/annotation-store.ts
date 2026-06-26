import { create } from "zustand";

/** A highlight color: `rgb` (0..1) is written into the exported PDF annotation,
 *  `css` is the solid color used for the on-screen overlay fill. */
export interface HighlightColor {
  id: string;
  label: string;
  rgb: [number, number, number];
  css: string;
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { id: "yellow", label: "Yellow", rgb: [1, 0.85, 0.2], css: "#fde047" },
  { id: "green", label: "Green", rgb: [0.55, 0.9, 0.45], css: "#86efac" },
  { id: "pink", label: "Pink", rgb: [1, 0.55, 0.72], css: "#f9a8d4" },
  { id: "blue", label: "Blue", rgb: [0.5, 0.74, 1], css: "#93c5fd" },
];

export function getHighlightColor(id: string): HighlightColor {
  return HIGHLIGHT_COLORS.find((c) => c.id === id) ?? HIGHLIGHT_COLORS[0];
}

export interface PdfHighlight {
  id: string;
  /** 0-based page index, matching MupdfPage. */
  pageIndex: number;
  colorId: string;
  /** RGB 0..1 for the exported PDF annotation. */
  rgb: [number, number, number];
  /** Solid CSS color for the on-screen overlay. */
  css: string;
  /** One quad per text line, in PDF page-space points:
   *  [ulx, uly, urx, ury, llx, lly, lrx, lry]. */
  quads: number[][];
  /** The selected text the highlight was created from. */
  text: string;
  /** Optional free-text reviewer note; falls back to `text` on export. */
  note?: string;
  createdAt: number;
}

/** Stable empty array so selectors don't churn for roots with no highlights. */
const EMPTY: PdfHighlight[] = [];

interface AnnotationState {
  /** rootFileId -> highlights for that document. */
  highlightsByRoot: Record<string, PdfHighlight[]>;
  /** Currently selected highlight color for new highlights. */
  activeColorId: string;
  setActiveColor: (id: string) => void;
  addHighlight: (
    rootFileId: string,
    highlight: Omit<PdfHighlight, "id" | "createdAt">,
  ) => void;
  removeHighlight: (rootFileId: string, id: string) => void;
  setHighlightNote: (rootFileId: string, id: string, note: string) => void;
  clearHighlights: (rootFileId: string) => void;
  clearAll: () => void;
}

export const useAnnotationStore = create<AnnotationState>((set) => ({
  highlightsByRoot: {},
  activeColorId: HIGHLIGHT_COLORS[0].id,
  setActiveColor: (id) => set({ activeColorId: id }),
  addHighlight: (rootFileId, highlight) =>
    set((s) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const next: PdfHighlight = { ...highlight, id, createdAt: Date.now() };
      const existing = s.highlightsByRoot[rootFileId] ?? EMPTY;
      return {
        highlightsByRoot: {
          ...s.highlightsByRoot,
          [rootFileId]: [...existing, next],
        },
      };
    }),
  removeHighlight: (rootFileId, id) =>
    set((s) => {
      const existing = s.highlightsByRoot[rootFileId];
      if (!existing) return s;
      return {
        highlightsByRoot: {
          ...s.highlightsByRoot,
          [rootFileId]: existing.filter((h) => h.id !== id),
        },
      };
    }),
  setHighlightNote: (rootFileId, id, note) =>
    set((s) => {
      const existing = s.highlightsByRoot[rootFileId];
      if (!existing) return s;
      const trimmed = note.trim();
      return {
        highlightsByRoot: {
          ...s.highlightsByRoot,
          [rootFileId]: existing.map((h) =>
            h.id === id ? { ...h, note: trimmed || undefined } : h,
          ),
        },
      };
    }),
  clearHighlights: (rootFileId) =>
    set((s) => {
      if (!s.highlightsByRoot[rootFileId]) return s;
      const next = { ...s.highlightsByRoot };
      delete next[rootFileId];
      return { highlightsByRoot: next };
    }),
  clearAll: () => set({ highlightsByRoot: {} }),
}));

/** Non-reactive read of a root's highlights (e.g. at export time). */
export function getHighlightsForRoot(rootFileId: string): PdfHighlight[] {
  return useAnnotationStore.getState().highlightsByRoot[rootFileId] ?? EMPTY;
}

/** Clear every document's highlights (used on project close). */
export function clearAllHighlights(): void {
  useAnnotationStore.getState().clearAll();
}
