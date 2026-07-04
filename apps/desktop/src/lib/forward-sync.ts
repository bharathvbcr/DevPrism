import { useDocumentStore, resolveTexRoot } from "@/stores/document-store";
import { synctexForward } from "@/lib/latex-compiler";
import {
  getCompileRootPreference,
  setCompileRootPreference,
} from "@/lib/compile-root-preference";
import {
  showWorkspaceError,
  showWorkspaceInfo,
} from "@/stores/workspace-banner-store";

/** Jump from the editor cursor to a highlighted region in the PDF preview. */
export async function triggerForwardSync(options?: {
  relativePath?: string;
  line?: number;
  column?: number;
}): Promise<boolean> {
  const state = useDocumentStore.getState();
  const { projectRoot, files, activeFileId } = state;
  if (!projectRoot) return false;

  const activeFile = files.find((f) => f.id === activeFileId);
  if (!activeFile || activeFile.type !== "tex") {
    showWorkspaceError(
      "SyncTeX unavailable",
      "Open a .tex file to sync with the PDF.",
      { dedupeKey: "forward-sync-no-tex" },
    );
    return false;
  }

  const editorRootId = resolveTexRoot(activeFileId, files);
  const preferredRoot = getCompileRootPreference(projectRoot);
  if (preferredRoot && preferredRoot !== editorRootId) {
    setCompileRootPreference(projectRoot, editorRootId);
    showWorkspaceInfo(
      "Preview switched",
      "SyncTeX now follows the active document.",
      { dedupeKey: "forward-sync-root-switch" },
    );
  }

  const relativePath = options?.relativePath ?? activeFile.relativePath;
  const line =
    options?.line ??
    (() => {
      const content = activeFile.content ?? "";
      const pos = Math.min(state.cursorPosition, content.length);
      const upto = content.slice(0, pos);
      return (upto.match(/\n/g) || []).length + 1;
    })();
  const column = options?.column ?? 0;

  const result = await synctexForward(projectRoot, relativePath, line, column);
  if (!result) {
    showWorkspaceError(
      "SyncTeX failed",
      "Could not locate this line in the PDF. Compile the document first, then try again.",
      { dedupeKey: "forward-sync-miss" },
    );
    return false;
  }

  state.setForwardSyncPulse({
    rootFileId: editorRootId,
    page: result.page,
    x: result.x,
    y: result.y,
    width: result.width,
    height: result.height,
    nonce: Date.now(),
  });
  return true;
}
