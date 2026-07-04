import { useEffect, useRef, useState, useCallback, memo } from "react";
import { XIcon, MessageSquareIcon } from "lucide-react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { createLogger } from "@/lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import type { StructuredTextData, LinkData, Rect } from "@/lib/mupdf/types";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Note editor popover for a single highlight. Commits on close/blur so we
 *  don't churn the store (and disk) on every keystroke. */
function HighlightNoteButton({
  note,
  onSave,
}: {
  note: string;
  onSave: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note);

  const commit = useCallback(() => {
    if (draft.trim() !== (note ?? "").trim()) onSave(draft);
  }, [draft, note, onSave]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) commit();
        else setDraft(note);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "pointer-events-auto flex size-6 items-center justify-center rounded-full border border-border bg-background shadow-sm transition-all hover:scale-110 hover:bg-accent",
            note ? "text-primary" : "text-muted-foreground opacity-60",
          )}
          title={note ? "Edit note" : "Add a note"}
          aria-label={note ? "Edit note" : "Add a note"}
          onClick={(e) => e.stopPropagation()}
        >
          <MessageSquareIcon className="size-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
              setOpen(false);
            }
          }}
          placeholder="Add a note for this highlight…"
          className="min-h-20 text-sm"
        />
        <p className="mt-1 px-0.5 text-[11px] text-muted-foreground">
          Saved into the exported PDF. ⌘/Ctrl+Enter to save.
        </p>
      </PopoverContent>
    </Popover>
  );
}

const log = createLogger("mupdf-page");
const RENDER_SCALE_DEBOUNCE_MS = 260;

/** Supersample the raster relative to the display so text stays crisp. On
 *  standard-DPI monitors (devicePixelRatio = 1) a fit-zoom page would otherwise
 *  be rasterized at only ~72 DPI and look soft; rendering at >=2x device pixels
 *  matches how a retina display already supersamples. Capped so deep zoom on a
 *  high-DPI display can't blow up the pixmap. */
const MIN_RENDER_DPR = 2;
const MAX_RENDER_DPR = 3;

/** Invert the rendered page for dark mode: white paper -> dark, black ink ->
 *  light, while hue-rotate keeps colored content roughly recognizable. The
 *  trailing brightness(<1) dims the inverted page so it doesn't glare against
 *  the dark UI. Applied as a CSS filter so the underlying canvas pixels (used
 *  by capture and text selection) stay untouched. */
const DARK_MODE_FILTER = "invert(0.905) hue-rotate(180deg) brightness(0.85)";

/** A persistent user highlight on this page. `rects` are the per-line boxes in
 *  PDF point coords; `css` is the solid fill color. */
export interface PageAnnotation {
  id: string;
  rects: Rect[];
  css: string;
  /** Optional reviewer note attached to this highlight. */
  note?: string;
}

interface MupdfPageProps {
  docId: number;
  pageIndex: number;
  scale: number;
  pageWidth: number;
  pageHeight: number;
  isVisible: boolean;
  darkMode?: boolean;
  /** Search-match rectangles (PDF point coords) to highlight on this page. */
  highlights?: { rect: Rect; active: boolean; pulse?: boolean }[];
  /** Persistent user highlights to render on this page. */
  annotations?: PageAnnotation[];
  /** Remove a user highlight by id (delete affordance). */
  onRemoveAnnotation?: (id: string) => void;
  /** Update the note text for a highlight. */
  onUpdateNote?: (id: string, note: string) => void;
}

/** Check if a canvas appears blank (GPU context was silently invalidated).
 *  Uses a single getImageData call covering a small center region. */
function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return true; // context fully lost
  // Sample a 2x2 region from the center in one GPU readback
  const cx = Math.max(0, Math.floor(canvas.width / 2) - 1);
  const cy = Math.max(0, Math.floor(canvas.height / 2) - 1);
  const data = ctx.getImageData(cx, cy, 2, 2).data;
  // If all sampled pixels have zero alpha, canvas is blank
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

