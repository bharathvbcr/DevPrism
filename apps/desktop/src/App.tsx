import { ThemeProvider, useTheme } from "next-themes";
import { ErrorBoundary } from "react-error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useUpdater } from "@/hooks/use-updater";
import { toast } from "sonner";

import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  showWorkspaceInfo,
  useWorkspaceBannerStore,
} from "@/stores/workspace-banner-store";
import { useProjectStore } from "@/stores/project-store";
import { ProjectPicker } from "@/components/project-picker";
import { BrowserPreviewBanner } from "@/components/browser-preview-banner";
import { displayProjectPathLabel } from "@/lib/browser-project/fsa-persistence";
import { isTauri } from "@/lib/runtime/is-tauri";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { ErrorFallback } from "@/components/error-fallback";
import { createLogger } from "@/lib/debug/logger";
import { EnvironmentOnboarding } from "@/components/environment-onboarding";
import {
  syncPersonalizationEnabled,
  scheduleIdentityProfileSync,
} from "@/lib/personalization";
import { watchSemanticLayerConfigSync } from "@/lib/semantic-layer-bridge";
import { usePersonalizationStore } from "@/stores/personalization-store";
import { useCareerStore } from "@/stores/career-store";
import { Skeleton } from "@/components/ui/skeleton";
import { OllamaPullBanner } from "@/components/ollama-pull-banner";

const log = createLogger("app");

const LazyDebugPage = lazy(() =>
  import("@/components/debug/debug-page").then((m) => ({
    default: m.DebugPage,
  })),
);

// Deferred so the whole editor/workspace bundle (CodeMirror, PDF, templates)
// is not pulled into the initial ProjectPicker paint.
const WorkspaceLayout = lazy(() =>
  import("@/components/workspace/workspace-layout").then((m) => ({
    default: m.WorkspaceLayout,
  })),
);

const CareerView = lazy(() =>
  import("@/components/career/career-view").then((m) => ({
    default: m.CareerView,
  })),
);

// PDF/mupdf-heavy dialog that is mounted at the root but rarely opened.
const TrackChangesPdfDialog = lazy(() =>
  import("@/components/workspace/track-changes-pdf-dialog").then((m) => ({
    default: m.TrackChangesPdfDialog,
  })),
);

interface ClaudeSessionInfo {
  session_id: string;
  title: string;
  last_modified: number;
}

