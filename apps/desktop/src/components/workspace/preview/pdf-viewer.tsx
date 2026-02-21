import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { LoaderIcon } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { ask } from "@tauri-apps/plugin-dialog";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PdfTextSelection {
  text: string;
  pageNumber: number;
  position: { top: number; left: number }; // screen coords (bottom of selection)
  pdfX: number; // PDF-space x coordinate (for synctex)
  pdfY: number; // PDF-space y coordinate (for synctex)
}

interface PdfViewerProps {
  data: Uint8Array;
  scale: number;
  onError?: (error: string) => void;
  onLoadSuccess?: (numPages: number) => void;
  onScaleChange?: (scale: number) => void;
  onTextClick?: (text: string) => void;
  onSynctexClick?: (page: number, x: number, y: number) => void;
  onTextSelect?: (selection: PdfTextSelection | null) => void;
}

export function PdfViewer({
  data,
  scale,
  onError,
  onLoadSuccess,
  onScaleChange,
  onTextClick,
  onSynctexClick,
  onTextSelect,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasSetInitialScale = useRef(false);
  const [numPages, setNumPages] = useState(0);

  // Keep refs for values used in native event listeners
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const synctexClickRef = useRef(onSynctexClick);
  synctexClickRef.current = onSynctexClick;
  const textSelectRef = useRef(onTextSelect);
  textSelectRef.current = onTextSelect;

  // Scroll preservation across recompile
  const isFirstLoad = useRef(true);
  const savedPageRef = useRef<number>(0); // 0 = no saved page

  /** Compute which page is currently at the top of the viewport */
  function getVisiblePage(): number {
    const container = containerRef.current;
    if (!container) return 1;
    const pages = container.querySelectorAll(".react-pdf__Page");
    if (pages.length === 0) return 1;
    const containerRect = container.getBoundingClientRect();
    for (const page of pages) {
      const el = page as HTMLElement;
      const rect = el.getBoundingClientRect();
      // First page whose bottom is past the container top (+50px threshold)
      if (rect.bottom > containerRect.top + 50) {
        return parseInt(el.getAttribute("data-page-number") || "1", 10);
      }
    }
    return 1;
  }

  const file = useMemo(() => {
    const pdfData =
      data instanceof Uint8Array ? data : new Uint8Array(Object.values(data));
    // Only reset initial scale on first load, not on recompile
    if (isFirstLoad.current) {
      hasSetInitialScale.current = false;
    }
    // Save visible page and lock container height before Document reloads
    if (containerRef.current && !isFirstLoad.current) {
      const page = getVisiblePage();
      savedPageRef.current = page;
      // Lock the inner content div height to prevent scroll collapse
      // when Document unmounts Page children during loading
      if (contentRef.current) {
        contentRef.current.style.minHeight = `${contentRef.current.scrollHeight}px`;
      }
      console.log("[pdf-viewer] data changed → saved page:", page, "locked minHeight:", contentRef.current?.scrollHeight);
    }
    return { data: pdfData.slice() };
  }, [data]);

  const handleLoadSuccess = useCallback(
    ({ numPages: newNumPages }: { numPages: number }) => {
      setNumPages(newNumPages);
      isFirstLoad.current = false;
      onLoadSuccess?.(newNumPages);

      const targetPage = savedPageRef.current;
      console.log("[pdf-viewer] Document loaded, numPages:", newNumPages, "targetPage:", targetPage);

      if (targetPage > 0) {
        savedPageRef.current = 0;
        // Poll until the target page element renders with height
        const scrollToPage = (attempts: number) => {
          const container = containerRef.current;
          if (!container || attempts <= 0) {
            console.log("[pdf-viewer] scroll restore gave up after max attempts");
            // Clear min-height even if we fail
            if (contentRef.current) contentRef.current.style.minHeight = "";
            return;
          }
          const pageEl = container.querySelector(
            `[data-page-number="${targetPage}"]`,
          ) as HTMLElement | null;
          console.log("[pdf-viewer] scrollToPage attempt", 30 - attempts + 1, "pageEl:", !!pageEl, "height:", pageEl?.clientHeight);
          if (pageEl && pageEl.clientHeight > 0) {
            const containerRect = container.getBoundingClientRect();
            const pageRect = pageEl.getBoundingClientRect();
            container.scrollTop += pageRect.top - containerRect.top - 16; // 16px for padding
            console.log("[pdf-viewer] scrolled to page", targetPage, "scrollTop:", container.scrollTop);
            // Clear min-height
            if (contentRef.current) contentRef.current.style.minHeight = "";
          } else {
            requestAnimationFrame(() => scrollToPage(attempts - 1));
          }
        };
        requestAnimationFrame(() => scrollToPage(30)); // ~30 frames = ~500ms
      }
    },
    [onLoadSuccess],
  );

  const handlePageLoadSuccess = useCallback(
    ({ width: _width }: { width: number }) => {
      // Scale is now managed externally — default 100% (1.0)
      hasSetInitialScale.current = true;
    },
    [],
  );

  const handleLoadError = useCallback(
    (error: Error) => {
      onError?.(error.message);
    },
    [onError],
  );

  const handleTextLayerClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onTextClick) return;

      const target = e.target as HTMLElement;
      if (
        target.tagName === "SPAN" &&
        target.closest(".react-pdf__Page__textContent")
      ) {
        const text = target.textContent?.trim();
        if (text && text.length > 2) {
          onTextClick(text);
        }
      }
    },
    [onTextClick],
  );

  // Native dblclick listener — more reliable than React's onDoubleClick
  // because it captures events from react-pdf's text layer properly
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleDblClick = (e: MouseEvent) => {
      const cb = synctexClickRef.current;
      if (!cb) return;

      const target = e.target as HTMLElement;
      const pageEl = target.closest(".react-pdf__Page") as HTMLElement | null;
      if (!pageEl) {
        console.log("[synctex] dblclick: no .react-pdf__Page found");
        return;
      }

      const pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
      if (pageNum === 0) {
        console.log("[synctex] dblclick: no data-page-number attribute");
        return;
      }

      // Get click position relative to the page element
      const rect = pageEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      // Convert screen pixels → PDF points (72 DPI)
      // Both canvas and synctex use top-left origin, y-down
      const currentScale = scaleRef.current;
      const pdfX = offsetX / currentScale;
      const pdfY = offsetY / currentScale;

      console.log("[synctex] dblclick:", { pageNum, pdfX: pdfX.toFixed(1), pdfY: pdfY.toFixed(1), scale: currentScale });
      cb(pageNum, pdfX, pdfY);
    };

    container.addEventListener("dblclick", handleDblClick);
    return () => container.removeEventListener("dblclick", handleDblClick);
  }, []); // stable — uses refs for changing values

  // Text selection detection via mouseup (with delay to avoid interrupting long drags)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let selectionTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelPendingSelection = () => {
      if (selectionTimer !== null) {
        clearTimeout(selectionTimer);
        selectionTimer = null;
      }
    };

    const handleMouseDown = () => {
      // Cancel any pending selection toolbar when user starts a new drag
      cancelPendingSelection();
    };

    const handleMouseUp = () => {
      const cb = textSelectRef.current;
      if (!cb) return;

      // Cancel any previously pending selection
      cancelPendingSelection();

      // Delay showing the toolbar so that extending/adjusting selections
      // (quick mousedown after mouseup) doesn't flash the toolbar
      selectionTimer = setTimeout(() => {
        selectionTimer = null;

        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 2) {
          cb(null);
          return;
        }

        // Check that the selection is within the PDF text layer
        const anchorEl = sel?.anchorNode?.parentElement;
        if (!anchorEl?.closest(".react-pdf__Page__textContent")) {
          cb(null);
          return;
        }

        // Find which page the selection is in
        const pageEl = anchorEl.closest(".react-pdf__Page") as HTMLElement | null;
        const pageNum = pageEl
          ? parseInt(pageEl.getAttribute("data-page-number") || "1", 10)
          : 1;

        // Get position at the end of the selection (bottom)
        const range = sel!.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        // Compute PDF-space coordinates from selection start for synctex
        let pdfX = 0;
        let pdfY = 0;
        if (pageEl) {
          const pageRect = pageEl.getBoundingClientRect();
          const currentScale = scaleRef.current;
          pdfX = (rect.left - pageRect.left) / currentScale;
          pdfY = (rect.top - pageRect.top) / currentScale;
        }

        cb({
          text,
          pageNumber: pageNum,
          position: { top: rect.bottom, left: rect.left },
          pdfX,
          pdfY,
        });
      }, 300);
    };

    container.addEventListener("mousedown", handleMouseDown);
    container.addEventListener("mouseup", handleMouseUp);
    return () => {
      cancelPendingSelection();
      container.removeEventListener("mousedown", handleMouseDown);
      container.removeEventListener("mouseup", handleMouseUp);
    };
  }, []); // stable — uses refs for changing values

  // Dismiss selection toolbar on scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const cb = textSelectRef.current;
      if (cb) cb(null);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        onScaleChange(Math.max(0.25, Math.min(4, scale + delta)));
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [scale, onScaleChange]);

  // Intercept annotation layer link clicks — prevent in-app navigation
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      // Only intercept links within the annotation layer
      if (!anchor.closest(".react-pdf__Page__annotations")) return;

      e.preventDefault();
      e.stopPropagation();

      const href = anchor.href;
      if (!href) return;

      // Internal PDF links (e.g. #page=3) — scroll to page
      if (href.includes("#page=")) {
        const match = href.match(/#page=(\d+)/);
        if (match) {
          const pageNum = parseInt(match[1], 10);
          const pageEl = container.querySelector(
            `[data-page-number="${pageNum}"]`,
          ) as HTMLElement | null;
          if (pageEl) {
            pageEl.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
        return;
      }

      // External links — confirm then open in system default browser
      if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
        ask(`Open in browser?\n${href}`, {
          title: "External Link",
          kind: "info",
          okLabel: "Open",
          cancelLabel: "Cancel",
        }).then((confirmed) => {
          if (confirmed) shellOpen(href);
        });
      }
    };

    container.addEventListener("click", handleClick, true); // capture phase
    return () => container.removeEventListener("click", handleClick, true);
  }, []);

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
      <div
        ref={contentRef}
        className="flex flex-col items-center gap-4 p-4"
        onClick={handleTextLayerClick}
      >
        <Document
          file={file}
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
          loading={
            numPages > 0 ? (
              // During recompile, show nothing so old pages remain visible
              <></>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <LoaderIcon className="size-4 animate-spin" />
                Loading PDF...
              </div>
            )
          }
        >
          {Array.from({ length: numPages }, (_, i) => (
            <Page
              key={i + 1}
              pageNumber={i + 1}
              scale={scale}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className="mb-4 shadow-lg"
              onLoadSuccess={i === 0 ? handlePageLoadSuccess : undefined}
            />
          ))}
        </Document>
      </div>
    </div>
  );
}
