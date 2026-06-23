import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Project Spaces — group related projects (e.g. all papers for one research
 * topic, or a job-application space of resumes) and give each group a shared
 * default local model and a set of auto-installed DevPrism skills.
 *
 * Offline-first: everything is persisted locally (no backend / no network).
 */
export interface Space {
  id: string;
  name: string;
  /** A color token used for the space dot/badge in the UI. */
  color: string;
  /** Default model for projects in this space (empty = auto-detect from Ollama). */
  defaultModel: string | null;
}

/** Palette used when creating a new space (cycles deterministically). */
export const SPACE_COLORS = [
  "#6366f1", // indigo
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
] as const;

interface SpacesState {
  spaces: Space[];
  /** Maps a project path to the space it belongs to. */
  projectSpace: Record<string, string>;
  /** Currently filtered space in the picker; null = "All Projects". */
  activeSpaceId: string | null;

  createSpace: (name: string, color?: string) => Space;
  renameSpace: (id: string, name: string) => void;
  deleteSpace: (id: string) => void;
  setSpaceDefaults: (
    id: string,
    defaults: Partial<Pick<Space, "defaultModel">>,
  ) => void;

  assignProject: (path: string, spaceId: string | null) => void;
  spaceForProject: (path: string) => Space | null;
  setActiveSpace: (id: string | null) => void;
}

function newId(): string {
  // Webview (Tauri/Chromium) always exposes crypto.randomUUID.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `space-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export const useSpacesStore = create<SpacesState>()(
  persist(
    (set, get) => ({
      spaces: [],
      projectSpace: {},
      activeSpaceId: null,

      createSpace: (name, color) => {
        const trimmed = name.trim() || "New Space";
        const space: Space = {
          id: newId(),
          name: trimmed,
          color:
            color ?? SPACE_COLORS[get().spaces.length % SPACE_COLORS.length],
          defaultModel: "",
        };
        set((state) => ({ spaces: [...state.spaces, space] }));
        return space;
      },

      renameSpace: (id, name) =>
        set((state) => ({
          spaces: state.spaces.map((s) =>
            s.id === id ? { ...s, name: name.trim() || s.name } : s,
          ),
        })),

      deleteSpace: (id) =>
        set((state) => {
          const projectSpace = { ...state.projectSpace };
          for (const [path, spaceId] of Object.entries(projectSpace)) {
            if (spaceId === id) delete projectSpace[path];
          }
          return {
            spaces: state.spaces.filter((s) => s.id !== id),
            projectSpace,
            activeSpaceId:
              state.activeSpaceId === id ? null : state.activeSpaceId,
          };
        }),

      setSpaceDefaults: (id, defaults) =>
        set((state) => ({
          spaces: state.spaces.map((s) =>
            s.id === id ? { ...s, ...defaults } : s,
          ),
        })),

      assignProject: (path, spaceId) =>
        set((state) => {
          const projectSpace = { ...state.projectSpace };
          if (spaceId === null) {
            delete projectSpace[path];
          } else {
            projectSpace[path] = spaceId;
          }
          return { projectSpace };
        }),

      spaceForProject: (path) => {
        const id = get().projectSpace[path];
        if (!id) return null;
        return get().spaces.find((s) => s.id === id) ?? null;
      },

      setActiveSpace: (id) => set({ activeSpaceId: id }),
    }),
    {
      name: "devprism-spaces",
      partialize: (state) => ({
        spaces: state.spaces,
        projectSpace: state.projectSpace,
      }),
    },
  ),
);
