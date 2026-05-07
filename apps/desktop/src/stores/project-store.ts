import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

export interface LinkedProject {
  id: string;
  name: string;
  path: string;
  tech_stack: string[];
  last_analyzed: string | null;
  tags: string[];
  role?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  description?: string | null;
  notes?: string | null;
}

interface ProjectState {
  recentProjects: RecentProject[];
  linkedProjects: LinkedProject[];
  lastProjectFolder: string | null;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  setLastProjectFolder: (path: string) => void;

  // Linked projects
  loadLinkedProjects: () => Promise<void>;
  addLinkedProject: (
    name: string,
    path: string,
    techStack: string[],
    details?: Partial<
      Pick<
        LinkedProject,
        "tags" | "role" | "start_date" | "end_date" | "description" | "notes"
      >
    >,
  ) => Promise<void>;
  removeLinkedProject: (id: string) => Promise<void>;
  analyzeLinkedProject: (id: string) => Promise<void>;
}

const MAX_RECENT = 10;

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      recentProjects: [],
      linkedProjects: [],
      lastProjectFolder: null,

      setLastProjectFolder: (path) => set({ lastProjectFolder: path }),

      addRecentProject: (path) => {
        const name = path.split(/[/\\]/).pop() || path;
        set((state) => {
          const filtered = state.recentProjects.filter((p) => p.path !== path);
          return {
            recentProjects: [
              { path, name, lastOpened: Date.now() },
              ...filtered,
            ].slice(0, MAX_RECENT),
          };
        });
      },

      removeRecentProject: (path) => {
        set((state) => ({
          recentProjects: state.recentProjects.filter((p) => p.path !== path),
        }));
      },

      loadLinkedProjects: async () => {
        try {
          const projects = await invoke<LinkedProject[]>(
            "list_linked_projects",
          );
          set({ linkedProjects: projects });
        } catch (err) {
          console.error("Failed to load linked projects", err);
        }
      },

      addLinkedProject: async (name, path, techStack, details = {}) => {
        try {
          await invoke("add_linked_project", {
            name,
            path,
            techStack,
            tags: details.tags ?? [],
            role: details.role ?? null,
            startDate: details.start_date ?? null,
            endDate: details.end_date ?? null,
            description: details.description ?? null,
            notes: details.notes ?? null,
          });
          await get().loadLinkedProjects();
        } catch (err) {
          console.error("Failed to add linked project", err);
        }
      },

      removeLinkedProject: async (id) => {
        try {
          await invoke("remove_linked_project", { id });
          await get().loadLinkedProjects();
        } catch (err) {
          console.error("Failed to remove linked project", err);
        }
      },

      analyzeLinkedProject: async (id) => {
        try {
          await invoke("analyze_linked_project", { id });
          await get().loadLinkedProjects();
        } catch (err) {
          console.error("Failed to analyze linked project", err);
        }
      },
    }),
    {
      name: "devprism-projects",
    },
  ),
);
