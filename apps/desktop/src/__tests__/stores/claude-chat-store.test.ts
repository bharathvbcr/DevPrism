import { beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_PROVIDER_ID,
  SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY,
  loadSelectedProviderCredentialId,
  offsetToLineCol,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";

beforeEach(() => {
  localStorage.clear();
  useClaudeChatStore.setState({ selectedProviderCredentialId: null });
});

describe("offsetToLineCol", () => {
  it("returns line 1, col 1 for offset 0 on empty string", () => {
    expect(offsetToLineCol("", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns line 1, col 1 for offset 0 on non-empty string", () => {
    expect(offsetToLineCol("hello", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns correct col within a single line", () => {
    expect(offsetToLineCol("hello world", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles offset at end of single line", () => {
    expect(offsetToLineCol("hello", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles multiple lines correctly", () => {
    const content = "line1\nline2\nline3";
    // offset 6 is start of "line2"
    expect(offsetToLineCol(content, 6)).toEqual({ line: 2, col: 1 });
    // offset 11 is end of "line2" (the newline before line3)
    expect(offsetToLineCol(content, 11)).toEqual({ line: 2, col: 6 });
    // offset 12 is start of "line3"
    expect(offsetToLineCol(content, 12)).toEqual({ line: 3, col: 1 });
  });

  it("returns correct position at end of multi-line content", () => {
    const content = "ab\ncd\nef";
    expect(offsetToLineCol(content, 8)).toEqual({ line: 3, col: 3 });
  });

  it("handles content with only newlines", () => {
    expect(offsetToLineCol("\n\n", 1)).toEqual({ line: 2, col: 1 });
    expect(offsetToLineCol("\n\n", 2)).toEqual({ line: 3, col: 1 });
  });
});

describe("provider selection persistence", () => {
  it("persists Claude Code as an explicit provider selection", () => {
    useClaudeChatStore
      .getState()
      .setSelectedProviderCredentialId(CLAUDE_CODE_PROVIDER_ID);

    expect(localStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY)).toBe(
      CLAUDE_CODE_PROVIDER_ID,
    );
    expect(loadSelectedProviderCredentialId()).toBe(CLAUDE_CODE_PROVIDER_ID);
  });

  it("persists and clears OpenAI-compatible provider selections", () => {
    useClaudeChatStore.getState().setSelectedProviderCredentialId("qwen");

    expect(localStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY)).toBe(
      "qwen",
    );

    useClaudeChatStore.getState().setSelectedProviderCredentialId(null);

    expect(
      localStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY),
    ).toBeNull();
    expect(loadSelectedProviderCredentialId()).toBeNull();
  });
});

describe("queued guidance", () => {
  it("queues and consumes guidance for the active tab", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "please focus on the API key deletion flow", {
      label: "@main.tex:1:1-1:8",
      filePath: "main.tex",
      selectedText: "selected",
    });

    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance,
    ).toHaveLength(1);

    const queued = useClaudeChatStore.getState().consumeQueuedGuidance(tabId);
    expect(queued?.prompt).toBe("please focus on the API key deletion flow");
    expect(queued?.contextOverride?.filePath).toBe("main.tex");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance,
    ).toHaveLength(0);
  });

  it("can remove and consume a specific queued guidance item", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "first");
    chat.queueGuidance(tabId, "second");
    chat.queueGuidance(tabId, "third");

    const queue = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance;
    expect(queue?.map((item) => item.prompt)).toEqual([
      "first",
      "second",
      "third",
    ]);

    chat.removeQueuedGuidance(tabId, queue![1].id);
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => item.prompt),
    ).toEqual(["first", "third"]);

    const thirdId = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance?.[1].id;
    const selected = chat.consumeQueuedGuidance(tabId, thirdId);
    expect(selected?.prompt).toBe("third");
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => item.prompt),
    ).toEqual(["first"]);
  });

  it("marks multiple queued guidance items as displayed in chat", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "first");
    chat.queueGuidance(tabId, "second");
    chat.queueGuidance(tabId, "third");

    const queue = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance;
    const secondId = queue?.[1].id;
    const thirdId = queue?.[2].id;

    expect(
      useClaudeChatStore
        .getState()
        .displayQueuedGuidanceInChat(tabId, secondId),
    ).toBe(secondId);
    expect(
      useClaudeChatStore.getState().displayQueuedGuidanceInChat(tabId, thirdId),
    ).toBe(thirdId);

    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => ({
          prompt: item.prompt,
          displayedInChat: item.displayedInChat ?? false,
        })),
    ).toEqual([
      { prompt: "first", displayedInChat: false },
      { prompt: "second", displayedInChat: true },
      { prompt: "third", displayedInChat: true },
    ]);
  });

  it("consumes displayed guidance before ordinary queued guidance", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "first");
    chat.queueGuidance(tabId, "second");

    const secondId = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance?.[1].id;
    useClaudeChatStore.getState().displayQueuedGuidanceInChat(tabId, secondId);

    const selected = chat.consumeQueuedGuidance(tabId);
    expect(selected?.prompt).toBe("second");
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => item.prompt),
    ).toEqual(["first"]);
  });
});
