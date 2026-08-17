import { type RefObject, useMemo, useState } from "react";
import { EditorView } from "@codemirror/view";
import { ListTreeIcon, SparklesIcon, Loader2Icon } from "lucide-react";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist, summarizeSection } from "@/lib/ai-assist";
import { cn } from "@/lib/utils";
import { parseTypstHeadings } from "@/lib/typst-project";

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
  /** 1-based line number of the section command, shown for disambiguation. */
  line: number;
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
    const line = content.slice(0, m.index).split("\n").length;
    items.push({ title, level: level < 0 ? 0 : level, pos: m.index, line });
  }
  return items;
}

/**
 * Typst outline from `= Heading` markup. Heading depth is the run length, so
 * `=` is level 0 (matching LaTeX `\section`) and each extra `=` nests one
 * deeper, keeping the shared level-normalization below meaningful.
 */
function parseTypstOutline(content: string): OutlineItem[] {
  let pos = 0;
  const lineStarts: number[] = [0];
  for (const ch of content) {
    pos += ch.length;
    if (ch === "\n") lineStarts.push(pos);
  }
  return parseTypstHeadings(content).map((h) => ({
    title: h.title,
    level: Math.max(0, h.level - 1),
    pos: lineStarts[h.line - 1] ?? 0,
    line: h.line,
  }));
}

export function DocumentOutline({
  editorView,
  onBeforeJump,
}: {
  editorView: RefObject<EditorView | null>;
  /** Called before jumping when there is no CodeMirror view (e.g. rich editor). */
  onBeforeJump?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const activeFile = files.find((file) => file.id === activeFileId);
  const activeSource = useMemo(() => {
    if (activeFile?.type !== "tex" && activeFile?.type !== "typst") return null;
    return { kind: activeFile.type, content: activeFile.content ?? "" };
  }, [activeFile?.type, activeFile?.content]);

  const outline = useMemo(() => {
    if (!activeSource) return [];
    return activeSource.kind === "typst"
      ? parseTypstOutline(activeSource.content)
      : parseOutline(activeSource.content);
  }, [activeSource]);

  // Normalize levels so the shallowest heading present sits flush-left.
  const minLevel = outline.reduce(
    (min, i) => Math.min(min, i.level),
    SECTION_LEVELS.length,
  );

  if (activeSource === null) return null;

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
      onBeforeJump?.();
      useDocumentStore.getState().requestJumpToPosition(pos);
    }
  };

  const handleSummarize = async () => {
    if (!activeSource?.content || summarizing || !canUseAiAssist()) return;
    setSummarizing(true);
    try {
      const text = await summarizeSection(activeSource.content);
      setSummary(text);
    } catch (err) {
      showWorkspaceError(
        "Summary failed",
        err instanceof Error
          ? err.message
          : "Could not summarize the document.",
        { dedupeKey: "outline-summarize" },
      );
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Document outline"
              aria-pressed={open}
              className={cn(
                "size-7",
                open ? "bg-accent" : "text-muted-foreground",
              )}
            >
              <ListTreeIcon className="size-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Document outline</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="font-medium text-muted-foreground text-xs">
            Outline
          </span>
          {aiSummarize && canUseAiAssist() && outline.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleSummarize()}
              disabled={summarizing}
              aria-label="Summarize document with AI"
              className="h-6 gap-1 px-1.5 text-xs"
              title="Summarize document with AI"
            >
              {summarizing ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <SparklesIcon className="size-3" />
              )}
              Summary
            </Button>
          )}
        </div>
        {summary && (
          <div className="mx-2 mb-2 rounded border border-border/60 bg-muted/30 p-2 text-muted-foreground text-xs leading-snug">
            {summary}
          </div>
        )}
        {outline.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
            <ListTreeIcon className="size-5 text-muted-foreground/60" />
            <p className="text-muted-foreground text-xs leading-relaxed">
              No sections yet — add{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                {"\\section{…}"}
              </code>{" "}
              to build an outline.
            </p>
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto pb-1">
            {outline.map((item, idx) => (
              <button
                key={`${item.pos}-${idx}`}
                type="button"
                onClick={() => jumpTo(item.pos)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                style={{ paddingLeft: `${(item.level - minLevel) * 12 + 8}px` }}
                title={`${item.title} · line ${item.line}`}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
                  {item.line}
                </span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
