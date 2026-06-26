import { invoke } from "@tauri-apps/api/core";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import {
  useClaudeChatStore,
  type PromptContextOverride,
} from "@/stores/claude-chat-store";
import {
  canUseAiAssist,
  resolveAiProvider,
  fixLintLine,
  lineOffsets,
} from "@/lib/ai-assist";

export type InlineEditAction =
  | "rephrase"
  | "expand"
  | "proofread"
  | "grammar"
  | "shorten"
  | "formalize"
  | "simplify"
  | "edit";

export interface InlineEditSelection {
  filePath: string;
  absolutePath: string;
  content: string;
  from: number;
  to: number;
  selectedText: string;
  contextLabel: string;
}

const CHAT_PROMPTS: Record<InlineEditAction, string> = {
  rephrase:
    "Rephrase the selected text to improve clarity and flow while preserving meaning and all LaTeX commands. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
  expand:
    "Expand the selected text with more detail and specificity while preserving meaning and LaTeX structure. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
  proofread:
    "Proofread and fix grammar, spelling, and punctuation in the selected text while preserving meaning and LaTeX commands. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
  grammar:
    "Fix grammar, spelling, and punctuation in the selected text while preserving meaning and LaTeX commands. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
  shorten:
    "Shorten the selected text while preserving key meaning and LaTeX commands. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
  formalize:
    "Rewrite the selected text in a more formal, professional tone while preserving meaning and LaTeX. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
  simplify:
    "Simplify the selected text for clarity while preserving meaning and LaTeX. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
  edit: "Edit the selected text according to my instruction. Use the Edit tool to replace ONLY the selected span in the active file — do not change anything outside the selection.",
};

export function inlineEditChatPrompt(
  action: InlineEditAction,
  customInstruction?: string,
): string {
  const base = CHAT_PROMPTS[action];
  if (action === "edit" && customInstruction?.trim()) {
    return `${customInstruction.trim()}\n\n${base}`;
  }
  return base;
}

/** Build a proposed-change diff that replaces only the selected span. */
export function proposeSelectionReplacement(
  selection: InlineEditSelection,
  replacement: string,
): void {
  const { filePath, absolutePath, content, from, to } = selection;
  const newContent = content.slice(0, from) + replacement + content.slice(to);
  useProposedChangesStore.getState().addChange({
    id: `inline-${crypto.randomUUID()}`,
    filePath,
    absolutePath,
    oldContent: content,
    newContent,
    toolName: "Edit",
  });
}

/** Replace a single 1-based line via the proposed-changes flow. */
export function proposeLineReplacement(options: {
  filePath: string;
  absolutePath: string;
  content: string;
  line: number;
  newLineText: string;
}): void {
  const lines = options.content.split("\n");
  const idx = options.line - 1;
  if (idx < 0 || idx >= lines.length) return;
  let from = 0;
  for (let i = 0; i < idx; i++) from += lines[i].length + 1;
  const to = from + lines[idx].length;
  proposeSelectionReplacement(
    {
      filePath: options.filePath,
      absolutePath: options.absolutePath,
      content: options.content,
      from,
      to,
      selectedText: lines[idx],
      contextLabel: `@${options.filePath}:${options.line}`,
    },
    options.newLineText,
  );
}

/** Direct one-shot fix for a single lint error line. */
export async function applyLintLineFix(options: {
  content: string;
  line: number;
  message: string;
  filePath: string;
  absolutePath: string;
}): Promise<void> {
  const span = lineOffsets(options.content, options.line);
  if (!span) throw new Error("Invalid line number.");
  const fixed = (await fixLintLine(span.text, options.message)).trim();
  if (!fixed) throw new Error("AI returned an empty fix.");
  proposeLineReplacement({
    filePath: options.filePath,
    absolutePath: options.absolutePath,
    content: options.content,
    line: options.line,
    newLineText: fixed,
  });
}

/** Direct one-shot transform (Ollama or OpenAI-compatible), not the full agent loop. */
export function canUseDirectInlineTransform(): boolean {
  return canUseAiAssist();
}

async function runDirectInlineTransform(
  action: InlineEditAction,
  selectedText: string,
  customInstruction?: string,
): Promise<string> {
  const provider = resolveAiProvider();

  return invoke<string>("inline_transform_text", {
    text: selectedText,
    action,
    customInstruction: customInstruction ?? null,
    model: provider.model,
    baseUrl: provider.baseUrl,
    providerCredentialId: provider.providerCredentialId,
    numCtx: provider.numCtx,
    temperature: provider.temperature,
  });
}

export async function runInlineEdit(options: {
  action: InlineEditAction;
  selection: InlineEditSelection;
  customInstruction?: string;
  contextOverride?: PromptContextOverride;
}): Promise<"applied" | "chat"> {
  const { action, selection, customInstruction, contextOverride } = options;

  if (canUseDirectInlineTransform()) {
    const replacement = await runDirectInlineTransform(
      action,
      selection.selectedText,
      customInstruction,
    );
    proposeSelectionReplacement(selection, replacement);
    return "applied";
  }

  const chat = useClaudeChatStore.getState();
  const prompt = inlineEditChatPrompt(action, customInstruction);
  const context = contextOverride ?? {
    label: selection.contextLabel,
    filePath: selection.filePath,
    selectedText: selection.selectedText,
  };

  void chat.sendPrompt(prompt, context);
  chat.requestPinnedContextRemoval([context.label]);
  return "chat";
}

/** @deprecated Use canUseDirectInlineTransform */
export function inlineEditUsesNativeTransform(): boolean {
  return canUseDirectInlineTransform();
}

/** Whether a cloud provider (not Claude Code) is selected for chat fallback. */
export function inlineEditUsesDirectProvider(): boolean {
  return canUseAiAssist();
}

export function inlineEditSuccessMessage(action: InlineEditAction): string {
  switch (action) {
    case "rephrase":
      return "Rephrase ready — review the change";
    case "expand":
      return "Expansion ready — review the change";
    case "proofread":
    case "grammar":
      return "Grammar fix ready — review the change";
    case "shorten":
      return "Shortened text ready — review the change";
    case "formalize":
      return "Formal rewrite ready — review the change";
    case "simplify":
      return "Simplified text ready — review the change";
    default:
      return "Edit ready — review the change";
  }
}
