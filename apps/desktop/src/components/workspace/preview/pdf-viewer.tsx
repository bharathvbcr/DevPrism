import {
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import {
  LoaderIcon,
  SearchIcon,
  SparklesIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  XIcon,
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  getCachedDocument,
  getOrOpenDocument,
} from "@/lib/mupdf/pdf-doc-cache";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { expandSearchTerms, canUseAiAssist } from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { LOCAL_ZOOM_SHORTCUTS_ATTR } from "@/lib/app-zoom";
import { MupdfPage, type PageAnnotation } from "./mupdf-page";
import {
  useAnnotationStore,
  type PdfHighlight,
} from "@/stores/annotation-store";
import { createLogger } from "@/lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import type { PageSize, Rect } from "@/lib/mupdf/types";

const log = createLogger("pdf-viewer");

const MIN_PDF_SCALE = 0.25;
const MAX_PDF_SCALE = 4;
const MOUSE_WHEEL_ZOOM_SENSITIVITY = 0.00125;
const TRACKPAD_PINCH_ZOOM_SENSITIVITY = 0.012;
const MAX_MOUSE_WHEEL_FACTOR_PER_EVENT = 1.22;
const MAX_TRACKPAD_PINCH_FACTOR_PER_EVENT = 1.28;

type WebKitGestureEvent = Event & {
  scale?: number;
  clientX?: number;
  clientY?: number;
};

function clampPdfScale(value: number): number {
  return Math.max(MIN_PDF_SCALE, Math.min(MAX_PDF_SCALE, value));
}

function isModifiedZoomWheel(event: WheelEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey;
}

function isWheelInsidePdfViewer(
  event: WheelEvent,
  container: HTMLElement,
): boolean {
  if (event.target instanceof Node && container.contains(event.target)) {
    return true;
  }

  if (
    event
      .composedPath()
      .some((target) => target instanceof Node && container.contains(target))
  ) {
    return true;
  }

  const rect = container.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function isTrackpadPinchWheel(
  event: WheelEvent,
  isCtrlKeyDown: boolean,
  isMetaKeyDown: boolean,
): boolean {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !isCtrlKeyDown &&
    !isMetaKeyDown &&
    event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
    Math.abs(event.deltaX) < 1 &&
    event.deltaZ === 0
  );
}

function clampZoomFactor(factor: number, maxFactor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.max(1 / maxFactor, Math.min(maxFactor, factor));
}

function getWheelZoomFactor(
  event: WheelEvent,
  isTrackpadPinch: boolean,
): number {
  if (event.deltaY === 0) return 1;

  if (
    !isTrackpadPinch &&
    (event.deltaMode === WheelEvent.DOM_DELTA_LINE ||
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
  ) {
    return event.deltaY < 0 ? 1.16 : 1 / 1.16;
  }

  const sensitivity = isTrackpadPinch
    ? TRACKPAD_PINCH_ZOOM_SENSITIVITY
    : MOUSE_WHEEL_ZOOM_SENSITIVITY;
  const maxFactor = isTrackpadPinch
    ? MAX_TRACKPAD_PINCH_FACTOR_PER_EVENT
    : MAX_MOUSE_WHEEL_FACTOR_PER_EVENT;

  return clampZoomFactor(Math.exp(-event.deltaY * sensitivity), maxFactor);
}

interface PageZoomAnchor {
  pageNumber: number;
  pdfX: number;
  pdfY: number;
}

interface PendingZoomScroll {
  anchorClientX: number;
  anchorClientY: number;
  pageAnchor: PageZoomAnchor | null;
  fallbackAnchorX: number;
  fallbackAnchorY: number;
  fallbackRatio: number;
  nextScale: number;
  containerLeft: number;
  containerTop: number;
}

function findPageZoomAnchor(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  scale: number,
): PageZoomAnchor | null {
  if (scale <= 0) return null;

  const pages = Array.from(container.querySelectorAll(".mupdf-page"));
  let bestPage: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const page of pages) {
    const el = page as HTMLElement;
    const rect = el.getBoundingClientRect();
    const distance =
      clientY >= rect.top && clientY <= rect.bottom
        ? 0
        : Math.min(
            Math.abs(clientY - rect.top),
            Math.abs(clientY - rect.bottom),
          );

    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = el;
    }
  }

  if (!bestPage) return null;

  const pageNumber = parseInt(
    bestPage.getAttribute("data-page-number") || "0",
    10,
  );
  if (!pageNumber) return null;

  const rect = bestPage.getBoundingClientRect();
  return {
    pageNumber,
    pdfX: (clientX - rect.left) / scale,
    pdfY: (clientY - rect.top) / scale,
  };
}
/** Module-level scroll position cache: rootFileId → page number */
const scrollPositionCache = new Map<string, number>();

/** Clear all cached scroll positions (e.g., on project close). */
export function clearScrollPositionCache(): void {
  scrollPositionCache.clear();
}

export interface PdfTextSelection {
  text: string;
  pageNumber: number;
  position: { top: number; left: number };
  pdfX: number;
  pdfY: number;
  /** Per-line quads of the selection in PDF page-space points:
   *  [ulx, uly, urx, ury, llx, lly, lrx, lry]. Used for highlighting. */
  quads: number[][];
}

