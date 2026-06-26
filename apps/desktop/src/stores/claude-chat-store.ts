import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "./document-store";
import { useHistoryStore } from "./history-store";
import { useClaudeSetupStore } from "./claude-setup-store";
import { useSettingsStore } from "./settings-store";
import { aiComplete, canUseAiAssist } from "@/lib/ai-assist";
import { getChatLabels } from "@/lib/chat-labels";
import { createLogger } from "@/lib/debug/logger";
import { recordPersonalizationEvent } from "@/lib/personalization";
import {
  usePersonalizationStore,
  buildPersonalizationContext,
} from "./personalization-store";

const log = createLogger("claude");
export const CLAUDE_CODE_PROVIDER_ID = "__claude-code__";
export const SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY =
  "claude-prism:selected-provider-credential-id";

function providerSelectionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
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
    isTemporary?: boolean;
  }[];
}

export interface PromptContextOverride {
  label: string;
  filePath: string;
  selectedText: string;
  temporaryFilePaths?: string[];
}

export interface QueuedGuidance {
  id: string;
  prompt: string;
  contextOverride?: PromptContextOverride;
  createdAt: number;
  displayedInChat?: boolean;
}

export interface TabState {
  id: string;
  title: string;
  projectPath: string | null;
  sessionId: string | null;
  /** Provider currently selected in the tab UI. */
  providerKey: string | null;
  /** Provider that last executed this session, used for safe resume/switching. */
  sessionProviderKey: string | null;
  messages: ClaudeStreamMessage[];
  isStreaming: boolean;
  streamingStartedAt: number | null;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  draft: TabDraft;
  queuedGuidance?: QueuedGuidance[];
  forceQueuedGuidanceOnComplete?: boolean;
  forcedQueuedGuidanceId?: string | null;
  pendingTemporaryFilePaths?: string[];
}

/** Fields that are projected from the active tab to top-level state */
const TAB_FIELDS = [
  "sessionId",
  "messages",
  "isStreaming",
  "streamingStartedAt",
  "error",
  "totalInputTokens",
  "totalOutputTokens",
] as const;

function makeDefaultTab(
  id: string,
  projectPath: string | null = null,
): TabState {
  const selectedCredentialId =
    loadSelectedProviderCredentialId() ?? CLAUDE_CODE_PROVIDER_ID;
  return {
    id,
    title: "New Chat",
    projectPath,
    sessionId: null,
    providerKey: providerKeyForSelectedCredential(selectedCredentialId),
    sessionProviderKey: null,
    messages: [],
    isStreaming: false,
    streamingStartedAt: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
    queuedGuidance: [],
    forceQueuedGuidanceOnComplete: false,
    forcedQueuedGuidanceId: null,
    pendingTemporaryFilePaths: [],
  };
}

function providerSessionKey(providerCredentialId: string | null): string {
  return providerCredentialId
    ? `openai-compatible:${providerCredentialId}`
    : CLAUDE_CODE_PROVIDER_ID;
}

function providerKeyForSelectedCredential(credentialId: string | null): string {
  return credentialId && credentialId !== CLAUDE_CODE_PROVIDER_ID
    ? providerSessionKey(credentialId)
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

function selectedCredentialForProviderKey(providerKey: string | null) {
  const credentialId = providerCredentialIdFromSessionKey(providerKey);
  return credentialId === undefined ? null : credentialId;
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

export function messageContentText(message: ClaudeStreamMessage): string {
  const rawContent = (message.message as any)?.content;
  if (typeof rawContent === "string") return rawContent.trim();

  const blocks = rawContent ?? [];
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

function displayTextForStoredUserPrompt(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!/^\[(?:Currently open file|File): [^\]\n]*\]/.test(normalized)) {
    return text;
  }

  const contextEnd = normalized.lastIndexOf("]\n\n");
  if (contextEnd < 0) return text;

  const contextText = normalized.slice(0, contextEnd + 1);
  const body = normalized.slice(contextEnd + 3);
  const selectionMatch = contextText.match(/(?:^|\n)\[Selection: ([^\]\n]+)\]/);
  const contextLabel = selectionMatch?.[1]?.trim();

  if (!contextLabel) return body;
  return body.trim() ? `${contextLabel}\n${body}` : contextLabel;
}

function sanitizeStoredUserMessageForDisplay(
  message: ClaudeStreamMessage,
): ClaudeStreamMessage {
  if (message.type !== "user") return message;

  const rawContent = (message.message as any)?.content;
  if (typeof rawContent === "string") {
    const displayText = displayTextForStoredUserPrompt(rawContent);
    return displayText === rawContent
      ? message
      : {
          ...message,
          message: { ...message.message, content: displayText as any },
        };
  }

  if (!Array.isArray(rawContent)) return message;

  let changed = false;
  const content = rawContent.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") {
      return block;
    }

    const displayText = displayTextForStoredUserPrompt(block.text);
    if (displayText === block.text) return block;

    changed = true;
    return { ...block, text: displayText };
  });

  return changed
    ? { ...message, message: { ...message.message, content } }
    : message;
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
    "The conversation below happened earlier in this same DevPrism chat before switching model providers.",
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

// Tabs whose native (Ollama) runtime already holds conversation memory. Used to
// seed the FIRST native turn of a tab with the visible chat history (so resuming
// a CLI session or switching into native mode doesn't lose prior context — the
// native runtime keeps its own per-tab memory, empty until the first native turn).
// Reset wherever that memory is cleared (clear_native_session / resume).
const nativeSeededTabs = new Set<string>();

