export const BROWSER_MAX_ENTRIES = 20_000;
export const BROWSER_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export const OPFS_SCHEME = "opfs://";
export const FSA_SCHEME = "fsa://";
export const BROWSER_FILE_SCHEME = "browser-file://";

export interface ImportedProject {
  path: string;
  name: string;
}

export function sanitizeProjectName(raw: string): string {
  const cleaned = raw
    .split("")
    .map((c) => {
      if ('/\\:*?"<>|\0'.includes(c) || c.charCodeAt(0) < 32) return "-";
      return c;
    })
    .join("");
  const trimmed = cleaned
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return trimmed.length > 0 ? trimmed : "latex-project";
}

export function isBrowserProjectPath(path: string): boolean {
  return path.startsWith(OPFS_SCHEME) || path.startsWith(FSA_SCHEME);
}

export function browserJoin(...parts: string[]): string {
  const normalized = parts
    .filter(Boolean)
    .map((p, i) => {
      let s = p.replace(/\\/g, "/");
      if (i > 0) s = s.replace(/^\/+/, "");
      return s.replace(/\/+$/, "");
    })
    .join("/");
  return normalized.replace(/\/+/g, "/");
}

export function parseBrowserRoot(path: string): {
  scheme: "opfs" | "fsa";
  id: string;
} | null {
  if (path.startsWith(OPFS_SCHEME)) {
    const id = path.slice(OPFS_SCHEME.length).split("/")[0];
    return id ? { scheme: "opfs", id } : null;
  }
  if (path.startsWith(FSA_SCHEME)) {
    const id = path.slice(FSA_SCHEME.length).split("/")[0];
    return id ? { scheme: "fsa", id } : null;
  }
  return null;
}

export function browserRootPath(scheme: "opfs" | "fsa", id: string): string {
  return `${scheme === "opfs" ? OPFS_SCHEME : FSA_SCHEME}${id}`;
}

export function relativeFromBrowserAbsolute(
  rootPath: string,
  absolutePath: string,
): string {
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(`Path is outside project root: ${absolutePath}`);
  }
  return absolutePath.slice(prefix.length);
}

/** If every entry lives under one common top-level directory, return that name. */
export function singleRootPrefix(names: string[]): string | null {
  let root: string | null = null;
  let sawChild = false;

  for (const raw of names) {
    const name = raw.replace(/^\/+/, "");
    if (!name) continue;
    const top = name.split("/")[0] ?? "";
    if (!top || top === "__MACOSX") continue;
    if (root === null) root = top;
    else if (root !== top) return null;
    if (name.length > top.length) sawChild = true;
  }

  return root && sawChild ? root : null;
}

/** Reject zip-slip paths inside an archive entry name. */
export function safeZipRelativePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return null;
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) return null;
  return normalized;
}

export function isTexFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".tex") || lower.endsWith(".ltx");
}
