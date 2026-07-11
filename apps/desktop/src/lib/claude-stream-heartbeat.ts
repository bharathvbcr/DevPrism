import type {
  ClaudeStreamMessage,
  ContentBlock,
} from "@/stores/claude-chat-store";

/** Parse `phase` from a native-agent / CLI stream heartbeat event. */
export function heartbeatPhaseFromMessage(
  msg: ClaudeStreamMessage,
): string | null {
  if (msg.type !== "system" || msg.subtype !== "heartbeat") return null;
  const phase = (msg as { phase?: unknown }).phase;
  return typeof phase === "string" ? phase : null;
}

export function isStreamHeartbeat(msg: ClaudeStreamMessage): boolean {
  return msg.type === "system" && msg.subtype === "heartbeat";
}

function hasThinkingBlock(blocks: ContentBlock[] | undefined): boolean {
  return (
    blocks?.some((block) => block.type === "thinking" && block.thinking) ??
    false
  );
}

/** Infer streaming activity phase from an assistant stream message. */
export function streamActivityPhaseFromMessage(
  msg: ClaudeStreamMessage,
): string | null {
  if (msg.type !== "assistant") return null;
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return null;
  if (blocks.some((block) => block.type === "tool_use")) return "tool";
  if (hasThinkingBlock(blocks)) return "thinking";
  if (blocks.some((block) => block.type === "text" && block.text))
    return "chat";
  return null;
}

/** Human-readable label for the streaming activity indicator. */
export function streamPhaseLabel(
  phase: string | null,
  elapsedSec: number,
): string {
  switch (phase) {
    case "tool":
      return "Running tool…";
    case "ask_user":
      return "Waiting for you…";
    case "thinking":
      return "Thinking…";
    case "chat":
      return "Writing…";
    case "prep":
      return "Preparing…";
    case "retry":
      return "Retrying…";
    default:
      return elapsedSec >= 15 ? "Still working…" : "Thinking…";
  }
}

/** Short phase hint for tab-bar tooltips (no ellipsis). */
export function streamPhaseShortLabel(phase: string | null): string | null {
  switch (phase) {
    case "tool":
      return "tool";
    case "ask_user":
      return "waiting";
    case "thinking":
      return "thinking";
    case "chat":
      return "writing";
    case "prep":
      return "preparing";
    case "retry":
      return "retrying";
    default:
      return null;
  }
}
