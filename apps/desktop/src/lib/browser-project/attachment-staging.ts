import { BROWSER_FILE_SCHEME } from "./constants";

const stagedFiles = new Map<string, File>();

export type StagedBrowserFile = {
  path: string;
  file: File;
};

export function isStagedBrowserFilePath(path: string): boolean {
  return path.startsWith(BROWSER_FILE_SCHEME);
}

export function stageBrowserFile(file: File): string {
  const id = crypto.randomUUID();
  const path = `${BROWSER_FILE_SCHEME}${id}`;
  stagedFiles.set(path, file);
  return path;
}

export function getStagedBrowserFile(path: string): File | undefined {
  return stagedFiles.get(path);
}

export function stagedBrowserFileName(path: string): string {
  return stagedFiles.get(path)?.name ?? path.split("/").pop() ?? path;
}
