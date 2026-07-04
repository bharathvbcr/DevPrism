import { unzip } from "fflate";
import {
  BROWSER_MAX_ENTRIES,
  BROWSER_MAX_TOTAL_BYTES,
  browserRootPath,
  isTexFileName,
  safeZipRelativePath,
  sanitizeProjectName,
  singleRootPrefix,
  type ImportedProject,
} from "./constants";
import {
  mkdirOpfs,
  opfsContainsTex,
  removeOpfsProject,
  uniqueOpfsProjectId,
  writeOpfsFile,
} from "./opfs-store";

function stripWrapperPrefix(relative: string, prefix: string | null): string {
  if (!prefix) return relative;
  const normalized = relative.replace(/^\/+/, "");
  if (normalized === prefix) return "";
  const withSlash = `${prefix}/`;
  return normalized.startsWith(withSlash)
    ? normalized.slice(withSlash.length)
    : relative;
}

async function extractZipEntriesToOpfs(
  projectId: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  const names = Object.keys(entries);
  if (names.length > BROWSER_MAX_ENTRIES) {
    throw new Error(
      `Archive has too many entries (${names.length}); refusing to extract.`,
    );
  }
  const strip = singleRootPrefix(names);
  let totalBytes = 0;

  for (const [rawName, data] of Object.entries(entries)) {
    if (rawName.includes("__MACOSX")) continue;
    const safe = safeZipRelativePath(rawName);
    if (!safe) continue;
    const relative = stripWrapperPrefix(safe, strip);
    if (!relative) continue;

    totalBytes += data.byteLength;
    if (totalBytes > BROWSER_MAX_TOTAL_BYTES) {
      throw new Error("Archive is too large to import.");
    }

    if (relative.endsWith("/")) {
      await mkdirOpfs(projectId, relative.replace(/\/+$/, ""));
      continue;
    }

    await writeOpfsFile(projectId, relative, data);
  }
}

export async function importZipFile(file: File): Promise<ImportedProject> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = await new Promise((resolve, reject) => {
      unzip(buffer, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  } catch {
    throw new Error("Not a valid zip archive.");
  }

  const stem = file.name.replace(/\.zip$/i, "") || "latex-project";
  const name = sanitizeProjectName(stem);
  const projectId = await uniqueOpfsProjectId(name);

  try {
    await extractZipEntriesToOpfs(projectId, entries);
    if (!(await opfsContainsTex(projectId))) {
      throw new Error("The archive does not contain any LaTeX (.tex) files.");
    }
  } catch (err) {
    await removeOpfsProject(projectId).catch(() => {});
    throw err;
  }

  return {
    path: browserRootPath("opfs", projectId),
    name: projectId,
  };
}

export async function importLooseFiles(
  files: Array<File | { file: File; relativePath: string }>,
): Promise<ImportedProject> {
  if (files.length === 0) {
    throw new Error("Nothing to import.");
  }

  const normalized = files.map((item) => {
    if (item instanceof File) {
      return {
        relativePath: (item.webkitRelativePath || item.name).replace(
          /^\/+/,
          "",
        ),
        data: null as Uint8Array | null,
        file: item,
      };
    }
    return {
      relativePath: item.relativePath.replace(/^\/+/, ""),
      data: null as Uint8Array | null,
      file: item.file,
    };
  });

  const tex = normalized.find((f) =>
    isTexFileName(f.relativePath.split("/").pop() ?? ""),
  );
  if (!tex) {
    throw new Error("Drop at least one LaTeX (.tex) file to create a project.");
  }

  const texName = tex.relativePath.split("/").pop() ?? tex.relativePath;
  const rawStem = texName.replace(/\.(tex|ltx)$/i, "") || "latex-project";
  const stem =
    rawStem.toLowerCase() === "main" || rawStem.toLowerCase() === "document"
      ? "latex-project"
      : rawStem;
  const name = sanitizeProjectName(stem);
  const projectId = await uniqueOpfsProjectId(name);

  let entriesLeft = BROWSER_MAX_ENTRIES;
  let bytesLeft = BROWSER_MAX_TOTAL_BYTES;

  try {
    for (const entry of normalized) {
      if (!entry.relativePath || entry.relativePath.includes("..")) continue;
      if (entriesLeft === 0) {
        throw new Error("Too many files to import.");
      }
      entriesLeft -= 1;
      const data = entry.data ?? new Uint8Array(await entry.file.arrayBuffer());
      if (data.byteLength > bytesLeft) {
        throw new Error("The dropped files are too large to import.");
      }
      bytesLeft -= data.byteLength;
      await writeOpfsFile(projectId, entry.relativePath, data);
    }

    if (!(await opfsContainsTex(projectId))) {
      throw new Error(
        "The dropped files do not contain any LaTeX (.tex) files.",
      );
    }
  } catch (err) {
    await removeOpfsProject(projectId).catch(() => {});
    throw err;
  }

  return {
    path: browserRootPath("opfs", projectId),
    name: projectId,
  };
}
