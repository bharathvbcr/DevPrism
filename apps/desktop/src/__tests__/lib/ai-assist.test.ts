import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  extractGrammarSpan,
  extractProseContext,
  parseCompileErrorLine,
  lineOffsets,
  resolveAiProvider,
  canUseAiAssist,
} from "@/lib/ai-assist";
import {
  CLAUDE_CODE_PROVIDER_ID,
  CURSOR_CLI_PROVIDER_ID,
} from "@/stores/claude-chat-store";

vi.mock("@/stores/claude-chat-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/claude-chat-store")>();
  return {
    ...actual,
    useClaudeChatStore: {
      getState: vi.fn(() => ({
        selectedProviderCredentialId: actual.CLAUDE_CODE_PROVIDER_ID,
        selectedProviderModels: {},
      })),
    },
  };
});

vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      aiAssistEnabled: true,
      nativeAgentEnabled: false,
      nativeNumCtx: null,
      nativeTemperature: null,
      nativeOllamaModel: null,
    })),
  },
}));

vi.mock("@/stores/claude-setup-store", () => ({
  useClaudeSetupStore: {
    getState: vi.fn(() => ({
      openAiCredentials: [],
    })),
  },
}));

describe("resolveAiProvider CLI backends", () => {
  beforeEach(async () => {
    const { useClaudeChatStore } = await import("@/stores/claude-chat-store");
    vi.mocked(useClaudeChatStore.getState).mockReturnValue({
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      selectedProviderModels: {},
    } as never);
  });

  it("routes Claude Code sentinel to claude-code backend", async () => {
    const { useClaudeChatStore } = await import("@/stores/claude-chat-store");
    vi.mocked(useClaudeChatStore.getState).mockReturnValue({
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      selectedProviderModels: {},
    } as never);
    const cfg = resolveAiProvider();
    expect(cfg.backend).toBe("claude-code");
    expect(cfg.providerCredentialId).toBe(CLAUDE_CODE_PROVIDER_ID);
    expect(canUseAiAssist()).toBe(true);
  });

  it("routes Cursor sentinel to cursor-cli backend", async () => {
    const { useClaudeChatStore } = await import("@/stores/claude-chat-store");
    vi.mocked(useClaudeChatStore.getState).mockReturnValue({
      selectedProviderCredentialId: CURSOR_CLI_PROVIDER_ID,
      selectedProviderModels: {},
    } as never);
    const cfg = resolveAiProvider();
    expect(cfg.backend).toBe("cursor-cli");
    expect(cfg.providerCredentialId).toBe(CURSOR_CLI_PROVIDER_ID);
    expect(canUseAiAssist()).toBe(true);
  });

  it("falls back to Ollama when selected credential is stale/missing", async () => {
    const { useClaudeChatStore } = await import("@/stores/claude-chat-store");
    const { useSettingsStore } = await import("@/stores/settings-store");
    vi.mocked(useClaudeChatStore.getState).mockReturnValue({
      selectedProviderCredentialId: "missing-cred-id",
      selectedProviderModels: {},
    } as never);
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      aiAssistEnabled: true,
      nativeAgentEnabled: true,
      nativeNumCtx: null,
      nativeTemperature: null,
      nativeOllamaModel: "llama3.2",
    } as never);
    const cfg = resolveAiProvider();
    expect(cfg.backend).toBe("ollama");
    expect(canUseAiAssist()).toBe(true);
  });
});

describe("extractProseContext", () => {
  it("returns prose prefix when cursor is in body text", () => {
    const doc = "\\section{Intro}\nWe built a system that ";
    const { prefix, inProse } = extractProseContext(doc, doc.length);
    expect(inProse).toBe(true);
    expect(prefix).toContain("We built a system that");
  });

  it("skips when cursor is inside a command name", () => {
    const doc = "Hello \\textbf";
    const { inProse } = extractProseContext(doc, doc.length);
    expect(inProse).toBe(false);
  });
});

describe("extractGrammarSpan", () => {
  it("returns the current line for prose", () => {
    const doc = "Line one\nThis sentance has a typo\nLine three";
    const pos = doc.indexOf("sentance");
    const span = extractGrammarSpan(doc, pos);
    expect(span?.text).toContain("sentance");
    expect(span?.from).toBe(doc.indexOf("This"));
  });

  it("ignores LaTeX structure lines", () => {
    const doc = "\\section{Methods}\n";
    const span = extractGrammarSpan(doc, 5);
    expect(span).toBeNull();
  });
});

describe("parseCompileErrorLine", () => {
  it("parses l.NN from LaTeX logs", () => {
    expect(
      parseCompileErrorLine("! Undefined control sequence. l.42 \\foo"),
    ).toBe(42);
    expect(parseCompileErrorLine("no line here")).toBeNull();
  });
});

describe("lineOffsets", () => {
  it("returns character range for a 1-based line", () => {
    const doc = "one\ntwo\nthree";
    const span = lineOffsets(doc, 2);
    expect(span?.text).toBe("two");
    expect(doc.slice(span!.from, span!.to)).toBe("two");
  });
});
