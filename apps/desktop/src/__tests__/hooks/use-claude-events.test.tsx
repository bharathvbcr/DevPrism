import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { renderHook, waitFor } from "@testing-library/react";

const {
  createSnapshotMock,
  completeSemanticTurnMock,
  compileTargetToPdfMock,
  sendPromptMock,
} = vi.hoisted(() => ({
  createSnapshotMock: vi.fn(() => Promise.resolve()),
  completeSemanticTurnMock: vi.fn(() => Promise.resolve()),
  compileTargetToPdfMock: vi.fn(() => Promise.resolve(new Uint8Array([1]))),
  sendPromptMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: () => ({
      init: vi.fn(() => Promise.resolve()),
      loadSnapshots: vi.fn(() => Promise.resolve()),
      createSnapshot: createSnapshotMock,
    }),
  },
}));

vi.mock("@/lib/semantic-layer-bridge", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  completeSemanticTurn: completeSemanticTurnMock,
}));

vi.mock("@/lib/project-compile", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  compileTargetToPdf: compileTargetToPdfMock,
}));

import { useClaudeEvents } from "@/hooks/use-claude-events";
import { manviChatStartFailure } from "@/lib/chat-labels";
import {
  useClaudeChatStore,
  type QueuedGuidance,
  type TabState,
} from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

function makeStreamingTab(id: string, queuedGuidance: QueuedGuidance[] = []) {
  const tab: TabState = {
    id,
    title: "Tab",
    projectPath: "/proj",
    sessionId: null,
    providerKey: null,
    sessionProviderKey: null,
    messages: [],
    isStreaming: true,
    streamingStartedAt: Date.now(),
    streamingPhase: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
    queuedGuidance,
    forceQueuedGuidanceOnComplete: false,
    forcedQueuedGuidanceId: null,
    pendingTemporaryFilePaths: [],
  };
  return tab;
}

describe("useClaudeEvents handleComplete refresh resilience", () => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    vi.mocked(listen).mockImplementation(async (event, cb) => {
      handlers.set(event, cb as (event: { payload: unknown }) => void);
      return () => {};
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "scan_project_folder") {
        return Promise.reject(new Error("project folder vanished"));
      }
      return Promise.resolve(null);
    });

    useDocumentStore.setState({
      projectRoot: "/proj",
      files: [],
      folders: [],
      activeFileId: "",
      pdfRevision: 0,
      isCompiling: false,
      pendingRecompile: false,
      initialized: true,
      contentGeneration: 0,
      lastEditedFileId: null,
      compileErrorCache: new Map(),
      lastCompiledGenerations: new Map(),
      compiledPageCounts: new Map(),
    });
    useClaudeChatStore.setState({
      tabs: [],
      activeTabId: "",
      activeProjectPath: "/proj",
      messages: [],
      sessionId: null,
      isStreaming: false,
      streamingStartedAt: null,
      streamingPhase: null,
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      _cancelledTabs: new Set(),
      sendPrompt: sendPromptMock,
    });

    renderHook(() => useClaudeEvents());
    await waitFor(() => expect(handlers.has("claude-complete")).toBe(true));
  });

  afterEach(() => {
    for (const tab of useClaudeChatStore.getState().tabs) {
      useClaudeChatStore.getState()._clearStreamWatchdog(tab.id);
    }
  });

  function fireComplete(tabId: string, success = true) {
    const handler = handlers.get("claude-complete");
    expect(handler).toBeDefined();
    handler!({ payload: { tab_id: tabId, success } });
  }

  it("still resumes queued guidance when refreshFiles fails mid-completion", async () => {
    useClaudeChatStore.setState({
      tabs: [
        makeStreamingTab("tab-guidance", [
          {
            id: "g1",
            prompt: "continue please",
            contextOverride: undefined,
            displayedInChat: true,
            createdAt: 1,
          },
        ]),
      ],
      activeTabId: "tab-guidance",
    });

    fireComplete("tab-guidance");

    await waitFor(() =>
      expect(sendPromptMock).toHaveBeenCalledWith(
        "continue please",
        undefined,
        { tabId: "tab-guidance", preserveTabProvider: true },
      ),
    );
  });

  it("still auto-recompiles when refreshFiles fails with no guidance queued", async () => {
    useDocumentStore.setState({
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/proj/main.tex",
          type: "tex",
          content: "\\documentclass{article}\\begin{document}Hi\\end{document}",
          isDirty: false,
        },
      ],
      activeFileId: "main.tex",
    });
    useClaudeChatStore.setState({
      tabs: [makeStreamingTab("tab-recompile")],
      activeTabId: "tab-recompile",
    });

    fireComplete("tab-recompile");

    await waitFor(() => expect(compileTargetToPdfMock).toHaveBeenCalled());
    expect(useDocumentStore.getState().isCompiling).toBe(false);
  });

  function fireOutput(tabId: string, message: unknown) {
    const handler = handlers.get("claude-output");
    expect(handler).toBeDefined();
    handler!({
      payload: { tab_id: tabId, data: JSON.stringify(message) },
    });
  }

  it("does not cancel a manvi turn when AskUserQuestion arrives", () => {
    useSettingsStore.getState().setAgentBackend("claude-code");
    useClaudeChatStore.setState({
      tabs: [makeStreamingTab("tab-ask")],
      activeTabId: "tab-ask",
    });
    fireOutput("tab-ask", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "AskUserQuestion",
            input: {},
          },
        ],
      },
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "cancel_claude_execution",
      expect.anything(),
    );
  });

  it("cancels the claude cli when AskUserQuestion arrives", () => {
    useSettingsStore.getState().setAgentBackend("claude-code");
    const tab = makeStreamingTab("tab-cli");
    tab.providerKey = "openai-compatible:oa-1";
    useClaudeChatStore.setState({
      tabs: [tab],
      activeTabId: "tab-cli",
    });
    fireOutput("tab-cli", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "AskUserQuestion",
            input: {},
          },
        ],
      },
    });
    expect(invoke).toHaveBeenCalledWith("cancel_claude_execution", {
      tabId: "tab-cli",
    });
  });

  it("names manvi when a claude turn ends before any output", async () => {
    useSettingsStore.getState().setAgentBackend("claude-code");
    useClaudeChatStore.setState({
      tabs: [makeStreamingTab("tab-fail")],
      activeTabId: "tab-fail",
    });
    fireComplete("tab-fail", false);
    await waitFor(() =>
      expect(
        useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-fail")
          ?.error,
      ).toBe(manviChatStartFailure()),
    );
  });
});
