import {
  readTextFile,
  writeTextFile,
  readDir,
  exists as tauriExists,
  mkdir,
  readFile,
  copyFile,
  remove,
  rename,
  stat,
} from "@tauri-apps/plugin-fs";
import { join as tauriJoin } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { createLogger } from "@/lib/debug/logger";
import {
  browserJoin,
  isBrowserProjectPath,
} from "@/lib/browser-project/constants";
import {
  getStagedBrowserFile,
  isStagedBrowserFilePath,
} from "@/lib/browser-project/attachment-staging";
import {
  browserPathExists,
  getUniqueBrowserTargetName,
  mkdirBrowserPath,
  readBrowserFile,
  readBrowserImageAsDataUrl,
  readBrowserTextFile,
  removeBrowserPath,
  scanBrowserProjectFolder,
  writeBrowserFile,
  writeBrowserTextFile,
} from "@/lib/browser-project/browser-fs";
import {
  getProjectFileType,
  shouldSkipProjectDirectory,
  LARGE_FILE_THRESHOLD,
  type FsProjectFile,
  type ProjectFileType,
  type ScanResult,
} from "./fs-shared";

const log = createLogger("fs");

export type { ProjectFileType, FsProjectFile, ScanResult };
export { getProjectFileType, shouldSkipProjectDirectory, LARGE_FILE_THRESHOLD };

export async function scanProjectFolder(rootPath: string): Promise<ScanResult> {
  if (isBrowserProjectPath(rootPath)) {
    return scanBrowserProjectFolder(rootPath);
  }

  const files: FsProjectFile[] = [];
  const folders: string[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = await readDir(dir);
    for (const entry of entries) {
      const entryPath = await join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        if (shouldSkipProjectDirectory(entry.name)) {
          continue;
        }
        folders.push(relativePath);
        await walk(entryPath, relativePath);
      } else {
        const type = getProjectFileType(entry.name);
        if (type) {
          let fileSize = 0;
          if (type === "image" || type === "other") {
            try {
              const info = await stat(entryPath);
              fileSize = info.size;
            } catch {
              /* stat failed — treat as 0 */
            }
          }
          files.push({
            relativePath,
            absolutePath: entryPath,
            type,
            fileSize,
          });
        }
      }
    }
  }

  await walk(rootPath, "");
  log.info(`Scanned project: ${files.length} files, ${folders.length} folders`);
  return { files, folders };
}

export async function readTexFileContent(
  absolutePath: string,
): Promise<string> {
  if (isBrowserProjectPath(absolutePath)) {
    return readBrowserTextFile(absolutePath);
  }
  return readTextFile(absolutePath);
}

export async function writeTexFileContent(
  absolutePath: string,
  content: string,
): Promise<void> {
  if (isBrowserProjectPath(absolutePath)) {
    return writeBrowserTextFile(absolutePath, content);
  }
  return writeTextFile(absolutePath, content);
}

