import { createPdfTextSidecar, isPdfPath } from "@/lib/pdf-text-extractor";
import { copyFileToProject, join } from "@/lib/tauri/fs";

export interface ImportedReferenceFile {
  relativePath: string;
  sidecarRelativePath?: string;
  sidecarError?: string;
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export async function importReferenceFilesWithSidecars(
  projectRoot: string,
  sourcePaths: string[],
  targetFolder = "attachments",
): Promise<ImportedReferenceFile[]> {
  const imported: ImportedReferenceFile[] = [];

  for (const sourcePath of sourcePaths) {
    const targetName = `${targetFolder}/${baseName(sourcePath)}`;
    const relativePath = await copyFileToProject(
      projectRoot,
      sourcePath,
      targetName,
    );
    const reference: ImportedReferenceFile = { relativePath };

    if (isPdfPath(relativePath)) {
      try {
        const absolutePath = await join(projectRoot, relativePath);
        const sidecar = await createPdfTextSidecar(
          projectRoot,
          relativePath,
          absolutePath,
        );
        reference.sidecarRelativePath = sidecar.sidecarRelativePath;
      } catch (err) {
        reference.sidecarError =
          err instanceof Error ? err.message : String(err);
      }
    }

    imported.push(reference);
  }

  return imported;
}

export function buildReferenceFilesSection(
  references: ImportedReferenceFile[],
): string {
  if (references.length === 0) return "";

  const lines = references.map((reference) => {
    if (reference.sidecarRelativePath) {
      return `- \`${reference.relativePath}\` (extracted text: \`${reference.sidecarRelativePath}\`)`;
    }
    if (isPdfPath(reference.relativePath)) {
      return `- \`${reference.relativePath}\` (PDF; extracted text sidecar was not generated)`;
    }
    return `- \`${reference.relativePath}\``;
  });

  return [
    "",
    "### Reference Files",
    lines.join("\n"),
    "",
    "Please review them and incorporate relevant information. For PDFs, read the extracted text sidecar when one is listed instead of relying on the raw PDF file.",
    "",
  ].join("\n");
}
