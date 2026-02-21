import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore } from "./document-store";
import { useHistoryStore } from "./history-store";

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
  type: "text" | "tool_use" | "tool_result";
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

interface ClaudeChatState {
  messages: ClaudeStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  /** Deferred prompt to send once the workspace is ready (set by project wizard) */
  pendingInitialPrompt: string | null;
  setPendingInitialPrompt: (prompt: string | null) => void;
  consumePendingInitialPrompt: () => string | null;

  // Actions
  sendPrompt: (userPrompt: string, contextOverride?: { label: string; filePath: string; selectedText: string }) => Promise<void>;
  cancelExecution: () => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => Promise<void>;

  // Internal actions (called by event hook)
  _appendMessage: (msg: ClaudeStreamMessage) => void;
  _setSessionId: (id: string) => void;
  _setStreaming: (streaming: boolean) => void;
  _setError: (error: string | null) => void;
}

// ─── Store ───

export const useClaudeChatStore = create<ClaudeChatState>()((set, get) => ({
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  pendingInitialPrompt: null,
  setPendingInitialPrompt: (prompt) => set({ pendingInitialPrompt: prompt }),
  consumePendingInitialPrompt: () => {
    const { pendingInitialPrompt } = get();
    if (pendingInitialPrompt) {
      set({ pendingInitialPrompt: null });
    }
    return pendingInitialPrompt;
  },

  sendPrompt: async (userPrompt: string, contextOverride?: { label: string; filePath: string; selectedText: string }) => {
    const { sessionId, isStreaming } = get();
    if (isStreaming) return;

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set({ error: "No project open" });
      return;
    }

    // Compute context label for display in chat history
    const activeFile = docState.files.find((f) => f.id === docState.activeFileId);
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

    set((state) => ({
      messages: [...state.messages, userMessage],
      isStreaming: true,
      error: null,
    }));

    // Flush unsaved edits to disk so Claude reads the latest content
    if (docState.files.some((f) => f.isDirty)) {
      await docState.saveAllFiles();
    }

    // Snapshot before Claude edit
    if (projectPath) {
      try {
        await useHistoryStore.getState().createSnapshot(projectPath, "[claude] Before Claude edit");
      } catch { /* snapshot failure should not block Claude */ }
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
    const model = "sonnet";

    try {
      if (sessionId) {
        // Resume existing session
        await invoke("resume_claude_code", {
          projectPath,
          sessionId,
          prompt,
          model,
        });
      } else {
        // New session
        await invoke("execute_claude_code", {
          projectPath,
          prompt,
          model,
        });
      }
    } catch (err: any) {
      set({
        isStreaming: false,
        error: err?.message || String(err),
      });
    }
  },

  cancelExecution: async () => {
    try {
      await invoke("cancel_claude_execution");
    } catch {
      // ignore
    }
    set({ isStreaming: false });
  },

  clearMessages: () => {
    set({
      messages: [],
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  },

  newSession: () => {
    set({
      messages: [],
      sessionId: null,
      error: null,
      isStreaming: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  },

  resumeSession: async (sessionId: string) => {
    const projectPath = useDocumentStore.getState().projectRoot;
    console.log("[store] resumeSession called:", { sessionId, projectPath });

    // Reset state with new session ID
    set({
      messages: [],
      sessionId,
      error: null,
      isStreaming: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });

    // Load session history from JSONL file
    if (projectPath) {
      try {
        console.log("[store] loading session history...");
        const history = await invoke<any[]>("load_session_history", {
          projectPath,
          sessionId,
        });
        console.log("[store] received history entries:", history.length);

        // Filter to displayable message types and map to ClaudeStreamMessage
        const messages: ClaudeStreamMessage[] = [];
        for (const entry of history) {
          const type = entry.type;
          if (type === "user" || type === "assistant" || type === "result") {
            messages.push(entry as ClaudeStreamMessage);
          }
        }

        console.log("[store] filtered to displayable messages:", messages.length);
        set({ messages });
      } catch (err) {
        console.error("[store] Failed to load session history:", err);
      }
    } else {
      console.warn("[store] no projectPath, skipping history load");
    }
  },

  _appendMessage: (msg: ClaudeStreamMessage) => {
    set((state) => {
      let inputDelta = 0;
      let outputDelta = 0;
      const usage = msg.usage || msg.message?.usage;
      if (usage) {
        inputDelta = usage.input_tokens || 0;
        outputDelta = usage.output_tokens || 0;
      }

      return {
        messages: [...state.messages, msg],
        totalInputTokens: state.totalInputTokens + inputDelta,
        totalOutputTokens: state.totalOutputTokens + outputDelta,
      };
    });
  },

  _setSessionId: (id: string) => {
    set({ sessionId: id });
  },

  _setStreaming: (streaming: boolean) => {
    set({ isStreaming: streaming });
    // After Claude finishes, snapshot the result
    if (!streaming) {
      const projectPath = useDocumentStore.getState().projectRoot;
      if (projectPath) {
        useHistoryStore.getState().createSnapshot(projectPath, "[claude] After Claude edit").catch(() => {});
      }
    }
  },

  _setError: (error: string | null) => {
    set({ error });
  },
}));
