import { describe, expect, it } from "vitest";
import {
  classifyOllamaError,
  resolveOllamaCapabilities,
  ollamaModelHeuristics,
} from "@/lib/ollama";

describe("resolveOllamaCapabilities", () => {
  it("prefers API tool/vision flags when present", () => {
    expect(
      resolveOllamaCapabilities("custom-model", { tools: false, vision: true }),
    ).toEqual({
      tools: false,
      vision: true,
      source: "api",
    });
  });

  it("falls back to heuristics when API data is missing", () => {
    const resolved = resolveOllamaCapabilities("llama3.2:latest", {
      tools: null,
      vision: null,
    });
    expect(resolved.source).toBe("heuristic");
    expect(resolved.tools).toBe(ollamaModelHeuristics("llama3.2:latest").tools);
  });

  it("treats unknown models as lacking tools by heuristic", () => {
    expect(resolveOllamaCapabilities("tiny-random-model", null).tools).toBe(
      false,
    );
  });
});

describe("classifyOllamaError", () => {
  it("detects unreachable Ollama", () => {
    expect(
      classifyOllamaError("Could not reach Ollama at http://localhost:11434"),
    ).toMatchObject({ kind: "unreachable" });
  });

  it("prefers the structured code prefix and strips it from the message", () => {
    const classified = classifyOllamaError(
      "[E_NO_TOOLS] The model 'gemma:2b' does not support tool-calling. Pick another.",
    );
    expect(classified).toMatchObject({ kind: "no_tools", model: "gemma:2b" });
    expect(classified.message).not.toContain("[E_NO_TOOLS]");
  });

  it("classifies by code even when the prose has changed entirely", () => {
    expect(
      classifyOllamaError("[E_ALREADY_RUNNING] Reworded text."),
    ).toMatchObject({ kind: "already_running", message: "Reworded text." });
  });

  it("strips unknown codes and falls back to string matching", () => {
    expect(
      classifyOllamaError("[E_FUTURE_CODE] Could not reach Ollama at x"),
    ).toMatchObject({
      kind: "unreachable",
      message: "Could not reach Ollama at x",
    });
  });

  it("detects missing models", () => {
    expect(
      classifyOllamaError(
        "No Ollama model is available. Start Ollama and run ollama pull llama3",
      ),
    ).toMatchObject({ kind: "no_model" });
  });

  it("detects tool-calling failures", () => {
    expect(
      classifyOllamaError(
        "The model 'phi3' does not support tool-calling, which the agent requires.",
      ),
    ).toMatchObject({ kind: "no_tools", model: "phi3" });
  });

  it("classifies tool failures without a quoted model name", () => {
    const c = classifyOllamaError("This model does not support tool use.");
    expect(c.kind).toBe("no_tools");
    expect(c.model).toBeUndefined();
  });

  it("detects vision-capability failures", () => {
    expect(
      classifyOllamaError(
        "This model has no vision support; pick a vision-capable model.",
      ),
    ).toMatchObject({ kind: "no_vision" });
  });

  it("detects an already-running turn by prose fallback", () => {
    expect(
      classifyOllamaError("A native agent is already running in this tab."),
    ).toMatchObject({ kind: "already_running" });
  });

  it("falls back to generic for unrecognized errors", () => {
    expect(classifyOllamaError("Something odd happened.")).toMatchObject({
      kind: "generic",
      message: "Something odd happened.",
    });
  });

  it("classifies a stalled stream by code", () => {
    expect(
      classifyOllamaError(
        "[E_OLLAMA_STALLED] Ollama stopped emitting tokens for 90s",
      ),
    ).toMatchObject({ kind: "stalled" });
  });

  it("classifies an empty (OOM/load-failure) response by code", () => {
    const c = classifyOllamaError(
      "[E_OLLAMA_EMPTY] Ollama returned an empty response (the model may have failed to load)",
    );
    expect(c.kind).toBe("empty");
    expect(c.message).not.toContain("[E_OLLAMA_EMPTY]");
  });
});
