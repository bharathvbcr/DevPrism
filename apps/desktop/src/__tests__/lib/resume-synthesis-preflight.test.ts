import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkSynthesisReadiness,
  clearEmbedProbeCache,
  pendingEmbedCount,
} from "@/lib/resume-synthesis/preflight";
import { CLAUDE_CODE_PROVIDER_ID } from "@/stores/claude-chat-store";

vi.mock("@/lib/ai-assist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-assist")>();
  return {
    ...actual,
    canUseAiAssist: vi.fn(() => true),
    resolveAiProvider: vi.fn(() => ({
      providerCredentialId: "ollama-1",
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
      numCtx: null,
      temperature: null,
      backend: "ollama" as const,
    })),
    aiEmbed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
    aiComplete: vi.fn(async () => "OK"),
  };
});

vi.mock("@/lib/ollama", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ollama")>();
  return {
    ...actual,
    getOllamaStatus: vi.fn(async () => ({
      connected: true,
      baseUrl: "http://localhost:11434",
      version: "0.1",
      totalModels: 2,
      chatModels: 1,
      embeddingModels: 1,
    })),
    getOllamaBaseUrl: vi.fn(() => "http://localhost:11434"),
    resolveOllamaCredential: vi.fn(() => null),
  };
});

vi.mock("@/lib/career", () => ({
  listBlocks: vi.fn(async () => [{ id: "b1" }]),
  countBlocksMissingEmbeddings: vi.fn(async () => 0),
  listKbSources: vi.fn(async () => [{ id: "s1" }]),
  countKbChunksMissingEmbeddings: vi.fn(async () => 0),
}));

vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      aiAssistEnabled: true,
      nativeAgentEnabled: true,
      nativeNumCtx: null,
      nativeTemperature: null,
      nativeOllamaModel: "llama3.2",
    })),
  },
}));

vi.mock("@/stores/claude-setup-store", () => ({
  useClaudeSetupStore: {
    getState: vi.fn(() => ({
      openAiCredentials: [],
      status: "ready",
      claudeProviderConfigured: true,
      checkStatus: vi.fn(async () => {}),
    })),
  },
}));

vi.mock("@/stores/cursor-setup-store", () => ({
  useCursorSetupStore: {
    getState: vi.fn(() => ({
      status: "ready",
      checkStatus: vi.fn(async () => {}),
    })),
  },
}));

vi.mock("@/stores/claude-chat-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/claude-chat-store")>();
  return {
    ...actual,
    useClaudeChatStore: {
      getState: vi.fn(() => ({
        selectedProviderCredentialId: null,
        selectedProviderModels: {},
      })),
    },
  };
});

