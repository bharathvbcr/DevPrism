import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "./document-store";
import { useHistoryStore } from "./history-store";
import { useClaudeSetupStore } from "./claude-setup-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("claude");
export const CLAUDE_CODE_PROVIDER_ID = "__claude-code__";
export const SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY =
  "claude-prism:selected-provider-credential-id";

function providerSelectionStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSelectedProviderCredentialId(): string | null {
  const value = providerSelectionStorage()?.getItem(
    SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY,
  );
  const trimmed = value?.trim();
  return trimmed || null;
}

function persistSelectedProviderCredentialId(credentialId: string | null) {
  const storage = providerSelectionStorage();
  if (!storage) return;
  if (credentialId?.trim()) {
    storage.setItem(
      SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY,
      credentialId.trim(),
    );
  } else {
    storage.removeItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY);
  }
}

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

export interface ClaudeStreamMessage {
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
  providerKey: string | null;
  messages: ClaudeStreamMessage[];
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  draft: TabDraft;
}

/** Fields that are projected from the active tab to top-level state */
const TAB_FIELDS = [
  "sessionId",
  "messages",
  "isStreaming",
  "error",
  "totalInputTokens",
  "totalOutputTokens",
] as const;

function makeDefaultTab(id: string): TabState {
  return {
    id,
    title: "New Chat",
    sessionId: null,
    providerKey: null,
    messages: [],
    isStreaming: false,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
  };
}

function providerSessionKey(providerCredentialId: string | null): string {
  return providerCredentialId
    ? `openai-compatible:${providerCredentialId}`
    : CLAUDE_CODE_PROVIDER_ID;
}

function providerCredentialIdFromSessionKey(
  providerKey: string | null,
): string | null | undefined {
  if (!providerKey) return undefined;
  if (providerKey === CLAUDE_CODE_PROVIDER_ID) return CLAUDE_CODE_PROVIDER_ID;
  const prefix = "openai-compatible:";
  return providerKey.startsWith(prefix)
    ? providerKey.slice(prefix.length)
    : undefined;
}

function inferProviderKeyFromHistory(history: any[]): string | null {
  const init = history.find(
    (entry) => entry?.type === "system" && entry?.subtype === "init",
  );
  if (!init) return null;

  if (
    init.provider === "openai-compatible" &&
    typeof init.provider_credential_id === "string" &&
    init.provider_credential_id.trim()
  ) {
    return providerSessionKey(init.provider_credential_id.trim());
  }

  const model = typeof init.model === "string" ? init.model : "";
  if (model.toLowerCase().startsWith("claude")) {
    return CLAUDE_CODE_PROVIDER_ID;
  }

  const matchingCredential = useClaudeSetupStore
    .getState()
    .openAiCredentials.find((credential) => credential.model === model);
  return matchingCredential ? providerSessionKey(matchingCredential.id) : null;
}

function usageFromMessage(msg: ClaudeStreamMessage): {
  input_tokens: number;
  output_tokens: number;
} {
  const usage = msg.usage || msg.message?.usage;
  return {
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
  };
}

function usageTotalsForMessages(messages: ClaudeStreamMessage[]): {
  inputTokens: number;
  outputTokens: number;
} {
  return messages.reduce(
    (totals, msg) => {
      const usage = usageFromMessage(msg);
      totals.inputTokens += usage.input_tokens;
      totals.outputTokens += usage.output_tokens;
      return totals;
    },
    { inputTokens: 0, outputTokens: 0 },
  );
}

function stringifyBlockContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function messageContentText(message: ClaudeStreamMessage): string {
  const blocks = message.message?.content ?? [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text?.trim()) {
      parts.push(block.text.trim());
    } else if (block.type === "tool_use") {
      const input = block.input ? stringifyBlockContent(block.input) : "";
      parts.push(
        `[tool_use: ${block.name ?? "unknown"}${input ? ` ${input}` : ""}]`,
      );
    } else if (block.type === "tool_result") {
      const content = stringifyBlockContent(block.content ?? "");
      parts.push(`[tool_result${block.is_error ? " error" : ""}: ${content}]`);
    }
  }
  return parts.join("\n").trim();
}

