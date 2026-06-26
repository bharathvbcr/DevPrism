import { type FC, memo, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
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
import { NativeOllamaEmptyState } from "./native-ollama-empty-state";
import { MarkdownRenderer } from "./markdown-renderer";
import { ThinkingWidget, ToolWidget } from "./tool-widgets";

// ─── Streaming Indicator (isolated to prevent re-render storms) ───

const StreamingIndicator: FC<{ startedAt: number | null }> = memo(
  ({ startedAt }) => {
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

    return (
      <div className="flex items-center gap-1.5 px-1 py-1.5 text-muted-foreground">
        <div className="flex gap-0.5">
          <span
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50"
            style={{ animationDelay: "0ms" }}
          />
          <span
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50"
            style={{ animationDelay: "300ms" }}
          />
        </div>
        <span className="text-sm">
          Thinking...
          {elapsed >= 3 && (
            <span className="ml-1 text-muted-foreground/60 text-xs">
              {elapsed}s
            </span>
          )}
        </span>
      </div>
    );
  },
);

const EMPTY_PENDING_GUIDANCE: QueuedGuidance[] = [];
const THREAD_MAX_WIDTH = "max-w-[44rem]";

const MessageActions: FC<{
  text: string;
  align?: "left" | "right";
}> = ({ text, align = "left" }) => {
  const [copied, setCopied] = useState(false);
  const canCopy = text.trim().length > 0;

  const handleCopy = async () => {
    if (!canCopy) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
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
  const [pending, setPending] = useState(false);
  const requestIdRef = useRef(0);

  const eligible =
    aiSummarize && canUseAiAssist() && text.trim().length > SUMMARIZE_THRESHOLD;

  const summarize = async () => {
    if (pending) return;
    const requestId = ++requestIdRef.current;
    setPending(true);
    try {
      const result = await summarizeSection(text);
      // Ignore stale responses (cancellation-safe).
      if (requestId !== requestIdRef.current) return;
      const trimmed = result.trim();
      if (trimmed) {
        setSummary(trimmed);
      } else {
        toast.error("Couldn't generate a summary.");
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      toast.error("Couldn't generate a summary.");
    } finally {
      if (requestId === requestIdRef.current) setPending(false);
    }
  };

  const dismiss = () => {
    requestIdRef.current++;
    setSummary(null);
    setPending(false);
  };

  return { eligible, summary, pending, summarize, dismiss };
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

// ─── Chat Messages (main component) ───

export const ChatMessages: FC = () => {
  const messages = useClaudeChatStore((s) => s.messages) ?? [];
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const streamingStartedAt = useClaudeChatStore((s) => s.streamingStartedAt);
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
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const chatLabels = useChatLabels();

  // Build a map of tool_use_id → tool_result for inline display
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ContentBlock>();
    for (const msg of messages) {
      if (msg.type === "user" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            map.set(block.tool_use_id, block);
          }
        }
      }
    }
    return map;
  }, [messages]);

  // Filter displayable messages
  const displayMessages = useMemo(() => {
    // Collect all assistant text for dedup against result
    const assistantTexts = new Set<string>();
    for (const msg of messages) {
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            assistantTexts.add(block.text.trim());
          }
        }
      }
    }

    return messages.filter((msg) => {
      if (msg.type === "system" && msg.subtype === "init") return false;
      if (
        msg.type !== "user" &&
        msg.type !== "assistant" &&
        msg.type !== "result"
      )
        return false;
      if (msg.type === "user" && msg.message?.content) {
        if (Array.isArray(msg.message.content)) {
          const hasOnlyToolResults = msg.message.content.every(
            (b: any) => b.type === "tool_result",
          );
          if (hasOnlyToolResults) return false;
        }
      }
      if (msg.type === "result" && msg.result) {
        if (assistantTexts.has(msg.result.trim())) return false;
      }
      return true;
    });
  }, [messages]);

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
        (nativeAgentEnabled ? (
          <NativeOllamaEmptyState />
        ) : (
          <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground text-sm">
            <p className="font-medium text-foreground">Ask about your project</p>
            <p className="text-xs leading-relaxed">
              {chatLabels.emptyStateHint}
            </p>
          </div>
        ))}

      {displayMessages.map((msg, idx) => {
        const rawIndex = messages.indexOf(msg);
        let precedingUserIndex = -1;
        for (let i = rawIndex; i >= 0; i--) {
          if (messages[i]?.type === "user") {
            precedingUserIndex = i;
            break;
          }
        }
        const isLast = idx === displayMessages.length - 1;
        return (
          <div
            key={idx}
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
          <StreamingIndicator startedAt={streamingStartedAt} />
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
    /^\[Compilation errors\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
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
    const [, errorLines, prompt] = compileErrorMatch;
    const errors = errorLines
      .trim()
      .split("\n")
      .map((line) => ({
        message: line.replace(/^- /, ""),
      }));
    return renderErrorBlock(
      `Compilation ${errors.length === 1 ? "Error" : "Errors"}`,
      errors,
      prompt,
    );
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
            autoFocus
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
}> = ({ message, toolResultMap, regenerateIndex, canRegenerate }) => {
  const content = message.message?.content;
  const blocks = Array.isArray(content) ? content : [];

  const copyText = blocks
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n\n");

  // Hook must run unconditionally (before any early return).
  const { eligible, summary, pending, summarize, dismiss } =
    useSummarize(copyText);

  if (blocks.length === 0) return null;

  const hasRenderableContent = blocks.some(
    (block) =>
      (block.type === "text" && block.text) ||
      (block.type === "thinking" && block.thinking) ||
      (block.type === "tool_use" && block.id),
  );

  if (!hasRenderableContent) return null;

  return (
    <div className="fade-in slide-in-from-bottom-1 relative mx-auto w-full animate-in py-3 duration-150">
      <div className="wrap-break-word px-2 text-foreground text-sm leading-relaxed">
        {blocks.map((block, idx) => {
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
              />
            );
          }
          return null;
        })}
      </div>
      {summary && <SummaryCallout summary={summary} onDismiss={dismiss} />}
      <div className="-mb-7.5 ml-2 flex min-h-7.5 items-center gap-1 pt-1.5">
        <MessageActions text={copyText} />
        {eligible && !summary && (
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
      <div className="-mb-7.5 ml-2 flex min-h-7.5 items-center gap-1 pt-1.5">
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
