import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  FileTextIcon,
  SpellCheckIcon,
  AlertCircleIcon,
  Loader2Icon,
  RefreshCwIcon,
  MinusIcon,
  PlusIcon,
  DownloadIcon,
  HistoryIcon,
  MousePointerClickIcon,
  CrosshairIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  LightbulbIcon,
  CopyIcon,
  CheckIcon,
  ZapIcon,
  MoonIcon,
  HighlighterIcon,
  Trash2Icon,
  ExpandIcon,
  SparklesIcon,
  ImageIcon,
  XIcon,
  MailIcon,
  TargetIcon,
} from "lucide-react";
import { writeFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  useDocumentStore,
  getPdfBytes,
  getCurrentPdfBytes,
  resolveTexRoot,
} from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  inlineEditChatPrompt,
  runInlineEdit,
  canUseDirectInlineTransform,
  inlineEditSuccessMessage,
  type InlineEditAction,
} from "@/lib/inline-edit";
import { toast } from "sonner";

function findSourceSpan(
  content: string,
  selectedText: string,
  nearLine: number,
): { from: number; to: number } | null {
  const trimmed = selectedText.trim();
  if (!trimmed) return null;

  const lines = content.split("\n");
  const center = Math.max(0, Math.min(nearLine - 1, lines.length - 1));
  const searchLines = new Set<number>([center, center - 1, center + 1]);
  for (const li of searchLines) {
    if (li < 0 || li >= lines.length) continue;
    let offset = 0;
    for (let i = 0; i < li; i++) offset += lines[i].length + 1;
    const line = lines[li];
    const idx = line.indexOf(trimmed);
    if (idx >= 0) {
      return { from: offset + idx, to: offset + idx + trimmed.length };
    }
    const short = trimmed.slice(0, Math.min(48, trimmed.length));
    const shortIdx = line.indexOf(short);
    if (shortIdx >= 0) {
      return { from: offset + shortIdx, to: offset + shortIdx + short.length };
    }
  }

  const globalIdx = content.indexOf(
    trimmed.slice(0, Math.min(48, trimmed.length)),
  );
  if (globalIdx >= 0) {
    const len = Math.min(trimmed.length, content.length - globalIdx);
    return { from: globalIdx, to: globalIdx + len };
  }
  return null;
}
import { useSettingsStore } from "@/stores/settings-store";
import {
  canUseAiAssist,
  explainCompileErrorsStream,
  summarizeSection,
} from "@/lib/ai-assist";
import { aiCaption } from "@/lib/ai-extras";
import {
  clearCompileRootPreference,
  fileAffectsCompileRoot,
  FOLLOW_EDITOR_COMPILE_ROOT,
  hasPinnedCompileRoot,
  resolveActiveCompileTarget,
  resolvePreviewCompileRoot,
  setCompileRootPreference,
} from "@/lib/compile-root-preference";
import { Button } from "@/components/ui/button";
import { ToolbarGroup } from "@/components/ui/toolbar-group";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { HistoryPanel } from "@/components/workspace/history-panel";
import {
  compileLatex,
  synctexEdit,
  listCompileRoots,
  formatCompileError,
  type CompileRootOption,
} from "@/lib/latex-compiler";
import {
  createAutoCompileScheduler,
  type AutoCompileScheduler,
} from "@/lib/auto-compile";
import { ErrorBoundary } from "react-error-boundary";
import {
  SelectionToolbar,
  type ToolbarAction,
} from "@/components/workspace/editor/selection-toolbar";
import { save } from "@tauri-apps/plugin-dialog";
import {
  PdfViewer,
  type PdfTextSelection,
  type CaptureResult,
} from "./pdf-viewer";
import {
  useAnnotationStore,
  getHighlightsForRoot,
  getHighlightColor,
  HIGHLIGHT_COLORS,
} from "@/stores/annotation-store";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { getOrOpenDocument } from "@/lib/mupdf/pdf-doc-cache";
import type { StructuredTextData } from "@/lib/mupdf/types";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("pdf-preview");

type FitMode = "fit-width" | "fit-height" | null;

/** Per-root zoom state cache: rootFileId -> { scale, fitMode } */
const zoomCache = new Map<string, { scale: number; fitMode: FitMode }>();

/** Max number of PdfViewer instances kept alive simultaneously. */
const MAX_ALIVE_VIEWERS = 5;

/** Clear zoom cache (e.g., on project close). */
export function clearZoomCache(): void {
  zoomCache.clear();
}

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

const IS_MAC =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
const COMPILE_HINT = IS_MAC ? "⌘↵" : "Ctrl+Enter";
const CAPTURE_HINT = IS_MAC ? "Cmd+X" : "Ctrl+X";
const SYNCTEX_HINT = IS_MAC ? "⌘+click" : "Ctrl+click";

/** Max characters of extracted PDF text fed to the summarizer. */
const SUMMARY_TEXT_CAP = 8000;
const PREVIEW_PILL_HIDE_MS = 2000;

type CompileRootKind = "main" | "cover-letter" | "other";

function getCompileRootPresentation(root: CompileRootOption): {
  title: string;
  subtitle: string;
  kind: CompileRootKind;
} {
  const fileName = root.targetPath.split("/").pop() ?? root.label;
  if (root.label.startsWith("Main (")) {
    return { title: "Main document", subtitle: fileName, kind: "main" };
  }
  if (root.label.startsWith("Cover letter (")) {
    return { title: "Cover letter", subtitle: fileName, kind: "cover-letter" };
  }
  const baseName = fileName.replace(/\.tex$/i, "");
  return {
    title: baseName,
    subtitle: root.targetPath,
    kind: "other",
  };
}

function CompileRootIcon({
  kind,
  className,
}: {
  kind: CompileRootKind;
  className?: string;
}) {
  const Icon = kind === "cover-letter" ? MailIcon : FileTextIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

function CompilePreviewTargetTrigger({
  root,
  hasError,
}: {
  root: CompileRootOption;
  hasError: boolean;
}) {
  const presentation = getCompileRootPresentation(root);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
      <CompileRootIcon kind={presentation.kind} />
      <div className="min-w-0 flex-1 truncate text-sm leading-none">
        <span className="font-medium text-foreground">{presentation.title}</span>
        <span className="text-muted-foreground"> · {presentation.subtitle}</span>
      </div>
      {hasError && (
        <AlertCircleIcon
          className="size-3.5 shrink-0 text-destructive"
          aria-label="Compile error on this target"
        />
      )}
    </div>
  );
}

function CompilePreviewTargetItem({
  root,
  hasError,
}: {
  root: CompileRootOption;
  hasError: boolean;
}) {
  const presentation = getCompileRootPresentation(root);
  return (
    <div className="flex min-w-0 items-start gap-2.5 py-0.5">
      <CompileRootIcon kind={presentation.kind} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-foreground">
            {presentation.title}
          </span>
          {hasError && (
            <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium text-[10px] text-destructive">
              Error
            </span>
          )}
        </div>
        <div className="truncate text-muted-foreground text-xs">
          {presentation.subtitle}
        </div>
      </div>
    </div>
  );
}

/** Flatten MuPDF structured text into a plain paragraph string. */
function flattenPageText(data: StructuredTextData): string {
  const lines: string[] = [];
  for (const block of data.blocks) {
    for (const line of block.lines) {
      const t = line.text?.trim();
      if (t) lines.push(t);
    }
  }
  return lines.join("\n");
}

