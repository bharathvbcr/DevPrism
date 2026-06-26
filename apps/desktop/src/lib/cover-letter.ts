import { toast } from "sonner";
import { createFileOnDisk } from "@/lib/tauri/fs";
import { getLatexSnippetInsert } from "@/lib/latex-snippets";
import { setCompileRootPreference } from "@/lib/compile-root-preference";
import { useDocumentStore } from "@/stores/document-store";

const COVER_LETTER_NAME = "COVER_LETTER.tex";

function findCoverLetterFile(
  files: { id: string; name: string; relativePath: string }[],
) {
  return files.find(
    (f) =>
      f.name.toLowerCase() === COVER_LETTER_NAME.toLowerCase() ||
      f.relativePath.toLowerCase().endsWith(COVER_LETTER_NAME.toLowerCase()),
  );
}

/** Create or open COVER_LETTER.tex and switch the compile root to it. */
export async function ensureCoverLetterFile(): Promise<boolean> {
  const state = useDocumentStore.getState();
  const { projectRoot, files } = state;
  if (!projectRoot) return false;

  const existing = findCoverLetterFile(files);
  if (existing) {
    state.setActiveFile(existing.id);
    setCompileRootPreference(projectRoot, existing.id);
    toast.message("Opened existing cover letter.");
    return true;
  }

  const content =
    getLatexSnippetInsert("cover-letter") ??
    "\\documentclass[11pt]{letter}\n\\begin{document}\n\\end{document}\n";

  try {
    await createFileOnDisk(projectRoot, COVER_LETTER_NAME, content);
    await state.refreshFiles();
    const created = findCoverLetterFile(useDocumentStore.getState().files);
    if (!created) {
      toast.error("Could not create COVER_LETTER.tex.");
      return false;
    }
    state.setActiveFile(created.id);
    setCompileRootPreference(projectRoot, created.id);
    toast.success("Created COVER_LETTER.tex");
    return true;
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : "Failed to create cover letter file.",
    );
    return false;
  }
}
