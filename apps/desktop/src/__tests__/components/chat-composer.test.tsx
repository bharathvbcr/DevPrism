import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/agent-chat/chat-composer";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

describe("ChatComposer provider and chat mode controls", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useDocumentStore.setState({
      projectRoot: "/project",
      files: [],
      activeFileId: null,
      selectionRange: null,
      pendingAttachments: [],
    } as any);
    useSettingsStore.setState({
      agentProviderSettings: {
        provider: "gemini-api",
        model: "gemini-1.5-pro",
        backendMode: "api",
        geminiApiKey: "",
        geminiCliModel: "gemini-1.5-pro",
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "llama3",
      },
    });
    useAgentChatStore.setState({
      messages: [],
      sessionId: null,
      isStreaming: false,
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tabs: [
        {
          id: "tab-default",
          title: "New Chat",
          sessionId: null,
          messages: [],
          isStreaming: false,
          error: null,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          draft: { input: "", pinnedContexts: [] },
          chatMode: "project",
        },
      ],
      activeTabId: "tab-default",
      chatMode: "project",
      selectedModel: "gemini-1.5-pro",
      effortLevel: "medium",
      pendingAttachments: [],
    } as any);
    await act(async () => {
      root.render(<ChatComposer isOpen={true} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("opens the provider picker and selects Ollama", async () => {
    const providerButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Gemini API"),
    ) as HTMLButtonElement;
    expect(providerButton).toBeTruthy();

    await act(async () => providerButton.click());
    const ollamaButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((button) =>
      button.textContent?.includes("Ollama"),
    ) as HTMLButtonElement;
    expect(ollamaButton).toBeTruthy();

    await act(async () => ollamaButton.click());

    expect(
      useAgentChatStore.getState().tabs[0].agentProviderSettings?.provider,
    ).toBe("ollama");
  });

  it("toggles ask-across-linked-projects mode", async () => {
    const modeButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Current project only"),
    ) as HTMLButtonElement;
    expect(modeButton).toBeTruthy();

    await act(async () => modeButton.click());

    expect(useAgentChatStore.getState().chatMode).toBe("linked-projects");
  });
});
