export type BrowserDropFile = {
  file: File;
  relativePath: string;
};

function readDirectoryEntry(
  entry: FileSystemDirectoryEntry,
  prefix: string,
): Promise<BrowserDropFile[]> {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader();
    const batch: BrowserDropFile[] = [];

    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) {
          resolve(batch);
          return;
        }
        try {
          for (const child of entries) {
            const childPath = prefix ? `${prefix}/${child.name}` : child.name;
            if (child.isFile) {
              const file = await new Promise<File>((res, rej) => {
                (child as FileSystemFileEntry).file(res, rej);
              });
              batch.push({ file, relativePath: childPath });
            } else if (child.isDirectory) {
              batch.push(
                ...(await readDirectoryEntry(
                  child as FileSystemDirectoryEntry,
                  childPath,
                )),
              );
            }
          }
          readBatch();
        } catch (err) {
          reject(err);
        }
      }, reject);
    };

    readBatch();
  });
}

async function entryToDropFiles(
  entry: FileSystemEntry,
  prefix = "",
): Promise<BrowserDropFile[]> {
  const name = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    return [{ file, relativePath: name }];
  }
  if (entry.isDirectory) {
    return readDirectoryEntry(entry as FileSystemDirectoryEntry, name);
  }
  return [];
}

/** Collect dropped files from a browser DragEvent (includes folder trees). */
export async function collectBrowserDropFiles(
  dataTransfer: DataTransfer,
): Promise<BrowserDropFile[]> {
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    const fromEntries: BrowserDropFile[] = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        fromEntries.push(...(await entryToDropFiles(entry)));
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          fromEntries.push({
            file,
            relativePath: file.webkitRelativePath || file.name,
          });
        }
      }
    }
    if (fromEntries.length > 0) return fromEntries;
  }

  return [...(dataTransfer.files ?? [])].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

export function classifyBrowserDropFiles(files: BrowserDropFile[]): {
  zips: File[];
  loose: BrowserDropFile[];
} {
  const zips: File[] = [];
  const loose: BrowserDropFile[] = [];

  for (const item of files) {
    const baseName =
      item.relativePath.split("/").pop()?.toLowerCase() ??
      item.file.name.toLowerCase();
    if (baseName.endsWith(".zip")) {
      zips.push(item.file);
    } else {
      loose.push(item);
    }
  }

  return { zips, loose };
}

export function hasBrowserFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return [...dataTransfer.types].some(
    (type) => type === "Files" || type === "application/x-moz-file",
  );
}