function nextGuidanceId(): string {
  return `guidance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

// Tabs whose AI title refinement has already been attempted, so the best-effort
// refinement fires at most once per session and can never enter a render loop.
const aiTitleRefinedTabs = new Set<string>();

/** Strip wrapping quotes / trailing punctuation and clamp to <= 5 words. */
function sanitizeAiChatTitle(raw: string): string | undefined {
  let title = normalizeChatTitleWhitespace(raw);
  // The model may answer on several lines or prefix with "Title:"; take the
  // first meaningful line and drop a leading label.
  title = title.split("\n")[0]?.trim() ?? title;
  title = title.replace(/^title\s*[:\-–]\s*/i, "").trim();
  title = title.replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, "").trim();
  if (!title) return undefined;
  const words = title.split(/\s+/);
  if (words.length > 5) title = words.slice(0, 5).join(" ");
  return title ? truncateChatTitle(title, 56) : undefined;
}

/**
 * Best-effort AI refinement of a chat tab's title. Fires once per tab, only
 * when the tab still carries the synchronous heuristic title derived from the
 * opening message (so a user-edited title is never overwritten), and degrades
 * silently on any failure. Passive/background — must never throw into callers.
 */
async function maybeRefineChatTitleWithAi(tabId: string): Promise<void> {
  if (aiTitleRefinedTabs.has(tabId)) return;
  if (!useSettingsStore.getState().aiAutoTitles || !canUseAiAssist()) return;

  const tab = useClaudeChatStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const firstUser = tab.messages.find((m) => m.type === "user");
  if (!firstUser) return;
  // Only refine once there is an assistant reply to learn the topic from.
  const firstAssistant = tab.messages.find((m) => m.type === "assistant");
  if (!firstAssistant) return;

  const userText = messageContentText(firstUser).trim();
  if (!userText) return;

  // The exact synchronous heuristic this tab would have been titled with. We
  // only replace that — never a title the user manually edited, and never a
  // title that already diverged (e.g. resumed/renamed sessions).
  const heuristicTitle = summarizeChatTitle(userText);
  const currentTitle = tab.title.trim();
  const replaceableDefault = currentTitle === "New Chat" || currentTitle === "";
  if (!replaceableDefault && currentTitle !== (heuristicTitle ?? "").trim()) {
    return;
  }

  // Mark as attempted up front so concurrent appends can't double-fire.
  aiTitleRefinedTabs.add(tabId);

  try {
    const assistantText = messageContentText(firstAssistant).trim();
    const promptParts = [`User's first message:\n${userText.slice(0, 1500)}`];
    if (assistantText) {
      promptParts.push(`Assistant's reply:\n${assistantText.slice(0, 1500)}`);
    }
    const aiTitle = await aiComplete({
      system:
        "Give a 3-5 word title for this chat. Title only, no quotes, no punctuation.",
      prompt: promptParts.join("\n\n"),
      temperature: 0.3,
    });
    const refined = sanitizeAiChatTitle(aiTitle);
    if (!refined) return;

    // Re-check at write time: the user may have renamed in the meantime, or a
    // new message may have changed the heuristic. Only overwrite a still-default
    // / still-heuristic title for this exact tab.
    set_TitleIfStillHeuristic(tabId, heuristicTitle, refined);
  } catch {
    // Passive background refinement — fail silently, keep the heuristic title.
  }
}

/**
 * Commit the AI title only if the tab still holds the default or the original
 * heuristic title (guards against a race with a manual rename).
 */
