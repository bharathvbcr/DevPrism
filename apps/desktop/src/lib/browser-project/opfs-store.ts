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

async function opfsProjectsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("devprism-projects", { create: true });
}

export async function listOpfsProjectIds(): Promise<string[]> {
  const root = await opfsProjectsRoot();
  const ids: string[] = [];
  for await (const [name] of directoryEntries(root)) {
    ids.push(name);
  }
  return ids;
}

export async function getOpfsProjectDir(
  projectId: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const root = await opfsProjectsRoot();
  return root.getDirectoryHandle(projectId, { create });
}

export async function opfsProjectExists(projectId: string): Promise<boolean> {
  try {
    const root = await opfsProjectsRoot();
    await root.getDirectoryHandle(projectId);
    return true;
  } catch {
    return false;
  }
}

export async function uniqueOpfsProjectId(baseName: string): Promise<string> {
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = sanitized || "latex-project";
  if (!(await opfsProjectExists(stem))) return stem;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem}-${n}`;
    if (!(await opfsProjectExists(candidate))) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

export async function getOpfsDirectoryAtRelativePath(
  projectId: string,
  relativePath: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = await getOpfsProjectDir(projectId, create);
  if (!relativePath) return dir;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

export async function writeOpfsFile(
  projectId: string,
  relativePath: string,
  data: Uint8Array | string,
): Promise<void> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getOpfsDirectoryAtRelativePath(projectId, dirPath, true);
  const file = await dir.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(data as BufferSource);
  await writable.close();
}

export async function readOpfsFile(
  projectId: string,
  relativePath: string,
): Promise<Uint8Array> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getOpfsDirectoryAtRelativePath(projectId, dirPath);
  const file = await dir.getFileHandle(fileName);
  const blob = await file.getFile();
  return new Uint8Array(await blob.arrayBuffer());
}

export async function opfsFileExists(
  projectId: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await readOpfsFile(projectId, relativePath);
    return true;
  } catch {
    return false;
  }
}

export async function removeOpfsProject(projectId: string): Promise<void> {
  const root = await opfsProjectsRoot();
  await root.removeEntry(projectId, { recursive: true });
}

export async function removeOpfsEntry(
  projectId: string,
  relativePath: string,
  recursive: boolean,
): Promise<void> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getOpfsDirectoryAtRelativePath(projectId, dirPath);
  await dir.removeEntry(name, { recursive });
}

export async function walkOpfsProject(
  projectId: string,
  visitor: (
    relativePath: string,
    kind: "file" | "directory",
  ) => void | Promise<void>,
): Promise<void> {
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
  const root = await getOpfsProjectDir(projectId);
  await walk(root, "");
}

export async function opfsContainsTex(projectId: string): Promise<boolean> {
  let found = false;
  await walkOpfsProject(projectId, (relativePath, kind) => {
    if (kind === "file") {
      const lower = relativePath.toLowerCase();
      if (lower.endsWith(".tex") || lower.endsWith(".ltx")) found = true;
    }
  });
  return found;
}

export async function mkdirOpfs(
  projectId: string,
  relativePath: string,
): Promise<void> {
  await getOpfsDirectoryAtRelativePath(projectId, relativePath, true);
}

export async function statOpfsFile(
  projectId: string,
  relativePath: string,
): Promise<{ size: number }> {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPath = slash >= 0 ? normalized.slice(0, slash) : "";
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dir = await getOpfsDirectoryAtRelativePath(projectId, dirPath);
  const file = await dir.getFileHandle(fileName);
  const blob = await file.getFile();
  return { size: blob.size };
}
