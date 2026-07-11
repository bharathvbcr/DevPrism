import { describe, expect, it } from "vitest";
import { AGENT_BACKENDS } from "@/lib/agent-backend";
import {
  getBackendIconSrc,
  getProviderDisplayName,
  getProviderIconSrc,
} from "@/lib/provider-icons";

describe("getProviderDisplayName", () => {
  it("derives provider names from old custom labels", () => {
    expect(
      getProviderDisplayName({
        label: "Custom OpenAI API",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.7-plus",
      }),
    ).toBe("Qwen");

    expect(
      getProviderDisplayName({
        label: "Custom OpenAI API",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-5.1",
      }),
    ).toBe("GLM");
  });

  it("keeps meaningful provider labels for unknown endpoints", () => {
    expect(
      getProviderDisplayName({
        label: "Acme AI",
        baseUrl: "https://models.example.test/v1",
        model: "acme-large",
      }),
    ).toBe("Acme AI");
  });

  it("recognizes local Ollama endpoints", () => {
    const provider = {
      label: "Custom OpenAI API",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
    };

    expect(getProviderDisplayName(provider)).toBe("Ollama");
    expect(getProviderIconSrc(provider)).toContain("ollama");
  });

  it("recognizes OpenRouter endpoints without confusing them for OpenAI", () => {
    const provider = {
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o",
    };

    expect(getProviderDisplayName(provider)).toBe("OpenRouter");
    expect(getProviderIconSrc(provider)?.toLowerCase()).toContain("openrouter");
  });

  it("maps Groq to its own icon, not OpenRouter", () => {
    const provider = {
      id: "groq",
      label: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    };

    expect(getProviderDisplayName(provider)).toBe("Groq");
    expect(getProviderIconSrc(provider)?.toLowerCase()).toContain("groq");
    expect(getProviderIconSrc(provider)?.toLowerCase()).not.toContain(
      "openrouter",
    );
  });

  it("maps Cursor CLI to its own icon", () => {
    const provider = {
      id: "cursor-cli",
      label: "Cursor",
      model: "cursor-agent",
    };

    expect(getProviderDisplayName(provider)).toBe("Cursor");
    expect(getProviderIconSrc(provider)?.toLowerCase()).toContain("cursor");
  });
});

describe("getBackendIconSrc", () => {
  it("returns an icon for every agent backend", () => {
    for (const backend of AGENT_BACKENDS) {
      expect(getBackendIconSrc(backend.id)).toBeTruthy();
    }
  });

  it("maps backends to the expected provider icons", () => {
    expect(getBackendIconSrc("native-ollama")).toBe(
      getProviderIconSrc({ label: "Ollama" }),
    );
    expect(getBackendIconSrc("native-groq")).toBe(
      getProviderIconSrc({ label: "Groq" }),
    );
    expect(getBackendIconSrc("native-api")).toBe(
      getProviderIconSrc({ label: "OpenAI" }),
    );
    expect(getBackendIconSrc("claude-code")).toBe(
      getProviderIconSrc({ label: "Anthropic" }),
    );
    expect(getBackendIconSrc("cursor-cli")).toBe(
      getProviderIconSrc({ label: "Cursor" }),
    );
  });
});
