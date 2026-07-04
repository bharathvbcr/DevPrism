import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir } from "@tauri-apps/api/path";
import { toast } from "sonner";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
  FolderOpenIcon,
  PaperclipIcon,
  XIcon,
  UploadIcon,
  ChevronDownIcon,
  FileTextIcon,
  MapPinIcon,
  Loader2Icon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineBanner } from "@/components/ui/inline-banner";
import { useSetupFlowStore } from "@/stores/setup-flow-store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useTemplateStore } from "@/stores/template-store";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  getTemplateById,
  getTemplateSkeleton,
  BIB_TEMPLATE,
} from "@/lib/template-registry";
import { getTemplatePdfUrl } from "@/lib/template-preview-cache";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { exists, join } from "@/lib/tauri/fs";
import {
  setupNewProjectInSpace,
  formatNewProjectSetupToast,
} from "@/lib/space-project";
import type { PageSize } from "@/lib/mupdf/types";
import { createLogger } from "@/lib/debug/logger";
import {
  buildReferenceFilesSection,
  importReferenceFiles,
} from "@/lib/project-attachments";
import { getProjectNameError, normalizeProjectName } from "@/lib/project-name";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist, suggestProjectName } from "@/lib/ai-assist";
import { WizardSetupChecklist } from "@/components/wizard-setup-checklist";

const log = createLogger("template-preview");

// ─── Helpers ───

// ─── Component ───

