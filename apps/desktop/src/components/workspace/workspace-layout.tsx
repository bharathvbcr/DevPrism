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
import { PdfPreview } from "./preview/pdf-preview";
import { WorkspacePanelResizeHandle } from "./panel-resize-handle";
import { WorkspaceLoadingSkeleton } from "./workspace-loading-skeleton";
import { WorkspaceBannerBar } from "./workspace-banner-bar";
import { CommandPalette } from "@/components/command-palette";
import { useDocumentStore } from "@/stores/document-store";
import { useEditorViewModeStore } from "@/stores/editor-view-mode-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useWorkspaceBannerStore } from "@/stores/workspace-banner-store";
import { useCompileRequest } from "@/hooks/use-compile-request";
import { buildCompileFixPrompt } from "@/lib/latex-compiler";
import { canUseAiAssist } from "@/lib/ai-assist";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

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
  const expandedSidebarSizeRef = useRef(SIDEBAR_DEFAULT_SIZE);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarCollapsedSize, setSidebarCollapsedSize] = useState(
    SIDEBAR_COLLAPSED_SIZE_FALLBACK,
  );
  const [codeVisible, setCodeVisible] = useState(true);

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
          .split(/\s*!\s*/)
          .map((s) => s.trim())
          .find((s) => s.length > 0 && s !== "Compilation failed") ??
        "Your document failed to compile.";
      const fixWithAiAvailable =
        (aiCompileAssist || nativeAgentEnabled) && canUseAiAssist();
      showWorkspaceBanner({
        kind: "error",
        dedupeKey,
        title: "Compilation failed",
        message:
          firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine,
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
    previewVisible,
    setPreviewVisible,
    showWorkspaceBanner,
  ]);

  useEffect(() => {
    return () => {
      if (sidebarAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarAnimationFrameRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const updateCollapsedSize = () => {
      const nextSize = getCollapsedSidebarSize();
      setSidebarCollapsedSize(nextSize);

      if (sidebarCollapsed && !sidebarAnimatingRef.current) {
        sidebarPanelRef.current?.resize(nextSize);
      }
    };

    updateCollapsedSize();

    const workspaceElement = workspaceRef.current;
    if (!workspaceElement) return;

    const resizeObserver = new ResizeObserver(updateCollapsedSize);
    resizeObserver.observe(workspaceElement);

    return () => resizeObserver.disconnect();
  }, [getCollapsedSidebarSize, sidebarCollapsed]);

  if (!initialized) {
    return <WorkspaceLoadingSkeleton />;
  }

  return (
    <div ref={workspaceRef} className="flex h-full flex-col">
      <WorkspaceBannerBar />
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
            layoutControls={{
              codeVisible,
              pdfVisible: previewVisible,
              sidebarVisible: !sidebarCollapsed,
              setCodeVisible: setCodePaneVisible,
              setPdfVisible: setPdfPaneVisible,
              setSidebarVisible: (visible) => setSidebarPaneCollapsed(!visible),
            }}
          />
        </Panel>

        <WorkspacePanelResizeHandle onReset={resetSidebarSize} />

        {codeVisible && (
          <Panel
            ref={editorPanelRef}
            defaultSize={previewVisible ? EDITOR_PREVIEW_DEFAULT_SIZE : 85}
            minSize={25}
            className="min-w-0"
          >
            {editorViewMode === "rich" && activeIsTex ? (
              <RichLatexEditor />
            ) : (
              <LatexEditor />
            )}
          </Panel>
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
            <PdfPreview />
          </Panel>
        )}
      </PanelGroup>
      <CommandPalette />
    </div>
  );
}