function NativeWindowThemeBridge() {
  const { resolvedTheme, theme } = useTheme();

  useEffect(() => {
    const syncNativeTheme = () => {
      const isDark =
        document.documentElement.classList.contains("dark") ||
        resolvedTheme === "dark";
      const nativeTheme = isDark ? "dark" : "light";

      document.documentElement.style.colorScheme = nativeTheme;
      if (!isTauri()) return;

      invoke("set_native_window_theme", { theme: nativeTheme })
        .catch((err) => {
          log.warn("Failed to sync native window theme via Rust command", {
            error: String(err),
          });
          return getCurrentWindow().setTheme(nativeTheme);
        })
        .catch((err) => {
          log.warn("Failed to sync native window theme via JS API", {
            error: String(err),
          });
        });
    };

    syncNativeTheme();

    const observer = new MutationObserver(syncNativeTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeQuery.addEventListener("change", syncNativeTheme);

    return () => {
      observer.disconnect();
      systemThemeQuery.removeEventListener("change", syncNativeTheme);
    };
  }, [resolvedTheme, theme]);

  return null;
}

/** Desktop-only: notify when a Tauri updater release is available. */
function UpdateNotifier() {
  const { status, installUpdate } = useUpdater();
  const notifiedVersion = useRef<string | null>(null);

  useEffect(() => {
    if (status.state !== "available") return;
    if (notifiedVersion.current === status.version) return;
    notifiedVersion.current = status.version;
    toast(`Update ${status.version} available`, {
      description: status.notes?.slice(0, 140) || "A new version is ready.",
      action: {
        label: "Install",
        onClick: () => {
          void installUpdate();
        },
      },
      duration: 20_000,
    });
  }, [status, installUpdate]);

  return null;
}

function WorkspaceWithClaude() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const initialized = useDocumentStore((s) => s.initialized);
  const autoResumedProjectRef = useRef<string | null>(null);
  const chatProjectRef = useRef<string | null>(null);

  // Update window title
  useEffect(() => {
    if (!projectRoot) return;
    const recent = useProjectStore
      .getState()
      .recentProjects.find((p) => p.path === projectRoot);
    const label = displayProjectPathLabel(projectRoot, recent?.name);
    if (isTauri()) {
      void getCurrentWindow().setTitle(`${label} - DevPrism`);
    } else {
      document.title = `${label} - DevPrism`;
    }
  }, [projectRoot]);

  useEffect(() => {
    if (chatProjectRef.current === projectRoot) return;
    chatProjectRef.current = projectRoot;
    useClaudeChatStore.getState().resetForProject(projectRoot ?? null);
    useWorkspaceBannerStore.getState().clearAll();
  }, [projectRoot]);

  useEffect(() => {
    if (!initialized || !projectRoot || isTauri()) return;
    showWorkspaceInfo(
      "Preview mode",
      "Editing works in the browser, but PDF compile and native AI require the desktop app.",
      { dedupeKey: "browser-preview-workspace" },
    );
  }, [initialized, projectRoot]);

  // Auto-setup Python venv when project opens
  useEffect(() => {
    if (!initialized || !projectRoot) return;
    const uvStore = useUvSetupStore.getState();
    uvStore
      .checkStatus()
      .then(() => {
        const { status } = useUvSetupStore.getState();
        if (status === "ready") {
          return uvStore.setupVenv(projectRoot);
        }
      })
      .catch((err) => {
        log.error("Failed to setup Python venv", { error: String(err) });
      });
  }, [initialized, projectRoot]);

  // Open the most recent chat when entering a project.
  useEffect(() => {
    if (!projectRoot) {
      autoResumedProjectRef.current = null;
      return;
    }
    if (!initialized) return;
    if (autoResumedProjectRef.current === projectRoot) return;

    const chatState = useClaudeChatStore.getState();
    if (chatState.pendingInitialPrompt) return;

    autoResumedProjectRef.current = projectRoot;
    let cancelled = false;

    invoke<ClaudeSessionInfo[]>("list_claude_sessions", {
      projectPath: projectRoot,
      generateTitles: false,
    })
      .then((sessions) => {
        if (cancelled) return;
        const latest = sessions
          .slice()
          .sort((a, b) => b.last_modified - a.last_modified)[0];

        const current = useClaudeChatStore.getState();
        if (current.pendingInitialPrompt || current.isStreaming) {
          return;
        }

        if (!latest?.session_id) {
          current.newSession();
          return;
        }

        current.resumeSession(latest.session_id, latest.title).catch((err) => {
          log.warn("Failed to auto-resume latest chat session", {
            sessionId: latest.session_id,
            error: String(err),
          });
        });
      })
      .catch((err) => {
        log.warn("Failed to auto-resume latest chat session", {
          error: String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [initialized, projectRoot]);

  // Consume pending initial prompt from project wizard
  useEffect(() => {
    if (!initialized) return;
    // Delay to let ClaudeChatDrawer mount and register event listeners
    const timer = setTimeout(() => {
      const prompt = useClaudeChatStore
        .getState()
        .consumePendingInitialPrompt();
      if (prompt) {
        useClaudeChatStore.getState().sendPrompt(prompt);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [initialized]);

  return (
    <Suspense fallback={<div className="h-full w-full bg-background" />}>
      <WorkspaceLayout />
    </Suspense>
  );
}

export function App({ onReady }: { onReady?: () => void }) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const careerOpen = useCareerStore((s) => s.careerOpen);
  const [showDebug, setShowDebug] = useState(false);

  // Register global keyboard shortcuts (Cmd+S, Cmd+N) at the app level
  useKeyboardShortcuts();

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
    };

    document.addEventListener("contextmenu", preventNativeContextMenu);
    return () => {
      document.removeEventListener("contextmenu", preventNativeContextMenu);
    };
  }, []);

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  useEffect(() => {
    const enabled = usePersonalizationStore.getState().personalizationEnabled;
    void syncPersonalizationEnabled(enabled);
    scheduleIdentityProfileSync(usePersonalizationStore.getState().profile);
  }, []);

  useEffect(() => watchSemanticLayerConfigSync(), []);

  useEffect(() => {
    if (!projectRoot) {
      if (isTauri()) {
        void getCurrentWindow().setTitle("DevPrism");
      } else {
        document.title = "DevPrism";
      }
    }
  }, [projectRoot]);

  // Listen for debug panel toggle (Ctrl+Shift+D)
  useEffect(() => {
    const handler = () => setShowDebug((prev) => !prev);
    window.addEventListener("toggle-debug-panel", handler);
    return () => window.removeEventListener("toggle-debug-panel", handler);
  }, []);

  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <ThemeProvider attribute="class" forcedTheme="dark">
        <TooltipProvider>
          <NativeWindowThemeBridge />
          {isTauri() ? <UpdateNotifier /> : null}
          <BrowserPreviewBanner />
          <OllamaPullBanner />
          {/* Global macOS titlebar drag region — sits above all content */}
          <div
            data-tauri-drag-region
            className="fixed inset-x-0 top-0 z-[9999] h-[var(--titlebar-height)]"
          />
          {careerOpen ? (
            <Suspense
              fallback={<div className="h-full w-full bg-background" />}
            >
              <CareerView />
            </Suspense>
          ) : projectRoot ? (
            <WorkspaceWithClaude />
          ) : (
            <ProjectPicker />
          )}
          <EnvironmentOnboarding />
          {showDebug && (
            <div className="fixed inset-0 z-[9998] flex items-end justify-center">
              <div
                className="absolute inset-0 bg-black/20"
                onClick={() => setShowDebug(false)}
              />
              <div className="relative h-[60vh] w-full border-border border-t bg-background shadow-lg">
                <div className="flex h-8 items-center justify-between border-border border-b bg-muted/50 px-3">
                  <span className="font-medium text-xs">Debug Panel</span>
                  <button
                    className="text-muted-foreground text-xs hover:text-foreground"
                    onClick={() => setShowDebug(false)}
                  >
                    Close (Ctrl+Shift+D)
                  </button>
                </div>
                <div className="h-[calc(60vh-2rem)] overflow-auto">
                  <Suspense
                    fallback={
                      <div className="space-y-2 p-4">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-[90%]" />
                      </div>
                    }
                  >
                    <LazyDebugPage />
                  </Suspense>
                </div>
              </div>
            </div>
          )}
          <Toaster />
          <Suspense fallback={null}>
            <TrackChangesPdfDialog />
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
