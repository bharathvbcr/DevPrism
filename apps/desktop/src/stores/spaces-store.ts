import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  type SpaceKind,
  inferSpaceKind,
  isSpaceKind,
} from "@/lib/space-features";

/**
 * Project Spaces — group related projects (e.g. all papers for one research
 * topic, or a job-application space of resumes) and give each group a shared
 * default local model and a set of auto-installed DevPrism skills.
 *
 * Offline-first: everything is persisted locally (no backend / no network).
 */
export type { SpaceKind };

export interface Space {
  id: string;
  name: string;
  /**
   * Deliverable type for this space — drives tailored-version workflows and
   * space-specific AI actions in the workspace. `general` = no special features.
   */
  kind: SpaceKind;
  /** A color token used for the space dot/badge in the UI. */
  color: string;
  /**
   * Key of the icon shown for this space (see SPACE_ICONS in the UI layer).
   * null = fall back to a plain colored dot.
   */
  icon: string | null;
  /** Optional free-form note describing what the space is for. */
  description: string;
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
  /**
   * Section the picker should open on next mount; consumed (reset to null) by
   * the picker once read. Lets the in-project sidebar deep-link to Settings.
   * Transient — excluded from persistence.
   */
  pendingPickerSection: "projects" | "settings" | null;
  setPendingPickerSection: (section: "projects" | "settings" | null) => void;
  /** Detail pane within Settings to focus when the picker opens Settings. */
  pendingSettingsDetailSection:
    | "provider"
    | "environment"
    | "editor"
    | "compilation"
    | "appearance"
    | "ai"
    | "personalization"
    | null;
  setPendingSettingsDetailSection: (
    section:
      | "provider"
      | "environment"
      | "editor"
      | "compilation"
      | "appearance"
      | "ai"
      | "personalization"
      | null,
  ) => void;

  createSpace: (
    name: string,
    init?: Partial<Pick<Space, "color" | "icon" | "description" | "kind">>,
  ) => Space;
  renameSpace: (id: string, name: string) => void;
  deleteSpace: (id: string) => void;
  /** Patch any customizable field of a space (color, icon, description, model). */
  updateSpace: (
    id: string,
    patch: Partial<
      Pick<
        Space,
        "name" | "kind" | "color" | "icon" | "description" | "defaultModel"
      >
    >,
  ) => void;
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
      pendingPickerSection: null,
      pendingSettingsDetailSection: null,

      createSpace: (name, init) => {
        const trimmed = name.trim() || "New Space";
        const space: Space = {
          id: newId(),
          name: trimmed,
          kind: init?.kind ?? "general",
          color:
            init?.color ??
            SPACE_COLORS[get().spaces.length % SPACE_COLORS.length],
          icon: init?.icon ?? null,
          description: init?.description?.trim() ?? "",
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

      updateSpace: (id, patch) =>
        set((state) => ({
          spaces: state.spaces.map((s) => {
            if (s.id !== id) return s;
            const next = { ...s, ...patch };
            // A blank name is meaningless — keep the previous one.
            if (patch.name !== undefined)
              next.name = patch.name.trim() || s.name;
            if (patch.description !== undefined) {
              next.description = patch.description.trim();
            }
            return next;
          }),
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

      setPendingPickerSection: (section) =>
        set({ pendingPickerSection: section }),

      setPendingSettingsDetailSection: (section) =>
        set({ pendingSettingsDetailSection: section }),
    }),
    {
      name: "devprism-spaces",
      version: 2,
      migrate: (persisted, fromVersion) => {
        const state = persisted as
          | {
              spaces?: Array<
                Partial<Space> & {
                  name: string;
                  id: string;
                  color: string;
                  defaultModel?: string | null;
                }
              >;
              projectSpace?: Record<string, string>;
            }
          | undefined;
        if (!state?.spaces) return persisted as SpacesState;

        let spaces = state.spaces.map((s) => ({
          ...s,
          icon: s.icon ?? null,
          description: s.description?.trim() ?? "",
          defaultModel: s.defaultModel ?? "",
        })) as Space[];

        if (fromVersion < 2) {
          spaces = spaces.map((s) => ({
            ...s,
            kind:
              s.kind && isSpaceKind(s.kind)
                ? s.kind
                : inferSpaceKind({
                    name: s.name,
                    description: s.description ?? "",
                    icon: s.icon ?? null,
                  }),
          }));
        }

        return {
          ...state,
          spaces,
        } as SpacesState;
      },
      partialize: (state) => ({
        spaces: state.spaces,
        projectSpace: state.projectSpace,
        activeSpaceId: state.activeSpaceId,
      }),
    },
  ),
);
