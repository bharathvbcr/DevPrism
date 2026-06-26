import { useState } from "react";
import { useTrackChangesPreviewStore } from "@/stores/track-changes-preview-store";
import { PdfViewer } from "@/components/workspace/preview/pdf-viewer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Dedicated modal for the compiled track-changes diff PDF. Self-contained: it
 * renders the diff bytes through its own PdfViewer with a synthetic rootFileId,
 * so it never touches the live preview pane, document-store PDF cache, SyncTeX
 * build info, or the export/summarize actions. Mounted once at the app root.
 */
export function TrackChangesPdfDialog() {
  const open = useTrackChangesPreviewStore((s) => s.open);
  const title = useTrackChangesPreviewStore((s) => s.title);
  const pdfBytes = useTrackChangesPreviewStore((s) => s.pdfBytes);
  const nonce = useTrackChangesPreviewStore((s) => s.nonce);
  const close = useTrackChangesPreviewStore((s) => s.close);
  const [scale, setScale] = useState(1);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Tracked changes — {title}</DialogTitle>
          <DialogDescription>
            Deletions are struck through in red; additions are colored. Scroll
            or pinch/⌘-scroll to zoom.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/30">
          {pdfBytes && (
            <PdfViewer
              data={pdfBytes}
              scale={scale}
              isActive={open}
              darkMode
              rootFileId={`__devprism-track-changes-preview__${nonce}`}
              onScaleChange={setScale}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
