import {
  type AgentBackend,
  isNativeApiBackend,
  isNativeGroqBackend,
  isNativeOllamaBackend,
  isCursorCliBackend,
} from "@/lib/agent-backend";
import { useSettingsStore } from "@/stores/settings-store";

/** User-facing copy that depends on the active agent backend. */
export function getChatLabels(backend: AgentBackend) {
  if (isNativeGroqBackend(backend)) {
    return {
      assistantName: "Groq",
      fixWithChat: "Fix with Groq",
      fixAllWithChat: "Fix all with Groq",
      historyBeforeEdit: "Before Groq edit",
      historyAfterEdit: "After Groq edit",
      snapshotBeforeEdit: "[agent] Before Groq edit",
      snapshotAfterEdit: "[agent] After Groq edit",
      commentForAgent: "the Groq assistant",
      commentPlaceholder: "Type a question or note for Groq…",
      processFailedStart:
        "Groq agent failed to start. Check your Groq API key in Settings → Provider.",
      processExited:
        "Groq agent stopped unexpectedly. Check your API key, rate limits, or try again.",
      emptyStateHint:
        "Ask about your LaTeX document, request edits, or attach files for context.",
      openChatAria: "Open chat",
      showSessionHistory: false,
      agentAuthorLabel: "Groq",
      agentAuthorInitial: "G",
    } as const;
  }

  if (isNativeApiBackend(backend)) {
    return {
      assistantName: "AI",
      fixWithChat: "Fix with AI",
      fixAllWithChat: "Fix all with AI",
      historyBeforeEdit: "Before AI edit",
      historyAfterEdit: "After AI edit",
      snapshotBeforeEdit: "[agent] Before AI edit",
      snapshotAfterEdit: "[agent] After AI edit",
      commentForAgent: "the AI assistant",
      commentPlaceholder: "Type a question or note for the AI assistant…",
      processFailedStart:
        "Native API agent failed to start. Check your provider API key in Settings → Provider.",
      processExited:
        "Native API agent stopped unexpectedly. Check your API key, rate limits, or try again.",
      emptyStateHint:
        "Ask about your LaTeX document, request edits, or attach files for context.",
      openChatAria: "Open chat",
      showSessionHistory: false,
      agentAuthorLabel: "AI",
      agentAuthorInitial: "A",
    } as const;
  }

  if (isNativeOllamaBackend(backend)) {
    return {
      assistantName: "AI",
      fixWithChat: "Fix with AI",
      fixAllWithChat: "Fix all with AI",
      historyBeforeEdit: "Before AI edit",
      historyAfterEdit: "After AI edit",
      snapshotBeforeEdit: "[agent] Before AI edit",
      snapshotAfterEdit: "[agent] After AI edit",
      commentForAgent: "the AI assistant",
      commentPlaceholder: "Type a question or note for the AI assistant…",
      processFailedStart:
        "Local agent failed to start. Check that Ollama is running with a chat model installed.",
      processExited:
        "Local agent stopped unexpectedly. Check Ollama, tool support, or try again.",
      emptyStateHint:
        "Ask about your LaTeX document, request edits, or attach files for context.",
      openChatAria: "Open chat",
      showSessionHistory: false,
      agentAuthorLabel: "AI",
      agentAuthorInitial: "A",
    } as const;
  }

  if (isCursorCliBackend(backend)) {
    return {
      assistantName: "Cursor",
      fixWithChat: "Fix with Cursor",
      fixAllWithChat: "Fix all with Cursor",
      historyBeforeEdit: "Before Cursor edit",
      historyAfterEdit: "After Cursor edit",
      snapshotBeforeEdit: "[cursor] Before Cursor edit",
      snapshotAfterEdit: "[cursor] After Cursor edit",
      commentForAgent: "Cursor Agent",
      commentPlaceholder: "Type a question or note for Cursor Agent…",
      processFailedStartWindows:
        "Cursor agent failed to start. Install the Cursor CLI and sign in.",
      processFailedStart:
        "Cursor agent failed to start. Install the Cursor CLI (`curl https://cursor.com/install -fsS | bash`) and sign in.",
      processExited:
        "Cursor agent exited unexpectedly. Check authentication or API limits.",
      emptyStateHint:
        "Ask Cursor about your LaTeX document, request edits, or attach files for context.",
      openChatAria: "Open AI Assistant",
      showSessionHistory: true,
      agentAuthorLabel: "Cursor",
      agentAuthorInitial: "Cu",
    } as const;
  }

  return {
    assistantName: "Claude",
    fixWithChat: "Fix with chat",
    fixAllWithChat: "Fix all with chat",
    historyBeforeEdit: "Before Claude",
    historyAfterEdit: "After Claude",
    snapshotBeforeEdit: "[claude] Before Claude",
    snapshotAfterEdit: "[claude] After Claude",
    commentForAgent: "Claude Code",
    commentPlaceholder: "Type a question or note for Claude Code…",
    processFailedStartWindows:
      "Claude process failed to start. Check that Claude Code CLI is installed and git-bash is available.",
    processFailedStart:
      "Claude process failed to start. Check that Claude Code CLI is installed.",
    processExited:
      "Claude process exited unexpectedly. This may be due to rate limiting or an API error.",
    emptyStateHint:
      "Ask Claude about your LaTeX document, request edits, or attach files for context.",
    openChatAria: "Open AI Assistant",
    showSessionHistory: true,
    agentAuthorLabel: "Claude",
    agentAuthorInitial: "C",
  } as const;
}

export function useChatLabels() {
  const backend = useSettingsStore((s) => s.agentBackend);
  return getChatLabels(backend);
}

export function isAgentSnapshotMessage(message: string): boolean {
  return (
    message.startsWith("[claude]") ||
    message.startsWith("[agent]") ||
    message.startsWith("[cursor]")
  );
}

export function displayAgentAuthor(
  author: string,
  backend: AgentBackend,
): string {
  if (author === "claude" || author === "cursor") {
    return getChatLabels(backend).agentAuthorLabel;
  }
  return author;
}

export function snapshotTypeLabel(
  message: string,
  backend: AgentBackend,
): string {
  if (message.startsWith("[auto]")) return "Auto-save";
  if (message.startsWith("[manual]")) return "Save";
  if (message.startsWith("[compile]")) return "Compile";
  if (isAgentSnapshotMessage(message)) {
    const labels = getChatLabels(backend);
    return message.includes("Before")
      ? labels.historyBeforeEdit
      : labels.historyAfterEdit;
  }
  if (message.startsWith("[restore]")) return "Restore";
  if (message.startsWith("[init]")) return "Initial";
  return message;
}
