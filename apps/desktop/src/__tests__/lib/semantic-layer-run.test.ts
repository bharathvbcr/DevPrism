import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearSemanticCache, runWithSemanticLayer } from "@/lib/semantic-layer";
import { useSettingsStore } from "@/stores/settings-store";

describe("runWithSemanticLayer", () => {
  beforeEach(() => {
    clearSemanticCache();
    useSettingsStore.setState({
      semanticLayerEnabled: false,
      semanticCacheEnabled: true,
      semanticRouterEnabled: false,
      semanticCompressorEnabled: false,
    });
  });

  it("calls infer when semantic layer is disabled", async () => {
    const embed = vi.fn(async () => [[1, 0, 0]]);
    const infer = vi.fn(async () => "fresh");

    const { result, cacheHit } = await runWithSemanticLayer(
      { prompt: "hello", defaultModel: "llama3" },
      infer,
      embed,
    );

    expect(result).toBe("fresh");
    expect(cacheHit).toBe(false);
    expect(infer).toHaveBeenCalledOnce();
    expect(embed).not.toHaveBeenCalled();
  });

  it("forwards onCachedResult for cache hits", async () => {
    useSettingsStore.setState({ semanticLayerEnabled: true });
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const onCachedResult = vi.fn();

    await runWithSemanticLayer(
      { prompt: "first query", defaultModel: "llama3" },
      async () => "stored answer",
      embed,
    );

    const { result, cacheHit } = await runWithSemanticLayer(
      { prompt: "first query", defaultModel: "llama3" },
      async () => "should not run",
      embed,
      { onCachedResult },
    );

    expect(result).toBe("stored answer");
    expect(cacheHit).toBe(true);
    expect(onCachedResult).toHaveBeenCalledWith("stored answer");
  });

  it("skips router when skipRouter is set", async () => {
    useSettingsStore.setState({
      semanticLayerEnabled: true,
      semanticRouterEnabled: true,
      semanticLightModel: "phi3:mini",
    });
    const embed = vi.fn(async () => [[1, 0, 0]]);
    const infer = vi.fn(async (prepared: { model: string | null }) => {
      expect(prepared.model).toBe("llama3");
      return "ok";
    });

    await runWithSemanticLayer(
      { prompt: "fix typo", defaultModel: "llama3", skipRouter: true },
      infer,
      embed,
    );

    expect(infer).toHaveBeenCalledOnce();
  });
});
