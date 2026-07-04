import { registerFsaRoot } from "./registry";

type DirectoryEntry = [string, FileSystemHandle];

function directoryEntries(
  dir: FileSystemDirectoryHandle,
): AsyncIterableIterator<DirectoryEntry> {
  return (
    dir as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<DirectoryEntry>;
    }
  ).entries();
}

export async function getFsaDirectoryAtRelativePath(
  handleId: string,
  relativePath: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const { getFsaRoot } = await import("./registry");
  const root = getFsaRoot(handleId);
  if (!root) {
    throw new Error(
      "This folder session expired. Open the project folder again.",
    );
  }
  let dir = root;
  if (!relativePath) return dir;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

export async function writeFsaFile(
  handleId: string,
  relativePath: string,
  data: Uint8Array | string,
): Promise<void> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getFsaDirectoryAtRelativePath(handleId, dirPath, true);
  const file = await dir.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(data as BufferSource);
  await writable.close();
}

export async function readFsaFile(
  handleId: string,
  relativePath: string,
): Promise<Uint8Array> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getFsaDirectoryAtRelativePath(handleId, dirPath);
  const file = await dir.getFileHandle(fileName);
  const blob = await file.getFile();
  return new Uint8Array(await blob.arrayBuffer());
}

export async function fsaFileExists(
  handleId: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await readFsaFile(handleId, relativePath);
    return true;
  } catch {
    return false;
  }
}

export async function walkFsaProject(
  handleId: string,
  visitor: (
    relativePath: string,
    kind: "file" | "directory",
  ) => void | Promise<void>,
): Promise<void> {
  const { getFsaRoot } = await import("./registry");
  const root = getFsaRoot(handleId);
  if (!root) {
    throw new Error(
      "This folder session expired. Open the project folder again.",
    );
  }

  async function walk(
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    for await (const [name, handle] of directoryEntries(dir)) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        await visitor(relativePath, "directory");
        await walk(handle as FileSystemDirectoryHandle, relativePath);
      } else {
        await visitor(relativePath, "file");
      }
    }
  }

  await walk(root, "");
}

export async function mkdirFsa(
  handleId: string,
  relativePath: string,
): Promise<void> {
  await getFsaDirectoryAtRelativePath(handleId, relativePath, true);
}

export async function statFsaFile(
  handleId: string,
  relativePath: string,
): Promise<{ size: number }> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getFsaDirectoryAtRelativePath(handleId, dirPath);
  const file = await dir.getFileHandle(fileName);
  const blob = await file.getFile();
  return { size: blob.size };
}

export async function removeFsaEntry(
  handleId: string,
  relativePath: string,
  recursive: boolean,
): Promise<void> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getFsaDirectoryAtRelativePath(handleId, dirPath);
  await dir.removeEntry(name, { recursive });
}

export function registerPickedFolder(
  handle: FileSystemDirectoryHandle,
): string {
  const id = crypto.randomUUID();
  registerFsaRoot(id, handle);
  return id;
}