// Single-surface creation dialog: the template preview and the project
// details form (name, purpose, reference files, location) are shown side by
// side, so picking a template and creating the project is one continuous
// step instead of a stacked preview → details sequence.
export function TemplatePreview({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
} = {}) {
  const previewTemplateId = useTemplateStore((s) => s.previewTemplateId);
  const closePreview = useTemplateStore((s) => s.closePreview);
  const template = previewTemplateId
    ? getTemplateById(previewTemplateId)
    : null;

  // ── PDF preview state ──
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

  // ── Creation form state ──
  const [purpose, setPurpose] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectNameError, setProjectNameError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const [refFilesOpen, setRefFilesOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const projectNameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── AI-suggested project name (from purpose) ──
  const aiNaming = useSettingsStore((s) => s.aiNaming);
  const [nameSuggesting, setNameSuggesting] = useState(false);
  const nameTouchedRef = useRef(false);
  const nameSuggestDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const nameSuggestRequestRef = useRef(0);

  // ── Store access ──
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const lastProjectFolder = useProjectStore((s) => s.lastProjectFolder);
  const setLastProjectFolder = useProjectStore((s) => s.setLastProjectFolder);
  const openProject = useDocumentStore((s) => s.openProject);

  // ── Dialog open/close ──
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closePreview();
        setCurrentPage(1);
        setNumPages(0);
        setIsLandscape(false);
        setError(false);
        if (docIdRef.current > 0) {
          getMupdfClient()
            .closeDocument(docIdRef.current)
            .catch(() => {});
          docIdRef.current = 0;
        }
      }
    },
    [closePreview],
  );

  // Reset form when a new template is previewed
  useEffect(() => {
    if (previewTemplateId) {
      setPurpose("");
      setAttachments([]);
      setProjectName("");
      setProjectNameError("");
      setCreateError(null);
      setRefFilesOpen(false);
      setLocationOpen(false);
      nameTouchedRef.current = false;
      setNameSuggesting(false);
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body) focusReturnRef.current = el;
    }
  }, [previewTemplateId]);

  // ── Debounced AI name suggestion from the purpose text ──
  // Only prefills while the user has not manually edited the name field.
  useEffect(() => {
    if (nameSuggestDebounceRef.current) {
      clearTimeout(nameSuggestDebounceRef.current);
    }

    if (!aiNaming || !canUseAiAssist()) return;
    if (!previewTemplateId) return;
    if (nameTouchedRef.current) return;

    const goal = purpose.trim();
    if (goal.length < 12) return;

    nameSuggestDebounceRef.current = setTimeout(() => {
      const id = ++nameSuggestRequestRef.current;
      setNameSuggesting(true);
      void suggestProjectName(goal)
        .then((suggested) => {
          if (id !== nameSuggestRequestRef.current) return;
          if (nameTouchedRef.current) return;
          const normalized = normalizeProjectName(suggested);
          if (normalized) {
            setProjectName(normalized);
            setProjectNameError("");
          }
        })
        .catch(() => {
          // Passive/background AI: fail silently.
        })
        .finally(() => {
          if (id === nameSuggestRequestRef.current) setNameSuggesting(false);
        });
    }, 800);

    return () => {
      if (nameSuggestDebounceRef.current) {
        clearTimeout(nameSuggestDebounceRef.current);
      }
    };
  }, [purpose, aiNaming, previewTemplateId]);

  // Default project folder
  useEffect(() => {
    if (projectFolder) return;
    if (lastProjectFolder) {
      setProjectFolder(lastProjectFolder);
    } else {
      homeDir()
        .then((home) => join(home, "Documents", "DevPrism"))
        .then(async (dir) => {
          await mkdir(dir, { recursive: true }).catch(() => {});
          setProjectFolder(dir);
        })
        .catch((err) =>
          console.warn("Failed to resolve default project folder:", err),
        );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus the project name field when the dialog opens
  useEffect(() => {
    if (previewTemplateId) {
      const timer = setTimeout(() => projectNameRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
  }, [previewTemplateId]);

  // ── PDF loading ──
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
        log.warn("load error", { error: String(err) });
        setLoading(false);
        setError(true);
      }
    })();
  }, [previewTemplateId]);

  // ── Render current page ──
  useEffect(() => {
    if (
      docIdRef.current <= 0 ||
      numPages === 0 ||
      !canvasRef.current ||
      !containerRef.current
    )
      return;

    const pageIndex = currentPage - 1;
    const size = pageSizesRef.current[pageIndex];
    if (!size) return;

    setIsLandscape(size.width > size.height);

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
    client
      .drawPage(docIdRef.current, pageIndex, dpi)
      .then((imageData) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.style.width = `${displayW}px`;
        canvas.style.height = `${displayH}px`;
        const ctx = canvas.getContext("2d")!;
        ctx.putImageData(imageData, 0, 0);
      })
      .catch((err) => {
        log.warn("render error", { error: String(err) });
      });
  }, [currentPage, numPages, isLandscape]);

  // ── Page navigation ──
  const goToPrevPage = useCallback(
    () => setCurrentPage((p) => Math.max(1, p - 1)),
    [],
  );
  const goToNextPage = useCallback(
    () => setCurrentPage((p) => Math.min(numPages, p + 1)),
    [numPages],
  );

  useEffect(() => {
    if (!previewTemplateId) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Don't hijack arrow keys while the user is typing in the form pane.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
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

  // ── Drag-drop for reference files ──
  useEffect(() => {
    if (!previewTemplateId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter") {
          setIsDragOver(true);
          setRefFilesOpen(true);
        } else if (type === "drop") {
          setIsDragOver(false);
          const paths = (event.payload as { paths: string[] }).paths;
          if (paths?.length > 0) {
            setAttachments((prev) => [
              ...prev,
              ...paths.filter((p) => !prev.includes(p)),
            ]);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [previewTemplateId]);

  // ── File handlers ──
  const handleAddAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      title: "Add Reference Files",
    });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      setAttachments((prev) => [
        ...prev,
        ...paths.filter((p) => !prev.includes(p)),
      ]);
    }
  }, []);

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  const handleChooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Location for New Project",
    });
    if (selected) {
      setProjectFolder(selected);
      setLastProjectFolder(selected);
    }
  }, [setLastProjectFolder]);

  // ── Create project ──
  const handleCreate = async () => {
    const name = normalizeProjectName(projectName);
    const nameError = getProjectNameError(projectName);
    if (!template || !projectFolder || nameError) {
      setProjectNameError(nameError ?? "");
      return;
    }
    setIsCreating(true);
    setCreateError(null);

    try {
      const projectPath = await join(projectFolder, name);
      if (await exists(projectPath)) {
        setProjectNameError("A folder with this name already exists here");
        return;
      }
      await mkdir(projectPath, { recursive: true });

      const mainTexPath = await join(projectPath, template.mainFileName);
      const mainExists = await exists(mainTexPath);
      if (!mainExists) {
        await writeTextFile(mainTexPath, getTemplateSkeleton(template));
      }

      if (template.hasBibliography) {
        const bibPath = await join(projectPath, "references.bib");
        const bibExists = await exists(bibPath);
        if (!bibExists) {
          await writeTextFile(bibPath, BIB_TEMPLATE);
        }
      }

      const referenceFiles =
        attachments.length > 0
          ? await importReferenceFiles(projectPath, attachments)
          : [];

      if (purpose.trim()) {
        const attachmentSection = buildReferenceFilesSection(referenceFiles);

        const prompt = [
          `## New ${template.name} Project`,
          "",
          `**Template:** \`${template.documentClass}\`  `,
          `**File:** \`${template.mainFileName}\``,
          "",
          `> The file currently contains only the LaTeX preamble (packages, styling, custom commands) with an empty document body.`,
          "",
          `### What I want to create`,
          "",
          purpose.trim(),
          attachmentSection,
          `### Instructions`,
          "",
          `Please generate the full document content based on my description. Keep the existing preamble and fill in the document body (between \`\\begin{document}\` and \`\\end{document}\`) with appropriate title, author, sections, and content. Make it a complete, well-structured **${template.name.toLowerCase()}** ready for me to refine.`,
        ].join("\n");

        useClaudeChatStore.getState().newSession();
        useClaudeChatStore.getState().setPendingInitialPrompt(prompt);
      }

      setLastProjectFolder(projectFolder);
      const setup = await setupNewProjectInSpace(projectPath);
      addRecentProject(projectPath);
      await openProject(projectPath);
      useSetupFlowStore.getState().completeOnboarding();
      const toastMsg = formatNewProjectSetupToast(setup, `Created "${name}"`);
      toast.success(toastMsg);

      // Close modal on success
      closePreview();
    } catch (err) {
      console.error("Failed to create project:", err);
      setCreateError(
        err instanceof Error ? err.message : "Could not create the project.",
      );
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = Boolean(
    template && projectFolder && !getProjectNameError(projectName),
  );

  if (!template) return null;

  // ── Modal width: wide two-pane layout (preview beside details form) ──
  const modalWidth = isLandscape
    ? "w-[min(80rem,calc(100vw-3rem))]"
    : "w-[min(66rem,calc(100vw-4rem))]";

  return (
    <Dialog open={!!previewTemplateId} onOpenChange={handleOpenChange}>
      <DialogContent
        className={`flex h-[min(46rem,85vh)] max-w-none flex-col gap-0 overflow-hidden p-0 transition-[width] duration-300 sm:max-w-none ${modalWidth}`}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const el = focusReturnRef.current;
          if (el?.isConnected) el.focus();
        }}
      >
        <DialogHeader className="shrink-0 border-border border-b px-6 py-3">
          <div className="flex items-center gap-4 pr-8">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-sm">{template.name}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-xs">
                {template.description} — {template.documentClass}
                {template.packages.length > 0 &&
                  ` — ${template.packages.length} packages`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* ── Left pane: template preview ── */}
          <div className="relative flex min-w-0 flex-1 flex-col border-border border-r">
            <div
              ref={containerRef}
              className="flex flex-1 items-center justify-center overflow-hidden bg-muted/30 p-6"
            >
              {loading && (
                <div className="flex w-full max-w-md flex-col gap-3 p-6">
                  <Skeleton className="aspect-[8.5/11] w-full rounded-md" />
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              )}
              {error && (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <span className="text-sm">Preview not available</span>
                  <span className="text-xs opacity-60">
                    This template has no preview yet — you can still create a
                    project from it.
                  </span>
                </div>
              )}
              {!loading && !error && numPages > 0 && (
                <canvas ref={canvasRef} className="shadow-xl" />
              )}
            </div>

            {numPages > 0 && (
              <div className="flex shrink-0 items-center justify-center gap-3 border-border border-t bg-background py-2.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={goToPrevPage}
                  disabled={currentPage <= 1}
                  aria-label="Previous page"
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <span className="min-w-16 text-center text-muted-foreground text-xs tabular-nums">
                  {numPages > 1 ? `${currentPage} / ${numPages}` : "1 page"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={goToNextPage}
                  disabled={currentPage >= numPages}
                  aria-label="Next page"
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            )}
          </div>

          {/* ── Right pane: project details form ── */}
          <div className="flex w-[23rem] shrink-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="space-y-4 p-5">
                <div className="space-y-2">
                  <div>
                    <span className="flex items-center gap-1.5 font-semibold text-sm">
                      Project name
                      {nameSuggesting && (
                        <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
                      )}
                    </span>
                    <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                      This becomes the folder name on disk.
                    </p>
                  </div>
                  <Input
                    ref={projectNameRef}
                    placeholder="e.g., conference-paper"
                    value={projectName}
                    onChange={(e) => {
                      nameTouchedRef.current = true;
                      setProjectName(e.target.value);
                      setProjectNameError("");
                    }}
                    onBlur={() =>
                      setProjectNameError(
                        getProjectNameError(projectName) ?? "",
                      )
                    }
                    className="text-sm"
                  />
                  {projectNameError && (
                    <p className="text-destructive text-xs">
                      {projectNameError}
                    </p>
                  )}
                </div>
                {/* Purpose — hero element */}
                <div className="space-y-2">
                  <div>
                    <span className="font-semibold text-sm">
                      What are you writing?
                    </span>
                    <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                      Describe your document and Claude will generate tailored
                      content.
                    </p>
                  </div>
                  <Textarea
                    ref={textareaRef}
                    placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    rows={3}
                    className="resize-none text-sm leading-relaxed placeholder:text-muted-foreground/50"
                  />
                </div>

                {purpose.trim() && canUseAiAssist() && (
                  <WizardSetupChecklist
                    onOpenSettings={() => {
                      closePreview();
                      onOpenSettings?.();
                    }}
                  />
                )}

                {/* Collapsible sections */}
                <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60 bg-card/30">
                  {/* Reference files */}
                  <div>
                    <button
                      type="button"
                      onClick={() => setRefFilesOpen(!refFilesOpen)}
                      aria-expanded={refFilesOpen}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
                        <FileTextIcon className="size-3 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-sm">
                          Reference files
                        </span>
                        {attachments.length > 0 && (
                          <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 font-semibold text-[10px] text-primary leading-none">
                            {attachments.length}
                          </span>
                        )}
                      </div>
                      <ChevronDownIcon
                        className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${refFilesOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {refFilesOpen && (
                      <div className="space-y-2.5 px-4 pb-3">
                        {attachments.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {attachments.map((path) => (
                              <div
                                key={path}
                                className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 py-1 pr-1.5 pl-2.5 text-xs transition-colors hover:bg-muted/60"
                              >
                                <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/70" />
                                <span className="max-w-30 truncate text-foreground/80">
                                  {path.split(/[/\\]/).pop()}
                                </span>
                                <button
                                  onClick={() => handleRemoveAttachment(path)}
                                  aria-label={`Remove ${path.split(/[/\\]/).pop()}`}
                                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                                >
                                  <XIcon className="size-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div
                          className={`flex flex-col items-center gap-1.5 rounded-lg border border-dashed p-3 transition-all ${
                            isDragOver
                              ? "border-primary bg-primary/5"
                              : "border-border/60 hover:border-border hover:bg-muted/20"
                          }`}
                        >
                          {isDragOver ? (
                            <>
                              <UploadIcon className="size-4 text-primary" />
                              <span className="font-medium text-primary text-xs">
                                Drop to add
                              </span>
                            </>
                          ) : (
                            <>
                              <UploadIcon className="size-4 text-muted-foreground/40" />
                              <div className="text-center">
                                <span className="text-muted-foreground/70 text-xs">
                                  Drag & drop or{" "}
                                </span>
                                <button
                                  onClick={handleAddAttachments}
                                  className="font-medium text-foreground/70 text-xs underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                                >
                                  browse files
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Project location */}
                  <div>
                    <button
                      type="button"
                      onClick={() => setLocationOpen(!locationOpen)}
                      aria-expanded={locationOpen}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
                        <MapPinIcon className="size-3 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-sm">
                          Project location
                        </span>
                      </div>
                      {!locationOpen && projectFolder && projectName.trim() && (
                        <span className="min-w-0 max-w-35 truncate rounded-md bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground/60">
                          .../{projectFolder.split(/[/\\]/).pop()}/
                          {normalizeProjectName(projectName)}
                        </span>
                      )}
                      <ChevronDownIcon
                        className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${locationOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {locationOpen && (
                      <div className="space-y-2 px-4 pb-3">
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 truncate rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/60">
                            {projectFolder
                              ? `${projectFolder}/${normalizeProjectName(projectName) || "..."}`
                              : "Choose a location"}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0 gap-1.5 rounded-lg border-border/60"
                            onClick={handleChooseFolder}
                          >
                            <FolderOpenIcon className="size-3.5" />
                            {projectFolder ? "Change" : "Choose"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Create button — sticky footer */}
            <div className="shrink-0 space-y-3 border-border/60 border-t px-5 py-4">
              {createError && (
                <InlineBanner
                  kind="error"
                  title="Could not create project"
                  message={createError}
                  onDismiss={() => setCreateError(null)}
                />
              )}
              <Button
                className="w-full gap-2 rounded-xl font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.99]"
                size="lg"
                disabled={!canCreate || isCreating}
                onClick={handleCreate}
              >
                {isCreating ? (
                  <>
                    <Loader2Icon className="size-4 animate-spin" />
                    Creating project...
                  </>
                ) : purpose.trim() ? (
                  <>
                    <SparklesIcon className="size-4" />
                    Create & Generate with AI
                  </>
                ) : (
                  "Create Project"
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