export function PdfPreview() {
  const compilerBackend = useSettingsStore((s) => s.compilerBackend);
  const setCompilerBackend = useSettingsStore((s) => s.setCompilerBackend);
  const autoCompile = useSettingsStore((s) => s.autoCompile);
  const setAutoCompile = useSettingsStore((s) => s.setAutoCompile);
  const pdfDarkMode = useSettingsStore((s) => s.pdfDarkMode);
  const setPdfDarkMode = useSettingsStore((s) => s.setPdfDarkMode);
  const contentGeneration = useDocumentStore((s) => s.contentGeneration);
  const pdfRevision = useDocumentStore((s) => s.pdfRevision);
  const compileError = useDocumentStore((s) => s.compileError);
  const isCompiling = useDocumentStore((s) => s.isCompiling);
  const isSaving = useDocumentStore((s) => s.isSaving);
  const setPdfData = useDocumentStore((s) => s.setPdfData);
  const setCompileError = useDocumentStore((s) => s.setCompileError);
  const setIsCompiling = useDocumentStore((s) => s.setIsCompiling);
  const setCompiledPageCount = useDocumentStore((s) => s.setCompiledPageCount);
  const forwardSyncPulse = useDocumentStore((s) => s.forwardSyncPulse);
  const setForwardSyncPulse = useDocumentStore((s) => s.setForwardSyncPulse);
  const content = useDocumentStore((s) => s.content);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const files = useDocumentStore((s) => s.files);
  const saveAllFiles = useDocumentStore((s) => s.saveAllFiles);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const activeFile = useDocumentStore((s) => {
    return s.files.find((f) => f.id === s.activeFileId) ?? null;
  });
  const activeFileType = activeFile?.type ?? "tex";
  const isTexActive = activeFileType === "tex";
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [copiedError, setCopiedError] = useState(false);
  const [compileExplanation, setCompileExplanation] = useState<string | null>(
    null,
  );
  const [explainingCompile, setExplainingCompile] = useState(false);
  const aiCompileAssist = useSettingsStore((s) => s.aiCompileAssist);
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);
  const aiVisionCaption = useSettingsStore((s) => s.aiVisionCaption);
  const [pageSummary, setPageSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryScope, setSummaryScope] = useState<"page" | "document">("page");
  const summaryRequestRef = useRef(0);
  // AI vision caption for the most recently captured region. Holds the
  // captured PNG (data URL) + page so a small post-capture callout can offer
  // "Caption with AI". Cancellation-safe via captionRequestRef.
  const [capturedRegion, setCapturedRegion] = useState<{
    dataUrl: string;
    pageNumber: number;
  } | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [captioning, setCaptioning] = useState(false);
  const [captionCopied, setCaptionCopied] = useState(false);
  const captionRequestRef = useRef(0);
  // Invalidates any in-flight compile-error explanation stream so stale
  // fragments can't repopulate the panel after a retry / new compile.
  const explainRequestRef = useRef(0);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInputValue, setPageInputValue] = useState<string>("1");
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [previewPillVisible, setPreviewPillVisible] = useState(false);
  const previewPillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollToPageRef = useRef<((page: number) => void) | null>(null);
  const [scale, setScale] = useState<number>(1.0);
  const [captureMode, setCaptureMode] = useState(false);
  const [fitMode, setFitMode] = useState<FitMode>(null);
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [firstPageSize, setFirstPageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const hasInitialCompile = useRef(false);
  const initialized = useDocumentStore((s) => s.initialized);

  // Drop any stale AI explanation when the compile error changes (fresh
  // compile / retry / root switch) so it never lingers across failures.
  useEffect(() => {
    // Also invalidate any in-flight explanation stream so its remaining
    // fragments can't repopulate the panel after the error changes.
    explainRequestRef.current++;
    setCompileExplanation(null);
  }, [compileError]);

  // Derive pdfData from external cache, re-read whenever pdfRevision bumps
  const pdfData = useMemo(() => getCurrentPdfBytes(), [pdfRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep-alive: track which root files have PdfViewer instances alive (LRU order)
  const compileRoots = useMemo(() => listCompileRoots(files), [files]);
  const compileErrorCache = useDocumentStore((s) => s.compileErrorCache);
  const activeFileId = useDocumentStore((s) => s.activeFileId);

  const currentRootFileId = useMemo(
    () => resolvePreviewCompileRoot(projectRoot, activeFileId, files),
    [projectRoot, activeFileId, files],
  );
  const currentCompileRoot = useMemo(
    () => compileRoots.find((r) => r.rootId === currentRootFileId) ?? null,
    [compileRoots, currentRootFileId],
  );
  const currentCompileRootHasError = Boolean(
    currentRootFileId && compileErrorCache.get(currentRootFileId),
  );
  const previewTargetPinned = hasPinnedCompileRoot(projectRoot, files);
  const [aliveOrder, setAliveOrder] = useState<string[]>([]);
  const prevRootRef = useRef(currentRootFileId);

  // Save/restore zoom state per root file on switch
  useEffect(() => {
    const prev = prevRootRef.current;
    if (prev && prev !== currentRootFileId) {
      // Save previous root's zoom
      zoomCache.set(prev, { scale, fitMode });
      // Cancel any in-flight summarize/caption for the previous document so a
      // stale result can't display against the newly switched-to root.
      summaryRequestRef.current++;
      captionRequestRef.current++;
      setPageSummary(null);
      setSummaryOpen(false);
      setSummarizing(false);
      setCaption(null);
      setCaptioning(false);
      setCapturedRegion(null);
    }
    // Restore new root's zoom
    const cached = zoomCache.get(currentRootFileId);
    if (cached) {
      setScale(cached.scale);
      setFitMode(cached.fitMode);
    }
    prevRootRef.current = currentRootFileId;
  }, [currentRootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update alive set when active root changes and has PDF data
  useEffect(() => {
    if (!currentRootFileId || !pdfData) return;
    setAliveOrder((prev) => {
      if (prev[0] === currentRootFileId) return prev; // already at front
      const without = prev.filter((id) => id !== currentRootFileId);
      return [currentRootFileId, ...without].slice(0, MAX_ALIVE_VIEWERS);
    });
  }, [currentRootFileId, pdfData]);

  // PDF text selection toolbar
  const [pdfSelection, setPdfSelection] = useState<PdfTextSelection | null>(
    null,
  );
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const bumpPreviewPill = useCallback(() => {
    setPreviewPillVisible(true);
    if (previewPillTimerRef.current) {
      clearTimeout(previewPillTimerRef.current);
    }
    previewPillTimerRef.current = setTimeout(() => {
      setPreviewPillVisible(false);
      previewPillTimerRef.current = null;
    }, PREVIEW_PILL_HIDE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (previewPillTimerRef.current) {
        clearTimeout(previewPillTimerRef.current);
      }
    };
  }, []);

  // Highlight annotations
  const addHighlight = useAnnotationStore((s) => s.addHighlight);
  const activeColorId = useAnnotationStore((s) => s.activeColorId);
  const setActiveColor = useAnnotationStore((s) => s.setActiveColor);
  const clearHighlights = useAnnotationStore((s) => s.clearHighlights);
  const highlightCount = useAnnotationStore((s) =>
    currentRootFileId
      ? (s.highlightsByRoot[currentRootFileId]?.length ?? 0)
      : 0,
  );
  const [isExporting, setIsExporting] = useState(false);

  /** Turn the current PDF text selection into a highlight in the active color.
   *  Shared by the selection toolbar action and the keyboard shortcut. */
  const highlightCurrentSelection = useCallback(() => {
    const sel = pdfSelection;
    if (!sel) return;
    setPdfSelection(null);
    window.getSelection()?.removeAllRanges();
    if (!currentRootFileId || sel.quads.length === 0) {
      import("sonner").then(({ toast }) => {
        toast.error("Couldn't highlight this selection. Try selecting text.");
      });
      return;
    }
    const color = getHighlightColor(activeColorId);
    addHighlight(currentRootFileId, {
      pageIndex: sel.pageNumber - 1,
      colorId: color.id,
      rgb: color.rgb,
      css: color.css,
      quads: sel.quads,
      text: sel.text,
    });
  }, [pdfSelection, currentRootFileId, activeColorId, addHighlight]);

  const handleTextClick = useCallback(
    (text: string) => {
      let index = content.indexOf(text);
      if (index === -1) {
        const cleanText = text.replace(/[{}\\$]/g, "");
        if (cleanText.length > 2) index = content.indexOf(cleanText);
      }
      if (index === -1 && text.length > 5) {
        const words = text.split(/\s+/).filter((w) => w.length > 3);
        for (const word of words) {
          index = content.indexOf(word);
          if (index !== -1) break;
        }
      }
      if (index !== -1) requestJumpToPosition(index);
    },
    [content, requestJumpToPosition],
  );

  const handleSynctexClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (!projectRoot) return;
      const result = await synctexEdit(projectRoot, page, x, y);
      if (!result) return;

      const normalize = (p: string) =>
        p.replace(/\\/g, "/").replace(/^\.\//, "");
      const normalizedTarget = normalize(result.file);
      const targetFile = files.find(
        (f) => normalize(f.relativePath) === normalizedTarget,
      );
      if (!targetFile) return;

      const state = useDocumentStore.getState();
      const needsSwitch = state.activeFileId !== targetFile.id;
      if (needsSwitch) {
        setActiveFile(targetFile.id);
      }

      const fileContent = targetFile.content ?? "";
      const fileLines = fileContent.split("\n");
      const targetLine = Math.max(1, Math.min(result.line, fileLines.length));
      let offset = 0;
      for (let i = 0; i < targetLine - 1; i++) {
        offset += fileLines[i].length + 1;
      }
      if (result.column > 0) {
        offset += Math.min(
          result.column,
          fileLines[targetLine - 1]?.length ?? 0,
        );
      }

      if (needsSwitch) {
        setTimeout(() => requestJumpToPosition(offset), 100);
      } else {
        requestJumpToPosition(offset);
      }
    },
    [projectRoot, files, setActiveFile, requestJumpToPosition],
  );

  // Resolved source location from synctex
  const [resolvedSource, setResolvedSource] = useState<{
    file: string;
    line: number;
    column: number;
  } | null>(null);

  const handleTextSelect = useCallback((selection: PdfTextSelection | null) => {
    setPdfSelection(selection);
    setResolvedSource(null);
  }, []);

  // When PDF selection changes, resolve source via synctex
  useEffect(() => {
    if (!pdfSelection || !projectRoot) return;
    let cancelled = false;
    synctexEdit(
      projectRoot,
      pdfSelection.pageNumber,
      pdfSelection.pdfX,
      pdfSelection.pdfY,
    )
      .then((result) => {
        if (cancelled || !result) return;
        setResolvedSource(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdfSelection, projectRoot]);

  const pdfContextLabel = resolvedSource
    ? `~@${resolvedSource.file}:${resolvedSource.line}`
    : pdfSelection
      ? `~@PDF page ${pdfSelection.pageNumber}`
      : "";

  const navigateToSource = useCallback(() => {
    if (!resolvedSource) return;
    const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    const normalizedTarget = normalize(resolvedSource.file);
    const targetFile = files.find(
      (f) => normalize(f.relativePath) === normalizedTarget,
    );
    if (!targetFile) return;

    const state = useDocumentStore.getState();
    const needsSwitch = state.activeFileId !== targetFile.id;
    if (needsSwitch) setActiveFile(targetFile.id);

    const fileContent = targetFile.content ?? "";
    const fileLines = fileContent.split("\n");
    const targetLine = Math.max(
      1,
      Math.min(resolvedSource.line, fileLines.length),
    );
    let offset = 0;
    for (let i = 0; i < targetLine - 1; i++) {
      offset += fileLines[i].length + 1;
    }
    if (resolvedSource.column > 0) {
      offset += Math.min(
        resolvedSource.column,
        fileLines[targetLine - 1]?.length ?? 0,
      );
    }

    if (needsSwitch) {
      setTimeout(() => requestJumpToPosition(offset), 100);
    } else {
      requestJumpToPosition(offset);
    }
  }, [resolvedSource, files, setActiveFile, requestJumpToPosition]);

  const buildPdfContext = useCallback(
    (text: string) => {
      const locationNote = resolvedSource
        ? `near ${resolvedSource.file}:${resolvedSource.line}`
        : pdfSelection
          ? `PDF page ${pdfSelection.pageNumber}`
          : "PDF";
      return `[Selected from PDF output, approximate source location: ${locationNote}]\n${text}`;
    },
    [resolvedSource, pdfSelection],
  );

  const handlePdfToolbarSendPrompt = useCallback(
    (prompt: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;
      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      useClaudeChatStore.getState().sendPrompt(prompt, {
        label,
        filePath: resolvedSource?.file ?? "document.pdf",
        selectedText: buildPdfContext(sel.text),
      });
    },
    [pdfSelection, pdfContextLabel, resolvedSource, buildPdfContext],
  );

  const pdfToolbarActions: ToolbarAction[] = useMemo(
    () => [
      {
        id: "pdf-highlight",
        label: "Highlight",
        icon: <HighlighterIcon className="size-4" />,
        hint: IS_MAC ? "⇧⌘H" : "Ctrl+Shift+H",
      },
      {
        id: "pdf-comment",
        label: "Comment",
        icon: <MessageSquareIcon className="size-4" />,
      },
      {
        id: "pdf-suggest",
        label: "Suggest",
        icon: <LightbulbIcon className="size-4" />,
      },
      {
        id: "rephrase",
        label: "Rephrase",
        icon: <RefreshCwIcon className="size-4" />,
      },
      {
        id: "expand",
        label: "Expand",
        icon: <ExpandIcon className="size-4" />,
      },
      {
        id: "proofread",
        label: "Proofread",
        icon: <SpellCheckIcon className="size-4" />,
      },
      {
        id: "navigate",
        label: "Navigate to source",
        icon: <FileTextIcon className="size-4" />,
        hint: "dbl-click",
      },
    ],
    [],
  );

  const handlePdfToolbarAction = useCallback(
    (actionId: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;

      // --- Highlight the selected text (persisted + exported as a real
      //     PDF Highlight annotation) ---
      if (actionId === "pdf-highlight") {
        highlightCurrentSelection();
        return;
      }

      // --- New: PDF-side commenting on selected text ---
      if (actionId === "pdf-comment" || actionId === "pdf-suggest") {
        if (!resolvedSource) {
          // Synctex couldn't map this region to source. Tell the user.
          // (The lookup may still be in-flight if the selection was very fresh.)
          import("sonner").then(({ toast }) => {
            toast.error(
              "Couldn't locate the source for this PDF selection. " +
                "Try again, or use the Navigate button to jump first.",
            );
          });
          return;
        }
        const normalize = (p: string) =>
          p.replace(/\\/g, "/").replace(/^\.\//, "");
        const target = files.find(
          (f) => normalize(f.relativePath) === normalize(resolvedSource.file),
        );
        if (!target) {
          import("sonner").then(({ toast }) => {
            toast.error(`Source file not in project: ${resolvedSource.file}`);
          });
          return;
        }
        const fileContent = target.content ?? "";
        const lines = fileContent.split("\n");
        const lineIdx = Math.max(
          0,
          Math.min(resolvedSource.line - 1, lines.length - 1),
        );
        const line = lines[lineIdx] ?? "";

        // Compute absolute offset of the start of the synctex line
        let lineStartOffset = 0;
        for (let i = 0; i < lineIdx; i++)
          lineStartOffset += lines[i].length + 1;

        // Try to find the selected text within the resolved line. Fall back
        // to anchoring on the whole line if not found.
        const selText = sel.text.trim();
        let charStart = lineStartOffset;
        let charEnd = lineStartOffset + line.length;
        let quoted = line;
        if (selText) {
          const idx = line.indexOf(selText);
          if (idx >= 0) {
            charStart = lineStartOffset + idx;
            charEnd = charStart + selText.length;
            quoted = selText;
          }
        }

        // Switch to the target file if needed, then dispatch
        const needsSwitch =
          useDocumentStore.getState().activeFileId !== target.id;
        if (needsSwitch) setActiveFile(target.id);

        setPdfSelection(null);
        window.getSelection()?.removeAllRanges();

        const dispatchEvent = () => {
          window.dispatchEvent(
            new CustomEvent("comments:start-from-pdf", {
              detail: {
                mode: actionId === "pdf-suggest" ? "suggestion" : "comment",
                filePath: target.relativePath,
                anchor: {
                  line_start: lineIdx + 1,
                  line_end: lineIdx + 1,
                  char_start: charStart,
                  char_end: charEnd,
                  quoted_text: quoted,
                },
              },
            }),
          );
        };
        if (needsSwitch) setTimeout(dispatchEvent, 100);
        else dispatchEvent();
        return;
      }

      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      if (
        actionId === "proofread" ||
        actionId === "rephrase" ||
        actionId === "expand"
      ) {
        const action = actionId as InlineEditAction;
        const runChatFallback = () => {
          useClaudeChatStore
            .getState()
            .sendPrompt(inlineEditChatPrompt(action), {
              label,
              filePath: resolvedSource?.file ?? "document.pdf",
              selectedText: buildPdfContext(sel.text),
            });
        };

        if (canUseDirectInlineTransform() && resolvedSource) {
          const normalize = (p: string) =>
            p.replace(/\\/g, "/").replace(/^\.\//, "");
          const normalizedTarget = normalize(resolvedSource.file);
          const targetFile = files.find(
            (f) => normalize(f.relativePath) === normalizedTarget,
          );
          const fileContent = targetFile?.content;
          if (targetFile && fileContent) {
            const span = findSourceSpan(
              fileContent,
              sel.text,
              resolvedSource.line,
            );
            if (span) {
              void (async () => {
                try {
                  const mode = await runInlineEdit({
                    action,
                    selection: {
                      filePath: targetFile.relativePath,
                      absolutePath: targetFile.absolutePath,
                      content: fileContent,
                      from: span.from,
                      to: span.to,
                      selectedText: fileContent.slice(span.from, span.to),
                      contextLabel: label,
                    },
                  });
                  if (mode === "applied") {
                    toast.success(inlineEditSuccessMessage(action));
                  }
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "PDF AI edit failed",
                  );
                  runChatFallback();
                }
              })();
              return;
            }
          }
        }
        runChatFallback();
      } else if (actionId === "navigate") {
        navigateToSource();
      }
    },
    [
      pdfSelection,
      pdfContextLabel,
      resolvedSource,
      navigateToSource,
      buildPdfContext,
      files,
      setActiveFile,
      highlightCurrentSelection,
    ],
  );

  const handlePdfToolbarDismiss = useCallback(() => {
    setPdfSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const pdfToolbarPosition = (() => {
    if (!pdfSelection || !previewContainerRef.current) return null;
    const containerRect = previewContainerRef.current.getBoundingClientRect();
    const relTop = pdfSelection.position.top - containerRect.top + 4;
    const relLeft = Math.max(
      8,
      Math.min(
        pdfSelection.position.left - containerRect.left,
        containerRect.width - 272,
      ),
    );
    return { top: relTop, left: relLeft };
  })();

  useEffect(() => {
    if (hasInitialCompile.current) return;
    if (!initialized || !projectRoot) return;
    if (pdfData || isCompiling || compileError) return;

    hasInitialCompile.current = true;

    const compile = async () => {
      setIsCompiling(true);
      try {
        await saveAllFiles();
        const { files: allFiles, activeFileId } = useDocumentStore.getState();
        const resolved = resolveActiveCompileTarget(
          projectRoot,
          activeFileId,
          allFiles,
        );
        if (!resolved) {
          setCompileError(
            "No .tex file found in this project. Create a main.tex file to compile.",
          );
          return;
        }
        const { rootId, targetPath } = resolved;
        const texlive =
          useSettingsStore.getState().compilerBackend === "texlive";
        const data = await compileLatex(projectRoot, targetPath, texlive);
        setPdfData(data, rootId);
      } catch (error) {
        setCompileError(formatCompileError(error));
      } finally {
        setIsCompiling(false);
      }
    };
    compile();
  }, [
    initialized,
    projectRoot,
    pdfData,
    isCompiling,
    compileError,
    setIsCompiling,
    setPdfData,
    setCompileError,
    saveAllFiles,
    files,
    activeFile,
  ]);

  // Recompute scale when fit mode is active and container/page size changes
  useEffect(() => {
    if (!fitMode || !containerSize || !firstPageSize) return;
    const PADDING = 32; // p-4 on each side
    if (fitMode === "fit-width") {
      const newScale = (containerSize.width - PADDING) / firstPageSize.width;
      setScale(Math.max(0.25, Math.min(4, newScale)));
    } else if (fitMode === "fit-height") {
      const newScale = (containerSize.height - PADDING) / firstPageSize.height;
      setScale(Math.max(0.25, Math.min(4, newScale)));
    }
  }, [fitMode, containerSize, firstPageSize]);

  const zoomIn = () => {
    setFitMode(null);
    setScale((s) => Math.min(4, s + 0.1));
    bumpPreviewPill();
  };
  const zoomOut = () => {
    setFitMode(null);
    setScale((s) => Math.max(0.25, s - 0.1));
    bumpPreviewPill();
  };

  const handleExport = async () => {
    const currentPdf = getCurrentPdfBytes();
    if (!currentPdf) return;
    const highlights = currentRootFileId
      ? getHighlightsForRoot(currentRootFileId)
      : [];
    const mainFile = files.find(
      (f) => f.name === "main.tex" || f.name === "document.tex",
    );
    const baseName = mainFile
      ? mainFile.name.replace(/\.tex$/, "")
      : "document";
    const defaultName =
      highlights.length > 0 ? `${baseName}-annotated.pdf` : `${baseName}.pdf`;
    const filePath = await save({
      title: "Export PDF",
      defaultPath: defaultName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!filePath) return;

    // No highlights → export the compiled PDF as-is.
    if (highlights.length === 0) {
      await writeFile(filePath, new Uint8Array(currentPdf));
      return;
    }

    // Apply highlights as real PDF annotations on a fresh copy of the bytes.
    setIsExporting(true);
    try {
      const copy = new Uint8Array(currentPdf.length);
      copy.set(currentPdf);
      const annotated = await getMupdfClient().exportAnnotatedPdf(
        copy.buffer,
        highlights.map((h) => ({
          pageIndex: h.pageIndex,
          color: h.rgb,
          opacity: 0.4,
          quads: h.quads,
          note: h.note?.trim() ? h.note : h.text,
        })),
      );
      await writeFile(filePath, new Uint8Array(annotated));
    } catch (err) {
      log.error("Annotated export failed", { error: String(err) });
      import("sonner").then(({ toast }) => {
        toast.error("Failed to export the highlighted PDF.");
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleCurrentPageChange = useCallback(
    (page: number) => {
      setCurrentPage((prev) => {
        if (prev === page) return prev;
        if (!isEditingPage) setPageInputValue(String(page));
        return page;
      });
    },
    [isEditingPage],
  );

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(numPages, page));
      scrollToPageRef.current?.(clamped);
    },
    [numPages],
  );

  const activeForwardPulse = useMemo(() => {
    if (
      !forwardSyncPulse ||
      forwardSyncPulse.rootFileId !== currentRootFileId
    ) {
      return null;
    }
    return forwardSyncPulse;
  }, [forwardSyncPulse, currentRootFileId]);

  useEffect(() => {
    if (!activeForwardPulse) return;
    goToPage(activeForwardPulse.page);
    const timer = window.setTimeout(() => setForwardSyncPulse(null), 4500);
    return () => window.clearTimeout(timer);
  }, [activeForwardPulse, goToPage, setForwardSyncPulse]);

  const handlePageInputCommit = useCallback(() => {
    setIsEditingPage(false);
    const parsed = parseInt(pageInputValue, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= numPages) {
      goToPage(parsed);
    } else {
      setPageInputValue(String(currentPage));
    }
  }, [pageInputValue, numPages, currentPage, goToPage]);

  const handleLoadSuccess = useCallback(
    (pages: number) => {
      setNumPages(pages);
      if (currentRootFileId) {
        setCompiledPageCount(currentRootFileId, pages);
      }
    },
    [currentRootFileId, setCompiledPageCount],
  );

  const handleScaleChange = useCallback(
    (newScale: number) => {
      setFitMode(null);
      setScale(newScale);
      bumpPreviewPill();
    },
    [bumpPreviewPill],
  );

  /** Summarize the current page (default) or the whole document via local AI.
   *  User-triggered: cancellation-safe via a requestId guard, toasts on error. */
  const runSummarize = useCallback(
    async (scope: "page" | "document") => {
      if (!aiSummarize || !canUseAiAssist()) return;
      const data = getCurrentPdfBytes();
      if (!data) return;

      const id = ++summaryRequestRef.current;
      setSummaryScope(scope);
      setSummaryOpen(true);
      setPageSummary(null);
      setSummarizing(true);

      try {
        const { docId, pageSizes } = await getOrOpenDocument(data);
        const client = getMupdfClient();

        let text = "";
        if (scope === "page") {
          const pageIndex = Math.max(
            0,
            Math.min(currentPage - 1, pageSizes.length - 1),
          );
          const structured = await client.getPageText(docId, pageIndex);
          text = flattenPageText(structured);
        } else {
          const parts: string[] = [];
          let total = 0;
          for (let i = 0; i < pageSizes.length; i++) {
            if (total >= SUMMARY_TEXT_CAP) break;
            const structured = await client.getPageText(docId, i);
            if (id !== summaryRequestRef.current) return; // cancelled
            const pageText = flattenPageText(structured);
            if (!pageText) continue;
            parts.push(pageText);
            total += pageText.length + 1;
          }
          text = parts.join("\n\n");
        }

        text = text.slice(0, SUMMARY_TEXT_CAP).trim();
        if (id !== summaryRequestRef.current) return; // cancelled

        if (!text) {
          if (id === summaryRequestRef.current) {
            setSummarizing(false);
            toast.error("No extractable text found to summarize.");
            setSummaryOpen(false);
          }
          return;
        }

        const summary = await summarizeSection(text);
        if (id !== summaryRequestRef.current) return; // cancelled
        setPageSummary(summary);
      } catch (err) {
        if (id !== summaryRequestRef.current) return;
        log.error("PDF summarize failed", { error: String(err) });
        toast.error(
          err instanceof Error ? err.message : "Could not summarize the PDF",
        );
        setSummaryOpen(false);
      } finally {
        if (id === summaryRequestRef.current) setSummarizing(false);
      }
    },
    [aiSummarize, currentPage],
  );

  const handleCompile = async (force = false) => {
    // Read all guard values from the store to avoid stale closures
    const state = useDocumentStore.getState();
    if (!state.projectRoot) return;
    if (state.isCompiling) {
      // Queue a recompile after the current one finishes
      state.setPendingRecompile(true);
      return;
    }
    const allFiles = state.files;
    const resolved = resolveActiveCompileTarget(
      state.projectRoot,
      state.activeFileId,
      allFiles,
    );
    if (!resolved) {
      setCompileError(
        "No .tex file found in this project. Create a main.tex file to compile.",
      );
      return;
    }
    const { rootId, targetPath: targetFile } = resolved;
    // Skip recompile if no edits since last successful compile of this root
    // (unless force=true, e.g. user clicked Recompile button)
    if (!force) {
      const lastGen = state.lastCompiledGenerations.get(rootId);
      if (
        getPdfBytes(rootId) &&
        lastGen !== undefined &&
        state.contentGeneration === lastGen
      ) {
        return;
      }
      if (
        hasPinnedCompileRoot(state.projectRoot, allFiles) &&
        state.lastEditedFileId &&
        !fileAffectsCompileRoot(state.lastEditedFileId, rootId, allFiles)
      ) {
        return;
      }
    }
    useHistoryStore.getState().stopReview();
    setIsCompiling(true);
    state.setPendingRecompile(false);
    setPdfError(null);
    const compileStart = Date.now();
    try {
      await saveAllFiles();
      const texlive = useSettingsStore.getState().compilerBackend === "texlive";
      const data = await compileLatex(state.projectRoot, targetFile, texlive);
      setPdfData(data, rootId);
    } catch (error) {
      setCompileError(formatCompileError(error), rootId);
    } finally {
      // Ensure the spinner is visible for at least 500ms for visual feedback
      const elapsed = Date.now() - compileStart;
      if (elapsed < 500) {
        await new Promise((r) => setTimeout(r, 500 - elapsed));
      }
      setIsCompiling(false);
      // If a recompile was requested while we were compiling, trigger it now
      // Use setTimeout to avoid unbounded recursion on the call stack
      if (useDocumentStore.getState().pendingRecompile) {
        setTimeout(() => handleCompile(), 0);
      }
    }
  };

  // Keep a fresh reference so the debounced auto-compile timer always invokes
  // the latest handleCompile without re-arming the scheduler on every render.
  const handleCompileRef = useRef(handleCompile);
  handleCompileRef.current = handleCompile;

  // Auto-compile: debounce a recompile after the document is edited.
  const autoCompileScheduler = useRef<AutoCompileScheduler | null>(null);
  if (!autoCompileScheduler.current) {
    autoCompileScheduler.current = createAutoCompileScheduler(() =>
      handleCompileRef.current(),
    );
  }
  useEffect(() => {
    autoCompileScheduler.current?.sync({
      enabled: autoCompile,
      ready: initialized && !!projectRoot,
      generation: contentGeneration,
    });
  }, [autoCompile, initialized, projectRoot, contentGeneration]);
  useEffect(() => () => autoCompileScheduler.current?.dispose(), []);

  /** Caption the most recently captured region via a local vision model.
   *  User-triggered: cancellation-safe via captionRequestRef, toasts on error,
   *  never throws into render. Gated by aiVisionCaption && canUseAiAssist(). */
  const runCaption = useCallback(async () => {
    if (!aiVisionCaption || !canUseAiAssist()) return;
    const region = capturedRegion;
    if (!region) return;

    const id = ++captionRequestRef.current;
    setCaption(null);
    setCaptionCopied(false);
    setCaptioning(true);
    try {
      const result = await aiCaption(
        region.dataUrl,
        "Write a concise figure caption for this image.",
      );
      if (id !== captionRequestRef.current) return; // cancelled
      const trimmed = result.trim();
      if (!trimmed) {
        toast.error("No caption was produced for this region.");
        return;
      }
      setCaption(trimmed);
    } catch (err) {
      if (id !== captionRequestRef.current) return;
      log.error("PDF caption failed", { error: String(err) });
      toast.error(
        err instanceof Error ? err.message : "Could not caption the region",
      );
    } finally {
      if (id === captionRequestRef.current) setCaptioning(false);
    }
  }, [aiVisionCaption, capturedRegion]);

  const dismissCaption = useCallback(() => {
    captionRequestRef.current++;
    setCapturedRegion(null);
    setCaption(null);
    setCaptioning(false);
    setCaptionCopied(false);
  }, []);

  const handleCopyCaption = useCallback(async () => {
    if (!caption) return;
    try {
      await navigator.clipboard.writeText(caption);
      setCaptionCopied(true);
      setTimeout(() => setCaptionCopied(false), 2000);
    } catch (err) {
      log.error("Failed to copy caption", { error: String(err) });
    }
  }, [caption]);

  const handleCapture = async (result: CaptureResult) => {
    setCaptureMode(false);
    // Offer an AI caption for this region only when the vision feature is
    // enabled and usable; reset any prior caption callout state.
    if (aiVisionCaption && canUseAiAssist()) {
      captionRequestRef.current++;
      setCaption(null);
      setCaptioning(false);
      setCaptionCopied(false);
      setCapturedRegion({
        dataUrl: result.dataUrl,
        pageNumber: result.pageNumber,
      });
    }
    if (!projectRoot) return;

    const fileName = `capture-p${result.pageNumber}-${Date.now()}.png`;
    const relativePath = `attachments/${fileName}`;

    try {
      const attachmentsDir = await join(projectRoot, "attachments");
      if (!(await exists(attachmentsDir))) {
        await mkdir(attachmentsDir, { recursive: true });
      }
      const fullPath = await join(projectRoot, relativePath);

      const base64 = result.dataUrl.split(",")[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await writeFile(fullPath, bytes);

      await useDocumentStore.getState().refreshFiles();

      useClaudeChatStore.getState().addPendingAttachment({
        label: `@${relativePath}`,
        filePath: relativePath,
        selectedText: `[Captured region from PDF page ${result.pageNumber}]`,
        imageDataUrl: result.dataUrl,
      });
    } catch (err) {
      log.error("Capture failed to save", { error: String(err) });
    }
  };

  // Listen for global Capture & Ask shortcut (Cmd+X / Ctrl+X)
  useEffect(() => {
    const handleToggleCapture = () => {
      if (pdfData) setCaptureMode((prev) => !prev);
    };
    window.addEventListener("toggle-capture-mode", handleToggleCapture);
    return () =>
      window.removeEventListener("toggle-capture-mode", handleToggleCapture);
  }, [pdfData]);

  // Cmd/Ctrl+Shift+H highlights the current PDF text selection.
  useEffect(() => {
    if (!pdfSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === "H" || e.key === "h")
      ) {
        e.preventDefault();
        e.stopPropagation();
        highlightCurrentSelection();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pdfSelection, highlightCurrentSelection]);

  const renderContent = () => {
    if (compileError) {
      const errors = [
        ...new Set(
          compileError
            .split(/\s*!\s*/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s !== "Compilation failed"),
        ),
      ];

      const handleFixWithAi = () => {
        const errorList = errors.map((e) => `- ${e}`).join("\n");
        useClaudeChatStore
          .getState()
          .sendPrompt(
            `[Compilation errors]\n${errorList}\n\nFix these LaTeX compilation errors.`,
          );
      };

      const handleExplainErrors = async () => {
        if (!canUseAiAssist() || errors.length === 0) return;
        const id = ++explainRequestRef.current;
        setExplainingCompile(true);
        setCompileExplanation("");
        try {
          const explanation = await explainCompileErrorsStream(
            errors,
            (fragment) => {
              if (id !== explainRequestRef.current) return; // cancelled
              setCompileExplanation((prev) => (prev ?? "") + fragment);
            },
          );
          if (id !== explainRequestRef.current) return; // cancelled
          setCompileExplanation(explanation);
        } catch (err) {
          import("sonner").then(({ toast }) => {
            toast.error(
              err instanceof Error ? err.message : "Could not explain errors",
            );
          });
        } finally {
          setExplainingCompile(false);
        }
      };

      const handleCopyErrors = async () => {
        try {
          await navigator.clipboard.writeText(compileError);
          setCopiedError(true);
          setTimeout(() => setCopiedError(false), 2000);
        } catch (err) {
          log.error("Failed to copy errors", { error: String(err) });
        }
      };

      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-6">
          <div className="w-full max-w-lg">
            <div className="mb-4 flex items-center gap-2 text-destructive">
              <AlertCircleIcon className="size-5" />
              <h2 className="font-semibold text-base">Compilation Failed</h2>
              <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-xs">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </span>
            </div>
            <div className="rounded-lg border border-destructive/20 bg-background">
              <div className="max-h-60 divide-y divide-border overflow-y-auto">
                {errors.map((error, i) => (
                  <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                    <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
                    <span className="text-foreground text-sm">{error}</span>
                  </div>
                ))}
              </div>
            </div>
            {compileExplanation && (
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-foreground text-sm">
                <div className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  <SparklesIcon className="size-3.5" />
                  AI explanation
                </div>
                <div className="whitespace-pre-wrap">{compileExplanation}</div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={handleFixWithAi}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs shadow-sm transition-colors hover:bg-primary/90"
              >
                <SparklesIcon className="size-3.5" />
                Fix with AI
              </button>
              {aiCompileAssist && canUseAiAssist() && (
                <button
                  onClick={() => void handleExplainErrors()}
                  disabled={explainingCompile}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {explainingCompile ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <SparklesIcon className="size-3.5" />
                  )}
                  Explain with AI
                </button>
              )}
              <button
                onClick={() => handleCompile(true)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-muted"
              >
                <RefreshCwIcon className="size-3.5" />
                Retry
              </button>
              <button
                onClick={handleCopyErrors}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-muted"
                title="Copy errors to clipboard"
              >
                {copiedError ? (
                  <CheckIcon className="size-3.5 text-emerald-500" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {copiedError ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (!pdfData) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <FileTextIcon className="mb-4 size-16 text-muted-foreground/50" />
          <h2 className="mb-2 font-medium text-lg text-muted-foreground">
            PDF Preview
          </h2>
          <p className="mb-4 text-center text-muted-foreground text-sm">
            Press Cmd+Enter to compile your document
          </p>
          {isTexActive && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => handleCompile(true)}
            >
              <RefreshCwIcon className="size-3.5" />
              Compile
            </Button>
          )}
        </div>
      );
    }
    if (pdfError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">
            PDF Load Error
          </h2>
          <p className="max-w-md text-center text-muted-foreground text-sm">
            {pdfError}
          </p>
        </div>
      );
    }

    // Keep-alive rendering: one PdfViewer per root file, toggle via CSS.
    // Use visibility:hidden + absolute positioning instead of display:none
    // so that the browser preserves scrollTop on the overflow container.
    return (
      <div className="relative flex min-h-0 flex-1">
        {aliveOrder.map((rootId) => {
          const data = getPdfBytes(rootId);
          if (!data) return null;
          const isActive = rootId === currentRootFileId;
          return (
            <ErrorBoundary
              key={rootId}
              fallback={
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 p-8">
                  <AlertCircleIcon className="size-10 text-destructive" />
                  <p className="text-muted-foreground text-sm">
                    PDF viewer crashed. Try recompiling.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => handleCompile(true)}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Recompile
                  </Button>
                </div>
              }
            >
              <div
                className={
                  isActive
                    ? "absolute inset-0 flex flex-col"
                    : "pointer-events-none invisible absolute inset-0 flex flex-col"
                }
              >
                <PdfViewer
                  data={data}
                  scale={scale}
                  rootFileId={rootId}
                  isActive={isActive}
                  darkMode={pdfDarkMode}
                  onError={isActive ? setPdfError : undefined}
                  onLoadSuccess={isActive ? handleLoadSuccess : undefined}
                  onScaleChange={isActive ? handleScaleChange : undefined}
                  onViewerActivity={isActive ? bumpPreviewPill : undefined}
                  onTextClick={isActive ? handleTextClick : undefined}
                  onSynctexClick={isActive ? handleSynctexClick : undefined}
                  forwardPulse={
                    isActive && activeForwardPulse
                      ? {
                          page: activeForwardPulse.page,
                          x: activeForwardPulse.x,
                          y: activeForwardPulse.y,
                          width: activeForwardPulse.width,
                          height: activeForwardPulse.height,
                        }
                      : null
                  }
                  onTextSelect={isActive ? handleTextSelect : undefined}
                  onFirstPageSize={
                    isActive
                      ? (w, h) => setFirstPageSize({ width: w, height: h })
                      : undefined
                  }
                  onContainerResize={
                    isActive
                      ? (w, h) => setContainerSize({ width: w, height: h })
                      : undefined
                  }
                  onCurrentPageChange={
                    isActive ? handleCurrentPageChange : undefined
                  }
                  scrollToPageRef={isActive ? scrollToPageRef : undefined}
                  captureMode={isActive ? captureMode : false}
                  onCapture={isActive ? handleCapture : undefined}
                  onCancelCapture={
                    isActive ? () => setCaptureMode(false) : undefined
                  }
                />
              </div>
            </ErrorBoundary>
          );
        })}
      </div>
    );
  };

  return (
    <div
      ref={previewContainerRef}
      className="@container/pv relative flex h-full flex-col bg-muted/50"
    >
      <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] shrink-0 min-w-0 items-center border-border border-b bg-background">
        <div className="scrollbar-none flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto px-2">
          <ToolbarGroup className="shrink-0 bg-muted/40">
            <Select
              value={compilerBackend}
              onValueChange={(v) =>
                setCompilerBackend(v as "tectonic" | "texlive")
              }
            >
              <SelectTrigger
                size="sm"
                className="h-7! @[44rem]/pv:w-[8rem] w-[6.25rem] border-0 bg-transparent text-xs shadow-none hover:bg-accent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tectonic">Tectonic</SelectItem>
                <SelectItem value="texlive">TeXLive</SelectItem>
              </SelectContent>
            </Select>
          </ToolbarGroup>
          {currentCompileRoot && (
            <ToolbarGroup className="shrink-0 bg-muted/40">
              <div className="flex items-center gap-1.5 px-1">
                <span className="hidden @[40rem]/pv:flex items-center gap-1 px-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  <TargetIcon className="size-3" />
                  Preview
                </span>
                {compileRoots.length > 1 ? (
                  <Select
                    value={
                      previewTargetPinned
                        ? currentRootFileId
                        : FOLLOW_EDITOR_COMPILE_ROOT
                    }
                    onValueChange={(rootId) => {
                      if (!projectRoot) return;
                      if (rootId === FOLLOW_EDITOR_COMPILE_ROOT) {
                        clearCompileRootPreference(projectRoot);
                        const editorRoot = resolveTexRoot(activeFileId, files);
                        useDocumentStore.getState().setPreviewRoot(editorRoot);
                        return;
                      }
                      setCompileRootPreference(projectRoot, rootId);
                      useDocumentStore.getState().setPreviewRoot(rootId);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-8! @[40rem]/pv:w-[17rem] w-[13rem] max-w-[20rem] border-0 bg-transparent px-2 shadow-none hover:bg-accent"
                      title="Compile / preview target"
                    >
                      <SelectValue asChild>
                        {previewTargetPinned && currentCompileRoot ? (
                          <CompilePreviewTargetTrigger
                            root={currentCompileRoot}
                            hasError={currentCompileRootHasError}
                          />
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                            <CompileRootIcon kind="main" />
                            <div className="min-w-0 flex-1 truncate text-sm leading-none">
                              <span className="font-medium text-foreground">
                                Follow editor
                              </span>
                              {currentCompileRoot && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {currentCompileRoot.label}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      align="start"
                      className="min-w-[var(--radix-select-trigger-width)] max-w-[24rem]"
                    >
                      <SelectGroup>
                        <SelectLabel>Compile &amp; preview target</SelectLabel>
                        <SelectItem
                          value={FOLLOW_EDITOR_COMPILE_ROOT}
                          className="py-2"
                        >
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="font-medium text-sm">
                              Follow active editor
                            </span>
                            <span className="text-muted-foreground text-xs">
                              Preview updates when you switch .tex files
                            </span>
                          </div>
                        </SelectItem>
                        {compileRoots.map((root) => {
                          const hasError = Boolean(
                            compileErrorCache.get(root.rootId),
                          );
                          return (
                            <SelectItem
                              key={root.rootId}
                              value={root.rootId}
                              className="py-2"
                            >
                              <CompilePreviewTargetItem
                                root={root}
                                hasError={hasError}
                              />
                            </SelectItem>
                          );
                        })}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <div
                    className="flex h-8 min-w-0 items-center px-2"
                    title="Compile / preview target"
                  >
                    <CompilePreviewTargetTrigger
                      root={currentCompileRoot}
                      hasError={currentCompileRootHasError}
                    />
                  </div>
                )}
              </div>
            </ToolbarGroup>
          )}
          <ToolbarGroup className="shrink-0 bg-muted/40">
            <Button
              variant={autoCompile ? "default" : "ghost"}
              size="sm"
              className="h-7 gap-1.5 @[42rem]/pv:px-2.5 px-2 text-xs"
              onClick={() => setAutoCompile(!autoCompile)}
              aria-pressed={autoCompile}
              title={
                autoCompile
                  ? "Auto-compile on (recompiles after edits)"
                  : "Auto-compile off"
              }
            >
              <ZapIcon className="size-3.5" />
              <span className="@[42rem]/pv:inline hidden">Auto</span>
            </Button>
          </ToolbarGroup>
          {(() => {
            // One stable compile control that reflects state in place instead
            // of swapping four separate blocks in and out (which shifted the
            // toolbar layout). Hidden only when idle with nothing to compile.
            const busy = isSaving || isCompiling;
            const hasError = !busy && !!compileError;
            if (!busy && !hasError && !isTexActive) return null;
            const label = isSaving
              ? "Saving…"
              : isCompiling
                ? "Compiling…"
                : hasError
                  ? "Retry"
                  : pdfData
                    ? "Recompile"
                    : "Compile";
            return (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 shrink-0 gap-1.5 @[42rem]/pv:px-2.5 px-2 text-xs",
                  hasError && "text-destructive hover:text-destructive",
                )}
                onClick={() => handleCompile(true)}
                disabled={busy || !isTexActive}
                title={
                  busy
                    ? label
                    : hasError
                      ? "Retry compile"
                      : `${label} (${COMPILE_HINT})`
                }
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
                <span className="@[38rem]/pv:inline hidden">{label}</span>
              </Button>
            );
          })()}

          <div
            className="mx-0.5 h-5 w-px shrink-0 bg-border/60 @[48rem]/pv:block hidden"
            aria-hidden
          />

          {pdfData && (
            <>
              <span
                className="@[52rem]/pv:inline hidden shrink-0 text-[10px] text-muted-foreground"
                title={`${SYNCTEX_HINT} or double-click PDF → source · ${IS_MAC ? "⌘⇧J" : "Ctrl+Shift+J"} source → PDF`}
              >
                {SYNCTEX_HINT} → source · {IS_MAC ? "⌘⇧J" : "Ctrl+Shift+J"} →
                PDF
              </span>

              <Button
                variant={pdfDarkMode ? "default" : "ghost"}
                size="icon"
                className="size-7 shrink-0"
                onClick={() => setPdfDarkMode(!pdfDarkMode)}
                aria-pressed={pdfDarkMode}
                title={
                  pdfDarkMode
                    ? "PDF dark mode on (invert page colors)"
                    : "PDF dark mode off"
                }
              >
                <MoonIcon className="size-3.5" />
              </Button>

              {/* Highlighter color picker */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative size-7 shrink-0"
                    title="Highlight color (select text, then choose Highlight)"
                  >
                    <HighlighterIcon
                      className="size-3.5"
                      style={{ color: getHighlightColor(activeColorId).css }}
                    />
                    {highlightCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 font-medium text-[9px] text-primary-foreground tabular-nums">
                        {highlightCount}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-48 p-2">
                  <div className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">
                    Highlight color
                  </div>
                  <div className="flex items-center gap-1.5 px-1">
                    {HIGHLIGHT_COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setActiveColor(c.id)}
                        className={cn(
                          "size-7 rounded-full border transition-transform hover:scale-110",
                          activeColorId === c.id
                            ? "border-foreground ring-2 ring-ring/40"
                            : "border-border",
                        )}
                        style={{ backgroundColor: c.css }}
                        title={c.label}
                        aria-label={c.label}
                        aria-pressed={activeColorId === c.id}
                      />
                    ))}
                  </div>
                  <p className="mt-2 px-1 text-[11px] text-muted-foreground leading-snug">
                    Select text, then click{" "}
                    <span className="font-medium">Highlight</span> or press{" "}
                    <span className="font-medium">
                      {IS_MAC ? "⇧⌘H" : "Ctrl+Shift+H"}
                    </span>
                    . Add notes per highlight; Export saves them into the PDF.
                  </p>
                  {highlightCount > 0 && currentRootFileId && (
                    <button
                      type="button"
                      onClick={() => clearHighlights(currentRootFileId)}
                      className="mt-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-destructive text-xs transition-colors hover:bg-destructive/10"
                    >
                      <Trash2Icon className="size-3.5" />
                      Clear {highlightCount}{" "}
                      {highlightCount === 1 ? "highlight" : "highlights"}
                    </button>
                  )}
                </PopoverContent>
              </Popover>

              {/* Capture mode */}
              <Button
                variant={captureMode ? "default" : "secondary"}
                size="sm"
                className={`h-7 shrink-0 gap-1.5 @[56rem]/pv:px-2.5 px-2 text-xs ${
                  captureMode
                    ? "ring-2 ring-primary/30"
                    : "bg-foreground text-background hover:bg-foreground/90"
                }`}
                onClick={() => setCaptureMode(!captureMode)}
                title={`Capture & Ask (${CAPTURE_HINT})`}
              >
                <CrosshairIcon className="size-3.5 shrink-0" />
                <span className="@[56rem]/pv:inline hidden">Capture & Ask</span>
                <kbd className="pointer-events-none ml-0.5 @[64rem]/pv:inline hidden rounded border border-background/30 bg-background/20 px-1 py-0.5 font-medium text-[10px] text-background leading-none">
                  {CAPTURE_HINT}
                </kbd>
              </Button>

              {/* Export */}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={handleExport}
                disabled={isExporting}
                title={
                  highlightCount > 0
                    ? `Export PDF with ${highlightCount} ${
                        highlightCount === 1 ? "highlight" : "highlights"
                      }`
                    : "Export PDF"
                }
              >
                {isExporting ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3.5" />
                )}
              </Button>

              {/* AI summarize (page / document) */}
              {aiSummarize && canUseAiAssist() && (
                <Popover
                  open={summaryOpen}
                  onOpenChange={(open) => {
                    setSummaryOpen(open);
                    if (!open) {
                      // Cancel any in-flight summarize and clear pending state.
                      summaryRequestRef.current++;
                      setSummarizing(false);
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 gap-1.5 @[56rem]/pv:px-2.5 px-2 text-xs"
                      onClick={() => {
                        // Default to summarizing the current page on open.
                        if (!summaryOpen) void runSummarize("page");
                      }}
                      title="Summarize page or document with AI"
                    >
                      {summarizing ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <SparklesIcon className="size-3.5" />
                      )}
                      <span className="@[56rem]/pv:inline hidden">
                        Summarize
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80 p-3">
                    <div className="mb-2 flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                      <SparklesIcon className="size-3.5" />
                      AI summary
                    </div>
                    <div className="mb-2 flex items-center gap-1.5">
                      <Button
                        variant={
                          summaryScope === "page" ? "default" : "outline"
                        }
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        disabled={summarizing}
                        onClick={() => void runSummarize("page")}
                      >
                        This page
                      </Button>
                      <Button
                        variant={
                          summaryScope === "document" ? "default" : "outline"
                        }
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        disabled={summarizing}
                        onClick={() => void runSummarize("document")}
                      >
                        Whole document
                      </Button>
                    </div>
                    <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/30 p-2.5 text-foreground text-sm">
                      {summarizing ? (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2Icon className="size-3.5 animate-spin" />
                          Summarizing
                          {summaryScope === "document"
                            ? " document…"
                            : " page…"}
                        </div>
                      ) : pageSummary ? (
                        <div className="whitespace-pre-wrap">{pageSummary}</div>
                      ) : (
                        <div className="text-muted-foreground">
                          No summary yet.
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                title="History"
              >
                <HistoryIcon className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
              <HistoryPanel maxHeight="max-h-[32rem]" />
            </PopoverContent>
          </Popover>
        </div>
        <div
          data-tauri-drag-region
          className="min-w-8 shrink-0 self-stretch"
          aria-hidden
        />
      </div>
      {renderContent()}
      {/* Page + zoom floating pill */}
      {pdfData && !captureMode && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center">
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border/60 bg-background/90 py-1.5 pr-2 pl-1.5 shadow-lg backdrop-blur-sm transition-opacity duration-500 ease-in-out",
              previewPillVisible
                ? "pointer-events-auto opacity-100"
                : "opacity-0",
            )}
            onMouseEnter={bumpPreviewPill}
            onFocusCapture={bumpPreviewPill}
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-full"
              onClick={() => {
                goToPage(currentPage - 1);
                bumpPreviewPill();
              }}
              disabled={currentPage <= 1}
              title="Previous page"
            >
              <ChevronUpIcon className="size-4" />
            </Button>
            <div className="flex shrink-0 items-center gap-1 px-1 text-sm tabular-nums">
              {isEditingPage ? (
                <input
                  type="text"
                  inputMode="numeric"
                  className="h-8 w-10 rounded-full border border-border bg-background text-center text-foreground text-sm outline-none focus:ring-1 focus:ring-ring"
                  value={pageInputValue}
                  onChange={(e) => setPageInputValue(e.target.value)}
                  onBlur={handlePageInputCommit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handlePageInputCommit();
                    if (e.key === "Escape") {
                      setIsEditingPage(false);
                      setPageInputValue(String(currentPage));
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-foreground hover:bg-muted"
                  onClick={() => {
                    setIsEditingPage(true);
                    setPageInputValue(String(currentPage));
                    bumpPreviewPill();
                  }}
                  title="Click to jump to page"
                >
                  {currentPage}
                </button>
              )}
              <span className="text-muted-foreground/70">/</span>
              <span className="flex h-8 min-w-8 items-center justify-center text-muted-foreground">
                {numPages}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-full"
              onClick={() => {
                goToPage(currentPage + 1);
                bumpPreviewPill();
              }}
              disabled={currentPage >= numPages}
              title="Next page"
            >
              <ChevronDownIcon className="size-4" />
            </Button>

            <div className="mx-1 h-7 w-px shrink-0 bg-border/60" aria-hidden />

            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-full"
              onClick={zoomOut}
              disabled={scale <= 0.25}
              title="Zoom out"
            >
              <MinusIcon className="size-4" />
            </Button>
            <Select
              value={fitMode ?? scale.toString()}
              onValueChange={(v) => {
                if (v === "fit-width" || v === "fit-height") {
                  setFitMode(v);
                } else {
                  setFitMode(null);
                  setScale(Number(v));
                }
                bumpPreviewPill();
              }}
            >
              <SelectTrigger
                size="sm"
                className="h-9! w-[6.25rem] shrink-0 rounded-full border-0 bg-transparent text-sm shadow-none hover:bg-accent"
              >
                <SelectValue>
                  {fitMode === "fit-width"
                    ? "Fit width"
                    : fitMode === "fit-height"
                      ? "Fit height"
                      : `${Math.round(scale * 100)}%`}
                </SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" align="center">
                <SelectItem value="fit-width">Fit to width</SelectItem>
                <SelectItem value="fit-height">Fit to height</SelectItem>
                <SelectSeparator />
                {ZOOM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-full"
              onClick={zoomIn}
              disabled={scale >= 4}
              title="Zoom in"
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>
        </div>
      )}
      {/* PDF selection toolbar */}
      {pdfToolbarPosition && pdfSelection && (
        <SelectionToolbar
          position={pdfToolbarPosition}
          contextLabel={pdfContextLabel}
          actions={pdfToolbarActions}
          onSendPrompt={handlePdfToolbarSendPrompt}
          onAction={handlePdfToolbarAction}
          onDismiss={handlePdfToolbarDismiss}
        />
      )}
      {/* Capture mode floating banner */}
      {captureMode && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <CrosshairIcon className="size-3.5 text-primary" />
            <span className="text-foreground text-xs">
              Drag to select a region
            </span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
              ESC
            </kbd>
            <span className="text-[10px] text-muted-foreground">or</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
              {CAPTURE_HINT}
            </kbd>
            <span className="text-[10px] text-muted-foreground">to cancel</span>
          </div>
        </div>
      )}
      {/* AI caption callout for the most recently captured region */}
      {capturedRegion && aiVisionCaption && canUseAiAssist() && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
          <div className="pointer-events-auto w-full max-w-md rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur-sm">
            <div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              <ImageIcon className="size-3.5" />
              AI caption
              <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">
                page {capturedRegion.pageNumber}
              </span>
              <button
                type="button"
                onClick={dismissCaption}
                className="-mr-1 ml-auto flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Dismiss"
                aria-label="Dismiss caption"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            {caption ? (
              <>
                <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2.5 text-foreground text-sm">
                  {caption}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => void handleCopyCaption()}
                  >
                    {captionCopied ? (
                      <CheckIcon className="size-3.5 text-emerald-500" />
                    ) : (
                      <CopyIcon className="size-3.5" />
                    )}
                    {captionCopied ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={captioning}
                    onClick={() => void runCaption()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Regenerate
                  </Button>
                </div>
              </>
            ) : (
              <div className="mt-2">
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  disabled={captioning}
                  onClick={() => void runCaption()}
                >
                  {captioning ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <SparklesIcon className="size-3.5" />
                  )}
                  {captioning ? "Captioning…" : "Caption with AI"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
