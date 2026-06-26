import { create } from "zustand";

/**
 * Holds the compiled track-changes diff PDF for the dedicated preview dialog.
 * Kept separate from the main preview pane (document-store) so the diff PDF
 * never overwrites the live document's PDF, SyncTeX, or export/summarize state.
 */
interface TrackChangesPreviewState {
  open: boolean;
  title: string;
  pdfBytes: Uint8Array | null;
  /** Increments on every show() so the viewer gets a distinct rootFileId per
   * diff and doesn't restore a previous diff's cached scroll position. */
  nonce: number;
  show: (pdfBytes: Uint8Array, title: string) => void;
  close: () => void;
}

export const useTrackChangesPreviewStore = create<TrackChangesPreviewState>(
  (set) => ({
    open: false,
    title: "",
    pdfBytes: null,
    nonce: 0,
    show: (pdfBytes, title) =>
      set((s) => ({ open: true, pdfBytes, title, nonce: s.nonce + 1 })),
    // Keep the bytes briefly so the dialog can animate out, but drop the
    // reference on close to release the buffer.
    close: () => set({ open: false, pdfBytes: null }),
  }),
);