function set_TitleIfStillHeuristic(
  tabId: string,
  heuristicTitle: string | undefined,
  refined: string,
): void {
  useClaudeChatStore.setState((state) => {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return {};
    const current = tab.title.trim();
    const stillDefault = current === "New Chat" || current === "";
    const stillHeuristic = current === (heuristicTitle ?? "").trim();
    if (!stillDefault && !stillHeuristic) return {};
    if (current === refined) return {};
    return applyTabUpdate(state, tabId, { title: refined });
  });
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
  streamingStartedAt: number | null;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  // ── Tab state ──
  tabs: TabState[];
  activeTabId: string;
  activeProjectPath: string | null;

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

  /**
   * Text to seed into the composer from an external trigger (e.g. the
   * "Tailor with AI" action). Setting it opens the chat drawer and pre-fills
   * the prompt for the user to review and send.
   */
  pendingComposerInput: string | null;
  seedComposerInput: (text: string) => void;
  consumePendingComposerInput: () => string | null;
  /** Bumped to ask the composer to open the model picker (native Ollama UX). */
  modelPickerRequestId: number;
  requestModelPicker: () => void;
  pendingPinnedContextRemovalLabels: string[];
  requestPinnedContextRemoval: (labels: string[]) => void;
  consumePendingPinnedContextRemovals: () => string[];

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
    contextOverride?: PromptContextOverride,
    options?: { tabId?: string; preserveTabProvider?: boolean },
  ) => Promise<void>;
  queueGuidance: (
    tabId: string,
    prompt: string,
    contextOverride?: PromptContextOverride,
  ) => void;
  consumeQueuedGuidance: (
    tabId: string,
    guidanceId?: string | null,
  ) => QueuedGuidance | null;
  displayQueuedGuidanceInChat: (
    tabId: string,
    guidanceId?: string | null,
  ) => string | null;
  removeQueuedGuidance: (tabId: string, guidanceId: string) => void;
  clearQueuedGuidance: (tabId: string) => void;
  consumeTemporaryFilePaths: (tabId: string) => string[];
  forceQueuedGuidanceNow: (tabId: string, guidanceId?: string) => Promise<void>;
  cancelExecution: (tabId?: string) => Promise<void>;
  /**
   * Re-run the conversation from a prior user message: truncate the active tab
   * to just before `messageIndex`, then resend that message's text (optionally
   * replaced by `newText` for edit-and-resend / regenerate).
   */
  resendFromMessage: (messageIndex: number, newText?: string) => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;
  resetForProject: (projectPath: string | null) => void;
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
  streamingStartedAt: null,
  error: null,
  _cancelledByUser: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  // Tab state
  tabs: [makeDefaultTab(DEFAULT_TAB_ID)],
  activeTabId: DEFAULT_TAB_ID,
  activeProjectPath: null,

  selectedModel: "opus",
  setSelectedModel: (model) => set({ selectedModel: model }),
  selectedProviderCredentialId:
    loadSelectedProviderCredentialId() ?? CLAUDE_CODE_PROVIDER_ID,
  setSelectedProviderCredentialId: (credentialId) => {
    persistSelectedProviderCredentialId(credentialId);
    const providerKey = providerKeyForSelectedCredential(
      credentialId ?? CLAUDE_CODE_PROVIDER_ID,
    );
    set((state) => ({
      selectedProviderCredentialId: credentialId,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId ? { ...tab, providerKey } : tab,
      ),
    }));
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

  pendingComposerInput: null,
  seedComposerInput: (text) => set({ pendingComposerInput: text }),
  consumePendingComposerInput: () => {
    const { pendingComposerInput } = get();
    if (pendingComposerInput != null) set({ pendingComposerInput: null });
    return pendingComposerInput;
  },
  modelPickerRequestId: 0,
  requestModelPicker: () =>
    set((state) => ({
      modelPickerRequestId: state.modelPickerRequestId + 1,
    })),
  pendingPinnedContextRemovalLabels: [],
  requestPinnedContextRemoval: (labels) => {
    if (labels.length === 0) return;
    set((state) => ({
      pendingPinnedContextRemovalLabels: [
        ...state.pendingPinnedContextRemovalLabels,
        ...labels,
      ],
    }));
  },
  consumePendingPinnedContextRemovals: () => {
    const { pendingPinnedContextRemovalLabels } = get();
    if (pendingPinnedContextRemovalLabels.length > 0) {
      set({ pendingPinnedContextRemovalLabels: [] });
    }
    return pendingPinnedContextRemovalLabels;
  },

  anyStreaming: () => get().tabs.some((t) => t.isStreaming),

  sendPrompt: async (
    userPrompt: string,
    contextOverride?: PromptContextOverride,
    options?: { tabId?: string; preserveTabProvider?: boolean },
  ) => {
    let state = get();
    let activeTabId = options?.tabId ?? state.activeTabId;
    let activeTab = state.tabs.find((t) => t.id === activeTabId);
    if (!activeTab || activeTab.isStreaming) return;

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set((s) => applyTabUpdate(s, activeTabId, { error: "No project open" }));
      return;
    }

    if (activeTab.projectPath && activeTab.projectPath !== projectPath) {
      get().resetForProject(projectPath);
      state = get();
      activeTabId = state.activeTabId;
      activeTab = state.tabs.find((t) => t.id === activeTabId);
      if (!activeTab || activeTab.isStreaming) return;
    }

    // Base64 of any pasted images, for the native runtime's vision support.
    const nativeImages = (activeTab.draft.pinnedContexts ?? [])
      .map((c) => c.imageDataUrl)
      .filter((u): u is string => !!u)
      .map((u) => u.replace(/^data:image\/[^;]+;base64,/, ""));

    const { selectedModel, effortLevel, selectedProviderModels } = state;
    const sessionId = activeTab.sessionId;
    const tabSelectedProviderCredentialId =
      selectedCredentialForProviderKey(activeTab.providerKey) ??
      state.selectedProviderCredentialId;
    let providerCredentialId =
      tabSelectedProviderCredentialId &&
      tabSelectedProviderCredentialId !== CLAUDE_CODE_PROVIDER_ID
        ? tabSelectedProviderCredentialId
        : null;

    if (options?.preserveTabProvider && activeTab.providerKey) {
      const tabProviderCredentialId = providerCredentialIdFromSessionKey(
        activeTab.providerKey,
      );
      if (tabProviderCredentialId === CLAUDE_CODE_PROVIDER_ID) {
        providerCredentialId = null;
      } else if (tabProviderCredentialId !== undefined) {
        providerCredentialId = tabProviderCredentialId;
      }
    }

    const providerModelOverride = providerCredentialId
      ? selectedProviderModels[providerCredentialId] || null
      : null;
    const requestProviderKey = providerSessionKey(providerCredentialId);
    const previousProviderKey = activeTab?.sessionProviderKey ?? null;
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
    const streamingStartedAt = Date.now();
    log.info("sendPrompt start", {
      sessionId: !!sessionId,
      providerChanged,
      hasContext: !!contextOverride,
      tab: activeTabId,
    });

    recordPersonalizationEvent("chat_sent", { text: userPrompt.trim() });

    // Compute context label for display in chat history — a chip showing which
    // editor context was attached to this message.
    const activeFile = docState.files.find(
      (f) => f.id === docState.activeFileId,
    );
    const nativeMode = useSettingsStore.getState().nativeAgentEnabled;
    let contextLabel: string | null = null;

    if (contextOverride) {
      contextLabel = contextOverride.label;
    } else if (activeFile) {
      const selRange = docState.selectionRange;
      if (selRange && activeFile.content && selRange.end > selRange.start) {
        const content = activeFile.content;
        const startLine = offsetToLineCol(content, selRange.start).line;
        const endLine = offsetToLineCol(content, selRange.end).line;
        contextLabel =
          startLine === endLine
            ? `@${activeFile.relativePath}:${startLine}`
            : `@${activeFile.relativePath}:${startLine}-${endLine}`;
      } else if (nativeMode) {
        // The native runtime attaches the open file's context every turn (and
        // inlines small files), so show which file is in play even with no
        // selection — otherwise that attached context is invisible to the user.
        contextLabel = `@${activeFile.relativePath}`;
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
      const currentTab = s.tabs.find((t) => t.id === activeTabId);
      const temporaryFilePaths = Array.from(
        new Set([
          ...(currentTab?.pendingTemporaryFilePaths ?? []),
          ...(contextOverride?.temporaryFilePaths ?? []),
        ]),
      );
      const tabUpdates: Partial<TabState> = {
        messages: [...(currentTab?.messages ?? []), userMessage],
        projectPath,
        sessionId: resumeSessionId,
        providerKey: requestProviderKey,
        sessionProviderKey: requestProviderKey,
        isStreaming: true,
        streamingStartedAt,
        error: null,
        pendingTemporaryFilePaths: temporaryFilePaths,
      };
      if (tabTitle) tabUpdates.title = tabTitle;
      return {
        ...applyTabUpdate(s, activeTabId, tabUpdates),
        activeProjectPath: projectPath,
        _cancelledByUser: false,
      };
    });

    // Flush unsaved edits to disk so Claude reads the latest content
    if (docState.files.some((f) => f.isDirty)) {
      log.debug("saving dirty files...");
      await docState.saveAllFiles();
      log.debug("saveAllFiles done");
    }

    // Trigger automatic personalization extraction in the background
    const activeDoc = docState.files.find((f) => f.id === docState.activeFileId);
    if (activeDoc && activeDoc.content) {
      usePersonalizationStore
        .getState()
        .analyzeLaTeXContent(activeDoc.relativePath, activeDoc.content);
    }
    const updatedMessages = [...(activeTab?.messages ?? []), userMessage];
    void usePersonalizationStore
      .getState()
      .analyzeChatConversation(updatedMessages);

    // Snapshot before agent edit
    if (projectPath) {
      try {
        log.debug("creating snapshot...");
        const snapshotLabel = getChatLabels(
          useSettingsStore.getState().nativeAgentEnabled,
        ).snapshotBeforeEdit;
        await useHistoryStore
          .getState()
          .createSnapshot(projectPath, snapshotLabel);
        log.debug("snapshot done");
      } catch {
        /* snapshot failure should not block the agent */
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
      if (useSettingsStore.getState().nativeAgentEnabled) {
        // DevPrism native runtime: talk directly to a local Ollama model, no
        // Claude CLI. Keeps multi-turn memory per tab in the Rust runtime and
        // emits the same events as the CLI path, so the UI is unchanged. Use the
        // configured Ollama (OpenAI-compatible) credential's base URL + model
        // when available; otherwise the runtime defaults to localhost:11434 and
        // the first installed model.
        const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
        const isOllama = (c?: { base_url?: string | null }) =>
          /:11434|localhost|127\.0\.0\.1/.test(c?.base_url ?? "");
        const selected = creds.find((c) => c.id === providerCredentialId);
        const cred =
          (selected && isOllama(selected) ? selected : undefined) ??
          creds.find(isOllama);
        const ns = useSettingsStore.getState();
        const nativeModel =
          ns.nativeOllamaModel?.trim() ||
          (cred
            ? selectedProviderModels[cred.id]?.trim() || cred.model?.trim()
            : null) ||
          null;
        // Native conveys the open file + selection via the structured channel
        // below (-> the runtime's system prompt, rebuilt fresh each turn), so use
        // the RAW user prompt here instead of the CLI path's `[Currently open
        // file]` ctx block. That keeps a single selection-context path and avoids
        // a stale selection getting persisted into the runtime's history.
        // First native turn for this tab is still seeded with the visible
        // conversation so the local model isn't blind to context the user can see.
        let nativePrompt = userPrompt;
        if (!nativeSeededTabs.has(activeTabId)) {
          const priorContext = buildProviderSwitchContext(
            activeTab?.messages ?? [],
          );
          if (priorContext) nativePrompt = `${priorContext}\n\n${userPrompt}`;
        }
        nativeSeededTabs.add(activeTabId);
        // The file the user currently has open and any selected text, so deictic
        // prompts ("fix this paragraph", "edit this file", "the selection")
        // resolve to the precise span without them naming a path. Prefer the
        // toolbar's explicit context (it survives even when the toolbar clears the
        // live selection on dismiss); else the current editor selection. Bounded
        // here; the Rust side truncates further and flags it.
        const docState = useDocumentStore.getState();
        const activeDoc = docState.files.find(
          (f) => f.id === docState.activeFileId,
        );
        const activeFile = activeDoc?.relativePath ?? null;
        const sel = docState.selectionRange;
        const liveSelText =
          activeDoc?.content && sel && sel.end > sel.start
            ? activeDoc.content.slice(sel.start, sel.end)
            : null;
        const rawSelection = contextOverride?.selectedText ?? liveSelText;
        const selection = rawSelection ? rawSelection.slice(0, 4000) : null;
        // 1-based line range of the selection, so the model can Read the
        // surrounding region and edit in context. Keep the line source consistent
        // with the *text* source: for an explicit toolbar selection locate its
        // (unique) occurrence; otherwise use the live editor offsets.
        let selectionStartLine: number | null = null;
        let selectionEndLine: number | null = null;
        const selContent = activeDoc?.content;
        if (selContent && contextOverride?.selectedText) {
          const at = selContent.indexOf(contextOverride.selectedText);
          if (
            at >= 0 &&
            selContent.indexOf(contextOverride.selectedText, at + 1) === -1
          ) {
            selectionStartLine = offsetToLineCol(selContent, at).line;
            selectionEndLine = offsetToLineCol(
              selContent,
              at + contextOverride.selectedText.length,
            ).line;
          }
        } else if (selContent && sel && sel.end > sel.start) {
          selectionStartLine = offsetToLineCol(selContent, sel.start).line;
          selectionEndLine = offsetToLineCol(selContent, sel.end).line;
        }
        await invoke("run_native_agent", {
          projectPath,
          prompt: nativePrompt,
          tabId: activeTabId,
          model: nativeModel || null,
          baseUrl: cred?.base_url || null,
          images: nativeImages.length ? nativeImages : null,
          numCtx: ns.nativeNumCtx ?? null,
          temperature: ns.nativeTemperature ?? null,
          activeFile,
          selection,
          selectionStartLine,
          selectionEndLine,
          personalizationPrompt: null,
        });
      } else if (resumeSessionId) {
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
          streamingStartedAt: null,
          error: err?.message || String(err),
        }),
      );
    }
  },

  queueGuidance: (tabId, prompt, contextOverride) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const queuedGuidance = [
        ...(tab.queuedGuidance ?? []),
        {
          id: nextGuidanceId(),
          prompt: trimmed,
          contextOverride,
          createdAt: Date.now(),
        },
      ];
      return applyTabUpdate(state, tabId, { queuedGuidance });
    });
  },

  consumeQueuedGuidance: (tabId, guidanceId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    const queue = tab?.queuedGuidance ?? [];
    const displayedIndex = queue.findIndex(
      (guidance) => guidance.displayedInChat,
    );
    const targetIndex = guidanceId
      ? queue.findIndex((guidance) => guidance.id === guidanceId)
      : displayedIndex >= 0
        ? displayedIndex
        : 0;
    const next = targetIndex >= 0 ? queue[targetIndex] : null;
    if (!next) {
      if (tab?.forceQueuedGuidanceOnComplete) {
        set((s) =>
          applyTabUpdate(s, tabId, {
            forceQueuedGuidanceOnComplete: false,
            forcedQueuedGuidanceId: null,
          }),
        );
      }
      return null;
    }
    const rest = queue.filter((_, index) => index !== targetIndex);
    set((s) =>
      applyTabUpdate(s, tabId, {
        queuedGuidance: rest,
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
      }),
    );
    return next;
  },

  displayQueuedGuidanceInChat: (tabId, guidanceId) => {
    let displayedId: string | null = null;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      const queue = tab?.queuedGuidance ?? [];
      const targetId = guidanceId ?? queue[0]?.id;
      if (!tab || !targetId || queue.length === 0) return {};
      displayedId = targetId;
      return applyTabUpdate(state, tabId, {
        queuedGuidance: queue.map((guidance) => ({
          ...guidance,
          displayedInChat: guidance.displayedInChat || guidance.id === targetId,
        })),
      });
    });
    return displayedId;
  },

  removeQueuedGuidance: (tabId, guidanceId) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const queuedGuidance = (tab.queuedGuidance ?? []).filter(
        (guidance) => guidance.id !== guidanceId,
      );
      const nextForcedGuidanceId =
        tab.forcedQueuedGuidanceId === guidanceId
          ? (queuedGuidance.find((guidance) => guidance.displayedInChat)?.id ??
            null)
          : tab.forcedQueuedGuidanceId;
      return applyTabUpdate(state, tabId, {
        queuedGuidance,
        ...(tab.forcedQueuedGuidanceId === guidanceId
          ? {
              forceQueuedGuidanceOnComplete: nextForcedGuidanceId !== null,
              forcedQueuedGuidanceId: nextForcedGuidanceId,
            }
          : {}),
      });
    });
  },

  clearQueuedGuidance: (tabId) => {
    set((state) =>
      applyTabUpdate(state, tabId, {
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
      }),
    );
  },

  consumeTemporaryFilePaths: (tabId) => {
    const paths =
      get().tabs.find((tab) => tab.id === tabId)?.pendingTemporaryFilePaths ??
      [];
    if (paths.length > 0) {
      set((state) =>
        applyTabUpdate(state, tabId, { pendingTemporaryFilePaths: [] }),
      );
    }
    return paths;
  },

  forceQueuedGuidanceNow: async (tabId, guidanceId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.isStreaming || !(tab.queuedGuidance?.length ?? 0)) return;
    const targetId = get().displayQueuedGuidanceInChat(tabId, guidanceId);
    if (!targetId) return;

    set((state) => {
      const currentTab = state.tabs.find((t) => t.id === tabId);
      const existingForcedId = currentTab?.forcedQueuedGuidanceId ?? null;
      const existingForcedStillQueued = (currentTab?.queuedGuidance ?? []).some(
        (guidance) => guidance.id === existingForcedId,
      );
      return applyTabUpdate(state, tabId, {
        forceQueuedGuidanceOnComplete: true,
        forcedQueuedGuidanceId: existingForcedStillQueued
          ? existingForcedId
          : targetId,
      });
    });

    try {
      if (useSettingsStore.getState().nativeAgentEnabled) {
        await invoke("stop_native_agent", { tabId });
        set({ _cancelledByUser: true });
      } else {
        const interrupted = await invoke<boolean>(
          "interrupt_claude_execution",
          {
            tabId,
          },
        );
        if (interrupted) {
          set({ _cancelledByUser: true });
        }
      }
    } catch (err: any) {
      set((state) => {
        const currentTab = state.tabs.find((t) => t.id === tabId);
        const existingForcedId = currentTab?.forcedQueuedGuidanceId ?? null;
        const nextForcedId =
          existingForcedId && existingForcedId !== targetId
            ? existingForcedId
            : null;
        return applyTabUpdate(state, tabId, {
          queuedGuidance: (currentTab?.queuedGuidance ?? []).map((guidance) =>
            guidance.id === targetId
              ? { ...guidance, displayedInChat: false }
              : guidance,
          ),
          forceQueuedGuidanceOnComplete: nextForcedId !== null,
          forcedQueuedGuidanceId: nextForcedId,
          error: err?.message || String(err),
        });
      });
    }
  },

  cancelExecution: async (tabId) => {
    const activeTabId = tabId ?? get().activeTabId;
    const tab = get().tabs.find((t) => t.id === activeTabId);
    if (!tab?.isStreaming) return;
    set({ _cancelledByUser: true });
    // Surface a "Stopped." marker while the tab is still streaming, so it isn't
    // dropped by the handleStreamMessage isStreaming guard. subtype "cancelled"
    // is treated as non-error (use-claude-events) and renders as a plain result,
    // so the user gets acknowledgment their Stop took effect instead of dead-air.
    get()._appendMessage(activeTabId, {
      type: "result",
      subtype: "cancelled",
      is_error: false,
      result: "Stopped.",
    } as ClaudeStreamMessage);
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        isStreaming: false,
        streamingStartedAt: null,
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
      }),
    );
    try {
      if (useSettingsStore.getState().nativeAgentEnabled) {
        await invoke("stop_native_agent", { tabId: activeTabId });
      } else {
        await invoke("cancel_claude_execution", { tabId: activeTabId });
      }
    } catch {
      // The UI has already moved to a stopped state; stale output is ignored.
    }
  },

  resendFromMessage: async (messageIndex, newText) => {
    const state = get();
    const tabId = state.activeTabId;
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || tab.isStreaming) return;
    const target = tab.messages[messageIndex];
    if (!target || target.type !== "user") return;

    // Recover the prompt text, dropping a leading context-label line if present.
    const recoverPrompt = (): string => {
      const raw = target.message?.content;
      const text = Array.isArray(raw)
        ? raw
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
        : typeof raw === "string"
          ? raw
          : "";
      const firstBreak = text.indexOf("\n");
      if (firstBreak > 0) {
        const firstLine = text.slice(0, firstBreak).trim();
        if (firstLine.startsWith("@") || firstLine.startsWith("~@")) {
          return text.slice(firstBreak + 1);
        }
      }
      return text;
    };

    const text = (newText ?? recoverPrompt()).trim();
    if (!text) return;

    // Drop the target user message and everything after it, then resend.
    const truncated = tab.messages.slice(0, messageIndex);
    set((s) => applyTabUpdate(s, tabId, { messages: truncated, error: null }));
    await get().sendPrompt(text, undefined, {
      tabId,
      preserveTabProvider: true,
    });
  },

  clearMessages: () => {
    const { activeTabId } = get();
    // Also clear the native runtime's per-tab conversation memory.
    nativeSeededTabs.delete(activeTabId);
    // Allow a fresh AI title for the next conversation in this reused tab.
    aiTitleRefinedTabs.delete(activeTabId);
    void Promise.resolve(
      invoke("clear_native_session", { tabId: activeTabId }),
    ).catch(() => {});
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        error: null,
        streamingStartedAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
        draft: { input: "", pinnedContexts: [] },
      }),
    );
  },

  resetForProject: (projectPath) => {
    const state = get();
    const tabsAlreadyScoped =
      state.activeProjectPath === projectPath &&
      state.tabs.every((tab) => tab.projectPath === projectPath);
    if (tabsAlreadyScoped) return;

    const id = nextTabId();
    const tab = makeDefaultTab(id, projectPath);
    const nextSelectedProviderCredentialId =
      selectedCredentialForProviderKey(tab.providerKey) ??
      CLAUDE_CODE_PROVIDER_ID;
    persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);

    set({
      tabs: [tab],
      activeTabId: id,
      activeProjectPath: projectPath,
      messages: tab.messages,
      sessionId: tab.sessionId,
      isStreaming: tab.isStreaming,
      streamingStartedAt: tab.streamingStartedAt,
      error: tab.error,
      totalInputTokens: tab.totalInputTokens,
      totalOutputTokens: tab.totalOutputTokens,
      pendingAttachments: [],
      pendingComposerInput: null,
      pendingPinnedContextRemovalLabels: [],
      selectedProviderCredentialId: nextSelectedProviderCredentialId,
      _cancelledByUser: false,
    });
  },

  newSession: () => {
    log.info("Starting new session");
    const { activeTabId, tabs } = get();
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const projectPath =
      get().activeProjectPath ??
      useDocumentStore.getState().projectRoot ??
      null;
    if (activeTab?.isStreaming) {
      const id = nextTabId();
      const newTab = {
        ...makeDefaultTab(id, projectPath),
        providerKey:
          activeTab.providerKey ??
          providerKeyForSelectedCredential(get().selectedProviderCredentialId),
      };
      set({
        tabs: [...tabs, newTab],
        activeTabId: id,
        activeProjectPath: projectPath,
        messages: newTab.messages,
        sessionId: newTab.sessionId,
        isStreaming: newTab.isStreaming,
        streamingStartedAt: newTab.streamingStartedAt,
        error: newTab.error,
        totalInputTokens: newTab.totalInputTokens,
        totalOutputTokens: newTab.totalOutputTokens,
        selectedProviderCredentialId: selectedCredentialForProviderKey(
          newTab.providerKey,
        ),
      });
      return;
    }

    // "New Chat" reuses the same tab id, so also wipe the native runtime's
    // per-tab memory — otherwise the local model carries prior context into the
    // new conversation (mirrors clearMessages / closeTab).
    nativeSeededTabs.delete(activeTabId);
    aiTitleRefinedTabs.delete(activeTabId);
    void Promise.resolve(
      invoke("clear_native_session", { tabId: activeTabId }),
    ).catch(() => {});

    set((s) => ({
      ...applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId: null,
        projectPath,
        providerKey:
          activeTab?.providerKey ??
          providerKeyForSelectedCredential(s.selectedProviderCredentialId),
        sessionProviderKey: null,
        error: null,
        isStreaming: false,
        streamingStartedAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
      }),
      activeProjectPath: projectPath,
    }));
  },

  resumeSession: async (sessionId: string, title?: string) => {
    log.info(`Resuming session: ${sessionId.slice(0, 8)}`);
    const sessionTitle = title?.trim() || undefined;
    const projectPath = useDocumentStore.getState().projectRoot;
    const state = get();
    let { activeTabId } = state;
    let { tabs } = state;
    const existingTab = tabs.find(
      (tab) => tab.sessionId === sessionId && tab.projectPath === projectPath,
    );

    if (existingTab) {
      const nextTitle = sessionTitle ?? existingTab.title;
      activeTabId = existingTab.id;
      const nextTabs = tabs.map((tab) =>
        tab.id === existingTab.id ? { ...tab, title: nextTitle } : tab,
      );
      const nextSelectedProviderCredentialId =
        selectedCredentialForProviderKey(existingTab.providerKey) ??
        CLAUDE_CODE_PROVIDER_ID;
      persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);
      set({
        tabs: nextTabs,
        activeTabId: existingTab.id,
        activeProjectPath: projectPath ?? existingTab.projectPath,
        messages: existingTab.messages,
        sessionId: existingTab.sessionId,
        isStreaming: existingTab.isStreaming,
        streamingStartedAt: existingTab.streamingStartedAt,
        error: existingTab.error,
        totalInputTokens: existingTab.totalInputTokens,
        totalOutputTokens: existingTab.totalOutputTokens,
        selectedProviderCredentialId: nextSelectedProviderCredentialId,
      });
      if (existingTab.isStreaming) return;
    } else {
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      if (activeTab?.isStreaming) {
        const id = nextTabId();
        const newTab = {
          ...makeDefaultTab(id, projectPath ?? state.activeProjectPath),
          providerKey:
            activeTab.providerKey ??
            providerKeyForSelectedCredential(
              get().selectedProviderCredentialId,
            ),
        };
        tabs = [...tabs, newTab];
        activeTabId = id;
        set({
          tabs,
          activeTabId,
          activeProjectPath: projectPath ?? newTab.projectPath,
          messages: newTab.messages,
          sessionId: newTab.sessionId,
          isStreaming: newTab.isStreaming,
          streamingStartedAt: newTab.streamingStartedAt,
          error: newTab.error,
          totalInputTokens: newTab.totalInputTokens,
          totalOutputTokens: newTab.totalOutputTokens,
          selectedProviderCredentialId: selectedCredentialForProviderKey(
            newTab.providerKey,
          ),
        });
      }
    }

    // Reset state with new session ID
    set((s) => ({
      ...applyTabUpdate(s, activeTabId, {
        messages: [],
        projectPath: projectPath ?? null,
        sessionId,
        providerKey: null,
        sessionProviderKey: null,
        error: null,
        isStreaming: false,
        streamingStartedAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: sessionTitle ?? "New Chat",
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
      }),
      activeProjectPath: projectPath ?? null,
    }));

    // Load session history from JSONL file
    if (projectPath) {
      try {
        const history = await invoke<any[]>("load_session_history", {
          projectPath,
          sessionId,
        });

        // Filter to displayable message types and map to ClaudeStreamMessage
        const rawMessages: ClaudeStreamMessage[] = [];
        for (const entry of history) {
          const type = entry.type;
          if (type === "user" || type === "assistant" || type === "result") {
            rawMessages.push(entry as ClaudeStreamMessage);
          }
        }

        const messages = rawMessages.map(sanitizeStoredUserMessageForDisplay);
        const totals = usageTotalsForMessages(messages);
        const providerKey = inferProviderKeyFromHistory(history);
        const selectedProviderCredentialId =
          providerCredentialIdFromSessionKey(providerKey);
        const nextSelectedProviderCredentialId =
          selectedProviderCredentialId === undefined
            ? CLAUDE_CODE_PROVIDER_ID
            : selectedProviderCredentialId;
        persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);
        set((s) => ({
          ...applyTabUpdate(s, activeTabId, {
            messages,
            providerKey:
              providerKey ??
              providerKeyForSelectedCredential(
                nextSelectedProviderCredentialId,
              ),
            sessionProviderKey:
              providerKey ??
              providerKeyForSelectedCredential(
                nextSelectedProviderCredentialId,
              ),
            title: sessionTitle ?? titleForMessages(rawMessages) ?? "New Chat",
            totalInputTokens: totals.inputTokens,
            totalOutputTokens: totals.outputTokens,
          }),
          selectedProviderCredentialId: nextSelectedProviderCredentialId,
        }));
      } catch (err) {
        log.error("Failed to load session history", { error: String(err) });
      }
    }

    // The resumed conversation lives only in the UI; the native runtime has no
    // memory of it. Drop the seeded flag and any stale native memory so the next
    // native turn re-seeds from the loaded history (native mode resumes too).
    // Done last so it can't preempt the load_session_history call above.
    nativeSeededTabs.delete(activeTabId);
    // Resumed sessions already carry a persisted/derived title; don't AI-rename
    // them on the next assistant reply.
    aiTitleRefinedTabs.add(activeTabId);
    void Promise.resolve(
      invoke("clear_native_session", { tabId: activeTabId }),
    ).catch(() => {});
  },

  // ─── Tab Actions ───

  createTab: () => {
    log.debug("Creating new tab");
    const id = nextTabId();
    const state = get();
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const projectPath =
      state.activeProjectPath ??
      useDocumentStore.getState().projectRoot ??
      null;
    const newTab = {
      ...makeDefaultTab(id, projectPath),
      providerKey:
        activeTab?.providerKey ??
        providerKeyForSelectedCredential(state.selectedProviderCredentialId),
    };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: id,
      activeProjectPath: projectPath,
      // Project new tab fields to top-level
      messages: newTab.messages,
      sessionId: newTab.sessionId,
      isStreaming: newTab.isStreaming,
      streamingStartedAt: newTab.streamingStartedAt,
      error: newTab.error,
      totalInputTokens: newTab.totalInputTokens,
      totalOutputTokens: newTab.totalOutputTokens,
      selectedProviderCredentialId: selectedCredentialForProviderKey(
        newTab.providerKey,
      ),
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
    // Free the native runtime's conversation memory for this tab.
    nativeSeededTabs.delete(tabId);
    aiTitleRefinedTabs.delete(tabId);
    void Promise.resolve(invoke("clear_native_session", { tabId })).catch(
      () => {},
    );

    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const newTabs = state.tabs.filter((t) => t.id !== tabId);

    if (tabId === state.activeTabId) {
      // Switch to adjacent tab
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newActive = newTabs[newIdx];
      const nextSelectedProviderCredentialId =
        selectedCredentialForProviderKey(newActive.providerKey) ??
        CLAUDE_CODE_PROVIDER_ID;
      persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);
      set({
        tabs: newTabs,
        activeTabId: newActive.id,
        activeProjectPath: newActive.projectPath,
        // Project new active tab
        messages: newActive.messages,
        sessionId: newActive.sessionId,
        isStreaming: newActive.isStreaming,
        streamingStartedAt: newActive.streamingStartedAt,
        error: newActive.error,
        totalInputTokens: newActive.totalInputTokens,
        totalOutputTokens: newActive.totalOutputTokens,
        selectedProviderCredentialId: nextSelectedProviderCredentialId,
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
    const nextSelectedProviderCredentialId =
      selectedCredentialForProviderKey(targetTab.providerKey) ??
      CLAUDE_CODE_PROVIDER_ID;
    persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);

    // Project the target tab's fields to top-level
    set({
      activeTabId: tabId,
      activeProjectPath: targetTab.projectPath,
      messages: targetTab.messages,
      sessionId: targetTab.sessionId,
      isStreaming: targetTab.isStreaming,
      streamingStartedAt: targetTab.streamingStartedAt,
      error: targetTab.error,
      totalInputTokens: targetTab.totalInputTokens,
      totalOutputTokens: targetTab.totalOutputTokens,
      selectedProviderCredentialId: nextSelectedProviderCredentialId,
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

    // Best-effort AI title refinement: once an assistant reply has landed for a
    // tab, try to upgrade its heuristic title. Fires at most once per tab
    // (guarded inside the helper) and degrades silently — never blocks or
    // throws into the append path.
    if (msg.type === "assistant" && !aiTitleRefinedTabs.has(tabId)) {
      void maybeRefineChatTitleWithAi(tabId);
    }
  },

  _setSessionId: (tabId: string, id: string) => {
    set((state) => applyTabUpdate(state, tabId, { sessionId: id }));
  },

  _setSessionTitle: (sessionId: string, title: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.sessionId === sessionId &&
        tab.projectPath === state.activeProjectPath
          ? { ...tab, title: cleanTitle }
          : tab,
      ),
    }));
  },

  _setStreaming: (tabId: string, streaming: boolean) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      return applyTabUpdate(state, tabId, {
        isStreaming: streaming,
        streamingStartedAt: streaming
          ? (tab?.streamingStartedAt ?? Date.now())
          : null,
      });
    });
  },

  _setError: (tabId: string, error: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { error }));
  },
}));
