import { toast } from "sonner";
import { useDocumentStore, resolveTexRoot } from "@/stores/document-store";
import { synctexForward } from "@/lib/latex-compiler";
import {
  getCompileRootPreference,
  setCompileRootPreference,
} from "@/lib/compile-root-preference";

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
    toast.error("Open a .tex file to sync with the PDF.");
    return false;
  }

  const editorRootId = resolveTexRoot(activeFileId, files);
  const preferredRoot = getCompileRootPreference(projectRoot);
  if (preferredRoot && preferredRoot !== editorRootId) {
    setCompileRootPreference(projectRoot, editorRootId);
    toast.message("Switched preview to the active document for SyncTeX.");
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
    toast.error(
      "Could not locate this line in the PDF. Compile the document first, then try again.",
      { duration: 6000 },
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
