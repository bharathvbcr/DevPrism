import { type FC, memo, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  CornerDownRightIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  SendHorizonalIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  messageContentText,
  useClaudeChatStore,
  type ClaudeStreamMessage,
  type ContentBlock,
  type QueuedGuidance,
} from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist, summarizeSection } from "@/lib/ai-assist";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatLabels } from "@/lib/chat-labels";
import { isNativeOllamaBackend } from "@/lib/agent-backend";
import {
  buildDisplayEntries,
  buildToolResultMap,
  stabilizeToolResultMap,
} from "@/lib/chat-message-display";
import { NativeOllamaEmptyState } from "./native-ollama-empty-state";
import { ChatStarterChips } from "./chat-starter-chips";
import { buildChatStarterPromptsFromStore } from "@/lib/chat-starter-prompts";
import { useDocumentStore } from "@/stores/document-store";
import { MarkdownRenderer } from "./markdown-renderer";
import {
  ThinkingWidget,
  ToolWidget,
  ToolGroupWidget,
  groupAssistantToolBlocks,
} from "./tool-widgets";
import { streamPhaseLabel } from "@/lib/claude-stream-heartbeat";

// ─── Streaming Indicator (isolated to prevent re-render storms) ───

const PHASE_DOT_CLASS: Record<string, string> = {
  thinking: "bg-violet-400/70 animate-pulse",
  chat: "bg-sky-400/70 animate-bounce",
  tool: "bg-amber-400/70 animate-bounce",
  ask_user: "bg-emerald-400/70 animate-pulse",
  prep: "bg-muted-foreground/40 animate-pulse",
  retry: "bg-orange-400/70 animate-pulse",
};

