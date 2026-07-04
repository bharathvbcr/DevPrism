export type ProjectFileType =
  | "tex"
  | "image"
  | "pdf"
  | "bib"
  | "style"
  | "other";

export interface FsProjectFile {
  relativePath: string;
  absolutePath: string;
  type: ProjectFileType;
  fileSize: number;
}

/** Files larger than this (1 MB) are not auto-loaded into memory during project open. */
export const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".bmp",
  ".webp",
]);

const STYLE_EXTENSIONS = new Set([
  ".sty",
  ".cls",
  ".bst",
  ".def",
  ".cfg",
  ".fd",
  ".dtx",
  ".ins",
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  "env",
]);

const IGNORED_EXTENSIONS = new Set([
  ".aux",
  ".log",
  ".out",
  ".toc",
  ".lof",
  ".lot",
  ".fls",
  ".fdb_latexmk",
  ".synctex.gz",
  ".synctex",
  ".blg",
  ".bbl",
  ".nav",
  ".snm",
  ".vrb",
  ".run.xml",
  ".bcf",
  ".pyc",
  ".pyo",
  ".pyd",
  ".so",
  ".dylib",
  ".o",
  ".obj",
  ".dll",
  ".exe",
  ".bin",
]);

export function shouldSkipProjectDirectory(name: string): boolean {
  return (
    name.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(name.toLowerCase())
  );
}

export function getProjectFileType(name: string): ProjectFileType | null {
  const lower = name.toLowerCase();
  for (const ext of IGNORED_EXTENSIONS) {
    if (lower.endsWith(ext)) return null;
  }
  if (lower.endsWith(".tex") || lower.endsWith(".ltx")) return "tex";
  if (lower.endsWith(".bib")) return "bib";
  if (lower.endsWith(".pdf")) return "pdf";
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "image";
  }
  for (const ext of STYLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "style";
  }
  return "other";
}

export interface ScanResult {
  files: FsProjectFile[];
  folders: string[];
}
