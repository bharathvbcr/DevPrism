import { unzip } from "fflate";
import {
  isTexFileName,
  safeZipRelativePath,
  singleRootPrefix,
} from "@/lib/browser-project/constants";

export { isTexFileName };

/** Hard cap on a dropped resume file (bytes). Fail closed on floods. */
export const RESUME_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
/** Hard cap on retained resume text (chars). Aligns with ATS input clamp. */
export const RESUME_SOURCE_MAX_CHARS = 400_000;
/** Zip archives with more entries than this are rejected. */
export const RESUME_ZIP_MAX_ENTRIES = 500;

const UNSUPPORTED_HINT = "Drop a resume as .zip, .tex, .pdf, .md, or .txt.";

/** A resume source ready for the import wizard textarea. */
export interface ResumeSource {
  source: string;
  /** Human label of where the source came from (file name). */
  label: string;
}

export type PdfTextExtractor = (buffer: ArrayBuffer) => Promise<string>;

export interface ResumeSourceOptions {
  /** Injected in tests; production uses MuPDF via career ingest. */
  extractPdfText?: PdfTextExtractor;
  maxBytes?: number;
}

export function isZipFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".zip");
}

export function isPdfFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

export function isPlainResumeFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".txt")
  );
}

export function isDocxFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".docx");
}

/** True when this filename is a supported career-import resume source. */
export function isResumeImportFileName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return (
    isZipFileName(base) ||
    isTexFileName(base) ||
    isPdfFileName(base) ||
    isPlainResumeFileName(base)
  );
}

const PRIMARY_BASENAMES = [
  "main.tex",
  "resume.tex",
  "cv.tex",
  "curriculum_vitae.tex",
  "curriculum-vitae.tex",
  "resume.md",
  "cv.md",
  "resume.txt",
  "cv.txt",
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

function isZipResumeEntry(name: string): boolean {
  const base = name.split("/").pop() ?? "";
  return isTexFileName(base) || isPlainResumeFileName(base);
}

function preferTexThenPlain(a: string, b: string): number {
  const aTex = isTexFileName(a.split("/").pop() ?? "");
  const bTex = isTexFileName(b.split("/").pop() ?? "");
  if (aTex !== bTex) return aTex ? -1 : 1;
  return compareCandidates(a, b);
}

function clampSourceText(text: string): string {
  if (text.length <= RESUME_SOURCE_MAX_CHARS) return text;
  return text.slice(0, RESUME_SOURCE_MAX_CHARS);
}

function assertByteBudget(size: number, label: string, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(
      `"${label}" exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB resume import limit.`,
    );
  }
}

/**
 * Sanitized zip entries relative to a single wrapper directory
 * (Overleaf-style), with __MACOSX noise removed.
 */
export function sanitizeZipTexEntries(
  entries: Record<string, Uint8Array>,
): Map<string, Uint8Array> {
  return sanitizeZipResumeEntries(entries, (base) => isTexFileName(base));
}

function sanitizeZipResumeEntries(
  entries: Record<string, Uint8Array>,
  accept: (base: string) => boolean,
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
    const base = relative.split("/").pop() ?? "";
    if (!relative || !accept(base)) continue;
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
  return pickResumeSourceEntry(entries, (base) => isTexFileName(base));
}

function pickResumeSourceEntry(
  entries: Record<string, Uint8Array>,
  accept: (base: string) => boolean,
  compare: (a: string, b: string) => number = compareCandidates,
): { name: string; text: string } | null {
  const found = sanitizeZipResumeEntries(entries, accept);
  if (found.size === 0) return null;

  const names = [...found.keys()].sort(compare);
  const chosen = names[0];
  const decoder = new TextDecoder("utf-8");
  return { name: chosen, text: decoder.decode(found.get(chosen)) };
}

function texEntryTextMap(
  entries: Record<string, Uint8Array>,
): Map<string, string> {
  const decoder = new TextDecoder("utf-8");
  const map = new Map<string, string>();
  for (const [name, data] of sanitizeZipTexEntries(entries)) {
    map.set(name, decoder.decode(data));
  }
  return map;
}

function resolveZipInputName(
  raw: string,
  entries: Map<string, string>,
): string | null {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || trimmed.includes("..") || /[:\\]/.test(trimmed)) return null;
  const normalized = trimmed.replace(/^\.\//, "");
  const names = [...entries.keys()];
  const baseOf = (n: string) => (n.split("/").pop() ?? "").toLowerCase();
  const candidates = [normalized];
  if (!/\.(tex|ltx)$/i.test(normalized)) {
    candidates.push(`${normalized}.tex`, `${normalized}.ltx`);
  }
  for (const cand of candidates) {
    const lower = cand.toLowerCase();
    const hit =
      names.find((n) => n === cand) ??
      names.find((n) => n.toLowerCase() === lower) ??
      names.find((n) => baseOf(n) === lower) ??
      names.find(
        (n) => baseOf(n) === `${lower}.tex` || baseOf(n) === `${lower}.ltx`,
      );
    if (hit) return hit;
  }
  const base = baseOf(normalized);
  return (
    names.find((n) => baseOf(n) === base) ??
    names.find(
      (n) => baseOf(n) === `${base}.tex` || baseOf(n) === `${base}.ltx`,
    ) ??
    null
  );
}

