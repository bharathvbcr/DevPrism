import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const { mockDocumentState, getDocumentState, createSnapshotMock } = vi.hoisted(
  () => ({
    mockDocumentState: {} as any,
    getDocumentState: vi.fn(),
    createSnapshotMock: vi.fn(() => Promise.resolve(null)),
  }),
);

vi.mock("@/stores/document-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/document-store")>();
  return {
    ...actual,
    useDocumentStore: {
      getState: getDocumentState,
    },
  };
});

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      createSnapshot: createSnapshotMock,
    })),
  },
}));

import {
  CLAUDE_CODE_PROVIDER_ID,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

function resetClaudeChatStore() {
  useClaudeChatStore.setState({
    messages: [],
    sessionId: null,
    isStreaming: false,
    streamingStartedAt: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    tabs: [
      {
        id: "tab-default",
        title: "New Chat",
        projectPath: "/project",
        sessionId: null,
        providerKey: CLAUDE_CODE_PROVIDER_ID,
        sessionProviderKey: null,
        messages: [],
        isStreaming: false,
        streamingStartedAt: null,
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        draft: { input: "", pinnedContexts: [] },
      },
    ],
    activeTabId: "tab-default",
    activeProjectPath: "/project",
    pendingInitialPrompt: null,
    pendingAttachments: [],
    pendingPinnedContextRemovalLabels: [],
    selectedModel: "opus",
    selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
    selectedProviderModels: {},
    effortLevel: "medium",
    _cancelledTabs: new Set(),
  });
}

function invokeArgs(command: string): any {
  const calls = vi
    .mocked(invoke)
    .mock.calls.filter((call) => call[0] === command);
  return calls[calls.length - 1]?.[1];
}

function setMockDocumentState(overrides: Partial<any> = {}) {
  const content = ["Line 1", "Line 2", "Line 3", "Line 4"].join("\n");

  const state = {
    projectRoot: "/project",
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "/project/main.tex",
        type: "tex",
        content,
        isDirty: false,
      },
    ],
    activeFileId: "main.tex",
    selectionRange: null,
    compileError: null,
    compileErrorCache: new Map(),
    lastCompiledGenerations: new Map(),
    compiledPageCounts: new Map(),
    contentGeneration: 0,
    isCompiling: false,
    saveAllFiles: vi.fn(() => Promise.resolve()),
    refreshFiles: vi.fn(() => Promise.resolve()),
    reloadFile: vi.fn(() => Promise.resolve()),
    ...overrides,
  };

  Object.keys(mockDocumentState).forEach(
    (key) => delete mockDocumentState[key],
  );
  Object.assign(mockDocumentState, state);
  getDocumentState.mockImplementation(() => mockDocumentState);
  return state;
}