export async function readImageAsDataUrl(
  absolutePath: string,
): Promise<string> {
  if (isBrowserProjectPath(absolutePath)) {
    return readBrowserImageAsDataUrl(absolutePath);
  }
  const data = await readFile(absolutePath);
  const ext = absolutePath.split(".").pop()?.toLowerCase() || "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    webp: "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";

  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

export function getAssetUrl(absolutePath: string): string {
  if (isBrowserProjectPath(absolutePath)) {
    return absolutePath;
  }
  return convertFileSrc(absolutePath);
}

export async function createFileOnDisk(
  rootPath: string,
  name: string,
  content: string,
): Promise<string> {
  const fullPath = await join(rootPath, name);
  const lastSep = Math.max(
    fullPath.lastIndexOf("/"),
    fullPath.lastIndexOf("\\"),
  );
  const parentDir = lastSep > 0 ? fullPath.substring(0, lastSep) : "";
  if (parentDir && !(await pathExists(parentDir))) {
    await mkdirPath(parentDir);
  }
  await writeTexFileContent(fullPath, content);
  return fullPath;
}

export async function getUniqueTargetName(
  rootPath: string,
  targetName: string,
): Promise<string> {
  if (isBrowserProjectPath(rootPath)) {
    return getUniqueBrowserTargetName(rootPath, targetName);
  }
  const fullPath = await join(rootPath, targetName);
  if (!(await pathExists(fullPath))) return targetName;

  const dotIndex = targetName.lastIndexOf(".");
  const slashIndex = targetName.lastIndexOf("/");
  const hasExt = dotIndex > slashIndex + 1;
  const baseName = hasExt ? targetName.slice(0, dotIndex) : targetName;
  const ext = hasExt ? targetName.slice(dotIndex) : "";

  for (let i = 1; i < 100; i++) {
    const candidate = `${baseName} (${i})${ext}`;
    const candidatePath = await join(rootPath, candidate);
    if (!(await pathExists(candidatePath))) return candidate;
  }
  return `${baseName} (${Date.now()})${ext}`;
}

export async function copyFileToProject(
  rootPath: string,
  sourcePath: string,
  targetName: string,
): Promise<string> {
  const uniqueName = await getUniqueTargetName(rootPath, targetName);
  const fullPath = await join(rootPath, uniqueName);
  const lastSlash = Math.max(
    fullPath.lastIndexOf("/"),
    fullPath.lastIndexOf("\\"),
  );
  if (lastSlash > 0) {
    const parentDir = fullPath.substring(0, lastSlash);
    if (!(await pathExists(parentDir))) {
      await mkdirPath(parentDir);
    }
  }
  if (isBrowserProjectPath(rootPath)) {
    let bytes: Uint8Array;
    if (isStagedBrowserFilePath(sourcePath)) {
      const file = getStagedBrowserFile(sourcePath);
      if (!file) {
        throw new Error("The selected attachment is no longer available.");
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    } else if (isBrowserProjectPath(sourcePath)) {
      bytes = await readBrowserFile(sourcePath);
    } else {
      bytes = new Uint8Array(await readFile(sourcePath));
    }
    await writeBrowserFile(fullPath, bytes);
    return uniqueName;
  }
  await copyFile(sourcePath, fullPath);
  return uniqueName;
}

export async function deleteFileFromDisk(absolutePath: string): Promise<void> {
  log.debug(`Deleting file: ${absolutePath}`);
  if (isBrowserProjectPath(absolutePath)) {
    return removeBrowserPath(absolutePath, false);
  }
  await remove(absolutePath);
}

export async function deleteFolderFromDisk(
  absolutePath: string,
): Promise<void> {
  log.debug(`Deleting folder: ${absolutePath}`);
  if (isBrowserProjectPath(absolutePath)) {
    return removeBrowserPath(absolutePath, true);
  }
  await remove(absolutePath, { recursive: true });
}

export async function renameFileOnDisk(
  oldPath: string,
  newPath: string,
): Promise<void> {
  log.debug(`Renaming: ${oldPath} → ${newPath}`);
  if (isBrowserProjectPath(oldPath) || isBrowserProjectPath(newPath)) {
    const bytes = await readBrowserFile(oldPath);
    await writeBrowserFile(newPath, bytes);
    await removeBrowserPath(oldPath, false);
    return;
  }
  await rename(oldPath, newPath);
}

export async function createDirectory(absolutePath: string): Promise<void> {
  await mkdirPath(absolutePath);
}

async function mkdirPath(absolutePath: string): Promise<void> {
  if (isBrowserProjectPath(absolutePath)) {
    return mkdirBrowserPath(absolutePath);
  }
  await mkdir(absolutePath, { recursive: true });
}

async function pathExists(absolutePath: string): Promise<boolean> {
  if (isBrowserProjectPath(absolutePath)) {
    return browserPathExists(absolutePath);
  }
  return tauriExists(absolutePath);
}

export async function join(...parts: string[]): Promise<string> {
  if (parts.some(isBrowserProjectPath)) {
    return browserJoin(...parts);
  }
  return tauriJoin(...parts);
}

export async function exists(absolutePath: string): Promise<boolean> {
  return pathExists(absolutePath);
}