function inlineTexInputs(
  text: string,
  entries: Map<string, string>,
  depth = 0,
): string {
  if (depth > 8) return text;
  return text.replace(
    /\\(?:input|include)\*?\{([^}]+)\}/g,
    (full, rawName: string) => {
      const key = resolveZipInputName(rawName, entries);
      if (!key) return full;
      const inner = entries.get(key);
      if (inner === undefined) return "";
      return inlineTexInputs(inner, entries, depth + 1);
    },
  );
}

/**
 * Extract resume source from zip bytes. Prefers LaTeX, then markdown/text.
 * Throws when the bytes are not a zip archive or contain no resume source.
 */
export async function readResumeSourceFromZipBytes(
  bytes: Uint8Array,
  label: string,
): Promise<ResumeSource> {
  assertByteBudget(bytes.byteLength, label, RESUME_SOURCE_MAX_BYTES);
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

  if (Object.keys(entries).length > RESUME_ZIP_MAX_ENTRIES) {
    throw new Error(`"${label}" has too many entries to import safely.`);
  }

  const picked = pickResumeSourceEntry(
    entries,
    (base) => isZipResumeEntry(base),
    preferTexThenPlain,
  );
  if (!picked) {
    throw new Error(`"${label}" does not contain a resume source.`);
  }
  const texPool = texEntryTextMap(entries);
  const inlined = isTexFileName(picked.name)
    ? inlineTexInputs(picked.text, texPool)
    : picked.text;
  const source = clampSourceText(inlined);
  if (!source.trim()) throw new Error(`"${picked.name}" is empty.`);
  return { source, label: picked.name };
}

async function defaultExtractPdfText(buffer: ArrayBuffer): Promise<string> {
  const { extractPdfPages } = await import("./ingest/pdf");
  const pages = await extractPdfPages(buffer);
  return pages.map((p) => p.text).join("\n\n");
}

async function readPlainFileText(file: File, name: string): Promise<string> {
  const text = await file.text();
  if (!text.trim()) throw new Error(`"${name}" is empty.`);
  return clampSourceText(text);
}

/** Browser drop/pick path: zip, tex, pdf, markdown, or plain text. */
export async function readResumeSourceFromFile(
  file: File,
  options?: ResumeSourceOptions,
): Promise<ResumeSource> {
  const name = file.name;
  const maxBytes = options?.maxBytes ?? RESUME_SOURCE_MAX_BYTES;
  assertByteBudget(file.size, name, maxBytes);

  if (isDocxFileName(name)) {
    throw new Error(
      "Word .docx is not supported. Export the resume to PDF or plain text.",
    );
  }
  if (isZipFileName(name)) {
    return readResumeSourceFromZipBytes(
      new Uint8Array(await file.arrayBuffer()),
      name,
    );
  }
  if (isPdfFileName(name) || file.type === "application/pdf") {
    const extract = options?.extractPdfText ?? defaultExtractPdfText;
    const text = (await extract(await file.arrayBuffer())).trim();
    if (!text) throw new Error(`"${name}" has no extractable text.`);
    return { source: clampSourceText(text), label: name };
  }
  if (
    isTexFileName(name) ||
    isPlainResumeFileName(name) ||
    file.type === "text/plain" ||
    file.type === "text/markdown"
  ) {
    return { source: await readPlainFileText(file, name), label: name };
  }
  throw new Error(UNSUPPORTED_HINT);
}

/** Tauri dropped-path variant of {@link readResumeSourceFromFile}. */
export async function readResumeSourceFromPath(
  path: string,
  options?: ResumeSourceOptions,
): Promise<ResumeSource> {
  const name = path.split(/[\\/]/).pop() ?? path;
  const maxBytes = options?.maxBytes ?? RESUME_SOURCE_MAX_BYTES;
  if (isDocxFileName(name)) {
    throw new Error(
      "Word .docx is not supported. Export the resume to PDF or plain text.",
    );
  }
  if (isZipFileName(name)) {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(path).catch(() => null);
    if (info && typeof info.size === "number") {
      assertByteBudget(info.size, name, maxBytes);
    }
    return readResumeSourceFromZipBytes(await readFile(path), name);
  }
  if (isPdfFileName(name)) {
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(path).catch(() => null);
    if (info && typeof info.size === "number") {
      assertByteBudget(info.size, name, maxBytes);
    }
    const extract = options?.extractPdfText ?? defaultExtractPdfText;
    const bytes = await readFile(path);
    assertByteBudget(bytes.byteLength, name, maxBytes);
    const text = (await extract(bytes.buffer as ArrayBuffer)).trim();
    if (!text) throw new Error(`"${name}" has no extractable text.`);
    return { source: clampSourceText(text), label: name };
  }
  if (isTexFileName(name) || isPlainResumeFileName(name)) {
    const { readTextFile, stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(path).catch(() => null);
    if (info && typeof info.size === "number") {
      assertByteBudget(info.size, name, maxBytes);
    }
    const text = await readTextFile(path);
    if (!text.trim()) throw new Error(`"${name}" is empty.`);
    return { source: clampSourceText(text), label: name };
  }
  throw new Error(UNSUPPORTED_HINT);
}
