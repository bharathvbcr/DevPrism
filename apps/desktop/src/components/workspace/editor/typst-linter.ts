import { linter, type Diagnostic, type Action } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import {
  getTypstDiagnostics,
  type TypstDiagnostic,
} from "@/lib/typst-diagnostics";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { canUseAiAssist } from "@/lib/ai-assist";
import { applyLintLineFix } from "@/lib/inline-edit";
import { toast } from "sonner";
import { showWorkspaceError } from "@/stores/workspace-banner-store";

const SEVERITY_WEIGHT: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Convert a TypstDiagnostic into a CodeMirror 6 Diagnostic object.
 */
export function mapTypstDiagnosticToCM(
  diag: TypstDiagnostic,
  doc: Text,
  fileName: string,
  absolutePath?: string,
  content?: string,
): Diagnostic {
  // Line clamping: 1-based, clamped between 1 and doc.lines
  const rawLine = Number.isFinite(diag.line) ? (diag.line ?? 1) : 1;
  const lineNum = Math.max(1, Math.min(rawLine, doc.lines));
  const lineObj = doc.line(lineNum);

  // Column clamping: 1-based to 0-based offset
  const rawCol = Number.isFinite(diag.column) ? (diag.column ?? 1) : 1;
  const colOffset = Math.max(0, rawCol - 1);
  let from = Math.min(lineObj.from + colOffset, lineObj.to);
  let to = Math.min(from + 1, doc.length);

  // Handle edge cases at EOF or empty document
  if (from === to && from < doc.length) {
    to = from + 1;
  } else if (from === doc.length && doc.length > 0) {
    from = Math.max(0, to - 1);
  }

  // Format message including hints
  let message = diag.message;
  if (diag.hints && diag.hints.length > 0) {
    message += `\nHint: ${diag.hints.join("; ")}`;
  }

  const actions: Action[] = [
    {
      name:
        useSettingsStore.getState().aiLintFix && canUseAiAssist()
          ? "Fix with AI"
          : "Fix with Chat",
      apply: (_v: EditorView, _from: number, _to: number) => {
        if (
          useSettingsStore.getState().aiLintFix &&
          canUseAiAssist() &&
          absolutePath &&
          content != null
        ) {
          void applyLintLineFix({
            content,
            line: lineNum,
            message: diag.message,
            filePath: fileName,
            absolutePath,
          })
            .then(() => toast.success("Typst lint fix ready — review change"))
            .catch((err: unknown) => {
              showWorkspaceError(
                "Typst lint fix failed",
                err instanceof Error
                  ? err.message
                  : "AI fix could not be applied.",
                { dedupeKey: "typst-lint-fix" },
              );
              const ctx = `[Typst error in ${fileName}:${lineNum}:${diag.column ?? 1}]\n[Error: ${diag.message}]${
                diag.hints?.length ? `\n[Hints: ${diag.hints.join(", ")}]` : ""
              }`;
              useClaudeChatStore
                .getState()
                .sendPrompt(`${ctx}\n\nFix this Typst error.`);
            });
          return;
        }
        const ctx = `[Typst error in ${fileName}:${lineNum}:${diag.column ?? 1}]\n[Error: ${diag.message}]${
          diag.hints?.length ? `\n[Hints: ${diag.hints.join(", ")}]` : ""
        }`;
        useClaudeChatStore
          .getState()
          .sendPrompt(`${ctx}\n\nFix this Typst error.`);
      },
    },
  ];

  return {
    from,
    to,
    severity: diag.severity === "warning" ? "warning" : "error",
    message,
    source: "typst",
    actions,
  };
}

/**
 * CodeMirror 6 extension providing compiler-backed Typst linting.
 */
export function typstLinter() {
  return linter((view: EditorView) => {
    const docState = useDocumentStore.getState();
    const activeFile = docState.files.find(
      (f) => f.id === docState.activeFileId,
    );
    if (
      !activeFile ||
      (activeFile.type !== "typst" && !activeFile.name.endsWith(".typ"))
    ) {
      return [];
    }

    const rawDiags = getTypstDiagnostics(activeFile.relativePath);
    if (!rawDiags || rawDiags.length === 0) return [];

    const normActivePath = activeFile.relativePath
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");

    // Filter to diagnostics applicable to this file
    const fileDiags = rawDiags.filter((d) => {
      if (!d.file) return true;
      const normDiagFile = d.file.replace(/\\/g, "/").replace(/^\/+/, "");
      return normDiagFile === normActivePath;
    });

    // Map to CodeMirror Diagnostics
    const cmDiags = fileDiags.map((d) =>
      mapTypstDiagnosticToCM(
        d,
        view.state.doc,
        activeFile.relativePath,
        activeFile.absolutePath,
        activeFile.content,
      ),
    );

    // Stably sort diagnostics at the same offset by severity
    return cmDiags.sort((a, b) => {
      if (a.from !== b.from) return a.from - b.from;
      const weightA = SEVERITY_WEIGHT[a.severity] ?? 99;
      const weightB = SEVERITY_WEIGHT[b.severity] ?? 99;
      return weightA - weightB;
    });
  });
}
