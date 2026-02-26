import { useState, useCallback, useEffect, useRef } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
  LoaderIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTemplateStore } from "@/stores/template-store";
import { getTemplateById } from "@/lib/template-registry";
import { getTemplatePdfUrl } from "@/lib/template-preview-cache";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { PageSize } from "@/lib/mupdf/types";

interface TemplatePreviewProps {
  onUseTemplate: (id: string) => void;
}

export function TemplatePreview({ onUseTemplate }: TemplatePreviewProps) {
  const previewTemplateId = useTemplateStore((s) => s.previewTemplateId);
  const closePreview = useTemplateStore((s) => s.closePreview);

  const template = previewTemplateId ? getTemplateById(previewTemplateId) : null;

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLandscape, setIsLandscape] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const docIdRef = useRef(0);
  const pageSizesRef = useRef<PageSize[]>([]);
  const loadGenRef = useRef(0);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closePreview();
        setCurrentPage(1);
        setNumPages(0);
        setIsLandscape(false);
        setError(false);
        // Close document
        if (docIdRef.current > 0) {
          getMupdfClient().closeDocument(docIdRef.current).catch(() => {});
          docIdRef.current = 0;
        }
      }
    },
    [closePreview],
  );

  // Load document when template changes
  useEffect(() => {
    if (!previewTemplateId) return;

    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(false);
    setNumPages(0);
    setCurrentPage(1);

    (async () => {
      try {
        const url = getTemplatePdfUrl(previewTemplateId);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();

        if (gen !== loadGenRef.current) return;

        const client = getMupdfClient();

        // Close previous
        if (docIdRef.current > 0) {
          await client.closeDocument(docIdRef.current).catch(() => {});
        }

        const docId = await client.openDocument(buffer);
        if (gen !== loadGenRef.current) {
          client.closeDocument(docId).catch(() => {});
          return;
        }
        docIdRef.current = docId;

        const count = await client.countPages(docId);
        if (gen !== loadGenRef.current) return;

        const sizes: PageSize[] = [];
        for (let i = 0; i < count; i++) {
          const size = await client.getPageSize(docId, i);
          if (gen !== loadGenRef.current) return;
          sizes.push(size);
        }

        pageSizesRef.current = sizes;
        setNumPages(count);
        setCurrentPage(1);
        if (sizes.length > 0) {
          setIsLandscape(sizes[0].width > sizes[0].height);
        }
        setLoading(false);
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        console.warn("[template-preview] load error:", err);
        setLoading(false);
        setError(true);
      }
    })();
  }, [previewTemplateId]);

  // Render current page — fit canvas within the container
  useEffect(() => {
    if (docIdRef.current <= 0 || numPages === 0 || !canvasRef.current || !containerRef.current) return;

    const pageIndex = currentPage - 1;
    const size = pageSizesRef.current[pageIndex];
    if (!size) return;

    setIsLandscape(size.width > size.height);

    // Fit within available container space (minus padding)
    const container = containerRef.current;
    const maxW = container.clientWidth - 48;
    const maxH = container.clientHeight - 48;
    const pageAspect = size.width / size.height;

    let displayW = maxW;
    let displayH = displayW / pageAspect;
    if (displayH > maxH) {
      displayH = maxH;
      displayW = displayH * pageAspect;
    }

    const dpr = window.devicePixelRatio || 1;
    const dpi = (displayW / size.width) * 72 * dpr;

    const client = getMupdfClient();
    client.drawPage(docIdRef.current, pageIndex, dpi).then((imageData) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;
      const ctx = canvas.getContext("2d")!;
      ctx.putImageData(imageData, 0, 0);
    }).catch((err) => {
      console.warn("[template-preview] render error:", err);
    });
  }, [currentPage, numPages, isLandscape]);

  const goToPrevPage = useCallback(
    () => setCurrentPage((p) => Math.max(1, p - 1)),
    [],
  );
  const goToNextPage = useCallback(
    () => setCurrentPage((p) => Math.min(numPages, p + 1)),
    [numPages],
  );

  // Arrow key navigation
  useEffect(() => {
    if (!previewTemplateId) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrevPage();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToNextPage();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewTemplateId, goToPrevPage, goToNextPage]);

  if (!template) return null;

  return (
    <Dialog open={!!previewTemplateId} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className={`flex h-[70vh] max-w-none sm:max-w-none flex-col gap-0 overflow-hidden p-0 ${isLandscape ? "w-[min(72rem,calc(100vw-4rem))]" : "w-[min(48rem,calc(100vw-6rem))]"}`}>
        {/* Header */}
        <DialogHeader className="shrink-0 border-b border-border px-6 py-3">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-sm">{template.name}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-xs">
                {template.description} — {template.documentClass}
                {template.packages.length > 0 && ` — ${template.packages.length} packages`}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  closePreview();
                  onUseTemplate(template.id);
                }}
                className="gap-1.5"
              >
                <SparklesIcon className="size-3.5" />
                Use Template
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* Main content area */}
        <div className="flex flex-1 overflow-hidden">
          <div className="relative flex flex-1 flex-col">
            <div ref={containerRef} className="flex flex-1 items-center justify-center overflow-hidden bg-muted/30 p-6">
              {loading && (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <LoaderIcon className="size-5 animate-spin" />
                  <span className="text-sm">Loading preview...</span>
                </div>
              )}
              {error && (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <span className="text-sm">Preview not available</span>
                  <span className="text-xs opacity-60">
                    Run `pnpm generate-previews` to generate
                  </span>
                </div>
              )}
              {!loading && !error && numPages > 0 && (
                <canvas
                  ref={canvasRef}
                  className="shadow-xl"
                />
              )}
            </div>

            {/* Page navigation */}
            {numPages > 0 && (
              <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border bg-background py-2.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={goToPrevPage}
                  disabled={currentPage <= 1}
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <span className="min-w-[4rem] text-center text-xs tabular-nums text-muted-foreground">
                  {numPages > 1 ? `${currentPage} / ${numPages}` : "1 page"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={goToNextPage}
                  disabled={currentPage >= numPages}
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
