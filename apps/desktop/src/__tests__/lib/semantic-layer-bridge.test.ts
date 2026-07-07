import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearSemanticTurn,
  completeSemanticTurn,
  trackSemanticTurn,
} from "@/lib/semantic-layer-bridge";
import { clearSemanticCache } from "@/lib/semantic-layer";
import { useSettingsStore } from "@/stores/settings-store";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";

vi.mock("@/lib/ai-assist", () => ({
  aiEmbed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
}));

describe("semantic-layer-bridge turn tracking", () => {
  beforeEach(() => {
    clearSemanticCache();
    clearSemanticTurn("tab-1");
    useSettingsStore.setState({
      semanticLayerEnabled: true,
      semanticCacheEnabled: true,
      semanticRouterEnabled: false,
      semanticCompressorEnabled: false,
    });
  });

  it("stores a tracked turn after successful completion", async () => {
    trackSemanticTurn("tab-1", { prompt: "hello world" });

    const messages: ClaudeStreamMessage[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "cached later" }],
        },
      },
    ];

    await completeSemanticTurn("tab-1", messages, true);

    const { runWithSemanticLayer } = await import("@/lib/semantic-layer");
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const { result, cacheHit } = await runWithSemanticLayer(
      { prompt: "hello world" },
      async () => "fresh",
      embed,
    );

    expect(result).toBe("cached later");
    expect(cacheHit).toBe(true);
  });

  it("skips store when the turn failed", async () => {
    trackSemanticTurn("tab-1", { prompt: "hello world" });

    await completeSemanticTurn(
      "tab-1",
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "ignored" }] },
        },
      ],
      false,
    );

    const { runWithSemanticLayer } = await import("@/lib/semantic-layer");
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const { cacheHit } = await runWithSemanticLayer(
      { prompt: "hello world" },
      async () => "fresh",
      embed,
    );

    expect(cacheHit).toBe(false);
  });
});
