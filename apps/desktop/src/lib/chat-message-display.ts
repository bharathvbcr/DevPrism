import type {
  ClaudeStreamMessage,
  ContentBlock,
} from "@/stores/claude-chat-store";

/**
 * Pure derivation logic for the chat transcript list.
 *
 * Extracted from `ChatMessages` so the hot path is unit-testable and
 * fuzz-verifiable against a naive reference. The component re-renders these
 * derivations on every streaming delta; everything here is O(messages) with
 * zero allocations on the paths deltas hit most (no result messages yet ⇒ no
 * text scanning; stable tool-result map identity ⇒ memoized bubbles stay
 * mounted).
 */

export interface DisplayEntry {
  msg: ClaudeStreamMessage;
  /** Index into the raw messages array — stable under append-only streams,
   * unlike the position within the filtered list. Used as React key. */
  rawIndex: number;
  /** Nearest user message at or before this one (regenerate anchor). */
  precedingUserIndex: number;
}

/** True when every content block is a tool_result (these render inline in
 * their assistant bubble instead of as standalone user turns). */
export function isToolResultOnlyUserMessage(msg: ClaudeStreamMessage): boolean {
  if (msg.type !== "user") return false;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  return content.every((block) => block.type === "tool_result");
}

/** tool_use_id → its result block, across all user messages. */
export function buildToolResultMap(
  messages: ClaudeStreamMessage[],
): Map<string, ContentBlock> {
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
}

/**
 * Keep the previous map object when contents are identical.
 *
 * The map is rebuilt whenever `messages` changes — which is every streaming
 * delta — but its *contents* only change when a tool result arrives. Reusing
 * the old object keeps `MessageBubble`'s shallow prop comparison stable so
 * memoized bubbles do not all re-render per token.
 */
export function stabilizeToolResultMap(
  prev: Map<string, ContentBlock>,
  next: Map<string, ContentBlock>,
): Map<string, ContentBlock> {
  if (prev.size === next.size) {
    let identical = true;
    for (const [key, value] of next) {
      if (prev.get(key) !== value) {
        identical = false;
        break;
      }
    }
    if (identical) return prev;
  }
  return next;
}

/**
 * Filter to displayable messages with their anchors, in one forward pass.
 *
 * Replaces the previous three-pass shape (Set of every trimmed assistant
 * text + filter + per-entry indexOf/backward scan). Assistant-text collection
 * is gated on any result message existing: during streaming there are none,
 * so the per-delta cost drops from O(total transcript bytes + trim allocs)
 * to a handful of type checks.
 */
export function buildDisplayEntries(
  messages: ClaudeStreamMessage[],
): DisplayEntry[] {
  let hasResultText = false;
  for (const msg of messages) {
    if (msg.type === "result" && typeof msg.result === "string") {
      hasResultText = true;
      break;
    }
  }

  const assistantTexts = new Set<string>();
  if (hasResultText) {
    for (const msg of messages) {
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            assistantTexts.add(block.text.trim());
          }
        }
      }
    }
  }

  const entries: DisplayEntry[] = [];
  let lastUserIndex = -1;

  messages.forEach((msg, rawIndex) => {
    if (msg.type === "user") {
      lastUserIndex = rawIndex;
    }

    if (msg.type === "system" && msg.subtype === "init") return;
    if (
      msg.type === "assistant" &&
      (msg.subtype === "context_truncation" ||
        msg.subtype === "context_compaction")
    ) {
      return;
    }
    if (
      msg.type !== "user" &&
      msg.type !== "assistant" &&
      msg.type !== "result"
    )
      return;
    if (isToolResultOnlyUserMessage(msg)) return;
    if (
      hasResultText &&
      msg.type === "result" &&
      msg.result &&
      assistantTexts.has(msg.result.trim())
    ) {
      return;
    }

    entries.push({ msg, rawIndex, precedingUserIndex: lastUserIndex });
  });

  return entries;
}
