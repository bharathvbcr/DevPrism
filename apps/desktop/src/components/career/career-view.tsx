import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeftIcon,
  DatabaseIcon,
  FileUpIcon,
  SparklesIcon,
  BookOpenIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InlineBanner } from "@/components/ui/inline-banner";
import { Skeleton } from "@/components/ui/skeleton";
import { debounce, onCareerDbChanged } from "@/lib/career/db-events";
import {
  isTexFileName,
  isZipFileName,
  readResumeSourceFromFile,
  readResumeSourceFromPath,
  type ResumeSource,
} from "@/lib/career";
import {
  collectBrowserDropFiles,
  hasBrowserFileDrag,
} from "@/lib/browser-project/drag-drop";
import { useCareerStore, type CareerTab } from "@/stores/career-store";
import { useSynthesisStore } from "@/stores/synthesis-store";
import { isTauri } from "@/lib/runtime/is-tauri";
import { CareerDatabaseTab } from "./career-database-tab";
import { CareerKnowledgeTab } from "./career-knowledge-tab";
import { CareerSynthesizeTab } from "./career-synthesize-tab";

function firstImportablePath(paths: string[]): string | null {
  return (
    paths.find((p) => {
      const base = p.split(/[\\/]/).pop() ?? "";
      return isZipFileName(base) || isTexFileName(base);
    }) ?? null
  );
}

function firstImportableBrowserFile(
  files: Array<{ file: File; relativePath: string }>,
): File | null {
  for (const item of files) {
    const base = item.relativePath.split("/").pop() ?? "";
    if (isZipFileName(base) || isTexFileName(base)) return item.file;
  }
  return null;
}

function handleLoadedSource(out: ResumeSource) {
  useCareerStore.getState().requestResumeImport(out.source);
  toast.success(`Loaded ${out.label} — review and extract drafts`);
}

function reportImportFailure(pathsOrFiles: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (pathsOrFiles > 1) {
    toast.error(`${message} (other dropped items were ignored)`);
  } else {
    toast.error(message);
  }
}

export function CareerView() {
  const activeTab = useCareerStore((s) => s.activeTab);
  const setActiveTab = useCareerStore((s) => s.setActiveTab);
  const closeCareer = useCareerStore((s) => s.closeCareer);
  const loadAll = useCareerStore((s) => s.loadAll);
  const loading = useCareerStore((s) => s.loading);
  const blocks = useCareerStore((s) => s.blocks);
  const error = useCareerStore((s) => s.error);

  useEffect(() => {
    if (!isTauri()) return;
    void loadAll();
  }, [loadAll]);

  // External career.db commits (in-app MCP server, `--mcp-stdio` process)
  // arrive while any tab is mounted — refetch everything the UI caches.
  useEffect(() => {
    if (!isTauri()) return;
    return onCareerDbChanged(
      debounce(() => {
        const career = useCareerStore.getState();
        void career.loadAll();
        void useSynthesisStore.getState().refreshReadiness();
      }, 400),
    );
  }, []);

  useEffect(() => {
    if (isTauri()) {
      void getCurrentWindow().setTitle("Career - DevPrism");
    } else {
      document.title = "Career - DevPrism";
    }
  }, []);

  // ─── Drag-and-drop import (.zip LaTeX archives / loose .tex files) ───
  const [dragging, setDragging] = useState(false);
  const setDraggingRef = useRef(setDragging);
  setDraggingRef.current = setDragging;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    if (isTauri()) {
      getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (cancelled) return;
          const { type } = event.payload;
          if (type === "enter" || type === "over") {
            setDraggingRef.current(true);
          } else if (type === "leave") {
            setDraggingRef.current(false);
          } else if (type === "drop") {
            setDraggingRef.current(false);
            const paths = (event.payload as { paths?: string[] }).paths ?? [];
            const target = firstImportablePath(paths);
            if (!target) {
              toast.error(
                "Drop a .zip resume archive or a .tex file to import.",
              );
              return;
            }
            try {
              handleLoadedSource(await readResumeSourceFromPath(target));
            } catch (err) {
              reportImportFailure(paths.length, err);
            }
          }
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {
          /* fall through to HTML5 handlers below */
        });
    }

    const onDragEnter = (event: DragEvent) => {
      if (!hasBrowserFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDraggingRef.current(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasBrowserFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDraggingRef.current(true);
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget && event.currentTarget instanceof Node) {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      }
      setDraggingRef.current(false);
    };

    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      // In Tauri, native drops arrive via onDragDropEvent above.
      if (isTauri() || !hasBrowserFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDraggingRef.current(false);
      void collectBrowserDropFiles(event.dataTransfer)
        .then(async (files) => {
          const target = firstImportableBrowserFile(files);
          if (!target) {
            toast.error("Drop a .zip resume archive or a .tex file to import.");
            return;
          }
          try {
            handleLoadedSource(await readResumeSourceFromFile(target));
          } catch (err) {
            reportImportFailure(files.length, err);
          }
        })
        .catch((err: unknown) => reportImportFailure(1, err));
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  if (!isTauri()) {
    return (
      <div className="flex h-full flex-col bg-background text-foreground">
        <CareerHeader onBack={closeCareer} />
        <div className="mx-auto max-w-lg p-8">
          <InlineBanner
            kind="info"
            title="Desktop required"
            message="The Career database uses local SQLite and is only available in the DevPrism desktop app."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <CareerHeader onBack={closeCareer} />
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[9997] flex items-center justify-center bg-background/70 p-6">
          <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-xl border-2 border-primary/60 border-dashed px-6 py-10 text-center">
            <FileUpIcon className="size-8 text-primary/70" />
            <p className="font-medium text-sm">
              Drop a .zip resume archive or .tex file
            </p>
            <p className="text-muted-foreground text-xs">
              The LaTeX source is loaded into the resume import wizard — nothing
              is saved until you confirm.
            </p>
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
        {error && (
          <InlineBanner
            className="mb-3"
            kind="error"
            title="Career database error"
            message={error}
          />
        )}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as CareerTab)}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <TabsList className="w-fit shrink-0">
            <TabsTrigger value="database" className="gap-1.5">
              <DatabaseIcon className="size-3.5" />
              Database
            </TabsTrigger>
            <TabsTrigger value="knowledge" className="gap-1.5">
              <BookOpenIcon className="size-3.5" />
              Knowledge
            </TabsTrigger>
            <TabsTrigger value="synthesize" className="gap-1.5">
              <SparklesIcon className="size-3.5" />
              Synthesize
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="database"
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
          >
            {loading && blocks.length === 0 ? (
              <div className="space-y-3 p-2">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : (
              <CareerDatabaseTab />
            )}
          </TabsContent>
          <TabsContent
            value="knowledge"
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
          >
            <CareerKnowledgeTab />
          </TabsContent>
          <TabsContent
            value="synthesize"
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
          >
            <CareerSynthesizeTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function CareerHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="flex h-[calc(48px+var(--titlebar-height))] shrink-0 items-center gap-3 border-border/70 border-b px-5 pt-[var(--titlebar-height)]">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeftIcon className="size-3.5" />
        Projects
      </Button>
      <h1 className="font-semibold text-lg leading-none">Career</h1>
      <span className="text-muted-foreground text-xs">
        Master experience database
      </span>
    </header>
  );
}
