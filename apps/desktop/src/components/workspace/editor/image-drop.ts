import { EditorView } from "@codemirror/view";
import { copyFileToProject } from "@/lib/tauri/fs";
import { useDocumentStore } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("image-drop");

/**
 * Image extensions accepted on editor drop. Raster + eps go through
 * \includegraphics; svg goes through \includesvg. PDF is intentionally
 * excluded — a dropped PDF is more likely a document to open than a figure.
 */
export const IMAGE_DROP_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "bmp",
  "webp",
  "eps",
]);

/** Project-relative folder that dropped images are copied into. */
const IMAGE_FOLDER = "images";

function extOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True if the OS path looks like an image LaTeX can include. */
export function isDroppableImage(path: string): boolean {
  return IMAGE_DROP_EXTENSIONS.has(extOf(path));
}

/** Filter a dropped path list down to includable images. */
export function filterImagePaths(paths: string[]): string[] {
  return paths.filter(isDroppableImage);
}

/** Derive a LaTeX-safe label/caption stem from a file path. */
function captionAndLabel(relativePath: string): {
  caption: string;
  label: string;
} {
  const base = (relativePath.split(/[/\\]/).pop() ?? relativePath).replace(
    /\.[^.]+$/,
    "",
  );
  // Caption: humanize separators; Label: strip to a safe key set.
  const caption = base.replace(/[_-]+/g, " ").trim() || "figure";
  const label =
    "fig:" +
    (base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "figure");
  return { caption, label };
}

/** True if the path is an SVG (inserted via \includesvg, not \includegraphics). */
function isSvgPath(path: string): boolean {
  return /\.svg$/i.test(path);
}

/**
 * Build a `figure` environment for a project-relative image path.
 * The graphics path stays relative to the project root, which is where the
 * LaTeX compiler resolves \includegraphics/\includesvg from. SVG files use
 * \includesvg (svg package); everything else uses \includegraphics.
 */
export function buildFigureSnippet(relativePath: string): string {
  const graphicsPath = relativePath.replace(/\\/g, "/");
  const { caption, label } = captionAndLabel(relativePath);
  const include = isSvgPath(graphicsPath)
    ? `  \\includesvg[width=0.8\\linewidth]{${graphicsPath}}`
    : `  \\includegraphics[width=0.8\\linewidth]{${graphicsPath}}`;
  return [
    "\\begin{figure}[htbp]",
    "  \\centering",
    include,
    `  \\caption{${caption}}`,
    `  \\label{${label}}`,
    "\\end{figure}",
  ].join("\n");
}

/** Offset just after the `\documentclass` line, or null if there's no preamble. */
function preambleInsertPos(source: string): number | null {
  const m = /\\documentclass[^\n]*\n/.exec(source);
  return m ? m.index + m[0].length : null;
}

/**
 * If the document carries its own preamble (`\documentclass`) but never loads
 * `packageName` (matched by `presentPattern`), return a change that inserts
 * `\usepackage{packageName}` right after the `\documentclass` line so dropped
 * figures actually compile. Returns null when the package is already available,
 * or when there is no local preamble (e.g. an `\input`-ed sub-file that
 * inherits the root's packages).
 */
function packageChange(
  source: string,
  packageName: string,
  presentPattern: RegExp,
): { from: number; insert: string } | null {
  const pos = preambleInsertPos(source);
  if (pos === null) return null;
  if (presentPattern.test(source)) return null;
  return { from: pos, insert: `\\usepackage{${packageName}}\n` };
}

/** Ensure `graphicx` (or `graphics`) is loaded for \includegraphics. */
export function graphicsPackageChange(
  source: string,
): { from: number; insert: string } | null {
  return packageChange(
    source,
    "graphicx",
    /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bgraphic[sx]\b[^}]*\}/,
  );
}

/** Ensure the `svg` package is loaded for \includesvg. */
export function svgPackageChange(
  source: string,
): { from: number; insert: string } | null {
  return packageChange(
    source,
    "svg",
    /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bsvg\b[^}]*\}/,
  );
}

/**
 * Copy dropped image files into the project's images/ folder and insert
 * figure environments referencing them at the given document position.
 *
 * Returns the number of images inserted (0 if none were images or no project).
 */
export async function insertDroppedImages(
  view: EditorView,
  sourcePaths: string[],
  dropPos: number,
): Promise<number> {
  const state = useDocumentStore.getState();
  const projectRoot = state.projectRoot;
  if (!projectRoot) return 0;

  const imagePaths = filterImagePaths(sourcePaths);
  if (imagePaths.length === 0) return 0;

  const snippets: string[] = [];
  let needGraphicx = false;
  let needSvg = false;
  for (const sourcePath of imagePaths) {
    const fileName = sourcePath.split(/[/\\]/).pop() || sourcePath;
    try {
      // copyFileToProject deduplicates and returns the actual relative path.
      const relativePath = await copyFileToProject(
        projectRoot,
        sourcePath,
        `${IMAGE_FOLDER}/${fileName}`,
      );
      snippets.push(buildFigureSnippet(relativePath));
      if (isSvgPath(relativePath)) needSvg = true;
      else needGraphicx = true;
    } catch (err) {
      log.error("failed to copy dropped image", {
        sourcePath,
        error: String(err),
      });
    }
  }

  if (snippets.length === 0) return 0;

  // Snap insertion to the start of the line nearest the drop so figures land
  // on their own lines rather than splitting existing text.
  const doc = view.state.doc;
  const safePos = Math.max(0, Math.min(dropPos, doc.length));
  const insertAt = doc.lineAt(safePos).from;
  const figureText = `${snippets.join("\n\n")}\n\n`;

  const changes: { from: number; insert: string }[] = [
    { from: insertAt, insert: figureText },
  ];
  // Best-effort: ensure the relevant include package(s) are loaded so the new
  // figures compile. selection is in post-change coordinates, so accumulate the
  // length of any preamble insertions that sit before the figure.
  const source = doc.toString();
  let shift = 0;
  for (const change of [
    needGraphicx ? graphicsPackageChange(source) : null,
    needSvg ? svgPackageChange(source) : null,
  ]) {
    if (!change) continue;
    changes.push(change);
    if (change.from <= insertAt) shift += change.insert.length;
  }

  view.dispatch({
    changes,
    selection: { anchor: insertAt + figureText.length + shift },
  });
  view.focus();

  // Bring the new image files into the sidebar tree.
  await state.refreshFiles();

  return snippets.length;
}