describe("checkSynthesisReadiness", () => {
  beforeEach(async () => {
    clearEmbedProbeCache();
    vi.clearAllMocks();

    const { canUseAiAssist, resolveAiProvider, aiEmbed } = await import(
      "@/lib/ai-assist"
    );
    vi.mocked(canUseAiAssist).mockReturnValue(true);
    vi.mocked(resolveAiProvider).mockReturnValue({
      providerCredentialId: "ollama-1",
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
      numCtx: null,
      temperature: null,
      backend: "ollama",
    });
    vi.mocked(aiEmbed).mockResolvedValue([[0.1, 0.2, 0.3]]);

    const { getOllamaStatus } = await import("@/lib/ollama");
    vi.mocked(getOllamaStatus).mockResolvedValue({
      connected: true,
      baseUrl: "http://localhost:11434",
      version: "0.1",
      totalModels: 2,
      chatModels: 1,
      embeddingModels: 1,
    });

    const career = await import("@/lib/career");
    vi.mocked(career.listBlocks).mockResolvedValue([{ id: "b1" }] as never);
    vi.mocked(career.countBlocksMissingEmbeddings).mockResolvedValue(0);
    vi.mocked(career.listKbSources).mockResolvedValue([{ id: "s1" }] as never);
    vi.mocked(career.countKbChunksMissingEmbeddings).mockResolvedValue(0);

    const { useSettingsStore } = await import("@/stores/settings-store");
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      aiAssistEnabled: true,
      nativeAgentEnabled: true,
      nativeNumCtx: null,
      nativeTemperature: null,
      nativeOllamaModel: "llama3.2",
    } as never);
  });

  it("reports green when chat, embeddings, and data are ready", async () => {
    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.canRunWithAi).toBe(true);
    expect(readiness.embeddingsDown).toBe(false);
    expect(readiness.text.status).toBe("ok");
    expect(readiness.text.streams).toBe(true);
    expect(readiness.embeddings.status).toBe("ok");
    expect(readiness.data.status).toBe("ok");
    expect(pendingEmbedCount(readiness)).toBe(0);
  });

  it("blocks run when no chat provider is available", async () => {
    const { canUseAiAssist } = await import("@/lib/ai-assist");
    vi.mocked(canUseAiAssist).mockReturnValue(false);

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.canRunWithAi).toBe(false);
    expect(readiness.text.status).toBe("error");
    expect(readiness.text.issue).toBe("no-provider");
  });

  it("distinguishes Ollama unreachable for text generation", async () => {
    const { getOllamaStatus } = await import("@/lib/ollama");
    vi.mocked(getOllamaStatus).mockResolvedValue({
      connected: false,
      baseUrl: "http://localhost:11434",
      version: null,
      totalModels: 0,
      chatModels: 0,
      embeddingModels: 0,
    });

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.canRunWithAi).toBe(false);
    expect(readiness.text.issue).toBe("unreachable");
    expect(readiness.text.status).toBe("error");
  });

  it("distinguishes no chat model when Ollama is up but empty", async () => {
    const { getOllamaStatus } = await import("@/lib/ollama");
    const { resolveAiProvider } = await import("@/lib/ai-assist");
    vi.mocked(resolveAiProvider).mockReturnValue({
      providerCredentialId: "ollama-1",
      model: null,
      baseUrl: "http://localhost:11434",
      numCtx: null,
      temperature: null,
      backend: "ollama",
    });
    vi.mocked(getOllamaStatus).mockResolvedValue({
      connected: true,
      baseUrl: "http://localhost:11434",
      version: "0.1",
      totalModels: 0,
      chatModels: 0,
      embeddingModels: 0,
    });

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.text.issue).toBe("no-model");
    expect(readiness.canRunWithAi).toBe(false);
  });

  it("marks embeddings down on [E_NO_MODEL] without blocking chat", async () => {
    const { aiEmbed } = await import("@/lib/ai-assist");
    vi.mocked(aiEmbed).mockRejectedValue(
      new Error("[E_NO_MODEL] No embedding model installed"),
    );

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.canRunWithAi).toBe(true);
    expect(readiness.embeddingsDown).toBe(true);
    expect(readiness.embeddings.issue).toBe("no-model");
    expect(readiness.embeddings.status).toBe("warn");
  });

  it("marks embeddings unreachable on [E_OLLAMA_UNREACHABLE]", async () => {
    const { aiEmbed } = await import("@/lib/ai-assist");
    vi.mocked(aiEmbed).mockRejectedValue(
      new Error("[E_OLLAMA_UNREACHABLE] Could not reach Ollama"),
    );

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.embeddings.issue).toBe("unreachable");
    expect(readiness.embeddingsDown).toBe(true);
  });

  it("reports streams=false for CLI chat backends", async () => {
    const { resolveAiProvider } = await import("@/lib/ai-assist");
    vi.mocked(resolveAiProvider).mockReturnValue({
      providerCredentialId: CLAUDE_CODE_PROVIDER_ID,
      model: null,
      baseUrl: null,
      numCtx: null,
      temperature: null,
      backend: "claude-code",
    });

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.text.available).toBe(true);
    expect(readiness.text.streams).toBe(false);
    expect(readiness.text.backend).toBe("claude-code");
  });

  it("reports streams=true for openai-compat backends", async () => {
    const { resolveAiProvider } = await import("@/lib/ai-assist");
    vi.mocked(resolveAiProvider).mockReturnValue({
      providerCredentialId: "cred-1",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      numCtx: null,
      temperature: null,
      backend: "openai-compat",
    });
    const { aiComplete } = await import("@/lib/ai-assist");
    vi.mocked(aiComplete).mockResolvedValue("OK");

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.text.available).toBe(true);
    expect(readiness.text.streams).toBe(true);
    expect(readiness.text.backend).toBe("openai-compat");
  });

  it("warns when blocks exist but knowledge is empty / embeds pending", async () => {
    const career = await import("@/lib/career");
    vi.mocked(career.listKbSources).mockResolvedValue([]);
    vi.mocked(career.countBlocksMissingEmbeddings).mockResolvedValue(3);
    vi.mocked(career.countKbChunksMissingEmbeddings).mockResolvedValue(2);

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.data.status).toBe("warn");
    expect(readiness.data.blocksMissingEmbeddings).toBe(3);
    expect(readiness.data.kbChunksMissingEmbeddings).toBe(2);
    expect(pendingEmbedCount(readiness)).toBe(5);
  });

  it("errors data row when there are no experience blocks", async () => {
    const career = await import("@/lib/career");
    vi.mocked(career.listBlocks).mockResolvedValue([]);

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.data.status).toBe("error");
    expect(readiness.data.blockCount).toBe(0);
  });

  it("reports KB source coverage as unknown when the lookup fails", async () => {
    const career = await import("@/lib/career");
    vi.mocked(career.listKbSources).mockRejectedValue(
      new Error("database is locked"),
    );

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.data.kbSourceCount).toBeNull();
    expect(readiness.data.status).toBe("warn");
    expect(readiness.data.message).toMatch(/knowledge source lookup failed/i);
    expect(readiness.data.message).not.toMatch(/no knowledge sources/i);
  });

  it("errors when experience blocks cannot be loaded at all", async () => {
    const career = await import("@/lib/career");
    vi.mocked(career.listBlocks).mockRejectedValue(
      new Error("career db unavailable"),
    );

    const readiness = await checkSynthesisReadiness({ forceEmbedProbe: true });
    expect(readiness.data.blockCount).toBeNull();
    expect(readiness.data.status).toBe("error");
    expect(readiness.data.message).toMatch(/coverage unknown/i);
  });
});