const StreamingIndicator: FC<{
  startedAt: number | null;
  phase: string | null;
}> = memo(({ startedAt, phase }) => {
  const calculateElapsed = () =>
    startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;

  const [elapsed, setElapsed] = useState(calculateElapsed);

  useEffect(() => {
    setElapsed(calculateElapsed());
    const timer = setInterval(() => {
      setElapsed(calculateElapsed());
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const statusLabel = streamPhaseLabel(phase, elapsed);
  const dotClass =
    (phase && PHASE_DOT_CLASS[phase]) ||
    "bg-muted-foreground/50 animate-bounce";

  return (
    <div className="flex items-center gap-1.5 px-1 py-1.5 text-muted-foreground">
      <div className="flex gap-0.5">
        <span
          className={`size-1.5 rounded-full ${dotClass}`}
          style={{ animationDelay: "0ms" }}
        />
        <span
          className={`size-1.5 rounded-full ${dotClass}`}
          style={{ animationDelay: "150ms" }}
        />
        <span
          className={`size-1.5 rounded-full ${dotClass}`}
          style={{ animationDelay: "300ms" }}
        />
      </div>
      <span className="text-sm">
        {statusLabel}
        {elapsed >= 1 && (
          <span className="ml-1 text-muted-foreground/60 text-xs tabular-nums">
            {elapsed}s
          </span>
        )}
      </span>
    </div>
  );
});

const EMPTY_PENDING_GUIDANCE: QueuedGuidance[] = [];
/** Trailing refresh for starter prompts while the empty state is visible. */
const STARTER_REFRESH_DEBOUNCE_MS = 400;
const THREAD_MAX_WIDTH = "max-w-[44rem]";

function latestContextTruncation(messages: ClaudeStreamMessage[]): {
  dropped: string[];
  source?: string;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.subtype !== "context_truncation") continue;
    const dropped = msg.contextDropped?.filter(Boolean) ?? [];
    if (dropped.length > 0) {
      return { dropped, source: messageContentText(msg) || undefined };
    }
    const text = messageContentText(msg);
    const match = text.match(/Context trimmed \(([^)]+)\):\s*(.+?)\./i);
    if (match) {
      return {
        dropped: match[2]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        source: match[1],
      };
    }
  }
  return null;
}

/** Inline notice when the native agent drops context to fit the window. */
function ContextTruncationNotice({
  messages,
}: {
  messages: ClaudeStreamMessage[];
}) {
  const truncation = useMemo(
    () => latestContextTruncation(messages),
    [messages],
  );
  if (!truncation) return null;

  const detail = truncation.dropped.join(", ");
  const title = truncation.source
    ? `Context trimmed (${truncation.source})`
    : "Context trimmed";

  return (
    <div className={cn("mx-auto mb-3 w-full", THREAD_MAX_WIDTH)}>
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-warning-foreground text-xs"
      >
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-muted-foreground leading-snug">
            Dropped from context:{" "}
            <span className="text-foreground/90">{detail}</span>. Ask the agent
            to re-read files or earlier turns if answers seem incomplete.
          </p>
        </div>
      </div>
    </div>
  );
}

const MessageActions: FC<{
  text: string;
  align?: "left" | "right";
}> = ({ text, align = "left" }) => {
  const [copied, setCopied] = useState(false);
  const canCopy = text.trim().length > 0;

  const handleCopy = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  if (!canCopy) return null;

  return (
    <div
      className={cn(
        "flex gap-1 text-muted-foreground",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      <TooltipIconButton
        tooltip={copied ? "Copied" : "Copy"}
        side="top"
        variant="ghost"
        size="icon"
        className="size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={handleCopy}
      >
        {copied ? (
          <CheckIcon className="fade-in zoom-in-50 size-4 animate-in duration-200" />
        ) : (
          <CopyIcon className="fade-in zoom-in-75 size-4 animate-in duration-150" />
        )}
      </TooltipIconButton>
    </div>
  );
};

// Re-runs the conversation from the user message that produced this response.
const RegenerateButton: FC<{ userIndex: number }> = ({ userIndex }) => {
  const resendFromMessage = useClaudeChatStore((s) => s.resendFromMessage);
  if (userIndex < 0) return null;
  return (
    <TooltipIconButton
      tooltip="Regenerate"
      side="top"
      variant="ghost"
      size="icon"
      className="size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => void resendFromMessage(userIndex)}
    >
      <RefreshCwIcon className="size-4" />
    </TooltipIconButton>
  );
};

// Assistant messages longer than this expose a one-click TL;DR action.
const SUMMARIZE_THRESHOLD = 800;

// One-click "Summarize" (TL;DR) for long assistant messages. Holds its own
// pending/summary state and renders both the trigger button (in the action
// row) and a dismissable inline callout (above the action row).
const useSummarize = (text: string) => {
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestIdRef = useRef(0);

  const eligible =
    aiSummarize && canUseAiAssist() && text.trim().length > SUMMARIZE_THRESHOLD;

  const summarize = async () => {
    if (pending) return;
    const requestId = ++requestIdRef.current;
    setPending(true);
    setSummaryError(null);
    try {
      const result = await summarizeSection(text);
      // Ignore stale responses (cancellation-safe).
      if (requestId !== requestIdRef.current) return;
      const trimmed = result.trim();
      if (trimmed) {
        setSummary(trimmed);
      } else {
        setSummaryError("Couldn't generate a summary.");
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setSummaryError("Couldn't generate a summary.");
    } finally {
      if (requestId === requestIdRef.current) setPending(false);
    }
  };

  const dismiss = () => {
    requestIdRef.current++;
    setSummary(null);
    setSummaryError(null);
    setPending(false);
  };

  return { eligible, summary, summaryError, pending, summarize, dismiss };
};

const SummarizeButton: FC<{ pending: boolean; onClick: () => void }> = ({
  pending,
  onClick,
}) => (
  <TooltipIconButton
    tooltip="Summarize"
    side="top"
    variant="ghost"
    size="icon"
    className="size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    onClick={onClick}
    disabled={pending}
  >
    {pending ? (
      <Loader2Icon className="size-4 animate-spin" />
    ) : (
      <SparklesIcon className="size-4" />
    )}
  </TooltipIconButton>
);

const SummaryCallout: FC<{ summary: string; onDismiss: () => void }> = ({
  summary,
  onDismiss,
}) => (
  <div className="fade-in slide-in-from-top-1 mx-2 mb-2 animate-in rounded-lg border border-border/60 bg-muted/60 px-3 py-2 duration-150">
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
        <SparklesIcon className="size-3" />
        AI summary
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded text-muted-foreground/70 hover:text-foreground"
        aria-label="Dismiss summary"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
    <MarkdownRenderer
      content={summary}
      className="prose prose-sm dark:prose-invert max-w-none text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    />
  </div>
);

const SummaryErrorCallout: FC<{ message: string; onDismiss: () => void }> = ({
  message,
  onDismiss,
}) => (
  <div className="fade-in slide-in-from-top-1 mx-2 mb-2 animate-in rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 duration-150">
    <div className="flex items-center justify-between gap-2">
      <p className="text-destructive text-xs">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded text-destructive/70 hover:text-destructive"
        aria-label="Dismiss error"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  </div>
);

// ─── Chat Messages (main component) ───

export const ChatMessages: FC = () => {
  const messages = useClaudeChatStore((s) => s.messages) ?? [];
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const streamingStartedAt = useClaudeChatStore((s) => s.streamingStartedAt);
  const streamingPhase = useClaudeChatStore((s) => s.streamingPhase);
  const queuedGuidance =
    useClaudeChatStore(
      (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.queuedGuidance,
    ) ?? EMPTY_PENDING_GUIDANCE;
  const pendingGuidance = useMemo(
    () => queuedGuidance.filter((guidance) => guidance.displayedInChat),
    [queuedGuidance],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const userHasScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const agentBackend = useSettingsStore((s) => s.agentBackend);
  const isNativeOllama = isNativeOllamaBackend(agentBackend);
  const chatLabels = useChatLabels();
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);
  const saveDraft = useClaudeChatStore((s) => s.saveDraft);

  const applyStarterPrompt = (prompt: string) => {
    saveDraft(activeTabId, { input: prompt, pinnedContexts: [] });
  };

  // Build a map of tool_use_id → tool_result for inline display.
  // Identity-stabilized so memoized bubbles don't re-render per delta.
  const rawToolResultMap = useMemo(
    () => buildToolResultMap(messages),
    [messages],
  );
  const stableToolResultsRef = useRef<Map<string, ContentBlock>>(new Map());
  const toolResultMap = useMemo(
    () =>
      stabilizeToolResultMap(stableToolResultsRef.current, rawToolResultMap),
    [rawToolResultMap],
  );
  stableToolResultsRef.current = toolResultMap;

  // Displayable messages with anchors — single forward pass; `rawIndex` is
  // the stable React key (append-only streams never shift earlier indices,
  // unlike positions within this filtered list).
  const displayMessages = useMemo(
    () => buildDisplayEntries(messages),
    [messages],
  );

  // Starter prompts only matter for the empty conversation state. Computing
  // them scans the project (citations, outline); subscribing unconditionally
  // re-ran that scan on every debounced editor keystroke (~6Hz) because file
  // contents change. Gate the work behind visibility, with a short trailing
  // refresh while visible.
  const needsStarters =
    displayMessages.length === 0 &&
    pendingGuidance.length === 0 &&
    !isStreaming;
  const [starterPrompts, setStarterPrompts] = useState<string[]>([]);
  useEffect(() => {
    if (!needsStarters) return;
    setStarterPrompts(buildChatStarterPromptsFromStore());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useDocumentStore.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setStarterPrompts(buildChatStarterPromptsFromStore());
      }, STARTER_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [needsStarters]);

  // Auto-scroll to bottom (only if user hasn't scrolled up)
  useEffect(() => {
    if (shouldAutoScrollRef.current && viewportRef.current) {
      viewportRef.current.scrollTo({
        top: viewportRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [displayMessages, pendingGuidance]);

  // Reset auto-scroll when streaming stops
  useEffect(() => {
    if (!isStreaming) {
      shouldAutoScrollRef.current = true;
      userHasScrolledRef.current = false;
    }
  }, [isStreaming]);

  const handleScroll = () => {
    if (!viewportRef.current) return;
    const el = viewportRef.current;
    const isAtBottom =
      Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
    setShowScrollToBottom(!isAtBottom);
    if (!isAtBottom) {
      userHasScrolledRef.current = true;
      shouldAutoScrollRef.current = false;
    } else if (userHasScrolledRef.current) {
      shouldAutoScrollRef.current = true;
      userHasScrolledRef.current = false;
    }
  };

  const scrollToBottom = () => {
    if (!viewportRef.current) return;
    shouldAutoScrollRef.current = true;
    userHasScrolledRef.current = false;
    viewportRef.current.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    });
    setShowScrollToBottom(false);
  };

  return (
    <div className="absolute inset-0">
      <div
        ref={viewportRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto overscroll-contain scroll-smooth px-4 pt-4"
      >
        {displayMessages.length === 0 &&
          pendingGuidance.length === 0 &&
          !isStreaming &&
          (isNativeOllama ? (
            <NativeOllamaEmptyState />
          ) : (
            <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="font-medium text-foreground text-sm">
                Ask about your project
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {chatLabels.emptyStateHint}
              </p>
              <ChatStarterChips
                prompts={starterPrompts}
                onSelect={applyStarterPrompt}
              />
            </div>
          ))}

        <ContextTruncationNotice messages={messages} />

        {displayMessages.map(({ msg, rawIndex, precedingUserIndex }, idx) => {
          const isLast = idx === displayMessages.length - 1;
          return (
            <div
              key={rawIndex}
              className={cn("cv-auto-chat mx-auto w-full", THREAD_MAX_WIDTH)}
            >
              <MessageBubble
                message={msg}
                toolResultMap={toolResultMap}
                rawIndex={rawIndex}
                precedingUserIndex={precedingUserIndex}
                isStreaming={isStreaming}
                isLast={isLast}
              />
            </div>
          );
        })}

        {isStreaming && (
          <div className={cn("mx-auto w-full px-2", THREAD_MAX_WIDTH)}>
            <StreamingIndicator
              startedAt={streamingStartedAt}
              phase={streamingPhase}
            />
          </div>
        )}

        {pendingGuidance.map((guidance) => (
          <div
            key={guidance.id}
            className={cn("mx-auto w-full", THREAD_MAX_WIDTH)}
          >
            <PendingGuidanceMessage guidance={guidance} />
          </div>
        ))}
      </div>

      {showScrollToBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="pointer-events-auto h-8 gap-1.5 rounded-full border border-border bg-background/95 px-3 shadow-md backdrop-blur-sm"
            onClick={scrollToBottom}
          >
            <ArrowDownIcon className="size-3.5" />
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
};

// ─── Message Bubble ───

const MessageBubble: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
  rawIndex: number;
  precedingUserIndex: number;
  isStreaming: boolean;
  isLast: boolean;
}> = memo(
  ({
    message,
    toolResultMap,
    rawIndex,
    precedingUserIndex,
    isStreaming,
    isLast,
  }) => {
    if (message.type === "user") {
      return (
        <UserMessage
          message={message}
          rawIndex={rawIndex}
          canEdit={!isStreaming}
        />
      );
    }
    if (message.type === "assistant") {
      return (
        <AssistantMessage
          message={message}
          toolResultMap={toolResultMap}
          regenerateIndex={precedingUserIndex}
          canRegenerate={isLast && !isStreaming}
          streamingActive={isStreaming && isLast}
        />
      );
    }
    if (message.type === "result") {
      return (
        <ResultMessage
          message={message}
          regenerateIndex={precedingUserIndex}
          canRegenerate={isLast && !isStreaming}
        />
      );
    }
    return null;
  },
);

// ─── User Message ───

const UserMessage: FC<{
  message: ClaudeStreamMessage;
  rawIndex: number;
  canEdit: boolean;
}> = ({ message, rawIndex, canEdit }) => {
  const resendFromMessage = useClaudeChatStore((s) => s.resendFromMessage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const rawContent = message.message?.content;
  const textContent = Array.isArray(rawContent)
    ? rawContent
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : typeof rawContent === "string"
      ? rawContent
      : "";

  if (!textContent) return null;

  const firstLineMatch = textContent.match(/^([^\n]+)\n([\s\S]*)$/);
  const firstLine = firstLineMatch?.[1]?.trim() ?? "";
  const hasContextLabel =
    firstLine.startsWith("@") ||
    firstLine.startsWith("~@") ||
    /^Pasted image(?: \d+)?(?:, Pasted image(?: \d+)?)*$/.test(firstLine);
  const contextLabel = hasContextLabel ? firstLine : null;
  const bodyText =
    hasContextLabel && firstLineMatch ? firstLineMatch[2] : textContent;

  // Parse error block patterns for styled rendering:
  // Lint single: "[Lint error in FILE:LINE]\n[Error: MSG]\n\nPrompt"
  // Lint multi:  "[Lint errors in FILE]\n- FILE:LINE — MSG\n...\n\nPrompt"
  // Compile:     "[Compilation errors]\n- error1\n- error2\n...\n\nPrompt"
  const lintSingleMatch = bodyText.match(
    /^\[Lint error in ([^\]]+)\]\n\[Error: ([^\]]+)\]\n\n([\s\S]*)$/,
  );
  const lintMultiMatch = bodyText.match(
    /^\[Lint errors in ([^\]]+)\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
  );
  const compileErrorMatch = bodyText.match(
    /^\[Compilation errors(?: in ([^\]]+))?\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
  );

  // Shared error block renderer
  const renderErrorBlock = (
    title: string,
    errors: { message: string; location?: string }[],
    prompt: string,
  ) => (
    <div className="fade-in slide-in-from-bottom-1 grid w-full animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 duration-150 [&:where(>*)]:col-start-2">
      <div className="relative col-start-2 min-w-0">
        <div className="wrap-break-word rounded-xl bg-muted px-4 py-2 text-foreground text-sm empty:hidden">
          <div className="mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-2">
            <div className="mb-1.5 font-medium text-red-400 text-xs">
              {title}
            </div>
            <div className="space-y-1">
              {errors.map((e, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <AlertCircleIcon className="mt-0.5 size-3 shrink-0 text-red-400/70" />
                  <span className="flex-1 text-foreground/80 text-xs">
                    {e.message}
                  </span>
                  {e.location && (
                    <span className="shrink-0 font-mono text-muted-foreground text-xs">
                      {e.location}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <span className="text-muted-foreground">{prompt}</span>
        </div>
      </div>
      <div className="col-span-full col-start-1 row-start-2 -mr-1 flex justify-end">
        <MessageActions text={bodyText} align="right" />
      </div>
    </div>
  );

  if (lintSingleMatch) {
    const [, location, errorMsg, prompt] = lintSingleMatch;
    return renderErrorBlock(
      `Lint Error`,
      [{ message: errorMsg, location }],
      prompt,
    );
  }

  if (lintMultiMatch) {
    const [, fileName, errorLines, prompt] = lintMultiMatch;
    const errors = errorLines
      .trim()
      .split("\n")
      .map((line) => {
        const m = line.match(/^- (.+?):(\d+) — (.+)$/);
        return m
          ? { message: m[3], location: `${m[1]}:${m[2]}` }
          : { message: line.replace(/^- /, "") };
      });
    return renderErrorBlock(`Lint Errors — ${fileName}`, errors, prompt);
  }

  if (compileErrorMatch) {
    const [, fileName, errorLines, prompt] = compileErrorMatch;
    const errors = errorLines
      .trim()
      .split("\n")
      .map((line) => {
        const located = line.match(/^- (.+?):(\d+) — (.+)$/);
        if (located) {
          return {
            message: located[3],
            location: `${located[1]}:${located[2]}`,
          };
        }
        const lineOnly = line.match(/^- line (\d+) — (.+)$/);
        if (lineOnly) {
          return { message: lineOnly[2], location: `line ${lineOnly[1]}` };
        }
        return { message: line.replace(/^- /, "") };
      });
    const title = fileName
      ? `Compilation Errors — ${fileName}`
      : `Compilation ${errors.length === 1 ? "Error" : "Errors"}`;
    return renderErrorBlock(title, errors, prompt);
  }

  const submitEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next) void resendFromMessage(rawIndex, next);
  };

  if (editing) {
    return (
      <div className="grid w-full auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 [&:where(>*)]:col-start-2">
        <div className="col-start-2 min-w-0">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitEdit();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            className="w-full resize-none rounded-xl border border-border bg-background px-4 py-2 text-foreground text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setEditing(false)}
            >
              <XIcon className="size-3.5" />
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={submitEdit}
              disabled={!draft.trim()}
            >
              <SendHorizonalIcon className="size-3.5" />
              Send
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in slide-in-from-bottom-1 grid w-full animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 duration-150 [&:where(>*)]:col-start-2">
      <div className="relative col-start-2 min-w-0">
        <div className="wrap-break-word rounded-xl bg-muted px-4 py-2 text-foreground text-sm empty:hidden">
          {contextLabel && (
            <span className="mb-1 inline-flex items-center rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
              {contextLabel}
            </span>
          )}
          {contextLabel && bodyText && <br />}
          <MarkdownRenderer
            content={bodyText}
            className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
      </div>
      <div className="col-span-full col-start-1 row-start-2 -mr-1 flex items-center justify-end gap-1">
        {canEdit && (
          <TooltipIconButton
            tooltip="Edit & resend"
            side="top"
            variant="ghost"
            size="icon"
            className="size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              setDraft(bodyText);
              setEditing(true);
            }}
          >
            <PencilIcon className="size-4" />
          </TooltipIconButton>
        )}
        <MessageActions text={textContent} align="right" />
      </div>
    </div>
  );
};

// ─── Assistant Message ───

const PendingGuidanceMessage: FC<{ guidance: QueuedGuidance }> = ({
  guidance,
}) => {
  const contextLabel = guidance.contextOverride?.label ?? null;
  const copyText = contextLabel
    ? `${contextLabel}\n${guidance.prompt}`
    : guidance.prompt;

  return (
    <div className="fade-in slide-in-from-bottom-1 grid w-full animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 duration-150 [&:where(>*)]:col-start-2">
      <div className="relative col-start-2 min-w-0">
        <div className="wrap-break-word rounded-xl bg-muted px-4 py-2 text-foreground text-sm empty:hidden">
          {contextLabel && (
            <span className="mb-1 inline-flex items-center rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
              {contextLabel}
            </span>
          )}
          {contextLabel && guidance.prompt && <br />}
          <div className="flex min-w-0 items-start gap-2">
            <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
            <MarkdownRenderer
              content={guidance.prompt}
              className="prose prose-sm dark:prose-invert min-w-0 max-w-none flex-1 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        </div>
      </div>
      <div className="col-span-full col-start-1 row-start-2 -mr-1 flex justify-end">
        <MessageActions text={copyText} align="right" />
      </div>
    </div>
  );
};

const AssistantMessage: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
  regenerateIndex: number;
  canRegenerate: boolean;
  streamingActive?: boolean;
}> = ({
  message,
  toolResultMap,
  regenerateIndex,
  canRegenerate,
  streamingActive = false,
}) => {
  const content = message.message?.content;
  const blocks = Array.isArray(content) ? content : [];

  const copyText = blocks
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n\n");

  // Hook must run unconditionally (before any early return).
  const { eligible, summary, summaryError, pending, summarize, dismiss } =
    useSummarize(copyText);

  if (blocks.length === 0) return null;

  const hasRenderableContent = blocks.some(
    (block) =>
      (block.type === "text" && block.text) ||
      (block.type === "thinking" && block.thinking) ||
      (block.type === "tool_use" && block.id),
  );

  if (!hasRenderableContent) return null;

  const renderItems = groupAssistantToolBlocks(blocks);

  return (
    <div className="fade-in slide-in-from-bottom-1 relative mx-auto w-full animate-in py-3 duration-150">
      <div className="wrap-break-word px-2 text-foreground text-sm leading-relaxed">
        {renderItems.map((item) => {
          if (item.kind === "group") {
            return (
              <ToolGroupWidget
                key={`group-${item.index}`}
                name={item.name}
                tools={item.tools}
                toolResultMap={toolResultMap}
              />
            );
          }
          const block = item.block;
          const idx = item.index;
          if (block.type === "text" && block.text) {
            return (
              <MarkdownRenderer
                key={idx}
                content={block.text}
                className="prose prose-sm dark:prose-invert max-w-none"
              />
            );
          }
          if (block.type === "tool_use" && block.id) {
            const result = toolResultMap.get(block.id);
            return <ToolWidget key={idx} toolUse={block} toolResult={result} />;
          }
          if (block.type === "thinking" && block.thinking) {
            return (
              <ThinkingWidget
                key={idx}
                thinking={block.thinking}
                signature={block.signature}
                streaming={streamingActive}
              />
            );
          }
          return null;
        })}
      </div>
      {summary && <SummaryCallout summary={summary} onDismiss={dismiss} />}
      {summaryError && (
        <SummaryErrorCallout message={summaryError} onDismiss={dismiss} />
      )}
      <div className="mt-1 ml-2 flex items-center gap-1">
        <MessageActions text={copyText} />
        {eligible && !summary && !summaryError && (
          <SummarizeButton pending={pending} onClick={() => void summarize()} />
        )}
        {canRegenerate && <RegenerateButton userIndex={regenerateIndex} />}
      </div>
    </div>
  );
};

// ─── Result Message ───

const ResultMessage: FC<{
  message: ClaudeStreamMessage;
  regenerateIndex: number;
  canRegenerate: boolean;
}> = ({ message, regenerateIndex, canRegenerate }) => {
  const isError = message.is_error || message.subtype === "error";
  const resultText = message.result;

  if (!resultText) return null;

  return (
    <div className="fade-in slide-in-from-bottom-1 relative mx-auto w-full animate-in py-3 duration-150">
      <div className="wrap-break-word px-2 text-foreground text-sm leading-relaxed">
        {isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {resultText}
          </div>
        ) : (
          <MarkdownRenderer
            content={resultText}
            className="prose prose-sm dark:prose-invert max-w-none"
          />
        )}
      </div>
      <div className="mt-1 ml-2 flex items-center gap-1">
        <MessageActions text={resultText} />
        {canRegenerate && <RegenerateButton userIndex={regenerateIndex} />}
      </div>
      {message.cost_usd != null && (
        <div className="mt-1 px-1 text-right text-muted-foreground text-xs">
          Cost: ${message.cost_usd.toFixed(4)}
        </div>
      )}
    </div>
  );
};
