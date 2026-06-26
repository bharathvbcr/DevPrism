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
});