describe("useClaudeChatStore.sendPrompt context assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
    resetClaudeChatStore();
    setMockDocumentState();
    useSettingsStore.getState().setNativeAgentEnabled(false);
  });

  it("uses a plain file label and full file content for whole-file mentions", async () => {
    const wholeFileText =
      "\\section{Intro}\nThis is the full file.\n\\textbf{Important note}";

    await useClaudeChatStore.getState().sendPrompt("Please revise this", {
      label: "@main.tex",
      filePath: "main.tex",
      selectedText: wholeFileText,
    });

    expect(invoke).toHaveBeenCalledWith(
      "execute_claude_code",
      expect.objectContaining({
        projectPath: "/project",
        tabId: "tab-default",
        prompt: expect.stringContaining("[Selection: @main.tex]"),
      }),
    );

    const prompt = invokeArgs("execute_claude_code")?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex]");
    expect(prompt).toContain(wholeFileText);

    const userText =
      useClaudeChatStore.getState().messages[0].message?.content?.[0].text;
    expect(userText).toBe("@main.tex\nPlease revise this");
  });

  it("uses a line-range label and only the selected slice for selection context", async () => {
    const state = setMockDocumentState({
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          type: "tex",
          content: "alpha\nbeta\ngamma\ndelta",
          isDirty: false,
        },
      ],
      selectionRange: { start: 6, end: 16 },
    });

    await useClaudeChatStore.getState().sendPrompt("Please revise this");

    expect(invoke).toHaveBeenCalledWith(
      "execute_claude_code",
      expect.objectContaining({
        projectPath: "/project",
        tabId: "tab-default",
        prompt: expect.stringContaining("[Selection: @main.tex:2:1-3:6]"),
      }),
    );

    const prompt = invokeArgs("execute_claude_code")?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex:2:1-3:6]");
    expect(prompt).toContain("[Selected text:\nbeta\ngamma\n]");
    expect(prompt).not.toContain("alpha\na");
    expect(prompt).not.toContain("\ndelta");

    const userText =
      useClaudeChatStore.getState().messages[0].message?.content?.[0].text;
    // Display chip uses a readable line range (the prompt's `[Selection: …]`
    // block above still carries the precise line:col form for the model).
    expect(userText).toBe("@main.tex:2-3\nPlease revise this");
    expect(state.saveAllFiles).not.toHaveBeenCalled();
    expect(createSnapshotMock).toHaveBeenCalledWith(
      "/project",
      "[claude] Before Claude edit",
    );
  });

  it("sends Claude Code when the Claude provider option is selected", async () => {
    useClaudeChatStore.setState({
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
    });

    await useClaudeChatStore.getState().sendPrompt("Use Claude");

    expect(invoke).toHaveBeenCalledWith(
      "execute_claude_code",
      expect.objectContaining({
        providerCredentialId: null,
        providerModelOverride: null,
      }),
    );
  });

  it("starts Claude Code with prior context when switching from a direct provider", async () => {
    useClaudeChatStore.setState((state) => ({
      sessionId: "qwen-session",
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-default"
          ? {
              ...tab,
              sessionId: "qwen-session",
              providerKey: CLAUDE_CODE_PROVIDER_ID,
              sessionProviderKey: "openai-compatible:qwen-cred",
              messages: [
                {
                  type: "user",
                  message: {
                    content: [{ type: "text", text: "Old DS question" }],
                  },
                },
                {
                  type: "assistant",
                  message: {
                    content: [{ type: "text", text: "Old DS answer" }],
                  },
                },
              ],
            }
          : tab,
      ),
    }));

    await useClaudeChatStore.getState().sendPrompt("Use Claude now");

    expect(invoke).toHaveBeenCalledWith(
      "execute_claude_code",
      expect.objectContaining({
        providerCredentialId: null,
        providerModelOverride: null,
        prompt: expect.stringContaining("[Provider switch context]"),
      }),
    );
    const prompt = invokeArgs("execute_claude_code").prompt;
    expect(prompt).toContain("Old DS question");
    expect(prompt).toContain("Old DS answer");
    expect(prompt).toContain("Use Claude now");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "resume_claude_code"),
    ).toBe(false);
  });

  it("keeps the same backend session when switching between OpenAI-compatible providers", async () => {
    useClaudeChatStore.setState((state) => ({
      sessionId: "shared-session",
      selectedProviderCredentialId: "deepseek-cred",
      selectedProviderModels: { "deepseek-cred": "deepseek-chat" },
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-default"
          ? {
              ...tab,
              sessionId: "shared-session",
              providerKey: "openai-compatible:deepseek-cred",
              sessionProviderKey: "openai-compatible:qwen-cred",
            }
          : tab,
      ),
    }));

    await useClaudeChatStore.getState().sendPrompt("Use DeepSeek now");

    expect(invoke).toHaveBeenCalledWith(
      "resume_claude_code",
      expect.objectContaining({
        sessionId: "shared-session",
        providerCredentialId: "deepseek-cred",
        providerModelOverride: "deepseek-chat",
      }),
    );
  });

  it("passes an OpenAI-compatible model override with the provider credential", async () => {
    useClaudeChatStore.getState().setSelectedProviderCredentialId("qwen-cred");
    useClaudeChatStore.setState({
      selectedProviderModels: { "qwen-cred": "qwen3.7-plus" },
    });

    await useClaudeChatStore.getState().sendPrompt("Use Qwen");

    expect(invoke).toHaveBeenCalledWith(
      "execute_claude_code",
      expect.objectContaining({
        providerCredentialId: "qwen-cred",
        providerModelOverride: "qwen3.7-plus",
      }),
    );
  });
});

