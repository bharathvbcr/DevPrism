import { useSettingsStore } from "@/stores/settings-store";

/** User-facing copy that depends on Claude CLI vs native Ollama agent. */
export function getChatLabels(nativeAgentEnabled: boolean) {
  if (nativeAgentEnabled) {
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

  return {
    assistantName: "Claude",
    fixWithChat: "Fix with chat",
    fixAllWithChat: "Fix all with chat",
    historyBeforeEdit: "Before Claude",
    historyAfterEdit: "After Claude",
    snapshotBeforeEdit: "[claude] Before Claude edit",
    snapshotAfterEdit: "[claude] After Claude edit",
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
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  return getChatLabels(nativeAgentEnabled);
}

export function isAgentSnapshotMessage(message: string): boolean {
  return message.startsWith("[claude]") || message.startsWith("[agent]");
}

export function displayAgentAuthor(
  author: string,
  nativeAgentEnabled: boolean,
): string {
  if (author === "claude") {
    return getChatLabels(nativeAgentEnabled).agentAuthorLabel;
  }
  return author;
}

export function snapshotTypeLabel(
  message: string,
  nativeAgentEnabled: boolean,
): string {
  if (message.startsWith("[auto]")) return "Auto-save";
  if (message.startsWith("[manual]")) return "Save";
  if (message.startsWith("[compile]")) return "Compile";
  if (isAgentSnapshotMessage(message)) {
    const labels = getChatLabels(nativeAgentEnabled);
    return message.includes("Before")
      ? labels.historyBeforeEdit
      : labels.historyAfterEdit;
  }
  if (message.startsWith("[restore]")) return "Restore";
  if (message.startsWith("[init]")) return "Initial";
  return message;
}
