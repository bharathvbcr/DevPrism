import { create } from "zustand";
import { persist } from "zustand/middleware";

// ─── Per-file marks: pin a .tex file to the top of its folder + tag it a color ──
//
// Marks are purely cosmetic/organizational metadata that live alongside the
// project, not on disk. They are keyed by (projectRoot, relativePath) so two
// projects never share marks, and persisted to localStorage so they survive
// restarts. Marks for renamed/deleted files simply go stale and are ignored.

export type FileColor =
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "blue"
  | "violet"
  | "pink";

export interface FileMark {
  pinned?: boolean;
  // Manual ordering among pinned files. Only meaningful while `pinned` is true.
  // Comparisons only happen between siblings in the same folder, so values need
  // not be globally unique — they just establish relative order. Newly pinned
  // files get one past the current project-wide max so they land last.
  pinOrder?: number;
  color?: FileColor;
}

/** Swatch hex per color, tuned to read on both the light and dark sidebar. */
export const FILE_COLOR_HEX: Record<FileColor, string> = {
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
};

export const FILE_COLOR_LABEL: Record<FileColor, string> = {
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
};

export const FILE_COLORS = Object.keys(FILE_COLOR_HEX) as FileColor[];

// Use a NUL separator: it can't appear in a path, so the key never collides.
// Built via fromCharCode so no literal NUL byte lands in the source file.
const KEY_SEP = String.fromCharCode(0);
function markKey(projectRoot: string, relativePath: string) {
  return `${projectRoot}${KEY_SEP}${relativePath}`;
}

/** Extract the marks belonging to one project, keyed by relativePath. */
export function projectMarks(
  marks: Record<string, FileMark>,
  projectRoot: string,
): Map<string, FileMark> {
  const prefix = markKey(projectRoot, "");
  const out = new Map<string, FileMark>();
  for (const [key, mark] of Object.entries(marks)) {
    if (key.startsWith(prefix)) out.set(key.slice(prefix.length), mark);
  }
  return out;
}

interface FileMarksState {
  marks: Record<string, FileMark>;
  getMark: (projectRoot: string, relativePath: string) => FileMark | undefined;
  togglePin: (projectRoot: string, relativePath: string) => void;
  // Reassign pinOrder to the given paths in array order (0..n-1). Callers pass
  // the full set of pinned siblings of one folder in their desired order; only
  // entries that are still pinned are touched.
  reorderPins: (projectRoot: string, orderedRelativePaths: string[]) => void;
  setColor: (
    projectRoot: string,
    relativePath: string,
    color: FileColor | null,
  ) => void;
  clearMark: (projectRoot: string, relativePath: string) => void;
}

/** Drop a mark from the record once it carries no pin and no color. */
function pruneEmpty(marks: Record<string, FileMark>, key: string) {
  const mark = marks[key];
  if (mark && !mark.pinned && !mark.color) {
    const { [key]: _removed, ...rest } = marks;
    return rest;
  }
  return marks;
}

export const useFileMarksStore = create<FileMarksState>()(
  persist(
    (set, get) => ({
      marks: {},

      getMark: (projectRoot, relativePath) =>
        get().marks[markKey(projectRoot, relativePath)],

      togglePin: (projectRoot, relativePath) =>
        set((state) => {
          const key = markKey(projectRoot, relativePath);
          const current = state.marks[key];
          const willPin = !current?.pinned;

          let updated: FileMark;
          if (willPin) {
            // Land the newly pinned file after every existing pin in this project.
            const prefix = markKey(projectRoot, "");
            let maxOrder = -1;
            for (const [k, mark] of Object.entries(state.marks)) {
              if (k.startsWith(prefix) && mark.pinned) {
                maxOrder = Math.max(maxOrder, mark.pinOrder ?? 0);
              }
            }
            updated = { ...current, pinned: true, pinOrder: maxOrder + 1 };
          } else {
            // Unpinning drops the ordering too, so a later re-pin starts fresh.
            updated = { ...current, pinned: false, pinOrder: undefined };
          }

          const next = { ...state.marks, [key]: updated };
          return { marks: pruneEmpty(next, key) };
        }),

      reorderPins: (projectRoot, orderedRelativePaths) =>
        set((state) => {
          const next = { ...state.marks };
          let changed = false;
          orderedRelativePaths.forEach((relativePath, index) => {
            const key = markKey(projectRoot, relativePath);
            const current = next[key];
            if (current?.pinned && current.pinOrder !== index) {
              next[key] = { ...current, pinOrder: index };
              changed = true;
            }
          });
          return changed ? { marks: next } : state;
        }),

      setColor: (projectRoot, relativePath, color) =>
        set((state) => {
          const key = markKey(projectRoot, relativePath);
          const current = state.marks[key];
          const next = {
            ...state.marks,
            [key]: { ...current, color: color ?? undefined },
          };
          return { marks: pruneEmpty(next, key) };
        }),

      clearMark: (projectRoot, relativePath) =>
        set((state) => {
          const key = markKey(projectRoot, relativePath);
          if (!state.marks[key]) return state;
          const { [key]: _removed, ...rest } = state.marks;
          return { marks: rest };
        }),
    }),
    {
      name: "claude-prism-file-marks",
    },
  ),
);
