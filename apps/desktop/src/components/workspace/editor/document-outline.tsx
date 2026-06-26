import { type RefObject, useMemo, useState } from "react";
import { EditorView } from "@codemirror/view";
import { ListTreeIcon, SparklesIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist, summarizeSection } from "@/lib/ai-assist";
import { cn } from "@/lib/utils";

// Sectioning commands ordered by nesting depth. The index doubles as the
// indentation level used to render a hierarchical outline.
const SECTION_LEVELS = [
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
];

const SECTION_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/g;

interface OutlineItem {
  title: string;
  level: number;
  /** Character offset of the command in the document. */
  pos: number;
}

/** Read the brace-balanced argument starting at `open` (index of `{`). */
function readBraceArg(
  text: string,
  open: number,
): { value: string; end: number } {
  let depth = 0;
  let out = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return { value: out, end: i + 1 };
    }
    out += ch;
  }
  return { value: out, end: text.length };
}

/** Strip simple inline LaTeX markup so titles read as plain text. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/[{}$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  SECTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_RE.exec(content)) !== null) {
    const level = SECTION_LEVELS.indexOf(m[1]);
    const bracePos = m.index + m[0].length - 1;
    const { value } = readBraceArg(content, bracePos);
    const title = cleanTitle(value) || `(untitled ${m[1]})`;
    items.push({ title, level: level < 0 ? 0 : level, pos: m.index });
  }
  return items;
}

export function DocumentOutline({
  editorView,
}: {
  editorView: RefObject<EditorView | null>;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const aiAssistEnabled = useSettingsStore((s) => s.aiAssistEnabled);
  const activeContent = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.type === "tex" ? (f.content ?? "") : null;
  });

  const outline = useMemo(
    () => (activeContent ? parseOutline(activeContent) : []),
    [activeContent],
  );

  // Normalize levels so the shallowest heading present sits flush-left.
  const minLevel = outline.reduce(
    (min, i) => Math.min(min, i.level),
    SECTION_LEVELS.length,
  );

  if (activeContent === null) return null;

  const jumpTo = (pos: number) => {
    setOpen(false);
    const view = editorView.current;
    if (view) {
      const target = Math.min(pos, view.state.doc.length);
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "start" }),
      });
      view.focus();
    } else {
      useDocumentStore.getState().requestJumpToPosition(pos);
    }
  };

  const handleSummarize = async () => {
    if (!activeContent || summarizing || !canUseAiAssist()) return;
    setSummarizing(true);
    try {
      const text = await summarizeSection(activeContent);
      setSummary(text);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Summary failed");
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TooltipIconButton
          tooltip="Document outline"
          aria-pressed={open}
          className={cn("size-7", open ? "bg-accent" : "text-muted-foreground")}
        >
          <ListTreeIcon className="size-4" />
        </TooltipIconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="font-medium text-muted-foreground text-xs">
            Outline
          </span>
          {aiAssistEnabled && canUseAiAssist() && outline.length > 0 && (
            <button
              type="button"
              onClick={() => void handleSummarize()}
              disabled={summarizing}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Summarize document with AI"
            >
              {summarizing ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <SparklesIcon className="size-3" />
              )}
              Summary
            </button>
          )}
        </div>
        {summary && (
          <div className="mx-2 mb-2 rounded border border-border/60 bg-muted/30 p-2 text-muted-foreground text-xs leading-snug">
            {summary}
          </div>
        )}
        {outline.length === 0 ? (
          <div className="px-2 py-3 text-center text-muted-foreground text-xs">
            No sections found
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto pb-1">
            {outline.map((item, idx) => (
              <button
                key={`${item.pos}-${idx}`}
                type="button"
                onClick={() => jumpTo(item.pos)}
                className="block w-full truncate rounded px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                style={{ paddingLeft: `${(item.level - minLevel) * 12 + 8}px` }}
                title={item.title}
              >
                {item.title}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
