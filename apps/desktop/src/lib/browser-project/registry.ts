const fsaRoots = new Map<string, FileSystemDirectoryHandle>();

export function registerFsaRoot(
  id: string,
  handle: FileSystemDirectoryHandle,
): void {
  fsaRoots.set(id, handle);
}

export function getFsaRoot(id: string): FileSystemDirectoryHandle | undefined {
  return fsaRoots.get(id);
}

export function unregisterFsaRoot(id: string): void {
  fsaRoots.delete(id);
}
