import { create } from "zustand";
import { persist } from "zustand/middleware";
import { FSA_SCHEME } from "@/lib/browser-project/constants";
import {
  displayProjectPathLabel,
  getPersistedFsaFolderName,
} from "@/lib/browser-project/fsa-persistence";

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

interface ProjectState {
  recentProjects: RecentProject[];
  lastProjectFolder: string | null;
  addRecentProject: (path: string, displayName?: string) => void;
  removeRecentProject: (path: string) => void;
  renameRecentProject: (oldPath: string, newPath: string) => void;
  setLastProjectFolder: (path: string) => void;
}

const MAX_RECENT = 10;

function normalizeRecentPath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

async function resolveRecentProjectName(
  path: string,
  displayName?: string,
): Promise<string> {
  if (displayName?.trim()) {
    return displayProjectPathLabel(path, displayName);
  }
  if (path.startsWith(FSA_SCHEME)) {
    const id = path.slice(FSA_SCHEME.length).split("/")[0];
    if (id) {
      const folderName = await getPersistedFsaFolderName(id);
      if (folderName) return folderName;
    }
  }
  return displayProjectPathLabel(path);
}

function recentProjectName(path: string): string {
  return displayProjectPathLabel(path);
}

function isSameProjectPath(a: string, b: string): boolean {
  return (
    normalizeRecentPath(a).toLowerCase() ===
    normalizeRecentPath(b).toLowerCase()
  );
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      recentProjects: [],
      lastProjectFolder: null,

      setLastProjectFolder: (path) => set({ lastProjectFolder: path }),

      addRecentProject: (path, displayName) => {
        const normalizedPath = normalizeRecentPath(path);
        const commit = (name: string) => {
          set((state) => {
            const filtered = state.recentProjects.filter(
              (p) => !isSameProjectPath(p.path, normalizedPath),
            );
            return {
              recentProjects: [
                { path: normalizedPath, name, lastOpened: Date.now() },
                ...filtered,
              ].slice(0, MAX_RECENT),
            };
          });
        };

        if (displayName?.trim()) {
          commit(displayProjectPathLabel(normalizedPath, displayName));
          return;
        }
        if (!normalizedPath.startsWith(FSA_SCHEME)) {
          commit(recentProjectName(normalizedPath));
          return;
        }

        void resolveRecentProjectName(normalizedPath, displayName).then(commit);
      },

      removeRecentProject: (path) => {
        set((state) => ({
          recentProjects: state.recentProjects.filter(
            (p) => !isSameProjectPath(p.path, path),
          ),
        }));
      },

      renameRecentProject: (oldPath, newPath) => {
        const normalizedNewPath = normalizeRecentPath(newPath);
        const name = recentProjectName(normalizedNewPath);
        set((state) => ({
          recentProjects: [
            { path: normalizedNewPath, name, lastOpened: Date.now() },
            ...state.recentProjects.filter(
              (p) =>
                !isSameProjectPath(p.path, oldPath) &&
                !isSameProjectPath(p.path, normalizedNewPath),
            ),
          ].slice(0, MAX_RECENT),
        }));
      },
    }),
    {
      name: "claude-prism-projects",
      partialize: (state) => ({
        recentProjects: state.recentProjects,
        lastProjectFolder: state.lastProjectFolder,
      }),
    },
  ),
);

export { displayProjectPathLabel };
