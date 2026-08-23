import { unzip } from "fflate";
import {
  isTexFileName,
  safeZipRelativePath,
  singleRootPrefix,
} from "@/lib/browser-project/constants";

export { isTexFileName };

/** A LaTeX resume source ready for the import wizard textarea. */
export interface ResumeSource {
  source: string;
  /** Human label of where the source came from (file name). */
  label: string;
}

export function isZipFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".zip");
}

const PRIMARY_BASENAMES = [
  "main.tex",
  "resume.tex",
  "cv.tex",
  "curriculum_vitae.tex",
  "curriculum-vitae.tex",
];

function primaryRank(name: string): number | null {
  const base = (name.split("/").pop() ?? "").toLowerCase();
  const idx = PRIMARY_BASENAMES.indexOf(base);
  return idx === -1 ? null : idx;
}

function compareCandidates(a: string, b: string): number {
  const ra = primaryRank(a);
  const rb = primaryRank(b);
  if (ra !== null || rb !== null) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    if (ra !== rb) return ra - rb;
  }
  const da = a.split("/").length;
  const db = b.split("/").length;
  if (da !== db) return da - db;
  return a.localeCompare(b);
}

/**
 * Sanitized zip entries relative to a single wrapper directory
 * (Overleaf-style), with __MACOSX noise removed.
 */
export function sanitizeZipTexEntries(
  entries: Record<string, Uint8Array>,
): Map<string, Uint8Array> {
  const strip = singleRootPrefix(Object.keys(entries));
  const prefix = strip ? `${strip}/` : "";
  const cleaned = new Map<string, Uint8Array>();

  for (const [rawName, data] of Object.entries(entries)) {
    if (rawName.includes("__MACOSX")) continue;
    const safe = safeZipRelativePath(rawName);
    if (!safe) continue;
    const relative =
      prefix && safe.startsWith(prefix) ? safe.slice(prefix.length) : safe;
    if (!relative || !isTexFileName(relative.split("/").pop() ?? "")) continue;
    cleaned.set(relative, data);
  }
  return cleaned;
}

/**
 * Pick the resume's primary .tex entry from raw zip entries: known resume
 * basenames first, then shallowest path, then lexicographic for determinism.
 */
export function pickResumeTexEntry(
  entries: Record<string, Uint8Array>,
): { name: string; text: string } | null {
  const texEntries = sanitizeZipTexEntries(entries);
  if (texEntries.size === 0) return null;

  const names = [...texEntries.keys()].sort(compareCandidates);
  const chosen = names[0];
  const decoder = new TextDecoder("utf-8");
  return { name: chosen, text: decoder.decode(texEntries.get(chosen)) };
}

/**
 * Extract the resume .tex source from zip bytes. Throws when the bytes are
 * not a zip archive or contain no LaTeX (.tex/.ltx) files.
 */
export async function readResumeSourceFromZipBytes(
  bytes: Uint8Array,
  label: string,
): Promise<ResumeSource> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = await new Promise((resolve, reject) => {
      unzip(bytes, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  } catch {
    throw new Error(`"${label}" is not a valid zip archive.`);
  }

  const picked = pickResumeTexEntry(entries);
  if (!picked) {
    throw new Error(`"${label}" does not contain any LaTeX (.tex) files.`);
  }
  return { source: picked.text, label: picked.name };
}

/** Browser drop/pick path: a File that is either a .zip archive or .tex source. */
export async function readResumeSourceFromFile(
  file: File,
): Promise<ResumeSource> {
  const name = file.name;
  if (isZipFileName(name)) {
    return readResumeSourceFromZipBytes(
      new Uint8Array(await file.arrayBuffer()),
      name,
    );
  }
  if (isTexFileName(name) || file.type === "text/plain") {
    const text = await file.text();
    if (!text.trim()) throw new Error(`"${name}" is empty.`);
    return { source: text, label: name };
  }
  throw new Error("Drop a .zip archive or a .tex file.");
}

/** Tauri dropped-path variant of {@link readResumeSourceFromFile}. */
export async function readResumeSourceFromPath(
  path: string,
): Promise<ResumeSource> {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (isZipFileName(name)) {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    return readResumeSourceFromZipBytes(await readFile(path), name);
  }
  if (isTexFileName(name)) {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const text = await readTextFile(path);
    if (!text.trim()) throw new Error(`"${name}" is empty.`);
    return { source: text, label: name };
  }
  throw new Error("Drop a .zip archive or a .tex file.");
}
