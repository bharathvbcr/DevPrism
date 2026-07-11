import { parseBrowserRoot } from "@/lib/browser-project/constants";
import { removePersistedFsaRoot } from "@/lib/browser-project/fsa-persistence";
import { removeOpfsProject } from "@/lib/browser-project/opfs-store";
import { isTauri } from "@/lib/runtime/is-tauri";
import { deleteFolderFromDisk, exists } from "@/lib/tauri/fs";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { useSpacesStore } from "@/stores/spaces-store";

export type ProjectDeleteKind = "disk" | "opfs" | "fsa";

function normalizeProjectPath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function isSameProjectPath(a: string, b: string): boolean {
  return (
    normalizeProjectPath(a).toLowerCase() ===
    normalizeProjectPath(b).toLowerCase()
  );
}

export function projectDeleteKind(path: string): ProjectDeleteKind {
  const parsed = parseBrowserRoot(path);
  if (parsed?.scheme === "opfs") return "opfs";
  if (parsed?.scheme === "fsa") return "fsa";
  return "disk";
}

export function deleteProjectDialogCopy(
  kind: ProjectDeleteKind,
  name: string,
): { title: string; description: string; action: string } {
  switch (kind) {
    case "opfs":
      return {
        title: "Delete project",
        description: `Permanently delete "${name}"? All files imported into the app will be removed.`,
        action: "Delete",
      };
    case "fsa":
      return {
        title: "Remove project",
        description: `Remove "${name}" from your project list? Files in the linked folder on disk will not be deleted.`,
        action: "Remove",
      };
    default:
      return {
        title: "Delete project",
        description: `Permanently delete "${name}" and remove all project files from disk? This cannot be undone.`,
        action: "Delete",
      };
  }
}

export async function purgeBrowserProjectStorage(path: string): Promise<void> {
  const parsed = parseBrowserRoot(path);
  if (!parsed) return;

  if (parsed.scheme === "opfs") {
    await removeOpfsProject(parsed.id);
    return;
  }

  await removePersistedFsaRoot(parsed.id);
}

async function purgeDiskProjectStorage(path: string): Promise<void> {
  if (parseBrowserRoot(path)) return;
  if (!isTauri()) return;

  if (await exists(path)) {
    await deleteFolderFromDisk(path);
  }
}

export async function deleteProjectFromApp(path: string): Promise<void> {
  const normalized = normalizeProjectPath(path);

  const currentRoot = useDocumentStore.getState().projectRoot;
  if (currentRoot && isSameProjectPath(currentRoot, normalized)) {
    useDocumentStore.getState().closeProject();
  }

  await purgeBrowserProjectStorage(normalized);
  await purgeDiskProjectStorage(normalized);
  useProjectStore.getState().removeRecentProject(normalized);
  useSpacesStore.getState().assignProject(normalized, null);
}
