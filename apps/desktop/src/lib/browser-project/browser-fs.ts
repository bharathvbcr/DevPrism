import {
  getProjectFileType,
  shouldSkipProjectDirectory,
  type FsProjectFile,
  type ScanResult,
} from "@/lib/tauri/fs-shared";
import {
  browserJoin,
  browserRootPath,
  isBrowserProjectPath,
  parseBrowserRoot,
  relativeFromBrowserAbsolute,
} from "./constants";
import { walkFsaProject } from "./fsa-store";
import {
  fsaFileExists,
  mkdirFsa,
  readFsaFile,
  removeFsaEntry,
  statFsaFile,
  writeFsaFile,
} from "./fsa-store";
import {
  mkdirOpfs,
  opfsFileExists,
  readOpfsFile,
  removeOpfsEntry,
  statOpfsFile,
  walkOpfsProject,
  writeOpfsFile,
} from "./opfs-store";

const assetUrlCache = new Map<string, string>();

function splitBrowserAbsolutePath(absolutePath: string): {
  rootPath: string;
  relativePath: string;
} {
  const parsed = parseBrowserRoot(absolutePath);
  if (!parsed) {
    throw new Error(`Not a browser project path: ${absolutePath}`);
  }
  const rootPath = browserRootPath(parsed.scheme, parsed.id);
  const relativePath = relativeFromBrowserAbsolute(rootPath, absolutePath);
  return { rootPath, relativePath };
}

async function walkBrowserProject(
  rootPath: string,
  visitor: (
    relativePath: string,
    kind: "file" | "directory",
  ) => void | Promise<void>,
): Promise<void> {
  const parsed = parseBrowserRoot(rootPath);
  if (!parsed) throw new Error(`Invalid browser project root: ${rootPath}`);
  if (parsed.scheme === "opfs") {
    await walkOpfsProject(parsed.id, visitor);
  } else {
    await walkFsaProject(parsed.id, visitor);
  }
}

export async function scanBrowserProjectFolder(
  rootPath: string,
): Promise<ScanResult> {
  const files: FsProjectFile[] = [];
  const folders: string[] = [];

  await walkBrowserProject(rootPath, async (relativePath, kind) => {
    if (kind === "directory") {
      const name = relativePath.split("/").pop() ?? relativePath;
      if (shouldSkipProjectDirectory(name)) return;
      folders.push(relativePath);
      return;
    }
    const name = relativePath.split("/").pop() ?? relativePath;
    const type = getProjectFileType(name);
    if (!type) return;
    let fileSize = 0;
    if (type === "image" || type === "other") {
      try {
        const info = await statBrowserFile(browserJoin(rootPath, relativePath));
        fileSize = info.size;
      } catch {
        fileSize = 0;
      }
    }
    files.push({
      relativePath,
      absolutePath: browserJoin(rootPath, relativePath),
      type,
      fileSize,
    });
  });

  return { files, folders };
}

export async function readBrowserTextFile(
  absolutePath: string,
): Promise<string> {
  const bytes = await readBrowserFile(absolutePath);
  return new TextDecoder().decode(bytes);
}

export async function writeBrowserTextFile(
  absolutePath: string,
  content: string,
): Promise<void> {
  await writeBrowserFile(absolutePath, content);
}

export async function readBrowserFile(
  absolutePath: string,
): Promise<Uint8Array> {
  const { rootPath, relativePath } = splitBrowserAbsolutePath(absolutePath);
  const parsed = parseBrowserRoot(rootPath);
  if (!parsed) throw new Error(`Invalid browser path: ${absolutePath}`);
  if (parsed.scheme === "opfs") {
    return readOpfsFile(parsed.id, relativePath);
  }
  return readFsaFile(parsed.id, relativePath);
}