describe("useClaudeChatStore.resumeSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
    resetClaudeChatStore();
    setMockDocumentState();
    useSettingsStore.getState().setNativeAgentEnabled(false);
  });

  it("restores token totals from loaded session history", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        type: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 11, output_tokens: 7 },
        },
      },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 13, output_tokens: 5 },
      },
    ]);

    await useClaudeChatStore.getState().resumeSession("session-123");

    expect(invoke).toHaveBeenCalledWith("load_session_history", {
      projectPath: "/project",
      sessionId: "session-123",
    });

    const state = useClaudeChatStore.getState();
    expect(state.sessionId).toBe("session-123");
    expect(state.messages).toHaveLength(3);
    expect(state.totalInputTokens).toBe(24);
    expect(state.totalOutputTokens).toBe(12);
  });

  it("does not reuse a tab from another project with the same session id", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        type: "user",
        message: { content: [{ type: "text", text: "from current project" }] },
      },
    ]);

    useClaudeChatStore.setState((state) => {
      const baseTab = state.tabs[0];
      return {
        tabs: [
          {
            ...baseTab,
            id: "tab-current",
            projectPath: "/project",
            sessionId: null,
            messages: [],
          },
          {
            ...baseTab,
            id: "tab-other",
            title: "Other project",
            projectPath: "/other-project",
            sessionId: "shared-session-id",
            messages: [
              {
                type: "user",
                message: {
                  content: [{ type: "text", text: "from another project" }],
                },
              },
            ],
          },
        ],
        activeTabId: "tab-current",
        activeProjectPath: "/project",
        messages: [],
        sessionId: null,
      };
    });

    await useClaudeChatStore.getState().resumeSession("shared-session-id");

    expect(invoke).toHaveBeenCalledWith("load_session_history", {
      projectPath: "/project",
      sessionId: "shared-session-id",
    });

    const state = useClaudeChatStore.getState();
    const otherProjectTab = state.tabs.find((tab) => tab.id === "tab-other");
    expect(state.activeTabId).toBe("tab-current");
    expect(state.activeProjectPath).toBe("/project");
    expect(state.messages[0].message?.content?.[0].text).toBe(
      "from current project",
    );
    expect(otherProjectTab?.messages[0].message?.content?.[0].text).toBe(
      "from another project",
    );
  });

  it("hides internal file and pasted-image context when restoring history", async () => {
    const tempImagePath = [
      "C:\\Temp",
      "DevPrism",
      "chat-pastes",
      "1781110224092-1-paste-1781110223586-1.png",
    ].join("\\");
    const restoredPrompt = [
      "[Currently open file: main.tex]",
      "[Selection: Pasted image]",
      "[Selected text:",
      `[Temporary pasted image: ${tempImagePath}]`,
      "Use this image file as visual context for the user's message.",
      "]",
      "",
      "Please inspect this image",
    ].join("\n");

    vi.mocked(invoke).mockResolvedValueOnce([
      {
        type: "user",
        message: {
          content: restoredPrompt,
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "OK" }],
        },
      },
    ]);

    await useClaudeChatStore.getState().resumeSession("session-with-image");

    const state = useClaudeChatStore.getState();
    const userContent = state.messages[0].message?.content as any;
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);

    expect(userContent).toBe("Pasted image\nPlease inspect this image");
    expect(userContent).not.toContain("[Currently open file:");
    expect(userContent).not.toContain("[Temporary pasted image:");
    expect(activeTab?.title).toBe("Please inspect this image");
  });
});

