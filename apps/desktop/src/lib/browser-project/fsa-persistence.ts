import { FSA_SCHEME, OPFS_SCHEME, parseBrowserRoot } from "./constants";
import { getFsaRoot, registerFsaRoot } from "./registry";

const DB_NAME = "devprism-browser-projects";
const DB_VERSION = 1;
const STORE = "fsa-handles";
const META_STORE = "fsa-meta";

interface FsaMeta {
  id: string;
  folderName: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function persistFsaRoot(
  id: string,
  handle: FileSystemDirectoryHandle,
  folderName: string,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE], "readwrite");
    tx.objectStore(STORE).put(handle, id);
    tx.objectStore(META_STORE).put(
      { id, folderName, savedAt: Date.now() } satisfies FsaMeta,
      id,
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadPersistedFsaRoot(
  id: string,
): Promise<FileSystemDirectoryHandle | null> {
  if (getFsaRoot(id)) return getFsaRoot(id)!;
  try {
    const db = await openDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>(
      (resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () =>
          resolve(
            (req.result as FileSystemDirectoryHandle | undefined) ?? null,
          );
        req.onerror = () => reject(req.error);
      },
    );
    db.close();
    if (handle) registerFsaRoot(id, handle);
    return handle;
  } catch {
    return null;
  }
}

export async function getPersistedFsaFolderName(
  id: string,
): Promise<string | null> {
  try {
    const db = await openDb();
    const meta = await new Promise<FsaMeta | null>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const req = tx.objectStore(META_STORE).get(id);
      req.onsuccess = () =>
        resolve((req.result as FsaMeta | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return meta?.folderName ?? null;
  } catch {
    return null;
  }
}

export async function ensureFsaProjectPermission(
  rootPath: string,
): Promise<void> {
  const parsed = parseBrowserRoot(rootPath);
  if (!parsed || parsed.scheme !== "fsa") return;

  const handle = await loadPersistedFsaRoot(parsed.id);
  if (!handle) {
    throw new Error(
      "This folder session expired. Use Open Folder to grant access again.",
    );
  }

  let permission = await (
    handle as FileSystemDirectoryHandle & {
      queryPermission: (opts: {
        mode: "readwrite";
      }) => Promise<PermissionState>;
    }
  ).queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    permission = await (
      handle as FileSystemDirectoryHandle & {
        requestPermission: (opts: {
          mode: "readwrite";
        }) => Promise<PermissionState>;
      }
    ).requestPermission({ mode: "readwrite" });
  }
  if (permission !== "granted") {
    throw new Error(
      "Folder access was not granted. Use Open Folder to try again.",
    );
  }
}

export async function ensureBrowserProjectAccessible(
  rootPath: string,
): Promise<void> {
  if (rootPath.startsWith(FSA_SCHEME)) {
    await ensureFsaProjectPermission(rootPath);
  }
}

export function displayProjectPathLabel(
  path: string,
  storedName?: string,
): string {
  if (storedName?.trim()) return storedName.trim();
  if (path.startsWith(OPFS_SCHEME)) {
    return path.slice(OPFS_SCHEME.length).split("/")[0] ?? "Imported project";
  }
  if (path.startsWith(FSA_SCHEME)) {
    return "Linked folder";
  }
  return path.split(/[/\\]/).pop() || path;
}
