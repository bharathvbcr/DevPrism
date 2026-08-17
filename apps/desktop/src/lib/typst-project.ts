/**
 * Typst project structure: which `.typ` file is the compile root.
 *
 * LaTeX advertises its root with `\documentclass`; Typst has no such marker —
 * any file is a valid entry point. So the root is derived structurally: a
 * `.typ` file that **nothing else imports** is a root, and an imported file
 * compiles via whichever root pulls it in.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ProjectFile } from "@/stores/document-store";
import type { TypstCompileResult } from "@/lib/resume-synthesis/typst-compile";

/** Well-known entry-point names, preferred when several roots exist. */
const PREFERRED_ROOT_NAMES = ["main.typ", "resume.typ", "document.typ"];

/**
 * Extract the paths a Typst file imports or includes.
 *
 * Matches `#import "…"` and `#include "…"`. Only string-literal paths are
 * detected — a computed path (`#import mypath`) cannot be resolved statically,
 * which at worst means we treat a child as a root.
 */
export function parseTypstImports(content: string): string[] {
  const out: string[] = [];
  const re = /#(?:import|include)\s+"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].replace(/\\(.)/g, "$1");
    // Package imports (`@preview/…`) are not project files.
    if (raw.startsWith("@") || raw.length === 0) continue;
    out.push(raw);
  }
  return out;
}

/** Normalize a `a/b/../c` style path, keeping it project-relative. */
export function normalizeRelativePath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Escaping the project root is not resolvable.
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.length > 0 ? stack.join("/") : null;
}

/**
 * Resolve an import written inside `fromRelativePath` to a project-relative
 * path. Typst resolves a leading `/` against the project root and everything
 * else against the importing file's directory.
 */
export function resolveTypstImport(
  fromRelativePath: string,
  importPath: string,
): string | null {
  if (importPath.startsWith("/")) {
    return normalizeRelativePath(importPath);
  }
  const dir = fromRelativePath.replace(/\\/g, "/").split("/").slice(0, -1);
  return normalizeRelativePath([...dir, importPath].join("/"));
}

/** Project-relative paths of every `.typ` file imported by another `.typ`. */
export function typstImportedPaths(files: ProjectFile[]): Set<string> {
  const imported = new Set<string>();
  for (const file of files) {
    if (file.type !== "typst" || !file.content) continue;
    for (const raw of parseTypstImports(file.content)) {
      const resolved = resolveTypstImport(file.relativePath, raw);
      if (!resolved) continue;
      imported.add(resolved);
      // Typst allows omitting the extension in some tooling; accept both.
      if (!resolved.endsWith(".typ")) imported.add(`${resolved}.typ`);
    }
  }
  return imported;
}

export interface TypstRootOption {
  rootId: string;
  targetPath: string;
  label: string;
}

/**
 * Typst files that nothing else imports — the plausible compile roots.
 *
 * When every `.typ` is imported (a cycle, or a computed import we could not
 * see), all of them are returned rather than none, so the UI never offers an
 * empty list for a project that clearly has Typst sources.
 */
export function listTypstRoots(files: ProjectFile[]): TypstRootOption[] {
  const typFiles = files.filter((f) => f.type === "typst");
  if (typFiles.length === 0) return [];

  const imported = typstImportedPaths(files);
  let roots = typFiles.filter((f) => !imported.has(f.relativePath));
  if (roots.length === 0) roots = typFiles;

  return roots
    .map((f) => ({
      rootId: f.id,
      targetPath: f.relativePath,
      label: f.name,
    }))
    .sort((a, b) => {
      const ai = PREFERRED_ROOT_NAMES.indexOf(a.label.toLowerCase());
      const bi = PREFERRED_ROOT_NAMES.indexOf(b.label.toLowerCase());
      const aRank = ai === -1 ? PREFERRED_ROOT_NAMES.length : ai;
      const bRank = bi === -1 ? PREFERRED_ROOT_NAMES.length : bi;
      if (aRank !== bRank) return aRank - bRank;
      return a.label.localeCompare(b.label);
    });
}

/**
 * The `.typ` file that should be compiled when `fileId` is active.
 *
 * If the active file is itself a root, that is the answer. Otherwise the
 * first root that reaches it transitively; failing that, the file itself.
 */
export function resolveTypstRoot(fileId: string, files: ProjectFile[]): string {
  const file = files.find((f) => f.id === fileId);
  if (!file || file.type !== "typst") return fileId;

  const roots = listTypstRoots(files);
  if (roots.some((r) => r.rootId === fileId)) return fileId;

  const byPath = new Map(
    files.filter((f) => f.type === "typst").map((f) => [f.relativePath, f]),
  );

  for (const root of roots) {
    const seen = new Set<string>();
    const stack = [root.targetPath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (current === file.relativePath) return root.rootId;
      const node = byPath.get(current);
      if (!node?.content) continue;
      for (const raw of parseTypstImports(node.content)) {
        const resolved = resolveTypstImport(current, raw);
        if (resolved && !seen.has(resolved)) stack.push(resolved);
      }
    }
  }
  return fileId;
}

/**
 * Compile a Typst document inside a project directory (resolves `#import`
 * against the project root, unlike the hermetic resume compiler).
 */
export async function compileTypstProject(
  projectDir: string,
  mainFile: string,
): Promise<TypstCompileResult> {
  return invoke<TypstCompileResult>("career_typst_compile_project", {
    projectDir,
    mainFile,
  });
}

/** Headings for the document outline: `= Title`, `== Section`, … */
export interface TypstHeading {
  level: number;
  title: string;
  line: number;
}

/**
 * Parse Typst headings, skipping fenced raw blocks and line comments so a
 * `=` inside sample code does not become an outline entry.
 */
export function parseTypstHeadings(content: string): TypstHeading[] {
  const out: TypstHeading[] = [];
  const lines = content.split("\n");
  let inRaw = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.trimStart().startsWith("```");
    if (fence) {
      inRaw = !inRaw;
      continue;
    }
    if (inRaw) continue;
    const m = /^(=+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    out.push({ level: m[1].length, title: m[2].trim(), line: i + 1 });
  }
  return out;
}
