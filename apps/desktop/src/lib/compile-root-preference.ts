import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  listCompileRoots,
  resolveCompileTarget,
} from "@/lib/latex-compiler";

export const FOLLOW_EDITOR_COMPILE_ROOT = "__follow_editor__";

export function getCompileRootPreference(projectRoot: string): string | null {
  return useSettingsStore.getState().compileRootByProject[projectRoot] ?? null;
}

export function setCompileRootPreference(
  projectRoot: string,
  rootId: string | null,
): void {
  useSettingsStore.getState().setCompileRootForProject(projectRoot, rootId);
}

export function clearCompileRootPreference(projectRoot: string): void {
  setCompileRootPreference(projectRoot, null);
}

/** True when the user has explicitly chosen a compile/preview target for this project. */
export function hasPinnedCompileRoot(
  projectRoot: string | null,
  files: ProjectFile[],
): boolean {
  if (!projectRoot) return false;
  const preferred = getCompileRootPreference(projectRoot);
  if (!preferred) return false;
  return listCompileRoots(files).some((root) => root.rootId === preferred);
}

/**
 * Resolve which root file the PDF preview should show.
 * Uses the pinned compile/preview target when set; otherwise follows the active editor file.
 */
export function resolvePreviewCompileRoot(
  projectRoot: string | null,
  activeFileId: string,
  files: ProjectFile[],
): string {
  if (hasPinnedCompileRoot(projectRoot, files)) {
    return getCompileRootPreference(projectRoot!)!;
  }
  return resolveTexRoot(activeFileId, files);
}

/** Resolve the compile target honoring the pinned preview root when set. */
export function resolveActiveCompileTarget(
  projectRoot: string | null,
  activeFileId: string,
  files: ProjectFile[],
): { rootId: string; targetPath: string } | null {
  const preferred = projectRoot ? getCompileRootPreference(projectRoot) : null;
  return resolveCompileTarget(activeFileId, files, preferred);
}

const INPUT_RE =
  /\\(?:input|include|subfile|includeonly|InputIfFileExists|subfileinclude)\*?(?:\[[^\]]*\])?\{([^}]+)\}/g;

function resolveTexInputRef(ref: string, files: ProjectFile[]): string | null {
  const trimmed = ref.trim();
  const candidates = [
    trimmed,
    `${trimmed}.tex`,
    trimmed.replace(/\.tex$/i, ""),
  ];
  for (const candidate of candidates) {
    const match =
      files.find((f) => f.relativePath === candidate) ??
      files.find((f) => f.name === candidate) ??
      files.find((f) => f.relativePath.endsWith(`/${candidate}`));
    if (match) return match.id;
  }
  return null;
}

/** All .tex files transitively \\input/\\include'd from a compile root. */
export function collectTransitiveTexInputs(
  rootId: string,
  files: ProjectFile[],
): Set<string> {
  const visited = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const file = files.find((f) => f.id === id);
    if (!file?.content || file.type !== "tex") continue;
    for (const match of file.content.matchAll(INPUT_RE)) {
      const childId = resolveTexInputRef(match[1], files);
      if (childId && !visited.has(childId)) queue.push(childId);
    }
  }
  return visited;
}

/**
 * Whether an edited file can affect the PDF for a given compile root.
 * Used to skip auto-recompile when the pinned target is unrelated to the edit.
 */
export function fileAffectsCompileRoot(
  editedFileId: string,
  targetRootId: string,
  files: ProjectFile[],
): boolean {
  if (!editedFileId) return true;
  if (editedFileId === targetRootId) return true;

  const edited = files.find((f) => f.id === editedFileId);
  if (!edited) return false;

  if (edited.type === "tex") {
    if (collectTransitiveTexInputs(targetRootId, files).has(editedFileId)) {
      return true;
    }
    return resolveTexRoot(editedFileId, files) === targetRootId;
  }

  const root = files.find((f) => f.id === targetRootId);
  if (!root?.content) return false;
  const haystack = root.content;
  const bibStem =
    edited.type === "bib" ? edited.name.replace(/\.bib$/i, "") : null;
  const names = [
    edited.name,
    edited.relativePath,
    edited.id,
    ...(bibStem ? [bibStem, `{${bibStem}}`, `{${edited.name}}`] : []),
  ];
  if (names.some((name) => haystack.includes(name))) return true;

  for (const texId of collectTransitiveTexInputs(targetRootId, files)) {
    const tex = files.find((f) => f.id === texId);
    if (!tex?.content) continue;
    if (names.some((name) => tex.content!.includes(name))) return true;
  }
  return false;
}
