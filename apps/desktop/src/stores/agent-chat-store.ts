import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "./document-store";
import { useHistoryStore } from "./history-store";
import { useProjectStore } from "./project-store";
import { useSettingsStore, type AgentProviderSettings } from "./settings-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("claude");

/** Convert a character offset to 1-based line:col */
export function offsetToLineCol(
  content: string,
  offset: number,
): { line: number; col: number } {
  const before = content.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// ─── Types ───

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: any;
  // tool_result block
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
  // thinking block
  thinking?: string;
  signature?: string;
}

export interface AgentStreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  message?: {
    content?: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
}

// ─── Tab Types ───

export interface TabDraft {
  input: string;
  pinnedContexts: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
}

export interface TabState {
  id: string;
  title: string;
  sessionId: string | null;
  messages: AgentStreamMessage[];
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  draft: TabDraft;
  agentProviderSettings?: AgentProviderSettings;
  chatMode: "project" | "linked-projects";
}

/** Fields that are projected from the active tab to top-level state */
const TAB_FIELDS = [
  "sessionId",
  "messages",
  "isStreaming",
  "error",
  "totalInputTokens",
  "totalOutputTokens",
  "agentProviderSettings",
  "chatMode",
] as const;

function makeDefaultTab(id: string): TabState {
  return {
    id,
    title: "New Chat",
    sessionId: null,
    messages: [],
    isStreaming: false,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
    chatMode: "project",
  };
}

let tabCounter = 0;
function nextTabId(): string {
  return `tab-${++tabCounter}`;
}

/**
 * Update a specific tab in `tabs[]` and, if that tab is the active tab,
 * also project the changed fields to top-level state for consumer compatibility.
 */
function applyTabUpdate(
  state: AgentChatState,
  tabId: string,
  updates: Partial<TabState>,
): Partial<AgentChatState> {
  const newTabs = state.tabs.map((t) =>
    t.id === tabId ? { ...t, ...updates } : t,
  );
  const result: Partial<AgentChatState> = { tabs: newTabs };
  if (tabId === state.activeTabId) {
    for (const key of TAB_FIELDS) {
      if (key in updates) {
        (result as any)[key] = (updates as any)[key];
      }
    }
  }
  return result;
}

// ─── State Interface ───

const DEFAULT_TAB_ID = nextTabId();

interface AgentChatState {
  // ── Projected fields (from active tab — read by consumers) ──
  messages: AgentStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  agentProviderSettings?: AgentProviderSettings;
  chatMode: "project" | "linked-projects";

  // ── Tab state ──
  tabs: TabState[];
  activeTabId: string;

  /** Deferred prompt to send once the workspace is ready (set by project wizard) */
  pendingInitialPrompt: string | null;
  setPendingInitialPrompt: (prompt: string | null) => void;
  consumePendingInitialPrompt: () => string | null;

  /** Pending attachments from external sources (e.g. PDF capture) */
  pendingAttachments: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
  addPendingAttachment: (attachment: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }) => void;
  consumePendingAttachments: () => {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];

  /** Currently selected model (passed per prompt to the active agent provider) */
  selectedModel:
    | "sonnet"
    | "opus"
    | "haiku"
    | "opusplan"
    | "gemini-1.5-pro"
    | "gemini-1.5-flash"
    | "gemini-cli"
    | "ollama";
  setSelectedModel: (
    model:
      | "sonnet"
      | "opus"
      | "haiku"
      | "opusplan"
      | "gemini-1.5-pro"
      | "gemini-1.5-flash"
      | "gemini-cli"
      | "ollama",
  ) => void;

  /** Effort level for Opus 4.6 adaptive reasoning */
  effortLevel: "low" | "medium" | "high";
  setEffortLevel: (level: "low" | "medium" | "high") => void;

  // Actions
  sendPrompt: (
    userPrompt: string,
    contextOverride?: { label: string; filePath: string; selectedText: string },
  ) => Promise<void>;
  cancelExecution: () => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => Promise<void>;

  // Tab actions
  createTab: () => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  saveDraft: (tabId: string, draft: TabDraft) => void;
  setTabProviderSettings: (
    tabId: string,
    settings: AgentProviderSettings,
  ) => void;
  useGlobalProviderSettingsForTab: (tabId: string) => void;
  setTabChatMode: (tabId: string, mode: "project" | "linked-projects") => void;

  /** True when any tab is streaming */
  anyStreaming: () => boolean;

  // Internal actions (called by event hook, routed by tabId)
  _appendMessage: (tabId: string, msg: AgentStreamMessage) => void;
  _setSessionId: (tabId: string, id: string) => void;
  _setStreaming: (tabId: string, streaming: boolean) => void;
  _setError: (tabId: string, error: string | null) => void;
  _cancelledByUser: boolean;
}