const EMPTY_HIGHLIGHTS: PdfHighlight[] = [];

export interface CaptureResult {
  dataUrl: string;
  pageNumber: number;
  pdfX: number;
  pdfY: number;
}

export interface ForwardSyncPulse {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PdfViewerProps {
  data: Uint8Array;
  scale: number;
  /** Root file ID for scroll position caching across file switches. */
  rootFileId?: string;
  /** Whether this viewer is currently the active/visible one (for keep-alive). */
  isActive?: boolean;
  /** Invert page rendering for a dark-friendly view. */
  darkMode?: boolean;
  onError?: (error: string) => void;
  onLoadSuccess?: (numPages: number) => void;
  onScaleChange?: (scale: number) => void;
  onTextClick?: (text: string) => void;
  onSynctexClick?: (page: number, x: number, y: number) => void;
  forwardPulse?: ForwardSyncPulse | null;
  onTextSelect?: (selection: PdfTextSelection | null) => void;
  onFirstPageSize?: (width: number, height: number) => void;
  onContainerResize?: (width: number, height: number) => void;
  onCurrentPageChange?: (page: number) => void;
  /** Fired when the user scrolls or zooms inside the viewer. */
  onViewerActivity?: () => void;
  scrollToPageRef?: React.RefObject<((page: number) => void) | null>;
  captureMode?: boolean;
  onCapture?: (result: CaptureResult) => void;
  onCancelCapture?: () => void;
}

export function PdfViewer({
  data,
  scale,
  rootFileId,
  isActive = true,
  darkMode = false,
  onError,
  onLoadSuccess,
  onScaleChange,
  onTextClick,
  onSynctexClick,
  forwardPulse = null,
  onTextSelect,
  onFirstPageSize,
  onContainerResize,
  onCurrentPageChange,
  onViewerActivity,
  scrollToPageRef,
  captureMode = false,
  onCapture,
  onCancelCapture,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const docIdRef = useRef(0);
  const loadGenRef = useRef(0);
  // Bumped each time a document's geometry is (re)applied — including a silent
  // recompile of the same root with an unchanged page count — so an open search
  // re-runs against the new doc instead of showing stale matches.
  const [loadGen, setLoadGen] = useState(0);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const renderedScaleRef = useRef(scale);
  const pendingZoomScrollRef = useRef<PendingZoomScroll | null>(null);
  const ctrlKeyDownRef = useRef(false);
  const metaKeyDownRef = useRef(false);
  const touchPinchRef = useRef<{
    distance: number;
    scale: number;
    x: number;
    y: number;
  } | null>(null);
  const gesturePinchRef = useRef<{ scale: number } | null>(null);
  const synctexClickRef = useRef(onSynctexClick);
  synctexClickRef.current = onSynctexClick;
  const textSelectRef = useRef(onTextSelect);
  textSelectRef.current = onTextSelect;

  // Scroll preservation across recompile
  const isFirstLoad = useRef(true);
  const savedPageRef = useRef<number>(0);

  // Increment on app-visibility-restored to force IntersectionObserver reconnection
  const [focusGen, setFocusGen] = useState(0);
  useEffect(() => {
    const handleRestore = () => setFocusGen((g) => g + 1);
    window.addEventListener(APP_VISIBILITY_RESTORED, handleRestore);
    return () =>
      window.removeEventListener(APP_VISIBILITY_RESTORED, handleRestore);
  }, []);

  useLayoutEffect(() => {
    renderedScaleRef.current = scale;

    const pending = pendingZoomScrollRef.current;
    if (!pending || Math.abs(pending.nextScale - scale) > 0.001) return;
    pendingZoomScrollRef.current = null;

    const container = containerRef.current;
    if (!container) return;

    if (pending.pageAnchor) {
      const pageEl = container.querySelector(
        `.mupdf-page[data-page-number="${pending.pageAnchor.pageNumber}"]`,
      ) as HTMLElement | null;
      if (pageEl) {
        const pageRect = pageEl.getBoundingClientRect();
        container.scrollLeft +=
          pageRect.left +
          pending.pageAnchor.pdfX * scale -
          pending.anchorClientX;
        container.scrollTop +=
          pageRect.top +
          pending.pageAnchor.pdfY * scale -
          pending.anchorClientY;
        return;
      }
    }

    container.scrollLeft =
      pending.fallbackAnchorX * pending.fallbackRatio -
      (pending.anchorClientX - pending.containerLeft);
    container.scrollTop =
      pending.fallbackAnchorY * pending.fallbackRatio -
      (pending.anchorClientY - pending.containerTop);
  }, [scale]);

  // Keep-alive scroll save/restore
  const savedScrollTop = useRef(0);
  const prevIsActive = useRef(isActive);
  useEffect(() => {
    if (prevIsActive.current && !isActive) {
      // Becoming hidden → save scrollTop
      if (containerRef.current) {
        savedScrollTop.current = containerRef.current.scrollTop;
      }
    } else if (!prevIsActive.current && isActive) {
      // Becoming visible → restore scrollTop
      const scrollVal = savedScrollTop.current;
      if (containerRef.current && scrollVal > 0) {
        // Use rAF to ensure layout is computed after visibility change
        requestAnimationFrame(() => {
          if (containerRef.current) {
            containerRef.current.scrollTop = scrollVal;
          }
        });
      }
    }
    prevIsActive.current = isActive;
  }, [isActive]);

  // Capture drag state
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [dragPageNum, setDragPageNum] = useState(0);

  const numPages = pageSizes.length;

  // ── Persistent user highlights (annotation store, scoped to this root) ──
  const rootHighlights = useAnnotationStore((s) =>
    rootFileId
      ? (s.highlightsByRoot[rootFileId] ?? EMPTY_HIGHLIGHTS)
      : EMPTY_HIGHLIGHTS,
  );
  const removeHighlight = useAnnotationStore((s) => s.removeHighlight);
  const setHighlightNote = useAnnotationStore((s) => s.setHighlightNote);
  const handleRemoveAnnotation = useCallback(
    (id: string) => {
      if (rootFileId) removeHighlight(rootFileId, id);
    },
    [rootFileId, removeHighlight],
  );
  const handleUpdateNote = useCallback(
    (id: string, note: string) => {
      if (rootFileId) setHighlightNote(rootFileId, id, note);
    },
    [rootFileId, setHighlightNote],
  );

  // Group highlights by page, converting each quad to a render rect.
  const annotationsByPage = useMemo(() => {
    if (rootHighlights.length === 0) return null;
    const map = new Map<number, PageAnnotation[]>();
    for (const h of rootHighlights) {
      const rects = h.quads.map((q) => ({
        x: q[0],
        y: q[1],
        w: q[2] - q[0],
        h: q[5] - q[1],
      }));
      const arr = map.get(h.pageIndex) ?? [];
      arr.push({ id: h.id, rects, css: h.css, note: h.note });
      map.set(h.pageIndex, arr);
    }
    return map;
  }, [rootHighlights]);

  // ── Full-document text search ──────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<
    { pageIndex: number; rect: Rect }[]
  >([]);
  const [activeMatch, setActiveMatch] = useState(-1);
  const [searching, setSearching] = useState(false);
  // When a literal search yields nothing, AI may surface matches for an
  // alternative wording; this holds that term so we can note it in the UI.
  const [semanticAltTerm, setSemanticAltTerm] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchGenRef = useRef(0);

  // Read once per render; non-component guards use getState() instead.
  const aiSemanticSearch = useSettingsStore((s) => s.aiSemanticSearch);

  /** Scroll a given match roughly to the vertical center of the viewport. */
  const scrollToMatch = useCallback((m: { pageIndex: number; rect: Rect }) => {
    const container = containerRef.current;
    if (!container) return;
    const pageEl = container.querySelector(
      `[data-page-number="${m.pageIndex + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return;
    const containerRect = container.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const matchTop = m.rect.y * scaleRef.current;
    const target =
      container.scrollTop +
      (pageRect.top - containerRect.top) +
      matchTop -
      container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, []);

  const goToMatch = useCallback(
    (idx: number) => {
      setSearchMatches((matches) => {
        if (matches.length === 0) return matches;
        const next = ((idx % matches.length) + matches.length) % matches.length;
        setActiveMatch(next);
        scrollToMatch(matches[next]);
        return matches;
      });
    },
    [scrollToMatch],
  );

  // Run the search (debounced) across every page whenever the query changes.
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchQuery.trim();
    setSemanticAltTerm(null);
    if (q.length < 1) {
      setSearchMatches([]);
      setActiveMatch(-1);
      setSearching(false);
      return;
    }
    const gen = ++searchGenRef.current;
    setSearching(true);

    // Literal substring search across every page for one term. Returns null if
    // a newer search has superseded this one (stale-run guard).
    const runLiteralSearch = async (
      term: string,
    ): Promise<{ pageIndex: number; rect: Rect }[] | null> => {
      const client = getMupdfClient();
      const docId = docIdRef.current;
      const results: { pageIndex: number; rect: Rect }[] = [];
      for (let i = 0; i < numPages; i++) {
        if (gen !== searchGenRef.current) return null;
        try {
          const rects = await client.searchPage(docId, i, term);
          for (const r of rects) results.push({ pageIndex: i, rect: r });
        } catch {
          // Skip pages that fail to search.
        }
      }
      return results;
    };

    const handle = setTimeout(async () => {
      const results = await runLiteralSearch(q);
      if (results === null || gen !== searchGenRef.current) return;

      if (results.length > 0) {
        setSearchMatches(results);
        setSearching(false);
        setActiveMatch(0);
        requestAnimationFrame(() => scrollToMatch(results[0]));
        return;
      }

      // ── Semantic fallback: literal search found nothing. Ask the AI for
      // alternative wordings and re-run the literal routine for each until one
      // yields matches. Passive/background AI — fails silently. ──
      if (aiSemanticSearch && canUseAiAssist()) {
        let alternatives: string[] = [];
        try {
          alternatives = await expandSearchTerms(q);
        } catch {
          alternatives = [];
        }
        if (gen !== searchGenRef.current) return;

        const qLower = q.toLowerCase();
        for (const alt of alternatives) {
          const term = alt.trim();
          if (!term || term.toLowerCase() === qLower) continue;
          const altResults = await runLiteralSearch(term);
          if (altResults === null || gen !== searchGenRef.current) return;
          if (altResults.length > 0) {
            setSemanticAltTerm(term);
            setSearchMatches(altResults);
            setSearching(false);
            setActiveMatch(0);
            requestAnimationFrame(() => scrollToMatch(altResults[0]));
            return;
          }
        }
        if (gen !== searchGenRef.current) return;
      }

      // No literal or semantic matches — keep the existing no-results state.
      setSearchMatches(results);
      setSearching(false);
      setActiveMatch(-1);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery, searchOpen, numPages, loadGen, scrollToMatch, aiSemanticSearch]);

  // Ctrl/Cmd+F opens the in-PDF search; Escape closes it.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isActive, searchOpen]);

  // Group matches by page so each MupdfPage receives only its own highlights.
  const highlightsByPage = useMemo(() => {
    const map = new Map<
      number,
      { rect: Rect; active: boolean; pulse?: boolean }[]
    >();

    if (forwardPulse) {
      const pageIndex = forwardPulse.page - 1;
      const rect: Rect = {
        x: forwardPulse.x,
        y: forwardPulse.y,
        w: forwardPulse.width,
        h: forwardPulse.height,
      };
      map.set(pageIndex, [{ rect, active: true, pulse: true }]);
    }

    if (searchOpen && searchMatches.length > 0) {
      searchMatches.forEach((m, idx) => {
        const arr = map.get(m.pageIndex) ?? [];
        arr.push({ rect: m.rect, active: idx === activeMatch });
        map.set(m.pageIndex, arr);
      });
    }

    return map.size > 0 ? map : null;
  }, [searchOpen, searchMatches, activeMatch, forwardPulse]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") ctrlKeyDownRef.current = true;
      if (event.key === "Meta") metaKeyDownRef.current = true;
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") ctrlKeyDownRef.current = false;
      if (event.key === "Meta") metaKeyDownRef.current = false;
    };
    const resetModifierState = () => {
      ctrlKeyDownRef.current = false;
      metaKeyDownRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", resetModifierState);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", resetModifierState);
    };
  }, []);

  function getVisiblePage(): number {
    const container = containerRef.current;
    if (!container) return 1;
    const pages = container.querySelectorAll(".mupdf-page");
    if (pages.length === 0) return 1;
    const containerRect = container.getBoundingClientRect();
    for (const page of pages) {
      const el = page as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerRect.top + 50) {
        return parseInt(el.getAttribute("data-page-number") || "1", 10);
      }
    }
    return 1;
  }

  /** Scroll the container so the given page is at the top (with 16px offset). */
  function scrollToPage(container: HTMLElement, page: number): boolean {
    const pageEl = container.querySelector(
      `[data-page-number="${page}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return false;
    const containerRect = container.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    container.scrollTop += pageRect.top - containerRect.top - 16;
    return true;
  }

  const prevRootFileIdRef = useRef<string | undefined>(undefined);

  // Save scroll position when rootFileId is about to change
  useEffect(() => {
    return () => {
      if (prevRootFileIdRef.current && containerRef.current) {
        scrollPositionCache.set(prevRootFileIdRef.current, getVisiblePage());
      }
    };
  }, [rootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load document with MuPDF (using LRU doc cache)
  useEffect(() => {
    const gen = ++loadGenRef.current;
    prevRootFileIdRef.current = rootFileId;

    const pdfData =
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);

    // Validate PDF header — must start with %PDF-
    if (
      pdfData.length < 5 ||
      pdfData[0] !== 0x25 ||
      pdfData[1] !== 0x50 ||
      pdfData[2] !== 0x44 ||
      pdfData[3] !== 0x46
    ) {
      log.error("Invalid PDF data: missing %PDF- header", {
        length: pdfData.length,
        firstBytes: Array.from(pdfData.slice(0, 16)),
      });
      setLoading(false);
      onError?.("Invalid PDF data received. Try recompiling the document.");
      return;
    }

    // Fast path: synchronous cache check — avoids async gap, state churn, and re-renders
    const syncResult = getCachedDocument(pdfData);
    if (syncResult && syncResult.docId === docIdRef.current) {
      // Same document already displayed — only restore scroll position on file switch
      isFirstLoad.current = false;
      if (rootFileId) {
        const targetPage = scrollPositionCache.get(rootFileId) ?? 0;
        if (targetPage > 0) {
          requestAnimationFrame(() => {
            const container = containerRef.current;
            if (container) scrollToPage(container, targetPage);
          });
        }
      }
      return;
    }

    // Save scroll position before reloading (for recompile of same file)
    if (containerRef.current && !isFirstLoad.current) {
      savedPageRef.current = getVisiblePage();
      if (contentRef.current) {
        contentRef.current.style.minHeight = `${contentRef.current.scrollHeight}px`;
      }
    }

    // Helper: retry-scroll to a page element with rAF retries
    const scrollToPageEl = (targetPage: number, maxAttempts = 30) => {
      const attempt = (remaining: number) => {
        const container = containerRef.current;
        if (!container || remaining <= 0) {
          if (contentRef.current) contentRef.current.style.minHeight = "";
          return;
        }
        const pageEl = container.querySelector(
          `[data-page-number="${targetPage}"]`,
        ) as HTMLElement | null;
        if (pageEl && pageEl.clientHeight > 0) {
          scrollToPage(container, targetPage);
          if (contentRef.current) contentRef.current.style.minHeight = "";
        } else {
          requestAnimationFrame(() => attempt(remaining - 1));
        }
      };
      requestAnimationFrame(() => attempt(maxAttempts));
    };

    // Synchronous cache hit for a different doc (file switch to cached PDF)
    if (syncResult) {
      docIdRef.current = syncResult.docId;
      setPageSizes(syncResult.pageSizes);
      setLoadGen((g) => g + 1);
      setLoading(false);

      if (isFirstLoad.current && syncResult.pageSizes.length > 0) {
        onFirstPageSize?.(
          syncResult.pageSizes[0].width,
          syncResult.pageSizes[0].height,
        );
      }
      isFirstLoad.current = false;
      onLoadSuccess?.(syncResult.pageSizes.length);

      if (rootFileId) {
        const targetPage = scrollPositionCache.get(rootFileId) ?? 0;
        if (targetPage > 0) scrollToPageEl(targetPage);
      }
      return;
    }

    // Cache miss — async path (first load or recompile with new content)
    setLoading(isFirstLoad.current);

    (async () => {
      try {
        const { docId, pageSizes: sizes } = await getOrOpenDocument(pdfData);
        if (gen !== loadGenRef.current) return;

        docIdRef.current = docId;
        setPageSizes(sizes);
        setLoadGen((g) => g + 1);
        setLoading(false);

        if (isFirstLoad.current && sizes.length > 0) {
          onFirstPageSize?.(sizes[0].width, sizes[0].height);
        }
        isFirstLoad.current = false;
        onLoadSuccess?.(sizes.length);

        const targetPage = savedPageRef.current;
        if (targetPage > 0) {
          savedPageRef.current = 0;
          scrollToPageEl(targetPage);
        }
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        setLoading(false);
        onError?.(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // IntersectionObserver for lazy page rendering — only when active
  useEffect(() => {
    if (!isActive) return;
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const pageNum = parseInt(
              el.getAttribute("data-page-number") || "0",
              10,
            );
            if (pageNum === 0) continue;
            if (entry.isIntersecting) {
              next.add(pageNum);
            } else {
              next.delete(pageNum);
            }
          }
          return next;
        });
      },
      {
        root: container,
        rootMargin: "200% 0px",
      },
    );

    const pages = container.querySelectorAll(".mupdf-page");
    pages.forEach((p) => observer.observe(p));

    return () => observer.disconnect();
  }, [pageSizes, isActive, focusGen]);

  // Report container dimensions to parent for fit-to-width/height
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onContainerResize) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      onContainerResize(width, height);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [onContainerResize]);

  // SyncTeX: double-click or Ctrl/Cmd+click jumps to source
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const jumpToSource = (e: MouseEvent) => {
      if (captureMode) return;
      const cb = synctexClickRef.current;
      if (!cb) return;

      const target = e.target as HTMLElement;
      const pageEl = target.closest(".mupdf-page") as HTMLElement | null;
      if (!pageEl) return;

      const pageNum = parseInt(
        pageEl.getAttribute("data-page-number") || "0",
        10,
      );
      if (pageNum === 0) return;

      const rect = pageEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const currentScale = scaleRef.current;
      const pdfX = offsetX / currentScale;
      const pdfY = offsetY / currentScale;

      cb(pageNum, pdfX, pdfY);
    };

    const handleDblClick = (e: MouseEvent) => {
      jumpToSource(e);
    };

    const handleClick = (e: MouseEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      jumpToSource(e);
    };

    container.addEventListener("dblclick", handleDblClick);
    container.addEventListener("click", handleClick);
    return () => {
      container.removeEventListener("dblclick", handleDblClick);
      container.removeEventListener("click", handleClick);
    };
  }, [captureMode]);

  // Text selection detection via mouseup
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
      cancelPendingSelection();
    };

    const handleMouseUp = () => {
      if (captureMode) return;
      const cb = textSelectRef.current;
      if (!cb) return;

      cancelPendingSelection();

      selectionTimer = setTimeout(() => {
        selectionTimer = null;

        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 2) {
          cb(null);
          return;
        }

        const anchorEl = sel?.anchorNode?.parentElement;
        if (!anchorEl?.closest(".mupdf-text-layer")) {
          cb(null);
          return;
        }

        const pageEl = anchorEl.closest(".mupdf-page") as HTMLElement | null;
        const pageNum = pageEl
          ? parseInt(pageEl.getAttribute("data-page-number") || "1", 10)
          : 1;

        const range = sel!.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        let pdfX = 0;
        let pdfY = 0;
        const quads: number[][] = [];
        if (pageEl) {
          const pageRect = pageEl.getBoundingClientRect();
          const currentScale = scaleRef.current;
          pdfX = (rect.left - pageRect.left) / currentScale;
          pdfY = (rect.top - pageRect.top) / currentScale;

          // getClientRects() yields one rect per span, so a single visual line
          // can arrive as several overlapping rects. Keep only rects whose
          // centre is on this page (selections can span pages), then merge
          // rects that share a line into one bar — otherwise the multiply
          // overlay stacks into dark bands and the export gets duplicate quads.
          const lines: {
            top: number;
            bottom: number;
            left: number;
            right: number;
          }[] = [];
          for (const r of Array.from(range.getClientRects())) {
            if (r.width < 1 || r.height < 1) continue;
            const cy = r.top + r.height / 2;
            if (cy < pageRect.top - 1 || cy > pageRect.bottom + 1) continue;
            const tol = r.height * 0.5;
            const sameLine = lines.find(
              (l) =>
                Math.abs(l.top - r.top) < tol &&
                Math.abs(l.bottom - r.bottom) < tol,
            );
            if (sameLine) {
              sameLine.top = Math.min(sameLine.top, r.top);
              sameLine.bottom = Math.max(sameLine.bottom, r.bottom);
              sameLine.left = Math.min(sameLine.left, r.left);
              sameLine.right = Math.max(sameLine.right, r.right);
            } else {
              lines.push({
                top: r.top,
                bottom: r.bottom,
                left: r.left,
                right: r.right,
              });
            }
          }
          for (const l of lines) {
            const x = (l.left - pageRect.left) / currentScale;
            const y = (l.top - pageRect.top) / currentScale;
            const w = (l.right - l.left) / currentScale;
            const h = (l.bottom - l.top) / currentScale;
            quads.push([x, y, x + w, y, x, y + h, x + w, y + h]);
          }
        }

        cb({
          text,
          pageNumber: pageNum,
          position: { top: rect.bottom, left: rect.left },
          pdfX,
          pdfY,
          quads,
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
  }, [captureMode]);

  // Track current visible page on scroll
  const currentPageChangeRef = useRef(onCurrentPageChange);
  currentPageChangeRef.current = onCurrentPageChange;
  const viewerActivityRef = useRef(onViewerActivity);
  viewerActivityRef.current = onViewerActivity;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isActive) return;

    let rafId = 0;
    const updateVisiblePage = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const cb = currentPageChangeRef.current;
        if (cb) cb(getVisiblePage());
      });
    };