export async function writeBrowserFile(
  absolutePath: string,
  data: Uint8Array | string,
): Promise<void> {
  const { rootPath, relativePath } = splitBrowserAbsolutePath(absolutePath);
  const parsed = parseBrowserRoot(rootPath);
  if (!parsed) throw new Error(`Invalid browser path: ${absolutePath}`);
  if (parsed.scheme === "opfs") {
    await writeOpfsFile(parsed.id, relativePath, data);
  } else {
    await writeFsaFile(parsed.id, relativePath, data);
  }
}

export async function browserPathExists(
  absolutePath: string,
): Promise<boolean> {
  try {
    const { rootPath, relativePath } = splitBrowserAbsolutePath(absolutePath);
    const parsed = parseBrowserRoot(rootPath);
    if (!parsed) return false;
    if (parsed.scheme === "opfs") {
      return opfsFileExists(parsed.id, relativePath);
    }
    return fsaFileExists(parsed.id, relativePath);
  } catch {
    return false;
  }
}

export async function mkdirBrowserPath(absolutePath: string): Promise<void> {
  const { rootPath, relativePath } = splitBrowserAbsolutePath(absolutePath);
  const parsed = parseBrowserRoot(rootPath);
  if (!parsed) throw new Error(`Invalid browser path: ${absolutePath}`);
  if (parsed.scheme === "opfs") {
    await mkdirOpfs(parsed.id, relativePath);
  } else {
    await mkdirFsa(parsed.id, relativePath);
  }
}

export async function statBrowserFile(
  absolutePath: string,
): Promise<{ size: number }> {
  const { rootPath, relativePath } = splitBrowserAbsolutePath(absolutePath);
  const parsed = parseBrowserRoot(rootPath);
  if (!parsed) throw new Error(`Invalid browser path: ${absolutePath}`);
  if (parsed.scheme === "opfs") {
    return statOpfsFile(parsed.id, relativePath);
  }
  return statFsaFile(parsed.id, relativePath);
}

export async function removeBrowserPath(
  absolutePath: string,
  recursive: boolean,
): Promise<void> {
  const { rootPath, relativePath } = splitBrowserAbsolutePath(absolutePath);
  const parsed = parseBrowserRoot(rootPath);
  if (!parsed) throw new Error(`Invalid browser path: ${absolutePath}`);
  if (parsed.scheme === "opfs") {
    await removeOpfsEntry(parsed.id, relativePath, recursive);
  } else {
    await removeFsaEntry(parsed.id, relativePath, recursive);
  }
}

export async function readBrowserImageAsDataUrl(
  absolutePath: string,
): Promise<string> {
  const bytes = await readBrowserFile(absolutePath);
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
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function getBrowserAssetUrlAsync(
  absolutePath: string,
): Promise<string> {
  const cached = assetUrlCache.get(absolutePath);
  if (cached) return cached;
  const bytes = await readBrowserFile(absolutePath);
  const ext = absolutePath.split(".").pop()?.toLowerCase() || "bin";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  };
  const mime = mimeMap[ext] ?? "application/octet-stream";
  const blob = new Blob([bytes as BufferSource], { type: mime });
  const url = URL.createObjectURL(blob);
  assetUrlCache.set(absolutePath, url);
  return url;
}

export async function getUniqueBrowserTargetName(
  rootPath: string,
  targetName: string,
): Promise<string> {
  const fullPath = browserJoin(rootPath, targetName);
  if (!(await browserPathExists(fullPath))) return targetName;

  const dotIndex = targetName.lastIndexOf(".");
  const slashIndex = targetName.lastIndexOf("/");
  const hasExt = dotIndex > slashIndex + 1;
  const baseName = hasExt ? targetName.slice(0, dotIndex) : targetName;
  const ext = hasExt ? targetName.slice(dotIndex) : "";

  for (let i = 1; i < 100; i++) {
    const candidate = `${baseName} (${i})${ext}`;
    if (!(await browserPathExists(browserJoin(rootPath, candidate)))) {
      return candidate;
    }
  }
  return `${baseName} (${Date.now()})${ext}`;
}

export { isBrowserProjectPath };
