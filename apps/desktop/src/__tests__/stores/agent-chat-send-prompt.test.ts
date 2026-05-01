import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const { mockDocumentState, getDocumentState, createSnapshotMock } = vi.hoisted(
  () => ({
    mockDocumentState: {} as any,
    getDocumentState: vi.fn(),
    createSnapshotMock: vi.fn(() => Promise.resolve(null)),
  }),
);

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: getDocumentState,
  },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      createSnapshot: createSnapshotMock,
    })),
  },
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      linkedProjects: [
        {
          id: "linked-1",
          name: "Evidence App",
          path: "/linked/evidence-app",
          tech_stack: ["Rust", "React"],
          last_analyzed: null,
          tags: ["agent"],
          role: "Owner",
          description: "Cross-project evidence app",
          notes: "Contains provider orchestration examples",
        },
      ],
      loadLinkedProjects: vi.fn(() => Promise.resolve()),
    })),
  },
}));

import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

function resetAgentChatStore() {
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
    pendingInitialPrompt: null,
    pendingAttachments: [],
    selectedModel: "opus",
    effortLevel: "medium",
    chatMode: "project",
    _cancelledByUser: false,
  });
  useSettingsStore.setState({
    agentProviderSettings: {
      provider: "gemini-cli",
      model: "gemini-1.5-pro",
      backendMode: "cli",
      geminiApiKey: "",
      geminiCliModel: "gemini-1.5-pro",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "llama3",
    },
  });
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

describe("useAgentChatStore.sendPrompt context assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentChatStore();
    setMockDocumentState();
  });

  it("uses a plain file label and full file content for whole-file mentions", async () => {
    const wholeFileText =
      "\\section{Intro}\nThis is the full file.\n\\textbf{Important note}";

    await useAgentChatStore.getState().sendPrompt("Please revise this", {
      label: "@main.tex",
      filePath: "main.tex",
      selectedText: wholeFileText,
    });

    expect(invoke).toHaveBeenCalledWith(
      "execute_agent_code",
      expect.objectContaining({
        projectPath: "/project",
        tabId: "tab-default",
        provider: "gemini-cli",
        backendMode: "cli",
        model: "gemini-1.5-pro",
        prompt: expect.stringContaining("[Selection: @main.tex]"),
      }),
    );

    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any)
      ?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex]");
    expect(prompt).toContain(wholeFileText);

    const userText =
      useAgentChatStore.getState().messages[0].message?.content?.[0].text;
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

    await useAgentChatStore.getState().sendPrompt("Please revise this");

    expect(invoke).toHaveBeenCalledWith(
      "execute_agent_code",
      expect.objectContaining({
        projectPath: "/project",
        tabId: "tab-default",
        prompt: expect.stringContaining("[Selection: @main.tex:2:1-3:6]"),
      }),
    );

    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any)
      ?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex:2:1-3:6]");
    expect(prompt).toContain("[Selected text:\nbeta\ngamma\n]");
    expect(prompt).not.toContain("alpha\na");
    expect(prompt).not.toContain("\ndelta");

    const userText =
      useAgentChatStore.getState().messages[0].message?.content?.[0].text;
    expect(userText).toBe("@main.tex:2:1-3:6\nPlease revise this");
    expect(state.saveAllFiles).not.toHaveBeenCalled();
    expect(createSnapshotMock).toHaveBeenCalledWith(
      "/project",
      "[agent] Before agent edit",
    );
  });

  it("sends active tab provider settings in the backend payload", async () => {
    useAgentChatStore.getState().setTabProviderSettings("tab-default", {
      provider: "ollama",
      model: "codellama",
      backendMode: "local",
      geminiApiKey: "",
      geminiCliModel: "gemini-1.5-pro",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaModel: "codellama",
    });

    await useAgentChatStore.getState().sendPrompt("Use local model");

    expect(invoke).toHaveBeenCalledWith(
      "execute_agent_code",
      expect.objectContaining({
        provider: "ollama",
        backendMode: "local",
        model: "codellama",
        ollamaBaseUrl: "http://127.0.0.1:11434",
      }),
    );
  });

  it("sends Codex CLI provider settings without a Gemini API key", async () => {
    useAgentChatStore.getState().setTabProviderSettings("tab-default", {
      provider: "codex-cli",
      model: "gpt-5.2",
      backendMode: "cli",
      geminiApiKey: "",
      geminiCliModel: "gemini-1.5-pro",
      codexCliModel: "gpt-5.2",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "llama3",
    });

    await useAgentChatStore.getState().sendPrompt("Use Codex CLI");

    expect(invoke).toHaveBeenCalledWith(
      "execute_agent_code",
      expect.objectContaining({
        provider: "codex-cli",
        backendMode: "cli",
        model: "gpt-5.2",
        geminiApiKey: "",
      }),
    );
  });

  it("keeps provider settings when sending from a resumed session", async () => {
    useAgentChatStore.setState((state) => ({
      sessionId: "session-123",
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-default" ? { ...tab, sessionId: "session-123" } : tab,
      ),
    }));

    await useAgentChatStore.getState().sendPrompt("Continue with CLI");

    expect(invoke).toHaveBeenCalledWith(
      "resume_agent_code",
      expect.objectContaining({
        sessionId: "session-123",
        provider: "gemini-cli",
        backendMode: "cli",
        model: "gemini-1.5-pro",
      }),
    );
  });

  it("can reset a tab provider snapshot to current global settings", async () => {
    useAgentChatStore.getState().setTabProviderSettings("tab-default", {
      provider: "ollama",
      model: "llama3",
      backendMode: "local",
      geminiApiKey: "",
      geminiCliModel: "gemini-1.5-pro",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "llama3",
    });
    useSettingsStore.setState({
      agentProviderSettings: {
        provider: "gemini-cli",
        model: "gemini-2.5-pro",
        backendMode: "cli",
        geminiApiKey: "",
        geminiCliModel: "gemini-2.5-flash",
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "llama3",
      },
    });

    useAgentChatStore.getState().useGlobalProviderSettingsForTab("tab-default");

    await useAgentChatStore.getState().sendPrompt("Use imported settings");

    expect(invoke).toHaveBeenCalledWith(
      "execute_agent_code",
      expect.objectContaining({
        provider: "gemini-cli",
        backendMode: "cli",
        model: "gemini-2.5-flash",
      }),
    );
  });

  it("adds linked project context when the tab is in ask-across-projects mode", async () => {
    useAgentChatStore
      .getState()
      .setTabChatMode("tab-default", "linked-projects");

    await useAgentChatStore.getState().sendPrompt("Compare reusable patterns");

    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any)
      ?.prompt as string;
    expect(prompt).toContain("[Chat mode: Ask across linked projects]");
    expect(prompt).toContain("compare_linked_projects");
    expect(prompt).toContain("Evidence App");
    expect(prompt).toContain("/linked/evidence-app");
    expect(prompt).toContain("Compare reusable patterns");
  });
});
