import { useRef, useState, useCallback, useEffect } from "react";
import {
  ChevronDownIcon,
  Maximize2Icon,
  MessageCircleIcon,
  Minimize2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  CHAT_DRAWER_OPEN_EVENT,
  CHAT_DRAWER_TOGGLE_EVENT,
  focusChatComposer,
  type ChatDrawerOpenDetail,
} from "@/lib/chat-drawer-events";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useClaudeEvents } from "@/hooks/use-claude-events";
import { ChatMessages } from "./chat-messages";
import { ChatComposer } from "./chat-composer";
import { ChatTabBar } from "./chat-tab-bar";
import { OllamaErrorHelp } from "@/components/ollama-error-help";
import { requestOllamaRefresh } from "@/lib/ollama-events";

const MIN_HEIGHT = 260;
const DEFAULT_HEIGHT = 360;

export function ClaudeChatDrawer() {
  // Initialize event listeners for Claude streaming
  useClaudeEvents();

  const anyStreaming = useClaudeChatStore((s) =>
    s.tabs.some((t) => t.isStreaming),
  );
  const error = useClaudeChatStore((s) => s.error);
  const clearMessages = useClaudeChatStore((s) => s.clearMessages);
  const hasMessages = useClaudeChatStore((s) => s.messages.length > 0);

  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const hasDraggedRef = useRef(false);
  const heightRef = useRef(height);
  heightRef.current = height;

  const pendingAttachments = useClaudeChatStore((s) => s.pendingAttachments);

  // Auto-open when streaming starts or a new attachment is added
  useEffect(() => {
    const shouldOpen = anyStreaming || pendingAttachments.length > 0;
    if (shouldOpen && !isOpen) {
      setIsOpen(true);
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight * 0.5);
      const nextHeight = Math.max(maxHeight, MIN_HEIGHT);
      setHeight(nextHeight);
      heightRef.current = nextHeight;
      if (panelRef.current) {
        panelRef.current.style.height = `${nextHeight}px`;
      }
    }
  }, [anyStreaming, isOpen, pendingAttachments]);

  // Track viewport size so the fullscreen panel and height caps follow window
  // resizing (dimensions are derived from window.inner* at render time).
  useEffect(() => {
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const restoreFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const el = focusReturnRef.current;
      if (el?.isConnected) el.focus({ preventScroll: true });
      focusReturnRef.current = null;
    });
  }, []);

  const openDrawer = useCallback((options?: ChatDrawerOpenDetail) => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && !containerRef.current?.contains(el)) {
      focusReturnRef.current = el;
    }
    setIsOpen(true);
    if (options?.focusComposer) {
      requestAnimationFrame(() => focusChatComposer());
    }
  }, []);

  const closeDrawer = useCallback(() => {
    setIsExpanded(false);
    setIsOpen(false);
    restoreFocus();
  }, [restoreFocus]);

  const toggleDrawer = useCallback(() => {
    setIsOpen((open) => {
      if (open) {
        setIsExpanded(false);
        restoreFocus();
        return false;
      }
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && !containerRef.current?.contains(el)) {
        focusReturnRef.current = el;
      }
      return true;
    });
  }, [restoreFocus]);

  // Keyboard shortcuts and command palette dispatch toggle/open events.
  useEffect(() => {
    const onToggle = () => toggleDrawer();
    const onOpen = (e: Event) =>
      openDrawer((e as CustomEvent<ChatDrawerOpenDetail>).detail);
    window.addEventListener(CHAT_DRAWER_TOGGLE_EVENT, onToggle);
    window.addEventListener(CHAT_DRAWER_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(CHAT_DRAWER_TOGGLE_EVENT, onToggle);
      window.removeEventListener(CHAT_DRAWER_OPEN_EVENT, onOpen);
    };
  }, [openDrawer, toggleDrawer]);

  // Escape exits fullscreen, then closes the drawer — but never while the user
  // is typing in the composer (let them keep their draft; the Close button is
  // there for that case).
  useEffect(() => {
    if (!isOpen && !isExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isExpanded) {
        setIsExpanded(false);
        return;
      }
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el?.tagName === "TEXTAREA" ||
        el?.tagName === "INPUT" ||
        el?.isContentEditable === true;
      if (!typing) closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDrawer, isOpen, isExpanded]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isExpanded) return;

      e.preventDefault();
      setIsDragging(true);
      hasDraggedRef.current = false;

      const startY = e.clientY;
      const startHeight = heightRef.current;

      const handleMouseMove = (e: MouseEvent) => {
        hasDraggedRef.current = true;
        const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight * 0.5);
        const delta = startY - e.clientY;
        const newHeight = Math.min(
          Math.max(startHeight + delta, MIN_HEIGHT),
          maxHeight,
        );
        heightRef.current = newHeight;
        if (panelRef.current) {
          panelRef.current.style.height = `${newHeight}px`;
        }
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        setHeight(heightRef.current);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [isExpanded],
  );

  const panelStyle = (): React.CSSProperties => {
    if (!isOpen && !isExpanded) {
      return { height: 0, maxWidth: 672, borderRadius: 24 };
    }
    if (isExpanded) {
      return {
        height: viewport.height,
        maxWidth: viewport.width,
        borderRadius: 0,
      };
    }
    // Clamp to the viewport so a stored height never overflows after the window
    // shrinks below the height the user previously dragged to.
    const clampedHeight = Math.min(
      Math.max(height, MIN_HEIGHT),
      Math.max(MIN_HEIGHT, viewport.height),
    );
    return {
      height: clampedHeight,
      minHeight: MIN_HEIGHT,
      maxWidth: 672,
      borderRadius: 24,
    };
  };

  const handleClose = closeDrawer;

  // Clearing is one-click (no confirm dialog, to keep this common action
  // low-friction) but recoverable: snapshot the active tab's messages first,
  // then offer an Undo toast that restores them. Note that Undo restores the
  // visible transcript only — the native runtime's per-tab memory is not
  // re-seeded, same as continuing a fresh conversation.
  const handleClearChat = useCallback(() => {
    const { activeTabId, messages } = useClaudeChatStore.getState();
    const prevMessages = messages;
    clearMessages();
    if (prevMessages.length === 0) return;
    toast("Chat cleared", {
      action: {
        label: "Undo",
        onClick: () => {
          useClaudeChatStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === activeTabId ? { ...t, messages: prevMessages } : t,
            ),
            ...(s.activeTabId === activeTabId
              ? { messages: prevMessages }
              : {}),
          }));
        },
      },
    });
  }, [clearMessages]);

  const headerActions = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={handleClearChat}
        disabled={!hasMessages || anyStreaming}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        aria-label="Clear chat"
        title={
          anyStreaming
            ? "Stop the response before clearing"
            : !hasMessages
              ? "Nothing to clear yet"
              : "Clear chat"
        }
      >
        <Trash2Icon className="size-4" />
      </button>
      <button
        type="button"
        onClick={handleClose}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Close chat"
        title="Close chat"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "pointer-events-none fixed inset-0 z-40 flex items-end justify-center transition-[padding] duration-300 ease-out",
        isExpanded ? "p-0" : "px-4 pt-4 pb-6",
      )}
    >
      {/* Floating toggle button */}
      <button
        type="button"
        onClick={() => openDrawer()}
        className={cn(
          "pointer-events-auto absolute right-4 bottom-6 flex size-12 items-center justify-center rounded-full border border-border bg-background shadow-lg transition-all duration-300 ease-out hover:scale-105 hover:shadow-xl",
          isOpen
            ? "pointer-events-none scale-50 opacity-0"
            : "scale-100 opacity-100",
          anyStreaming &&
            !isOpen &&
            "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
        )}
        aria-label={
          anyStreaming ? "Open AI Assistant (responding)" : "Open AI Assistant"
        }
      >
        <MessageCircleIcon className="size-5 text-foreground" />
        {anyStreaming && !isOpen && (
          <span className="absolute -top-0.5 -right-0.5 flex size-3">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 opacity-75" />
            <span className="relative inline-flex size-3 rounded-full bg-primary" />
          </span>
        )}
      </button>

      {/* Chat panel */}
      <div
        ref={panelRef}
        className={cn(
          "pointer-events-auto flex w-full flex-col overflow-hidden border bg-background transition-[height,max-width,border-radius,border-color,box-shadow,opacity,transform] duration-300 ease-out",
          isExpanded
            ? "border-transparent shadow-none"
            : "border-border shadow-2xl",
          isOpen
            ? "scale-100 opacity-100"
            : "pointer-events-none origin-bottom scale-95 opacity-0",
          isDragging && "!transition-none",
        )}
        style={panelStyle()}
      >
        {/* Header with drag handle, tab bar, and session selector */}
        {isExpanded ? (
          <>
            <div className="flex items-center justify-between border-border border-b px-2 py-1">
              <button
                type="button"
                onClick={() => setIsExpanded(false)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Exit fullscreen"
              >
                <Minimize2Icon className="size-4" />
              </button>
              {headerActions}
            </div>
            <ChatTabBar />
          </>
        ) : (
          <>
            <div className="group relative">
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize chat"
                tabIndex={0}
                className="flex cursor-row-resize items-center justify-center gap-2 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onMouseDown={handleMouseDown}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault();
                  const delta = e.key === "ArrowUp" ? 24 : -24;
                  const clampedHeight = Math.min(
                    Math.max(heightRef.current + delta, MIN_HEIGHT),
                    Math.max(MIN_HEIGHT, viewport.height),
                  );
                  heightRef.current = clampedHeight;
                  setHeight(clampedHeight);
                  if (panelRef.current) {
                    panelRef.current.style.height = `${clampedHeight}px`;
                  }
                }}
              >
                <div className="h-1 w-10 rounded-full bg-muted-foreground/30 transition-all group-hover:w-8" />
                <button
                  type="button"
                  aria-label="Collapse chat"
                  onClick={closeDrawer}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                >
                  <ChevronDownIcon className="size-4" />
                </button>
              </div>
              <div className="absolute top-1/2 left-2 flex -translate-y-1/2 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setIsExpanded(true)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Fullscreen"
                >
                  <Maximize2Icon className="size-4" />
                </button>
              </div>
              <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
                {headerActions}
              </div>
            </div>
            <ChatTabBar />
          </>
        )}

        {/* Error banner — for the native Ollama agent this renders actionable
            remediation (classified message + Change model / Dismiss); otherwise
            it degrades to the raw error string. */}
        {error && (
          <div className="mx-3 mt-2 mb-1 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive text-xs">
            <div className="min-w-0 flex-1">
              <OllamaErrorHelp error={error} onRetry={requestOllamaRefresh} />
            </div>
          </div>
        )}

        {/* Messages area */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ChatMessages />
        </div>

        {/* Composer */}
        <ChatComposer isOpen={isOpen} />
      </div>
    </div>
  );
}