function buildProviderSwitchContext(
  messages: ClaudeStreamMessage[],
  maxChars = 18000,
): string | null {
  const entries = messages
    .filter((msg) => msg.type === "user" || msg.type === "assistant")
    .map((msg) => {
      const text = messageContentText(msg);
      if (!text) return null;
      return `${msg.type === "user" ? "User" : "Assistant"}:\n${text}`;
    })
    .filter((entry): entry is string => !!entry);

  if (entries.length === 0) return null;

  const selected: string[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const next = entries[i];
    if (selected.length > 0 && total + next.length > maxChars) break;
    selected.unshift(next);
    total += next.length;
  }

  return [
    "[Provider switch context]",
    "The conversation below happened earlier in this same ClaudePrism chat before switching model providers.",
    "Use it as prior context. Do not repeat it; answer only the user's latest request after this block.",
    "",
    selected.join("\n\n"),
    "[End provider switch context]",
  ].join("\n");
}

let tabCounter = 0;
function nextTabId(): string {
  return `tab-${++tabCounter}`;
}

function truncateChatTitle(text: string, maxChars = 80): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 3))}...`
    : text;
}

function normalizeChatTitleWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isNoiseChatTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower.startsWith("template:") ||
    lower.startsWith("file:") ||
    lower.startsWith("reference files") ||
    lower === "what i want to create" ||
    lower.startsWith("(extracted text") ||
    lower.startsWith("attachments/") ||
    lower.startsWith("the file currently contains") ||
    (lower.startsWith("new ") && lower.includes(" project"))
  );
}

function extractMarkedRequestBody(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const markerIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === "what i want to create",
  );
  if (markerIndex < 0) return null;

  const selected: string[] = [];
  for (const line of lines.slice(markerIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === "reference files") break;
    if (isNoiseChatTitleLine(trimmed)) continue;
    selected.push(trimmed);
    if (selected.join(" ").length >= 120) break;
  }

  const body = normalizeChatTitleWhitespace(selected.join(" "));
  return body || null;
}

function firstMeaningfulTitleLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!isNoiseChatTitleLine(line)) {
      const normalized = normalizeChatTitleWhitespace(line);
      if (normalized) return normalized;
    }
  }
  return null;
}

function summarizeChatTitle(prompt: string): string | undefined {
  const clean = prompt.includes("]\n\n")
    ? prompt.slice(prompt.lastIndexOf("]\n\n") + 3)
    : prompt;
  if (
    clean.startsWith("<ide_") ||
    clean.startsWith("<system-reminder>") ||
    clean.startsWith("<command-name>") ||
    clean.startsWith("<local-command-stdout>")
  ) {
    return undefined;
  }

  const source =
    extractMarkedRequestBody(clean) ?? firstMeaningfulTitleLine(clean);
  if (!source) return undefined;

  const normalized = normalizeChatTitleWhitespace(source);
  const lower = normalized.toLowerCase();
  const researchPrefix = [
    "a research paper for ",
    "research paper for ",
    "a research paper on ",
    "research paper on ",
    "a research paper about ",
    "research paper about ",
  ].find((prefix) => lower.startsWith(prefix));

  if (researchPrefix) {
    const topic = normalized.slice(researchPrefix.length).trim();
    return topic
      ? `Research Paper: ${truncateChatTitle(topic, 56)}`
      : "Research Paper";
  }

  return truncateChatTitle(normalized);
}

function titleForMessages(messages: ClaudeStreamMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.type === "user");
  if (!firstUser) return undefined;
  return summarizeChatTitle(messageContentText(firstUser));
}

/**
 * Update a specific tab in `tabs[]` and, if that tab is the active tab,
 * also project the changed fields to top-level state for consumer compatibility.
 */
function applyTabUpdate(
  state: ClaudeChatState,
  tabId: string,
  updates: Partial<TabState>,
): Partial<ClaudeChatState> {
  const newTabs = state.tabs.map((t) =>
    t.id === tabId ? { ...t, ...updates } : t,
  );
  const result: Partial<ClaudeChatState> = { tabs: newTabs };
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

function mergeStreamingContent(
  existing: ContentBlock[],
  incoming: ContentBlock[],
): ContentBlock[] {
  let merged = [...existing];
  for (const block of incoming) {
    if (block.type === "text" && block.text) {
      const idx = merged.findIndex((item) => item.type === "text");
      if (idx >= 0) {
        merged = merged.map((item, itemIdx) =>
          itemIdx === idx
            ? { ...item, text: `${item.text ?? ""}${block.text}` }
            : item,
        );
      } else {
        merged.push(block);
      }
    } else if (block.type === "thinking" && block.thinking) {
      const idx = merged.findIndex((item) => item.type === "thinking");
      if (idx >= 0) {
        merged = merged.map((item, itemIdx) =>
          itemIdx === idx
            ? { ...item, thinking: `${item.thinking ?? ""}${block.thinking}` }
            : item,
        );
      } else {
        merged.unshift(block);
      }
    } else {
      merged.push(block);
    }
  }
  return merged;
}

const DEFAULT_TAB_ID = nextTabId();

interface ClaudeChatState {
  // ── Projected fields (from active tab — read by consumers) ──
  messages: ClaudeStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

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

  /** Currently selected model (passed per-prompt to Claude CLI) */
  selectedModel: "sonnet" | "opus" | "haiku" | "opusplan";
  setSelectedModel: (model: "sonnet" | "opus" | "haiku" | "opusplan") => void;
  selectedProviderCredentialId: string | null;
  setSelectedProviderCredentialId: (credentialId: string | null) => void;
  selectedProviderModels: Record<string, string>;
  setSelectedProviderModel: (credentialId: string, model: string) => void;

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
  resumeSession: (sessionId: string, title?: string) => Promise<void>;

  // Tab actions
  createTab: () => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  saveDraft: (tabId: string, draft: TabDraft) => void;

  /** True when any tab is streaming */
  anyStreaming: () => boolean;

  // Internal actions (called by event hook, routed by tabId)
  _appendMessage: (tabId: string, msg: ClaudeStreamMessage) => void;
  _setSessionId: (tabId: string, id: string) => void;
  _setSessionTitle: (sessionId: string, title: string) => void;
  _setStreaming: (tabId: string, streaming: boolean) => void;
  _setError: (tabId: string, error: string | null) => void;
  _cancelledByUser: boolean;
}

// ─── Store ───

export const useClaudeChatStore = create<ClaudeChatState>()((set, get) => ({
  // Projected fields (initialized from default tab)
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  _cancelledByUser: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  // Tab state
  tabs: [makeDefaultTab(DEFAULT_TAB_ID)],
  activeTabId: DEFAULT_TAB_ID,

  selectedModel: "opus",
  setSelectedModel: (model) => set({ selectedModel: model }),
  selectedProviderCredentialId: loadSelectedProviderCredentialId(),
  setSelectedProviderCredentialId: (credentialId) => {
    persistSelectedProviderCredentialId(credentialId);
    set({ selectedProviderCredentialId: credentialId });
  },
  selectedProviderModels: {},
  setSelectedProviderModel: (credentialId, model) =>
    set((state) => ({
      selectedProviderModels: {
        ...state.selectedProviderModels,
        [credentialId]: model,
      },
    })),

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

    const {
      sessionId,
      selectedModel,
      effortLevel,
      selectedProviderCredentialId,
      selectedProviderModels,
    } = state;
    const providerCredentialId =
      selectedProviderCredentialId &&
      selectedProviderCredentialId !== CLAUDE_CODE_PROVIDER_ID
        ? selectedProviderCredentialId
        : null;
    const providerModelOverride = providerCredentialId
      ? selectedProviderModels[providerCredentialId] || null
      : null;
    const requestProviderKey = providerSessionKey(providerCredentialId);
    const previousProviderKey = activeTab?.providerKey ?? null;
    const providerChanged =
      !!sessionId &&
      !!previousProviderKey &&
      previousProviderKey !== requestProviderKey;
    const switchingDirectProviderToClaudeCode =
      providerChanged &&
      requestProviderKey === CLAUDE_CODE_PROVIDER_ID &&
      previousProviderKey !== CLAUDE_CODE_PROVIDER_ID;
    const resumeSessionId = switchingDirectProviderToClaudeCode
      ? null
      : (sessionId ?? null);

    const sendStart = performance.now();
    log.info("sendPrompt start", {
      sessionId: !!sessionId,
      providerChanged,
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
    const userMessage: ClaudeStreamMessage = {
      type: "user",
      message: {
        content: [{ type: "text", text: displayText }],
      },
    };

    // Auto-set tab title from first prompt
    const isFirstMessage = activeTab && activeTab.messages.length === 0;
    const tabTitle = isFirstMessage
      ? summarizeChatTitle(userPrompt)
      : undefined;

    set((s) => {
      const tabUpdates: Partial<TabState> = {
        messages: [
          ...(s.tabs.find((t) => t.id === activeTabId)?.messages ?? []),
          userMessage,
        ],
        sessionId: resumeSessionId,
        providerKey: requestProviderKey,
        isStreaming: true,
        error: null,
      };
      if (tabTitle) tabUpdates.title = tabTitle;
      return {
        ...applyTabUpdate(s, activeTabId, tabUpdates),
        _cancelledByUser: false,
      };
    });

    // Flush unsaved edits to disk so Claude reads the latest content
    if (docState.files.some((f) => f.isDirty)) {
      log.debug("saving dirty files...");
      await docState.saveAllFiles();
      log.debug("saveAllFiles done");
    }

    // Snapshot before Claude edit
    if (projectPath) {
      try {
        log.debug("creating snapshot...");
        await useHistoryStore
          .getState()
          .createSnapshot(projectPath, "[claude] Before Claude edit");
        log.debug("snapshot done");
      } catch {
        /* snapshot failure should not block Claude */
      }
    }

    // Build prompt with full context for Claude
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
    if (switchingDirectProviderToClaudeCode) {
      const priorContext = buildProviderSwitchContext(
        activeTab?.messages ?? [],
      );
      if (priorContext) {
        prompt = `${priorContext}\n\n${prompt}`;
      }
    }
    log.info("invoking CLI", {
      promptLength: prompt.length,
      mode: resumeSessionId ? "resume" : "new",
    });

    try {
      if (resumeSessionId) {
        // Resume existing session
        await invoke("resume_claude_code", {
          projectPath,
          sessionId: resumeSessionId,
          prompt,
          tabId: activeTabId,
          model: selectedModel,
          effortLevel,
          providerCredentialId,
          providerModelOverride,
        });
      } else {
        // New session
        await invoke("execute_claude_code", {
          projectPath,
          prompt,
          tabId: activeTabId,
          model: selectedModel,
          effortLevel,
          providerCredentialId,
          providerModelOverride,
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
    const { activeTabId, tabs } = get();
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.isStreaming) {
      const id = nextTabId();
      const newTab = makeDefaultTab(id);
      set({
        tabs: [...tabs, newTab],
        activeTabId: id,
        messages: newTab.messages,
        sessionId: newTab.sessionId,
        isStreaming: newTab.isStreaming,
        error: newTab.error,
        totalInputTokens: newTab.totalInputTokens,
        totalOutputTokens: newTab.totalOutputTokens,
      });
      return;
    }

    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId: null,
        providerKey: null,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
      }),
    );
  },

  resumeSession: async (sessionId: string, title?: string) => {
    log.info(`Resuming session: ${sessionId.slice(0, 8)}`);
    const sessionTitle = title?.trim() || undefined;
    const state = get();
    let { activeTabId } = state;
    let { tabs } = state;
    const existingTab = tabs.find((tab) => tab.sessionId === sessionId);

    if (existingTab) {
      const nextTitle = sessionTitle ?? existingTab.title;
      activeTabId = existingTab.id;
      const nextTabs = tabs.map((tab) =>
        tab.id === existingTab.id ? { ...tab, title: nextTitle } : tab,
      );
      set({
        tabs: nextTabs,
        activeTabId: existingTab.id,
        messages: existingTab.messages,
        sessionId: existingTab.sessionId,
        isStreaming: existingTab.isStreaming,
        error: existingTab.error,
        totalInputTokens: existingTab.totalInputTokens,
        totalOutputTokens: existingTab.totalOutputTokens,
      });
      if (existingTab.isStreaming) return;
    } else {
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      if (activeTab?.isStreaming) {
        const id = nextTabId();
        const newTab = makeDefaultTab(id);
        tabs = [...tabs, newTab];
        activeTabId = id;
        set({
          tabs,
          activeTabId,
          messages: newTab.messages,
          sessionId: newTab.sessionId,
          isStreaming: newTab.isStreaming,
          error: newTab.error,
          totalInputTokens: newTab.totalInputTokens,
          totalOutputTokens: newTab.totalOutputTokens,
        });
      }
    }

    const projectPath = useDocumentStore.getState().projectRoot;

    // Reset state with new session ID
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId,
        providerKey: null,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: sessionTitle ?? "New Chat",
      }),
    );

    // Load session history from JSONL file
    if (projectPath) {
      try {
        const history = await invoke<any[]>("load_session_history", {
          projectPath,
          sessionId,
        });

        // Filter to displayable message types and map to ClaudeStreamMessage
        const messages: ClaudeStreamMessage[] = [];
        for (const entry of history) {
          const type = entry.type;
          if (type === "user" || type === "assistant" || type === "result") {
            messages.push(entry as ClaudeStreamMessage);
          }
        }

        const totals = usageTotalsForMessages(messages);
        const providerKey = inferProviderKeyFromHistory(history);
        const selectedProviderCredentialId =
          providerCredentialIdFromSessionKey(providerKey);
        if (selectedProviderCredentialId !== undefined) {
          persistSelectedProviderCredentialId(selectedProviderCredentialId);
        }
        set((s) => ({
          ...applyTabUpdate(s, activeTabId, {
            messages,
            providerKey,
            title: sessionTitle ?? titleForMessages(messages) ?? "New Chat",
            totalInputTokens: totals.inputTokens,
            totalOutputTokens: totals.outputTokens,
          }),
          ...(selectedProviderCredentialId !== undefined
            ? { selectedProviderCredentialId }
            : {}),
        }));
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
    });
  },

  saveDraft: (tabId: string, draft: TabDraft) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, draft } : t)),
    }));
  },

  // ─── Internal Actions (routed by explicit tabId) ───

  _appendMessage: (tabId: string, msg: ClaudeStreamMessage) => {
    set((state) => {
      const { input_tokens: inputDelta, output_tokens: outputDelta } =
        usageFromMessage(msg);

      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      if (msg.type === "assistant" && msg.subtype === "streaming_delta") {
        const last = tab.messages[tab.messages.length - 1];
        if (last?.type === "assistant" && last.subtype === "streaming_delta") {
          const existing = last.message?.content ?? [];
          const incoming = msg.message?.content ?? [];
          if (incoming.length > 0) {
            const merged: ClaudeStreamMessage = {
              ...last,
              message: {
                ...last.message,
                content: mergeStreamingContent(existing, incoming),
              },
            };
            return applyTabUpdate(state, tabId, {
              messages: [...tab.messages.slice(0, -1), merged],
              totalInputTokens: tab.totalInputTokens + inputDelta,
              totalOutputTokens: tab.totalOutputTokens + outputDelta,
            });
          }
        }
      }

      if (msg.type === "assistant" && msg.subtype === "streaming_final") {
        const last = tab.messages[tab.messages.length - 1];
        if (last?.type === "assistant" && last.subtype === "streaming_delta") {
          return applyTabUpdate(state, tabId, {
            messages: [...tab.messages.slice(0, -1), msg],
            totalInputTokens: tab.totalInputTokens + inputDelta,
            totalOutputTokens: tab.totalOutputTokens + outputDelta,
          });
        }
      }

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

  _setSessionTitle: (sessionId: string, title: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.sessionId === sessionId ? { ...tab, title: cleanTitle } : tab,
      ),
    }));
  },

  _setStreaming: (tabId: string, streaming: boolean) => {
    set((state) => applyTabUpdate(state, tabId, { isStreaming: streaming }));
  },

  _setError: (tabId: string, error: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { error }));
  },
}));
