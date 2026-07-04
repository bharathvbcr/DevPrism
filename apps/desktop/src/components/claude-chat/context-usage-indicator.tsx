import { useMemo } from "react";
import { AlertTriangleIcon } from "lucide-react";
import {
  useClaudeChatStore,
  messageContentText,
  type ClaudeStreamMessage,
} from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";

// Fallback only: old persisted histories predate the structured
// `subtype: "context_compaction"` marker and carry just the text.
const CONTEXT_WARNING_RE = /reached ~80% of the model's context limit/i;

// Context window for the Claude CLI path. Current Claude models share a
// 200k-token window; used as the meter denominator when the native
// (Ollama) agent is off.
const CLAUDE_CONTEXT_TOKENS = 200_000;

function latestPromptTokens(messages: ClaudeStreamMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const usage = msg.usage ?? msg.message?.usage;
    if (!usage) continue;
    // Cache reads/writes count toward the context window even though
    // input_tokens excludes them (Claude path with prompt caching).
    const input =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    if (input > 0) return input;
  }
  return 0;
}

function hasContextCompactionWarning(messages: ClaudeStreamMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== "assistant") continue;
    // Structured marker emitted by the native agent since the compaction
    // message got a machine-readable subtype.
    if (msg.subtype === "context_compaction") return true;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string" &&
        CONTEXT_WARNING_RE.test(block.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

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

/** Context-window fill for the active chat tab (Ollama or Claude path). */
export function ContextUsageIndicator({
  modelContextLength,
}: {
  /**
   * The selected model's real max context (from /api/show). Ollama silently
   * caps num_ctx at this, so the meter uses min(setting, model limit) —
   * otherwise a setting above the model's limit over-reports headroom.
   */
  modelContextLength?: number | null;
}) {
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const numCtxSetting = useSettingsStore((s) => s.nativeNumCtx);
  const messages = useClaudeChatStore((s) => s.messages);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);

  const promptTokens = useMemo(() => latestPromptTokens(messages), [messages]);
  const compactionWarning = useMemo(
    () => hasContextCompactionWarning(messages),
    [messages],
  );
  const compactionDetail = useMemo(() => {
    if (!compactionWarning) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== "assistant") continue;
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          block?.type === "text" &&
          typeof block.text === "string" &&
          CONTEXT_WARNING_RE.test(block.text)
        ) {
          const m = block.text.match(/(\d[\d,]*)\s+of\s+(\d[\d,]*)\s+tokens/i);
          if (m) {
            return {
              used: Number.parseInt(m[1].replace(/,/g, ""), 10),
              limit: Number.parseInt(m[2].replace(/,/g, ""), 10),
            };
          }
        }
      }
    }
    return null;
  }, [compactionWarning, messages]);
  const truncation = useMemo(
    () => latestContextTruncation(messages),
    [messages],
  );

  const modelCapped =
    nativeAgentEnabled &&
    modelContextLength != null &&
    modelContextLength > 0 &&
    modelContextLength < numCtxSetting;
  // Native (Ollama) path: min(configured num_ctx, model's real window).
  // Claude path: the CLI's models share a ~200k window.
  const numCtx = nativeAgentEnabled
    ? modelCapped
      ? modelContextLength
      : numCtxSetting
    : CLAUDE_CONTEXT_TOKENS;

  if (numCtx <= 0) return null;

  const ratio = promptTokens > 0 ? promptTokens / numCtx : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const nearLimit = compactionWarning || ratio >= 0.8 || truncation != null;
  const showBar = promptTokens > 0 || compactionWarning || truncation != null;

  if (!showBar && !isStreaming) return null;

  const usageLabel =
    (promptTokens > 0
      ? `${promptTokens.toLocaleString()} / ${numCtx.toLocaleString()} context tokens`
      : `Context window: ${numCtx.toLocaleString()} tokens`) +
    (modelCapped
      ? ` (model limit; setting is ${numCtxSetting.toLocaleString()})`
      : "");

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={usageLabel}
      className={cn(
        "flex min-w-0 max-w-[11rem] flex-col gap-0.5",
        nearLimit && "text-warning",
      )}
      title={usageLabel}
    >
      <div className="flex items-center gap-1.5 text-[10px] leading-none">
        {nearLimit && <AlertTriangleIcon className="size-3 shrink-0" />}
        <span className="truncate tabular-nums">
          {promptTokens > 0 ? (
            <>
              {promptTokens.toLocaleString()}
              <span className="text-muted-foreground/70">
                {" "}
                / {numCtx.toLocaleString()}
              </span>
            </>
          ) : isStreaming ? (
            <span className="text-muted-foreground">Context…</span>
          ) : null}
        </span>
      </div>
      {showBar && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              nearLimit ? "bg-warning" : "bg-primary/60",
            )}
            style={{ width: `${Math.max(pct, compactionWarning ? 80 : 2)}%` }}
          />
        </div>
      )}
      {compactionWarning && (
        <span className="truncate text-[9px] text-warning/90">
          {compactionDetail
            ? `Older context compacted (${compactionDetail.used.toLocaleString()} / ${compactionDetail.limit.toLocaleString()} tokens)`
            : "Older context compacted"}
        </span>
      )}
      {truncation && (
        <span
          className="truncate text-[9px] text-warning/90"
          title={truncation.dropped.join(", ")}
        >
          Dropped: {truncation.dropped.join(", ")}
        </span>
      )}
    </div>
  );
}