export const MupdfPage = memo(function MupdfPage({
  docId,
  pageIndex,
  scale,
  pageWidth,
  pageHeight,
  isVisible,
  darkMode = false,
  highlights,
  annotations,
  onRemoveAnnotation,
  onUpdateNote,
}: MupdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [textData, setTextData] = useState<StructuredTextData | null>(null);
  const [links, setLinks] = useState<LinkData[]>([]);
  const [renderScale, setRenderScale] = useState(scale);
  const renderGenRef = useRef(0);

  const cssW = pageWidth * scale;
  const cssH = pageHeight * scale;

  useEffect(() => {
    setRenderScale(scale);
  }, [docId, pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isVisible || docId <= 0) return;
    const timeout = window.setTimeout(
      () => setRenderScale(scale),
      RENDER_SCALE_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [docId, isVisible, scale]);

  /** Re-render the page onto the canvas via MuPDF worker. */
  const renderPage = useCallback(() => {
    if (!isVisible || docId <= 0) return;

    const gen = ++renderGenRef.current;
    const client = getMupdfClient();
    const dpr = Math.min(
      MAX_RENDER_DPR,
      Math.max(MIN_RENDER_DPR, window.devicePixelRatio || 1),
    );
    const dpi = renderScale * 72 * dpr;

    client
      .drawPage(docId, pageIndex, dpi)
      .then(async (imageData) => {
        if (gen !== renderGenRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const bitmap = await createImageBitmap(imageData);
        if (gen !== renderGenRef.current) {
          bitmap.close();
          return;
        }
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch((err) => {
        if (gen !== renderGenRef.current) return;
        log.error(`Render error page ${pageIndex}`, { error: String(err) });
      });
  }, [docId, pageIndex, renderScale, isVisible]);

  // Render the canvas immediately on load, then at debounced high-quality zoom.
  useEffect(() => {
    if (!isVisible || docId <= 0) return;
    renderPage();
  }, [docId, pageIndex, renderScale, isVisible, renderPage]);

  // Text and link layers do not need to be refetched for every zoom change.
  useEffect(() => {
    if (!isVisible || docId <= 0) return;
    let cancelled = false;

    const client = getMupdfClient();

    client
      .getPageText(docId, pageIndex)
      .then((data) => {
        if (cancelled) return;
        setTextData(data);
      })
      .catch(() => {});

    client
      .getPageLinks(docId, pageIndex)
      .then((data) => {
        if (cancelled) return;
        setLinks(data);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [docId, pageIndex, isVisible]);

  // Re-render canvas when returning from background if content was lost
  useEffect(() => {
    const handleVisibilityRestored = () => {
      const canvas = canvasRef.current;
      if (!canvas || !isVisible || docId <= 0) return;
      if (isCanvasBlank(canvas)) {
        log.warn(
          `Canvas blank after visibility restore, re-rendering page ${pageIndex}`,
        );
        renderPage();
      }
    };

    window.addEventListener(APP_VISIBILITY_RESTORED, handleVisibilityRestored);
    return () =>
      window.removeEventListener(
        APP_VISIBILITY_RESTORED,
        handleVisibilityRestored,
      );
  }, [docId, pageIndex, scale, isVisible, renderPage]);

  return (
    <div
      className="mupdf-page relative mb-4 shadow-lg"
      data-page-number={pageIndex + 1}
      style={{ width: cssW, height: cssH }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: cssW,
          height: cssH,
          display: "block",
          filter: darkMode ? DARK_MODE_FILTER : undefined,
        }}
      />

      {/* Text layer for selection */}
      {textData && (
        <svg
          className="mupdf-text-layer"
          viewBox={`0 0 ${pageWidth} ${pageHeight}`}
          preserveAspectRatio="none"
          style={{ width: cssW, height: cssH }}
        >
          {textData.blocks.map(
            (block, bi) =>
              block.type === "text" &&
              block.lines.map((line, li) => (
                <text
                  key={`${bi}-${li}`}
                  x={line.bbox.x}
                  y={line.y}
                  fontSize={line.font.size}
                  fontFamily={line.font.family || line.font.name || "serif"}
                  textLength={line.bbox.w > 0 ? line.bbox.w : undefined}
                  lengthAdjust="spacingAndGlyphs"
                >
                  {line.text}
                </text>
              )),
          )}
        </svg>
      )}

      {/* Persistent user highlight layer (above the text layer so the delete
          button is clickable; fills are non-interactive so text stays
          selectable through them). */}
      {annotations && annotations.length > 0 && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: 3 }}
        >
          {annotations.map((annot) => {
            // Union bbox of the highlight, for placing the delete button.
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            for (const r of annot.rects) {
              minX = Math.min(minX, r.x);
              minY = Math.min(minY, r.y);
              maxX = Math.max(maxX, r.x + r.w);
            }
            return (
              <div key={annot.id}>
                {annot.rects.map((r, i) => (
                  <div
                    key={i}
                    className="pointer-events-none absolute rounded-[1px]"
                    style={{
                      left: `${(r.x / pageWidth) * 100}%`,
                      top: `${(r.y / pageHeight) * 100}%`,
                      width: `${(r.w / pageWidth) * 100}%`,
                      height: `${(r.h / pageHeight) * 100}%`,
                      backgroundColor: annot.css,
                      opacity: 0.4,
                      mixBlendMode: "multiply",
                    }}
                  />
                ))}
                {Number.isFinite(minX) &&
                  (onUpdateNote || onRemoveAnnotation) && (
                    <div
                      className="absolute flex translate-x-1/2 -translate-y-1/2 items-center gap-1.5"
                      style={{
                        left: `${(maxX / pageWidth) * 100}%`,
                        top: `${(minY / pageHeight) * 100}%`,
                      }}
                    >
                      {onUpdateNote && (
                        <HighlightNoteButton
                          note={annot.note ?? ""}
                          onSave={(note) => onUpdateNote(annot.id, note)}
                        />
                      )}
                      {onRemoveAnnotation && (
                        <button
                          type="button"
                          className="pointer-events-auto flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-60 shadow-sm transition-all hover:scale-110 hover:bg-destructive hover:text-white hover:opacity-100"
                          title="Remove highlight"
                          aria-label="Remove highlight"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveAnnotation(annot.id);
                          }}
                        >
                          <XIcon className="size-2.5" />
                        </button>
                      )}
                    </div>
                  )}
              </div>
            );
          })}
        </div>
      )}

      {/* Search highlight layer */}
      {highlights && highlights.length > 0 && (
        <div className="pointer-events-none absolute inset-0">
          {highlights.map((h, i) => (
            <div
              key={i}
              className={cn(
                "absolute rounded-[1px]",
                h.pulse && "animate-synctex-pulse",
              )}
              style={{
                left: `${(h.rect.x / pageWidth) * 100}%`,
                top: `${(h.rect.y / pageHeight) * 100}%`,
                width: `${(h.rect.w / pageWidth) * 100}%`,
                height: `${(h.rect.h / pageHeight) * 100}%`,
                backgroundColor: h.pulse
                  ? "var(--pdf-synctex-pulse)"
                  : h.active
                    ? "var(--pdf-search-active)"
                    : "var(--pdf-search-match)",
                outline: h.pulse
                  ? "2px solid var(--pdf-synctex-pulse)"
                  : h.active
                    ? "2.5px solid var(--pdf-search-active-outline)"
                    : undefined,
                boxShadow: h.active
                  ? "0 0 0 1px var(--pdf-search-active-outline)"
                  : undefined,
                mixBlendMode: "multiply",
              }}
            />
          ))}
        </div>
      )}

      {/* Link layer */}
      {links.length > 0 && (
        <div className="mupdf-link-layer">
          {links.map((link, i) => (
            <a
              key={i}
              href={link.href}
              data-external={link.isExternal ? "true" : undefined}
              style={{
                left: `${(link.x / pageWidth) * 100}%`,
                top: `${(link.y / pageHeight) * 100}%`,
                width: `${(link.w / pageWidth) * 100}%`,
                height: `${(link.h / pageHeight) * 100}%`,
              }}
            >
              <span className="sr-only">Link</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
});
