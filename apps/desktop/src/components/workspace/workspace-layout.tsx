import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Panel,
  PanelGroup,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { RichLatexEditor } from "./editor/rich/rich-latex-editor";
import { ArtifactPreview } from "./preview/artifact-preview";
import { WorkspacePanelResizeHandle } from "./panel-resize-handle";
import { WorkspaceLoadingSkeleton } from "./workspace-loading-skeleton";
import { WorkspaceBannerBar } from "./workspace-banner-bar";
import { CommandPalette } from "@/components/command-palette";
import { ClaudeChatDrawer } from "@/components/claude-chat/claude-chat-drawer";
import { EditorTabStrip } from "./editor-tab-strip";
import { ProblemsDock } from "./problems-dock";
import { useDocumentStore } from "@/stores/document-store";
import { useEditorViewModeStore } from "@/stores/editor-view-mode-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useWorkspaceBannerStore } from "@/stores/workspace-banner-store";
import { useCompileRequest } from "@/hooks/use-compile-request";
import { buildCompileFixPrompt } from "@/lib/latex-compiler";
import { canUseAiAssist } from "@/lib/ai-assist";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { dispatchOpenSettings } from "@/lib/home-flow-events";
import {
  CHAT_DRAWER_OPEN_EVENT,
  CHAT_DRAWER_TOGGLE_EVENT,
} from "@/lib/chat-drawer-events";
import {
  getAllTypstDiagnostics,
  typstDiagnosticsRegistry,
} from "@/lib/typst-diagnostics";
import {
  FolderIcon,
  ListTreeIcon,
  BriefcaseIcon,
  AlertCircleIcon,
  MessageCircleIcon,
  SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ActivityView =
  | "explorer"
  | "outline"
  | "resume-organizer"
  | "problems";

export function allocatePanels(sidebarPct: number, problemsPct: number) {
  const clampedSidebar = Math.min(Math.max(sidebarPct, 15), 30);
  const clampedProblems = Math.min(Math.max(problemsPct, 10), 40);
  const mainEditorPct = 100 - clampedSidebar - clampedProblems;
  return {
    clampedSidebar,
    clampedProblems,
    mainEditorPct,
    total: clampedSidebar + clampedProblems + mainEditorPct,
  };
}

const SIDEBAR_DEFAULT_SIZE = 15;
const EDITOR_PREVIEW_DEFAULT_SIZE = 42.5;
const SIDEBAR_MIN_SIZE = 10;
const SIDEBAR_COLLAPSED_WIDTH_PX = 48;
const SIDEBAR_COLLAPSED_SIZE_FALLBACK = 8;
const SIDEBAR_ANIMATION_MS = 280;

function easeInOutSmooth(progress: number) {
  return progress * progress * (3 - 2 * progress);
}

export function WorkspaceLayout() {
  useCompileRequest();
  const initialized = useDocumentStore((s) => s.initialized);
  // Rich (Word-like) editing applies to .tex files only.
  const activeIsTex = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.type === "tex";
  });
  const editorViewMode = useEditorViewModeStore((s) => s.mode);
  const compileError = useDocumentStore((s) => s.compileError);
  const aiCompileAssist = useSettingsStore((s) => s.aiCompileAssist);
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const previewVisible = usePreviewStore((s) => s.visible);
  const setPreviewVisible = usePreviewStore((s) => s.setVisible);
  const showWorkspaceBanner = useWorkspaceBannerStore((s) => s.show);
  const dismissWorkspaceBanner = useWorkspaceBannerStore((s) => s.dismiss);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const editorPanelRef = useRef<ImperativePanelHandle>(null);
  const previewPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarAnimationFrameRef = useRef<number | null>(null);
  const sidebarAnimatingRef = useRef(false);
  const collapsedSizeRafRef = useRef<number | null>(null);
  const expandedSidebarSizeRef = useRef(SIDEBAR_DEFAULT_SIZE);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarCollapsedSize, setSidebarCollapsedSize] = useState(
    SIDEBAR_COLLAPSED_SIZE_FALLBACK,
  );
  const [codeVisible, setCodeVisible] = useState(true);
  const assistantPanelRef = useRef<ImperativePanelHandle>(null);
  const [activePanel, setActivePanel] = useState<ActivityView | null>(
    "explorer",
  );
  const [problemsDockOpen, setProblemsDockOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [diagnosticCount, setDiagnosticCount] = useState(0);

  const anyStreaming = useClaudeChatStore((s) =>
    s.tabs.some((t) => t.isStreaming),
  );

  useEffect(() => {
    const updateDiags = () => {
      const diags = getAllTypstDiagnostics();
      setDiagnosticCount(diags.length);
    };
    updateDiags();
    return typstDiagnosticsRegistry.subscribe(updateDiags);
  }, []);

  useEffect(() => {
    const onToggle = () => setAssistantOpen((prev) => !prev);
    const onOpen = () => setAssistantOpen(true);
    window.addEventListener(CHAT_DRAWER_TOGGLE_EVENT, onToggle);
    window.addEventListener(CHAT_DRAWER_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(CHAT_DRAWER_TOGGLE_EVENT, onToggle);
      window.removeEventListener(CHAT_DRAWER_OPEN_EVENT, onOpen);
    };
  }, []);

  const togglePanel = useCallback(
    (panel: ActivityView) => {
      if (panel === "problems") {
        setProblemsDockOpen((prev) => !prev);
        setActivePanel((curr) => (curr === "problems" ? null : "problems"));
        return;
      }

      if (activePanel === panel) {
        setActivePanel(null);
        setSidebarCollapsed(true);
      } else {
        setActivePanel(panel);
        setSidebarCollapsed(false);
      }
    },
    [activePanel],
  );

  const getCollapsedSidebarSize = useCallback(() => {
    const workspaceWidth =
      workspaceRef.current?.clientWidth ?? window.innerWidth;
    if (!workspaceWidth) return SIDEBAR_COLLAPSED_SIZE_FALLBACK;
    return Math.min(
      18,
      Math.max(2.5, (SIDEBAR_COLLAPSED_WIDTH_PX / workspaceWidth) * 100),
    );
  }, []);

  const animateSidebarToSize = useCallback((targetSize: number) => {
    const sidebarPanel = sidebarPanelRef.current;
    if (!sidebarPanel) return;

    if (sidebarAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarAnimationFrameRef.current);
    }

    const startSize = sidebarPanel.getSize();
    const sizeDelta = targetSize - startSize;
    const startedAt = performance.now();
    sidebarAnimatingRef.current = true;

    const step = (now: number) => {
      const progress = Math.min((now - startedAt) / SIDEBAR_ANIMATION_MS, 1);
      const nextSize = startSize + sizeDelta * easeInOutSmooth(progress);

      sidebarPanel.resize(nextSize);

      if (progress < 1) {
        sidebarAnimationFrameRef.current = window.requestAnimationFrame(step);
        return;
      }

      sidebarPanel.resize(targetSize);
      sidebarAnimationFrameRef.current = null;
      sidebarAnimatingRef.current = false;
    };

    sidebarAnimationFrameRef.current = window.requestAnimationFrame(step);
  }, []);

  const setSidebarPaneCollapsed = useCallback(
    (nextCollapsed: boolean) => {
      const sidebarPanel = sidebarPanelRef.current;
      if (!sidebarPanel) return;

      if (!nextCollapsed) {
        setSidebarCollapsed(false);
        animateSidebarToSize(expandedSidebarSizeRef.current);
      } else {
        const collapsedSize = getCollapsedSidebarSize();
        const currentSize = sidebarPanel.getSize();
        if (currentSize >= SIDEBAR_MIN_SIZE) {
          expandedSidebarSizeRef.current = currentSize;
        }
        setSidebarCollapsedSize(collapsedSize);
        setSidebarCollapsed(true);
        animateSidebarToSize(collapsedSize);
      }
    },
    [animateSidebarToSize, getCollapsedSidebarSize],
  );

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarPaneCollapsed(!sidebarCollapsed);
  }, [setSidebarPaneCollapsed, sidebarCollapsed]);

  const resetSidebarSize = useCallback(() => {
    if (sidebarCollapsed) {
      setSidebarPaneCollapsed(false);
    }
    sidebarPanelRef.current?.resize(SIDEBAR_DEFAULT_SIZE);
    expandedSidebarSizeRef.current = SIDEBAR_DEFAULT_SIZE;
  }, [setSidebarPaneCollapsed, sidebarCollapsed]);

  const resetEditorPreviewSplit = useCallback(() => {
    editorPanelRef.current?.resize(EDITOR_PREVIEW_DEFAULT_SIZE);
    previewPanelRef.current?.resize(EDITOR_PREVIEW_DEFAULT_SIZE);
  }, []);

  const setCodePaneVisible = useCallback(
    (visible: boolean) => {
      if (!visible && !previewVisible) {
        setPreviewVisible(true);
      }
      setCodeVisible(visible);
    },
    [previewVisible, setPreviewVisible],
  );

  const setPdfPaneVisible = useCallback(
    (visible: boolean) => {
      if (!visible && !codeVisible) {
        setCodeVisible(true);
      }
      setPreviewVisible(visible);
    },
    [codeVisible, setPreviewVisible],
  );

  // Cmd+\ / Ctrl+\ toggles the PDF preview pane.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setPdfPaneVisible(!previewVisible);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previewVisible, setPdfPaneVisible]);

  // Surface compile failures in a dismissable banner (persists across panes).
  useEffect(() => {
    const dedupeKey = "compile-error";
    if (compileError) {
      const firstLine =
        compileError
          .split(/\s*[!\n]\s*/)
          .map((s) => s.trim())
          .find((s) => s.length > 0 && s !== "Compilation failed") ??
        "Your document failed to compile.";
      const message =
        firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
      const existing = useWorkspaceBannerStore
        .getState()
        .banners.find((b) => b.dedupeKey === dedupeKey);
      if (
        existing &&
        existing.title === "Compilation failed" &&
        existing.message === message
      ) {
        return;
      }
      const fixWithAiAvailable =
        (aiCompileAssist || nativeAgentEnabled) && canUseAiAssist();
      showWorkspaceBanner({
        kind: "error",
        dedupeKey,
        title: "Compilation failed",
        message,
        ...(fixWithAiAvailable
          ? {
              secondaryActionLabel: "Fix with AI",
              onSecondaryAction: () => {
                const prompt = buildCompileFixPrompt();
                if (prompt)
                  void useClaudeChatStore.getState().sendPrompt(prompt);
              },
            }
          : {}),
        actionLabel: "Show preview",
        onAction: () => setPreviewVisible(true),
      });
      return;
    }

    const banner = useWorkspaceBannerStore
      .getState()
      .banners.find((b) => b.dedupeKey === dedupeKey);
    if (banner) dismissWorkspaceBanner(banner.id);
  }, [
    aiCompileAssist,
    compileError,
    dismissWorkspaceBanner,
    nativeAgentEnabled,
    setPreviewVisible,
    showWorkspaceBanner,
  ]);

  useEffect(() => {
    return () => {
      if (sidebarAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarAnimationFrameRef.current);
      }
      if (collapsedSizeRafRef.current !== null) {
        window.cancelAnimationFrame(collapsedSizeRafRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const applyCollapsedSize = () => {
      const nextSize = getCollapsedSidebarSize();
      setSidebarCollapsedSize((prev) =>
        Math.abs(prev - nextSize) < 0.05 ? prev : nextSize,
      );

      if (sidebarCollapsed && !sidebarAnimatingRef.current) {
        const currentSize = sidebarPanelRef.current?.getSize();
        if (
          currentSize === undefined ||
          Math.abs(currentSize - nextSize) >= 0.05
        ) {
          sidebarPanelRef.current?.resize(nextSize);
        }
      }
    };

    const scheduleCollapsedSizeUpdate = () => {
      if (collapsedSizeRafRef.current !== null) return;
      collapsedSizeRafRef.current = window.requestAnimationFrame(() => {
        collapsedSizeRafRef.current = null;
        applyCollapsedSize();
      });
    };

    applyCollapsedSize();

    const workspaceElement = workspaceRef.current;
    if (!workspaceElement) return;

    const resizeObserver = new ResizeObserver(scheduleCollapsedSizeUpdate);
    resizeObserver.observe(workspaceElement);

    return () => {
      resizeObserver.disconnect();
      if (collapsedSizeRafRef.current !== null) {
        window.cancelAnimationFrame(collapsedSizeRafRef.current);
        collapsedSizeRafRef.current = null;
      }
    };
  }, [getCollapsedSidebarSize, sidebarCollapsed]);

  if (!initialized) {
    return <WorkspaceLoadingSkeleton />;
  }

  return (
    <div ref={workspaceRef} className="flex h-full flex-col">
      <WorkspaceBannerBar />
      <div className="flex min-h-0 flex-1 flex-row">
        {/* Activity Bar Rail */}
        <div
          role="toolbar"
          aria-label="Activity Bar"
          className="z-20 flex w-12 shrink-0 select-none flex-col items-center justify-between border-border border-r bg-muted/30 py-2"
        >
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              aria-label="Files Explorer"
              data-active={activePanel === "explorer" && !sidebarCollapsed}
              onClick={() => togglePanel("explorer")}
              title="Files Explorer"
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md transition-colors",
                activePanel === "explorer" && !sidebarCollapsed
                  ? "border-l-2 border-l-primary bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              <FolderIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Document Outline"
              data-active={activePanel === "outline" && !sidebarCollapsed}
              onClick={() => togglePanel("outline")}
              title="Document Outline"
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md transition-colors",
                activePanel === "outline" && !sidebarCollapsed
                  ? "border-l-2 border-l-primary bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              <ListTreeIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Resume Organizer"
              data-active={
                activePanel === "resume-organizer" && !sidebarCollapsed
              }
              onClick={() => togglePanel("resume-organizer")}
              title="Resume Organizer"
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md transition-colors",
                activePanel === "resume-organizer" && !sidebarCollapsed
                  ? "border-l-2 border-l-primary bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              <BriefcaseIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Problems & Diagnostics"
              data-active={problemsDockOpen}
              onClick={() => togglePanel("problems")}
              title="Problems & Diagnostics"
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md transition-colors",
                problemsDockOpen
                  ? "border-l-2 border-l-primary bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              <AlertCircleIcon className="size-4" />
              {diagnosticCount > 0 && (
                <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-red-500 font-bold text-[9px] text-white">
                  {diagnosticCount > 9 ? "9+" : diagnosticCount}
                </span>
              )}
            </button>
          </div>

          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              aria-label="Toggle AI Assistant"
              data-active={assistantOpen}
              onClick={() => setAssistantOpen((prev) => !prev)}
              title="Toggle AI Assistant"
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md transition-colors",
                assistantOpen
                  ? "border-l-2 border-l-primary bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              <MessageCircleIcon className="size-4" />
              {anyStreaming && (
                <span className="absolute -top-0.5 -right-0.5 flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 opacity-75" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label="Settings"
              onClick={() => dispatchOpenSettings()}
              title="Settings"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
            >
              <SettingsIcon className="size-4" />
            </button>
          </div>
        </div>

        {/* Main Resizable Panel Group */}
        <PanelGroup direction="horizontal" className="min-h-0 flex-1">
          <Panel
            ref={sidebarPanelRef}
            defaultSize={SIDEBAR_DEFAULT_SIZE}
            minSize={SIDEBAR_MIN_SIZE}
            maxSize={25}
            collapsible
            collapsedSize={sidebarCollapsedSize}
            onCollapse={() => setSidebarCollapsed(true)}
            onExpand={() => setSidebarCollapsed(false)}
            onResize={(size) => {
              if (!sidebarAnimatingRef.current && size >= SIDEBAR_MIN_SIZE) {
                expandedSidebarSizeRef.current = size;
              }
            }}
            className="min-w-0 overflow-hidden"
          >
            <Sidebar
              collapsed={sidebarCollapsed}
              onToggleCollapsed={toggleSidebarCollapsed}
              section={
                activePanel === "outline"
                  ? "outline"
                  : activePanel === "resume-organizer"
                    ? "resume-organizer"
                    : "files"
              }
              onSectionChange={(newSection) => {
                if (newSection === "outline") setActivePanel("outline");
                else if (newSection === "resume-organizer")
                  setActivePanel("resume-organizer");
                else if (newSection === "files") setActivePanel("explorer");
                else setActivePanel(null);
              }}
              layoutControls={{
                codeVisible,
                pdfVisible: previewVisible,
                sidebarVisible: !sidebarCollapsed,
                setCodeVisible: setCodePaneVisible,
                setPdfVisible: setPdfPaneVisible,
                setSidebarVisible: (visible) =>
                  setSidebarPaneCollapsed(!visible),
              }}
            />
          </Panel>

          <WorkspacePanelResizeHandle onReset={resetSidebarSize} />

          {codeVisible && (
            <Panel
              ref={editorPanelRef}
              defaultSize={
                previewVisible
                  ? assistantOpen
                    ? 35
                    : EDITOR_PREVIEW_DEFAULT_SIZE
                  : assistantOpen
                    ? 55
                    : 85
              }
              minSize={25}
              className="min-w-0"
            >
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <EditorTabStrip />
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {editorViewMode === "rich" && activeIsTex ? (
                    <RichLatexEditor />
                  ) : (
                    <LatexEditor />
                  )}
                </div>
                <ProblemsDock
                  isOpen={problemsDockOpen}
                  onToggle={() => setProblemsDockOpen(false)}
                />
              </div>
            </Panel>
          )}

          {assistantOpen && (
            <>
              <WorkspacePanelResizeHandle />
              <Panel
                ref={assistantPanelRef}
                defaultSize={30}
                minSize={20}
                maxSize={45}
                className="min-w-0"
              >
                <ClaudeChatDrawer
                  isDocked
                  onClose={() => setAssistantOpen(false)}
                />
              </Panel>
            </>
          )}

          {codeVisible && previewVisible && (
            <WorkspacePanelResizeHandle onReset={resetEditorPreviewSplit} />
          )}

          {previewVisible && (
            <Panel
              ref={previewPanelRef}
              defaultSize={codeVisible ? EDITOR_PREVIEW_DEFAULT_SIZE : 85}
              minSize={25}
              className="min-w-0"
            >
              <ArtifactPreview />
            </Panel>
          )}
        </PanelGroup>
      </div>
      <CommandPalette />
    </div>
  );
}
