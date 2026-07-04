import { isTauri } from "@/lib/runtime/is-tauri";
import type { ImportedProject } from "@/lib/browser-project/constants";
import { importLooseFiles, importZipFile } from "@/lib/browser-project/import";
import {
  pickProjectFolder,
  pickProjectFiles,
  saveProjectFile,
} from "@/lib/platform-dialog";

export { pickProjectFolder, pickProjectFiles, saveProjectFile };

export async function importZipProject(
  zipPath: string,
): Promise<ImportedProject> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ImportedProject>("import_zip_project", { zipPath });
}

export async function importLooseProjectPaths(
  paths: string[],
): Promise<ImportedProject> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ImportedProject>("import_loose_files", { paths });
}

export async function importZipFromFile(file: File): Promise<ImportedProject> {
  if (isTauri()) {
    throw new Error(
      "Use importZipProject with a file path in the desktop app.",
    );
  }
  return importZipFile(file);
}

export async function importLooseFromFiles(
  files: Array<File | { file: File; relativePath: string }>,
): Promise<ImportedProject> {
  return importLooseFiles(files);
}

export type { ImportedProject };