describe("useClaudeChatStore native agent", () => {
  beforeEach(() => {
    resetClaudeChatStore();
    setMockDocumentState();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
    createSnapshotMock.mockClear();
    useSettingsStore.getState().setNativeAgentEnabled(true);
  });

  afterEach(() => {
    useSettingsStore.getState().setNativeAgentEnabled(false);
  });

  function lastNativeArgs(): any {
    const calls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "run_native_agent");
    return calls[calls.length - 1]?.[1] as any;
  }

  // Use a unique tab id per test so the module-level "seeded" set doesn't leak.
  function useTabWithMessages(id: string, messages: any[]) {
    useClaudeChatStore.setState((s) => ({
      tabs: [{ ...s.tabs[0], id, messages }],
      activeTabId: id,
    }));
  }

  it("seeds the first native turn with prior conversation context", async () => {
    useTabWithMessages("tab-native-seed", [
      {
        type: "user",
        message: { content: [{ type: "text", text: "earlier question" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "earlier answer" }] },
      },
    ]);

    await useClaudeChatStore.getState().sendPrompt("follow up question");
    const first = lastNativeArgs();
    expect(first).toBeTruthy();
    expect(first.prompt).toContain("[Provider switch context]");
    expect(first.prompt).toContain("earlier question");
    expect(first.prompt).toContain("earlier answer");
    expect(first.prompt).toContain("follow up question");

    // A later turn (simulate the previous one finishing) must NOT re-seed.
    useClaudeChatStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === "tab-native-seed" ? { ...t, isStreaming: false } : t,
      ),
    }));
    vi.mocked(invoke).mockClear();
    await useClaudeChatStore.getState().sendPrompt("another question");
    const second = lastNativeArgs();
    expect(second.prompt).not.toContain("[Provider switch context]");
    expect(second.prompt).toContain("another question");
  });

  it("does not seed when the tab has no prior messages", async () => {
    useTabWithMessages("tab-native-empty", []);
    await useClaudeChatStore.getState().sendPrompt("first question");
    const args = lastNativeArgs();
    expect(args).toBeTruthy();
    expect(args.prompt).not.toContain("[Provider switch context]");
    expect(args.prompt).toContain("first question");
  });

  it("forwards the configured native Ollama model", async () => {
    useSettingsStore.getState().setNativeOllamaModel("llama3.2:latest");
    useTabWithMessages("tab-native-model", []);
    await useClaudeChatStore.getState().sendPrompt("hello");
    expect(lastNativeArgs().model).toBe("llama3.2:latest");
    useSettingsStore.getState().setNativeOllamaModel(null);
  });

  it("creates an agent-labelled snapshot before native edits", async () => {
    useTabWithMessages("tab-native-snapshot", []);
    await useClaudeChatStore.getState().sendPrompt("edit the intro");
    expect(createSnapshotMock).toHaveBeenCalledWith(
      "/project",
      "[agent] Before AI edit",
    );
  });

  it("forwards the open editor file so deictic prompts resolve", async () => {
    // setMockDocumentState() (beforeEach) opens main.tex as the active file.
    useTabWithMessages("tab-native-activefile", []);
    await useClaudeChatStore.getState().sendPrompt("fix this paragraph");
    expect(lastNativeArgs().activeFile).toBe("main.tex");
  });

  it("forwards null when no editor file is open", async () => {
    setMockDocumentState({ activeFileId: "" });
    useTabWithMessages("tab-native-noactive", []);
    await useClaudeChatStore.getState().sendPrompt("hello");
    expect(lastNativeArgs().activeFile).toBeNull();
  });

  it("forwards the selected text so 'this paragraph' is precise", async () => {
    // The mock file content is "Line 1\nLine 2\n…"; select the first line.
    setMockDocumentState({ selectionRange: { start: 0, end: 6 } });
    useTabWithMessages("tab-native-selection", []);
    await useClaudeChatStore.getState().sendPrompt("fix this");
    expect(lastNativeArgs().selection).toBe("Line 1");
  });

  it("forwards null selection when nothing is selected", async () => {
    setMockDocumentState({ selectionRange: null });
    useTabWithMessages("tab-native-nosel", []);
    await useClaudeChatStore.getState().sendPrompt("hi");
    expect(lastNativeArgs().selection).toBeNull();
  });

  it("sends the raw prompt (no '[Currently open file]' ctx) — single path", async () => {
    // File + selection ride the structured channel, not the user prompt, so the
    // same context isn't embedded twice (and can't go stale in history).
    setMockDocumentState({ selectionRange: { start: 0, end: 6 } });
    useTabWithMessages("tab-native-noctx", []);
    await useClaudeChatStore.getState().sendPrompt("fix this");
    const args = lastNativeArgs();
    expect(args.prompt).toBe("fix this");
    expect(args.prompt).not.toContain("[Currently open file");
    expect(args.selection).toBe("Line 1");
    expect(args.activeFile).toBe("main.tex");
  });

  it("prefers the toolbar's explicit context over the live selection", async () => {
    // The toolbar clears the live selection on dismiss, so its explicit
    // selectedText must win even though selectionRange still points elsewhere.
    setMockDocumentState({ selectionRange: { start: 0, end: 6 } });
    useTabWithMessages("tab-native-ctxoverride", []);
    await useClaudeChatStore.getState().sendPrompt("Proofread this", {
      label: "main.tex:1:1-1:20",
      selectedText: "explicit toolbar selection",
    } as any);
    expect(lastNativeArgs().selection).toBe("explicit toolbar selection");
  });

  it("forwards the selection's line range from live offsets", async () => {
    // Content "Line 1\nLine 2\nLine 3\nLine 4"; offsets 7..13 cover "Line 2".
    setMockDocumentState({ selectionRange: { start: 7, end: 13 } });
    useTabWithMessages("tab-native-lines", []);
    await useClaudeChatStore.getState().sendPrompt("rewrite this");
    const args = lastNativeArgs();
    expect(args.selectionStartLine).toBe(2);
    expect(args.selectionEndLine).toBe(2);
  });

  it("derives the line range from a toolbar selection by locating it", async () => {
    // No live selection; the unique selectedText is found in the content.
    setMockDocumentState({ selectionRange: null });
    useTabWithMessages("tab-native-locate", []);
    await useClaudeChatStore.getState().sendPrompt("fix", {
      label: "main.tex",
      selectedText: "Line 3",
    } as any);
    const args = lastNativeArgs();
    expect(args.selection).toBe("Line 3");
    expect(args.selectionStartLine).toBe(3);
    expect(args.selectionEndLine).toBe(3);
  });

  it("leaves the line range null when nothing is selected", async () => {
    setMockDocumentState({ selectionRange: null });
    useTabWithMessages("tab-native-noline", []);
    await useClaudeChatStore.getState().sendPrompt("hi");
    const args = lastNativeArgs();
    expect(args.selectionStartLine).toBeNull();
    expect(args.selectionEndLine).toBeNull();
  });

  function lastUserText(tabId: string): string {
    const tab = useClaudeChatStore.getState().tabs.find((t) => t.id === tabId);
    const last = [...(tab?.messages ?? [])]
      .reverse()
      .find((m) => m.type === "user");
    const c = last?.message?.content as any;
    return Array.isArray(c) ? (c[0]?.text ?? "") : (c ?? "");
  }

  it("shows the active-file chip even without a selection (native)", async () => {
    setMockDocumentState({ selectionRange: null });
    useTabWithMessages("tab-native-chip", []);
    await useClaudeChatStore.getState().sendPrompt("fix this");
    // A leading "@file" line is rendered as a context chip by the UI.
    expect(lastUserText("tab-native-chip")).toBe("@main.tex\nfix this");
  });

  it("shows the selected line range in the chip", async () => {
    // Content "Line 1\nLine 2\n…"; offsets 7..13 cover line 2 only.
    setMockDocumentState({ selectionRange: { start: 7, end: 13 } });
    useTabWithMessages("tab-native-chiplines", []);
    await useClaudeChatStore.getState().sendPrompt("rewrite this");
    expect(lastUserText("tab-native-chiplines")).toBe(
      "@main.tex:2\nrewrite this",
    );
  });

  it("shows a multi-line range in the chip", async () => {
    // Offsets 0..13 span lines 1-2.
    setMockDocumentState({ selectionRange: { start: 0, end: 13 } });
    useTabWithMessages("tab-native-chiprange", []);
    await useClaudeChatStore.getState().sendPrompt("tighten this");
    expect(lastUserText("tab-native-chiprange")).toBe(
      "@main.tex:1-2\ntighten this",
    );
  });
});