    const handleScroll = () => {
      viewerActivityRef.current?.();
      updateVisiblePage();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    // Fire initial value without treating mount as user activity.
    updateVisiblePage();
    return () => {
      container.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(rafId);
    };
  }, [pageSizes, isActive]);

  // Expose scrollToPage via ref
  useEffect(() => {
    if (!scrollToPageRef) return;
    scrollToPageRef.current = (page: number) => {
      const container = containerRef.current;
      if (container) scrollToPage(container, page);
    };
    return () => {
      if (scrollToPageRef) scrollToPageRef.current = null;
    };
  }, [scrollToPageRef, pageSizes]);

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

  const zoomAtPoint = useCallback(
    (nextScaleValue: number, clientX?: number, clientY?: number) => {
      if (!onScaleChange) return;

      const container = containerRef.current;
      const previousScale = scaleRef.current;
      const renderedScale = renderedScaleRef.current;
      const nextScale = clampPdfScale(nextScaleValue);
      if (Math.abs(nextScale - previousScale) < 0.001) return;

      if (!container || previousScale <= 0 || renderedScale <= 0) {
        scaleRef.current = nextScale;
        onScaleChange(nextScale);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const anchorClientX =
        clientX ?? containerRect.left + containerRect.width / 2;
      const anchorClientY =
        clientY ?? containerRect.top + containerRect.height / 2;
      const pageAnchor = findPageZoomAnchor(
        container,
        anchorClientX,
        anchorClientY,
        renderedScale,
      );
      const fallbackAnchorX =
        anchorClientX - containerRect.left + container.scrollLeft;
      const fallbackAnchorY =
        anchorClientY - containerRect.top + container.scrollTop;
      const fallbackRatio = nextScale / renderedScale;

      pendingZoomScrollRef.current = {
        anchorClientX,
        anchorClientY,
        pageAnchor,
        fallbackAnchorX,
        fallbackAnchorY,
        fallbackRatio,
        nextScale,
        containerLeft: containerRect.left,
        containerTop: containerRect.top,
      };

      scaleRef.current = nextScale;
      onScaleChange(nextScale);
      viewerActivityRef.current?.();
    },
    [onScaleChange],
  );

  // Ctrl/Cmd + wheel zoom. Windows precision touchpad pinch arrives here too.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const handleWheel = (e: WheelEvent) => {
      if (!isModifiedZoomWheel(e) || !isWheelInsidePdfViewer(e, container)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const isTrackpadPinch = isTrackpadPinchWheel(
        e,
        ctrlKeyDownRef.current,
        metaKeyDownRef.current,
      );
      const factor = getWheelZoomFactor(e, isTrackpadPinch);
      if (Math.abs(factor - 1) < 0.0001) return;
      zoomAtPoint(scaleRef.current * factor, e.clientX, e.clientY);
    };

    window.addEventListener("wheel", handleWheel, {
      passive: false,
    });
    return () => {
      window.removeEventListener("wheel", handleWheel);
      pendingZoomScrollRef.current = null;
    };
  }, [onScaleChange, zoomAtPoint]);

  // Some WebViews report trackpad pinch through non-standard WebKit gesture
  // events instead of Ctrl/Cmd + wheel.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const readGestureScale = (event: WebKitGestureEvent) =>
      typeof event.scale === "number" && Number.isFinite(event.scale)
        ? event.scale
        : 1;

    const handleGestureStart: EventListener = (event) => {
      event.preventDefault();
      gesturePinchRef.current = { scale: scaleRef.current };
    };

    const handleGestureChange: EventListener = (event) => {
      const gesture = event as WebKitGestureEvent;
      const start = gesturePinchRef.current;
      if (!start) return;

      event.preventDefault();
      const factor =
        (start.scale * readGestureScale(gesture)) / scaleRef.current;
      zoomAtPoint(scaleRef.current * factor, gesture.clientX, gesture.clientY);
    };

    const handleGestureEnd: EventListener = () => {
      gesturePinchRef.current = null;
    };

    container.addEventListener("gesturestart", handleGestureStart, {
      passive: false,
    });
    container.addEventListener("gesturechange", handleGestureChange, {
      passive: false,
    });
    container.addEventListener("gestureend", handleGestureEnd);
    return () => {
      container.removeEventListener("gesturestart", handleGestureStart);
      container.removeEventListener("gesturechange", handleGestureChange);
      container.removeEventListener("gestureend", handleGestureEnd);
      gesturePinchRef.current = null;
    };
  }, [onScaleChange, zoomAtPoint]);

  // Two-finger touch pinch for touch-capable screens. Trackpads usually arrive
  // through the wheel path above.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const readTouchPinch = (touches: TouchList) => {
      if (touches.length < 2) return null;
      const first = touches.item(0);
      const second = touches.item(1);
      if (!first || !second) return null;
      const dx = second.clientX - first.clientX;
      const dy = second.clientY - first.clientY;
      return {
        distance: Math.hypot(dx, dy),
        x: (first.clientX + second.clientX) / 2,
        y: (first.clientY + second.clientY) / 2,
      };
    };

    const handleTouchStart = (event: TouchEvent) => {
      const pinch = readTouchPinch(event.touches);
      if (!pinch) return;
      event.preventDefault();
      touchPinchRef.current = {
        ...pinch,
        scale: scaleRef.current,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const start = touchPinchRef.current;
      const pinch = readTouchPinch(event.touches);
      if (!start || !pinch || start.distance <= 0) return;
      event.preventDefault();
      const factor =
        (start.scale * (pinch.distance / start.distance)) / scaleRef.current;
      zoomAtPoint(scaleRef.current * factor, pinch.x, pinch.y);
    };

    const handleTouchEnd = () => {
      if (containerRef.current && touchPinchRef.current) {
        touchPinchRef.current = null;
      }
    };

    container.addEventListener("touchstart", handleTouchStart, {
      passive: false,
    });
    container.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchEnd);
    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      touchPinchRef.current = null;
    };
  }, [onScaleChange, zoomAtPoint]);

  // Keyboard zoom (Cmd/Ctrl +/-), scoped to the PDF viewer.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomAtPoint(scaleRef.current + 0.25);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomAtPoint(scaleRef.current - 0.25);
      } else if (e.key === "0") {
        e.preventDefault();
        zoomAtPoint(1);
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [onScaleChange, zoomAtPoint]);

  // Intercept link clicks
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (!anchor.closest(".mupdf-link-layer")) return;

      e.preventDefault();
      e.stopPropagation();

      const href = anchor.getAttribute("href");
      if (!href) return;

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

      if (
        href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("mailto:")
      ) {
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

    container.addEventListener("click", handleClick, true);
    return () => container.removeEventListener("click", handleClick, true);
  }, []);

  // ESC during capture: cancel drag or cancel capture mode
  useEffect(() => {
    if (!captureMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dragStart) {
          setDragStart(null);
          setDragEnd(null);
        } else {
          onCancelCapture?.();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [captureMode, dragStart, onCancelCapture]);

  // Capture mode: drag to select region
  const handleCaptureMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!captureMode) return;
      const target = e.target as HTMLElement;
      const pageEl = target.closest(".mupdf-page") as HTMLElement | null;
      if (!pageEl) return;
      const pageNum = parseInt(
        pageEl.getAttribute("data-page-number") || "0",
        10,
      );
      if (!pageNum) return;
      setDragPageNum(pageNum);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragEnd(null);
    },
    [captureMode],
  );

  const handleCaptureMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!captureMode || !dragStart) return;
      setDragEnd({ x: e.clientX, y: e.clientY });
    },
    [captureMode, dragStart],
  );

  const handleCaptureMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!captureMode || !dragStart) {
        setDragStart(null);
        setDragEnd(null);
        return;
      }
      const end = { x: e.clientX, y: e.clientY };
      const w = Math.abs(end.x - dragStart.x);
      const h = Math.abs(end.y - dragStart.y);

      if (w < 10 || h < 10 || !onCapture) {
        setDragStart(null);
        setDragEnd(null);
        return;
      }

      const pageEl = containerRef.current?.querySelector(
        `.mupdf-page[data-page-number="${dragPageNum}"]`,
      ) as HTMLElement | null;
      const sourceCanvas = pageEl?.querySelector(
        "canvas",
      ) as HTMLCanvasElement | null;
      if (!pageEl || !sourceCanvas) {
        setDragStart(null);
        setDragEnd(null);
        return;
      }

      const pageRect = pageEl.getBoundingClientRect();
      const selLeft = Math.max(0, Math.min(dragStart.x, end.x) - pageRect.left);
      const selTop = Math.max(0, Math.min(dragStart.y, end.y) - pageRect.top);
      const selW = Math.min(pageRect.width - selLeft, w);
      const selH = Math.min(pageRect.height - selTop, h);

      const scaleX = sourceCanvas.width / pageRect.width;
      const scaleY = sourceCanvas.height / pageRect.height;
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = selW * scaleX;
      cropCanvas.height = selH * scaleY;
      const ctx = cropCanvas.getContext("2d")!;
      ctx.drawImage(
        sourceCanvas,
        selLeft * scaleX,
        selTop * scaleY,
        selW * scaleX,
        selH * scaleY,
        0,
        0,
        cropCanvas.width,
        cropCanvas.height,
      );

      const currentScale = scaleRef.current;
      const pdfX = selLeft / currentScale;
      const pdfY = selTop / currentScale;

      onCapture({
        dataUrl: cropCanvas.toDataURL("image/png"),
        pageNumber: dragPageNum,
        pdfX,
        pdfY,
      });

      setDragStart(null);
      setDragEnd(null);
    },
    [captureMode, dragStart, dragPageNum, onCapture],
  );

  // Text layer click for onTextClick
  const handleTextLayerClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onTextClick) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "text" && target.closest(".mupdf-text-layer")) {
        const text = target.textContent?.trim();
        if (text && text.length > 2) {
          onTextClick(text);
        }
      }
    },
    [onTextClick],
  );

  const selRect =
    dragStart && dragEnd
      ? {
          left: Math.min(dragStart.x, dragEnd.x),
          top: Math.min(dragStart.y, dragEnd.y),
          width: Math.abs(dragEnd.x - dragStart.x),
          height: Math.abs(dragEnd.y - dragStart.y),
        }
      : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {searchOpen && (
        <div className="absolute top-3 right-3 z-30 flex items-center gap-1 rounded-lg border border-border bg-background/95 px-2 py-1 shadow-lg backdrop-blur">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goToMatch(activeMatch + (e.shiftKey ? -1 : 1));
              } else if (e.key === "Escape") {
                setSearchOpen(false);
              }
            }}
            placeholder="Find in document"
            className="w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 px-1 text-muted-foreground text-xs tabular-nums">
            {searching
              ? "…"
              : searchMatches.length > 0
                ? `${activeMatch + 1}/${searchMatches.length}`
                : searchQuery.trim()
                  ? "0/0"
                  : ""}
          </span>
          {!searching && semanticAltTerm && searchMatches.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 px-1 text-muted-foreground text-xs"
              title={`No exact matches; showing results for "${semanticAltTerm}"`}
            >
              <SparklesIcon className="size-3 shrink-0" />
              <span className="max-w-28 truncate">
                Showing results for: {semanticAltTerm}
              </span>
            </span>
          )}
          <button
            type="button"
            onClick={() => goToMatch(activeMatch - 1)}
            disabled={searchMatches.length === 0}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ChevronUpIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => goToMatch(activeMatch + 1)}
            disabled={searchMatches.length === 0}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close search"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        tabIndex={-1}
        {...{ [LOCAL_ZOOM_SHORTCUTS_ATTR]: "true" }}
        className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none"
        style={{
          cursor: captureMode ? "crosshair" : undefined,
          touchAction: captureMode ? "none" : "pan-x pan-y",
        }}
        onMouseDownCapture={() => containerRef.current?.focus()}
        onMouseDown={handleCaptureMouseDown}
        onMouseMove={handleCaptureMouseMove}
        onMouseUp={handleCaptureMouseUp}
      >
        <div
          ref={contentRef}
          className="flex min-w-fit flex-col items-center gap-4 p-4"
          onClick={handleTextLayerClick}
        >
          {loading && numPages === 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Loading PDF...
            </div>
          )}
          {pageSizes.map((size, i) => (
            <MupdfPage
              key={i}
              docId={docIdRef.current}
              pageIndex={i}
              scale={scale}
              pageWidth={size.width}
              pageHeight={size.height}
              isVisible={visiblePages.has(i + 1)}
              darkMode={darkMode}
              highlights={highlightsByPage?.get(i)}
              annotations={annotationsByPage?.get(i)}
              onRemoveAnnotation={handleRemoveAnnotation}
              onUpdateNote={handleUpdateNote}
            />
          ))}
        </div>
        {selRect && (
          <div
            className="pointer-events-none fixed border-2 border-primary bg-primary/10"
            style={selRect}
          />
        )}
      </div>
    </div>
  );
}
