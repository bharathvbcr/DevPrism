import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { linter, forceLinting } from "@codemirror/lint";
import {
  canUseAiAssist,
  checkGrammar,
  extractGrammarSpan,
} from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { runInlineEdit, type InlineEditSelection } from "@/lib/inline-edit";

const grammarCache = new Map<
  string,
  { issues: { message: string; fix: string }[]; at: number }
>();
const CACHE_TTL_MS = 45_000;

function cacheKey(fileId: string, line: string): string {
  return `${fileId}:${line}`;
}

export const aiGrammarCompartment = new Compartment();

export function aiGrammarExtension(
  enabled: boolean,
  options: {
    fileId: string;
    getAbsolutePath: () => string;
    getRelativePath: () => string;
    getContent: () => string;
  },
): Extension {
  if (!enabled) return [];

  const grammarLinter = linter((view) => {
    if (!useSettingsStore.getState().aiGrammarHints || !canUseAiAssist()) {
      return [];
    }

    const span = extractGrammarSpan(
      view.state.doc.toString(),
      view.state.selection.main.head,
    );
    if (!span) return [];

    const key = cacheKey(options.fileId, span.text);
    const cached = grammarCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.issues.map((issue) => ({
        from: span.from,
        to: span.to,
        severity: "info" as const,
        message: issue.message,
        actions: [
          {
            name: "Apply AI fix",
            apply: (v: EditorView) => {
              const selection: InlineEditSelection = {
                filePath: options.getRelativePath(),
                absolutePath: options.getAbsolutePath(),
                content: options.getContent(),
                from: span.from,
                to: span.to,
                selectedText: span.text,
                contextLabel: `@${options.getRelativePath()}`,
              };
              void runInlineEdit({
                action: "proofread",
                selection,
              });
              grammarCache.delete(key);
              v.focus();
            },
          },
        ],
      }));
    }
    return [];
  });

  const fetchPlugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private requestId = 0;

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate) {
        if (!useSettingsStore.getState().aiGrammarHints || !canUseAiAssist()) {
          return;
        }
        if (!update.docChanged && !update.selectionSet) return;

        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 2200);
      }

      private async refresh() {
        const doc = this.view.state.doc.toString();
        const span = extractGrammarSpan(
          doc,
          this.view.state.selection.main.head,
        );
        if (!span || span.text.trim().length < 12) return;

        const key = cacheKey(options.fileId, span.text);
        const id = ++this.requestId;
        try {
          const issues = await checkGrammar(span.text);
          if (id !== this.requestId) return;
          grammarCache.set(key, { issues, at: Date.now() });
          forceLinting(this.view);
        } catch {
          grammarCache.delete(key);
        }
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );

  return [grammarLinter, fetchPlugin];
}
