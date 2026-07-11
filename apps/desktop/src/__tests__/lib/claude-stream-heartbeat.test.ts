import { describe, expect, it } from "vitest";
import {
  heartbeatPhaseFromMessage,
  isStreamHeartbeat,
  streamActivityPhaseFromMessage,
  streamPhaseLabel,
  streamPhaseShortLabel,
} from "@/lib/claude-stream-heartbeat";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
describe("claude-stream-heartbeat", () => {
  it("detects heartbeat messages", () => {
    expect(isStreamHeartbeat({ type: "system", subtype: "heartbeat" })).toBe(
      true,
    );
    expect(isStreamHeartbeat({ type: "system", subtype: "init" })).toBe(false);
    expect(isStreamHeartbeat({ type: "assistant" })).toBe(false);
  });

  it("parses heartbeat phase and detail", () => {
    const msg = {
      type: "system",
      subtype: "heartbeat",
      phase: "tool",
      detail: "Bash",
    } as ClaudeStreamMessage & { phase: string; detail: string };
    expect(heartbeatPhaseFromMessage(msg)).toBe("tool");
  });

  it("returns null phase for malformed heartbeats", () => {
    expect(
      heartbeatPhaseFromMessage({ type: "system", subtype: "heartbeat" }),
    ).toBeNull();
    expect(heartbeatPhaseFromMessage({ type: "assistant" })).toBeNull();
  });

  it("detects thinking and tool activity phases from assistant messages", () => {
    expect(
      streamActivityPhaseFromMessage({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Reasoning…" }],
        },
      }),
    ).toBe("thinking");

    expect(
      streamActivityPhaseFromMessage({
        type: "assistant",
        subtype: "streaming_delta",
        message: {
          content: [
            { type: "thinking", thinking: "Step 1" },
            { type: "text", text: "Hi" },
          ],
        },
      }),
    ).toBe("thinking");

    expect(
      streamActivityPhaseFromMessage({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
      }),
    ).toBe("tool");

    expect(
      streamActivityPhaseFromMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      }),
    ).toBe("chat");
  });

  it("labels streaming phases for the indicator", () => {
    expect(streamPhaseLabel("thinking", 0)).toBe("Thinking…");
    expect(streamPhaseLabel("chat", 0)).toBe("Writing…");
    expect(streamPhaseLabel("tool", 0)).toBe("Running tool…");
    expect(streamPhaseLabel("prep", 0)).toBe("Preparing…");
    expect(streamPhaseLabel("retry", 0)).toBe("Retrying…");
    expect(streamPhaseLabel(null, 20)).toBe("Still working…");
  });

  it("provides short tab-bar phase hints", () => {
    expect(streamPhaseShortLabel("thinking")).toBe("thinking");
    expect(streamPhaseShortLabel("chat")).toBe("writing");
    expect(streamPhaseShortLabel(null)).toBeNull();
  });
});