// ─── Store ───

export const useAgentChatStore = create<AgentChatState>()((set, get) => ({
  // Projected fields (initialized from default tab)
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  _cancelledByUser: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  chatMode: "project",

  // Tab state
  tabs: [makeDefaultTab(DEFAULT_TAB_ID)],
  activeTabId: DEFAULT_TAB_ID,

  selectedModel: "gemini-1.5-pro",
  setSelectedModel: (model) => set({ selectedModel: model }),

  effortLevel: "medium",
  setEffortLevel: (level) => set({ effortLevel: level }),

  pendingInitialPrompt: null,
  setPendingInitialPrompt: (prompt) => set({ pendingInitialPrompt: prompt }),
  consumePendingInitialPrompt: () => {
    const { pendingInitialPrompt } = get();
    if (pendingInitialPrompt) {
      set({ pendingInitialPrompt: null });
    }
    return pendingInitialPrompt;
  },

  pendingAttachments: [],
  addPendingAttachment: (attachment) => {
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, attachment],
    }));
  },
  consumePendingAttachments: () => {
    const { pendingAttachments } = get();
    if (pendingAttachments.length > 0) {
      set({ pendingAttachments: [] });
    }
    return pendingAttachments;
  },

  anyStreaming: () => get().tabs.some((t) => t.isStreaming),

  sendPrompt: async (
    userPrompt: string,
    contextOverride?: { label: string; filePath: string; selectedText: string },
  ) => {
    const state = get();
    const { activeTabId } = state;
    const activeTab = state.tabs.find((t) => t.id === activeTabId);
    // Guard: prevent sending from a tab that's already streaming
    if (activeTab?.isStreaming) return;

    const { sessionId, selectedModel, effortLevel } = state;
    const globalProviderSettings =
      useSettingsStore.getState().agentProviderSettings;
    const providerSettings =
      activeTab?.agentProviderSettings || globalProviderSettings;
    const provider = providerSettings.provider;
    const backendMode = providerSettings.backendMode;
    const model =
      provider === "ollama"
        ? providerSettings.ollamaModel
        : provider === "gemini-cli"
          ? (providerSettings.geminiCliModel ?? "gemini-1.5-pro")
          : provider === "gemini-api"
            ? providerSettings.model
            : selectedModel;

    const sendStart = performance.now();
    log.info("sendPrompt start", {
      sessionId: !!sessionId,
      hasContext: !!contextOverride,
      tab: activeTabId,
    });

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set((s) => applyTabUpdate(s, activeTabId, { error: "No project open" }));
      return;
    }

    // Compute context label for display in chat history
    const activeFile = docState.files.find(
      (f) => f.id === docState.activeFileId,
    );
    let contextLabel: string | null = null;

    if (contextOverride) {
      contextLabel = contextOverride.label;
    } else if (activeFile) {
      const selRange = docState.selectionRange;
      if (selRange && activeFile.content) {
        const content = activeFile.content;
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        contextLabel = `@${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}`;
      }
    }

    // Add user message to the list for display (with context label visible)
    const displayText = contextLabel
      ? `${contextLabel}\n${userPrompt}`
      : userPrompt;
    const userMessage: AgentStreamMessage = {
      type: "user",
      message: {
        content: [{ type: "text", text: displayText }],
      },
    };

    // Auto-set tab title from first prompt
    const isFirstMessage = activeTab && activeTab.messages.length === 0;
    const tabTitle = isFirstMessage
      ? userPrompt.slice(0, 40) + (userPrompt.length > 40 ? "..." : "")
      : undefined;

    set((s) => {
      const tabUpdates: Partial<TabState> = {
        messages: [
          ...(s.tabs.find((t) => t.id === activeTabId)?.messages ?? []),
          userMessage,
        ],
        isStreaming: true,
        error: null,
      };
      if (tabTitle) tabUpdates.title = tabTitle;
      return {
        ...applyTabUpdate(s, activeTabId, tabUpdates),
        _cancelledByUser: false,
      };
    });

    // Flush unsaved edits to disk so the agent reads the latest content
    if (docState.files.some((f) => f.isDirty)) {
      log.debug("saving dirty files...");
      await docState.saveAllFiles();
      log.debug("saveAllFiles done");
    }

    // Snapshot before agent edit
    if (projectPath) {
      try {
        log.debug("creating snapshot...");
        await useHistoryStore
          .getState()
          .createSnapshot(projectPath, "[agent] Before agent edit");
        log.debug("snapshot done");
      } catch {
        /* snapshot failure should not block the agent */
      }
    }

    // Build prompt with full context for the active agent provider
    let prompt = userPrompt;
    if (activeFile) {
      const selRange = docState.selectionRange;
      const selectedText =
        selRange && activeFile.content
          ? activeFile.content.slice(selRange.start, selRange.end)
          : null;
      let ctx = `[Currently open file: ${activeFile.relativePath}]`;
      if (contextOverride) {
        ctx += `\n[Selection: ${contextOverride.label}]`;
        ctx += `\n[Selected text:\n${contextOverride.selectedText}\n]`;
      } else if (selectedText && selRange) {
        const content = activeFile.content ?? "";
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        ctx += `\n[Selection: @${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}]`;
        ctx += `\n[Selected text:\n${selectedText}\n]`;
      }
      prompt = `${ctx}\n\n${userPrompt}`;
    }
    if (activeTab?.chatMode === "linked-projects") {
      const projectStore = useProjectStore.getState();
      if (projectStore.linkedProjects.length === 0) {
        await projectStore.loadLinkedProjects();
      }
      const linkedProjects = useProjectStore.getState().linkedProjects;
      const linkedProjectContext = linkedProjects
        .map((project) => {
          const tags =
            project.tags.length > 0 ? ` tags=${project.tags.join(", ")}` : "";
          const stack =
            project.tech_stack.length > 0
              ? ` stack=${project.tech_stack.join(", ")}`
              : "";
          const role = project.role ? ` role=${project.role}` : "";
          return `- ${project.name}: ${project.path}${role}${stack}${tags}`;
        })
        .join("\n");
      prompt = [
        "[Chat mode: Ask across linked projects]",
        "Use list_linked_projects, compare_linked_projects, cross_reference_project, search_linked_project, summarize_project_evidence, and git_insight when useful. Compare across linked projects and cite project names or paths for evidence.",
        linkedProjectContext
          ? `[Linked projects]\n${linkedProjectContext}`
          : "[Linked projects]\nNo linked projects are configured yet. Explain that the user can add projects in Settings > Knowledgebase.",
        prompt,
      ].join("\n\n");
    }
    log.info("invoking CLI", {
      promptLength: prompt.length,
      mode: sessionId ? "resume" : "new",
    });

    try {
      if (sessionId) {
        // Resume existing session
        await invoke("resume_claude_code", {
          projectPath,
          sessionId,
          prompt,
          tabId: activeTabId,
          model,
          effortLevel,
          provider,
          backendMode,
          ollamaBaseUrl: providerSettings.ollamaBaseUrl,
          geminiApiKey: providerSettings.geminiApiKey,
        });
      } else {
        // New session
        await invoke("execute_claude_code", {
          projectPath,
          prompt,
          tabId: activeTabId,
          model,
          effortLevel,
          provider,
          backendMode,
          ollamaBaseUrl: providerSettings.ollamaBaseUrl,
          geminiApiKey: providerSettings.geminiApiKey,
        });
      }
      log.info(
        `sendPrompt complete in ${(performance.now() - sendStart).toFixed(0)}ms`,
      );
    } catch (err: any) {
      log.error(
        `sendPrompt failed after ${(performance.now() - sendStart).toFixed(0)}ms`,
        { error: String(err) },
      );
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          isStreaming: false,
          error: err?.message || String(err),
        }),
      );
    }
  },

  cancelExecution: async () => {
    const { activeTabId } = get();
    set({ _cancelledByUser: true });
    try {
      await invoke("cancel_claude_execution", { tabId: activeTabId });
    } catch {
      // ignore
    }
    set((s) => applyTabUpdate(s, activeTabId, { isStreaming: false }));
  },

  clearMessages: () => {
    const { activeTabId } = get();
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );
  },

  newSession: () => {
    log.info("Starting new session");
    const { activeTabId } = get();
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId: null,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
      }),
    );
  },

  resumeSession: async (sessionId: string) => {
    log.info(`Resuming session: ${sessionId.slice(0, 8)}`);
    const { activeTabId } = get();
    const projectPath = useDocumentStore.getState().projectRoot;

    // Reset state with new session ID
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );

    // Load session history from JSONL file
    if (projectPath) {
      try {
        const history = await invoke<any[]>("load_session_history", {
          projectPath,
          sessionId,
        });

        // Filter to displayable message types and map to AgentStreamMessage
        const messages: AgentStreamMessage[] = [];
        for (const entry of history) {
          const type = entry.type;
          if (type === "user" || type === "assistant" || type === "result") {
            messages.push(entry as AgentStreamMessage);
          }
        }

        set((s) => applyTabUpdate(s, activeTabId, { messages }));
      } catch (err) {
        log.error("Failed to load session history", { error: String(err) });
      }
    }
  },

  // ─── Tab Actions ───

  createTab: () => {
    log.debug("Creating new tab");
    const id = nextTabId();
    const newTab = makeDefaultTab(id);
    const globalSettings = useSettingsStore.getState().agentProviderSettings;
    newTab.agentProviderSettings = { ...globalSettings };

    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: id,
      // Project new tab fields to top-level
      messages: newTab.messages,
      sessionId: newTab.sessionId,
      isStreaming: newTab.isStreaming,
      error: newTab.error,
      totalInputTokens: newTab.totalInputTokens,
      totalOutputTokens: newTab.totalOutputTokens,
      agentProviderSettings: newTab.agentProviderSettings,
      chatMode: newTab.chatMode,
    }));
    return id;
  },

  closeTab: (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    // Prevent closing a streaming tab
    if (tab?.isStreaming) return;
    // Prevent closing the last tab
    if (state.tabs.length <= 1) return;

    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const newTabs = state.tabs.filter((t) => t.id !== tabId);

    if (tabId === state.activeTabId) {
      // Switch to adjacent tab
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newActive = newTabs[newIdx];
      set({
        tabs: newTabs,
        activeTabId: newActive.id,
        // Project new active tab
        messages: newActive.messages,
        sessionId: newActive.sessionId,
        isStreaming: newActive.isStreaming,
        error: newActive.error,
        totalInputTokens: newActive.totalInputTokens,
        totalOutputTokens: newActive.totalOutputTokens,
        agentProviderSettings: newActive.agentProviderSettings,
        chatMode: newActive.chatMode,
      });
    } else {
      set({ tabs: newTabs });
    }
  },

  setActiveTab: (tabId: string) => {
    const state = get();
    if (tabId === state.activeTabId) return;
    const targetTab = state.tabs.find((t) => t.id === tabId);
    if (!targetTab) return;

    // Project the target tab's fields to top-level
    set({
      activeTabId: tabId,
      messages: targetTab.messages,
      sessionId: targetTab.sessionId,
      isStreaming: targetTab.isStreaming,
      error: targetTab.error,
      totalInputTokens: targetTab.totalInputTokens,
      totalOutputTokens: targetTab.totalOutputTokens,
      agentProviderSettings: targetTab.agentProviderSettings,
      chatMode: targetTab.chatMode,
    });
  },

  saveDraft: (tabId: string, draft: TabDraft) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, draft } : t)),
    }));
  },

  setTabProviderSettings: (tabId: string, settings: AgentProviderSettings) => {
    set((s) => applyTabUpdate(s, tabId, { agentProviderSettings: settings }));
  },

  useGlobalProviderSettingsForTab: (tabId: string) => {
    const globalSettings = useSettingsStore.getState().agentProviderSettings;
    set((s) =>
      applyTabUpdate(s, tabId, {
        agentProviderSettings: { ...globalSettings },
      }),
    );
  },

  setTabChatMode: (tabId, mode) => {
    set((s) => applyTabUpdate(s, tabId, { chatMode: mode }));
  },

  // ─── Internal Actions (routed by explicit tabId) ───

  _appendMessage: (tabId: string, msg: AgentStreamMessage) => {
    set((state) => {
      let inputDelta = 0;
      let outputDelta = 0;
      const usage = msg.usage || msg.message?.usage;
      if (usage) {
        inputDelta = usage.input_tokens || 0;
        outputDelta = usage.output_tokens || 0;
      }

      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      return applyTabUpdate(state, tabId, {
        messages: [...tab.messages, msg],
        totalInputTokens: tab.totalInputTokens + inputDelta,
        totalOutputTokens: tab.totalOutputTokens + outputDelta,
      });
    });
  },

  _setSessionId: (tabId: string, id: string) => {
    set((state) => applyTabUpdate(state, tabId, { sessionId: id }));
  },

  _setStreaming: (tabId: string, streaming: boolean) => {
    set((state) => applyTabUpdate(state, tabId, { isStreaming: streaming }));
  },

  _setError: (tabId: string, error: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { error }));
  },
}));
