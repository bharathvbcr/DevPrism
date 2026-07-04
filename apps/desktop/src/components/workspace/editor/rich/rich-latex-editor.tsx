/**
 * ScholarDoc rich editor — a Word-like WYSIWYG view for .tex files.
 *
 * Built on TipTap/ProseMirror. The LaTeX source is parsed into a rich
 * document via `latex-rich-doc.ts`; edits are serialized back to LaTeX and
 * written to the document store (which drives autosave and compilation).
 * The preamble and any LaTeX the rich model doesn't understand are preserved
 * verbatim, so switching between Source and Rich views never loses content.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { EditorView } from "@codemirror/view";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import {
  BoldIcon,
  CodeIcon,
  CrosshairIcon,
  FileCode2Icon,
  FunctionSquareIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  RedoIcon,
  SigmaSquareIcon,
  SpellCheckIcon,
  FileTextIcon,
  TableIcon,
  UnderlineIcon,
  UndoIcon,
} from "lucide-react";
import {
  latexToRichDoc,
  richDocToLatex,
  type RichNode,
} from "@/lib/rich-editor/latex-rich-doc";
import { useDocumentStore } from "@/stores/document-store";
import { useEditorViewModeStore } from "@/stores/editor-view-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import {
  canUseAiAssist,
  checkGrammar,
  summarizeSection,
  type GrammarIssue,
} from "@/lib/ai-assist";
import { EditorAiSuggestions } from "@/components/workspace/editor/editor-ai-suggestions";
import { DocumentOutline } from "@/components/workspace/editor/document-outline";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { ToolbarGroup } from "@/components/ui/toolbar-group";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { countWords } from "@/components/workspace/editor/editor-status-bar";
import {
  ProblemsPopover,
  type DiagnosticItem,
} from "@/components/workspace/editor/problems-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { requestCompile } from "@/lib/compile-events";
import { triggerForwardSync } from "@/lib/forward-sync";
import {
  buildCompileFixPrompt,
  parseCompileErrors,
} from "@/lib/latex-compiler";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  DisplayMath,
  InlineMath,
  LatexInline,
  LatexRaw,
} from "./rich-latex-nodes";
import "katex/dist/katex.min.css";
import "./rich-latex-editor.css";

const SYNC_DEBOUNCE_MS = 400;

/** Map compile log errors to toolbar diagnostics (rich mode has no CodeMirror linter). */
function compileErrorsToDiagnostics(
  errorText: string | null | undefined,
  content: string,
  defaultFile?: string,
): DiagnosticItem[] {
  if (!errorText?.trim()) return [];
  const lines = content.split("\n");
  return parseCompileErrors(errorText, defaultFile).map((err) => {
    const line = Math.max(1, err.line ?? 1);
    let from = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      from += lines[i]!.length + 1;
    }
    const lineLen = lines[line - 1]?.length ?? 0;
    return {
      from,
      to: from + lineLen,
      severity: "error",
      message: err.message,
      line,
    };
  });
}

function lineToOffset(content: string, line: number): number {
  const lines = content.split("\n");
  const target = Math.max(1, line);
  let from = 0;
  for (let i = 0; i < target - 1 && i < lines.length; i++) {
    from += lines[i]!.length + 1;
  }
  return from;
}

const LATEX_NODE_TYPES = [
  "inlineMath",
  "displayMath",
  "latexInline",
  "latexRaw",
] as const;
type LatexNodeType = (typeof LATEX_NODE_TYPES)[number];

const HEADING_OPTIONS = [
  { value: "0", label: "Normal text" },
  { value: "1", label: "Section" },
  { value: "2", label: "Subsection" },
  { value: "3", label: "Subsubsection" },
  { value: "4", label: "Paragraph" },
];

interface MathDialogState {
  nodeType: LatexNodeType;
  latex: string;
}

interface GrammarSpan {
  from: number;
  to: number;
  text: string;
}

function getGrammarCheckSpan(editor: Editor): GrammarSpan | null {
  const { from, to, empty } = editor.state.selection;
  if (!empty) {
    const text = editor.state.doc.textBetween(from, to, "\n");
    if (text.trim().length >= 8) return { from, to, text };
    return null;
  }
  const { $from } = editor.state.selection;
  if (!$from.parent.isTextblock) return null;
  const start = $from.start();
  const end = $from.end();
  const text = editor.state.doc.textBetween(start, end, "\n");
  if (text.trim().length < 8) return null;
  return { from: start, to: end, text };
}

export function RichLatexEditor() {
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const fileName = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.name ?? "";
  });
  const isDirty = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return !!f?.isDirty;
  });
  const isSaving = useDocumentStore((s) => s.isSaving);
  const isCompiling = useDocumentStore((s) => s.isCompiling);
  const compileError = useDocumentStore((s) => s.compileError);
  const activeContent = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.type === "tex" ? (f.content ?? "") : null;
  });
  const updateFileContent = useDocumentStore((s) => s.updateFileContent);
  const setViewMode = useEditorViewModeStore((s) => s.setMode);
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);
  const aiGrammarHints = useSettingsStore((s) => s.aiGrammarHints);
  const aiLintFix = useSettingsStore((s) => s.aiLintFix);
  const aiCompileAssist = useSettingsStore((s) => s.aiCompileAssist);
  const aiAssistEnabled = useSettingsStore((s) => s.aiAssistEnabled);
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);

  const nullEditorViewRef = useRef<EditorView | null>(
    null,
  ) as RefObject<EditorView | null>;

  // Preamble/postamble of the current file, preserved verbatim across edits.
  const framesRef = useRef({ preamble: "", postamble: "" });
  // Last LaTeX we emitted; used to ignore our own store echoes.
  const lastEmittedRef = useRef<string | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const activeFileIdRef = useRef(activeFileId);
  activeFileIdRef.current = activeFileId;

  const [mathDialog, setMathDialog] = useState<MathDialogState | null>(null);
  const [mathDraft, setMathDraft] = useState("");
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [grammarOpen, setGrammarOpen] = useState(false);
  const [grammarLoading, setGrammarLoading] = useState(false);
  const [grammarIssues, setGrammarIssues] = useState<GrammarIssue[]>([]);
  const [grammarSpan, setGrammarSpan] = useState<GrammarSpan | null>(null);

  const openLatexDialog = useCallback(
    (nodeType: LatexNodeType, latex: string) => {
      setMathDialog({ nodeType, latex });
      setMathDraft(latex);
    },
    [],
  );

  const scheduleSync = useCallback(
    (editor: Editor) => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null;
        const latex = richDocToLatex({
          ...framesRef.current,
          doc: editor.getJSON() as RichNode,
        });
        lastEmittedRef.current = latex;
        updateFileContent(activeFileIdRef.current, latex);
      }, SYNC_DEBOUNCE_MS);
    },
    [updateFileContent],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        strike: false,
      }),
      Underline,
      Placeholder.configure({ placeholder: "Start writing your manuscript…" }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      InlineMath,
      DisplayMath,
      LatexInline,
      LatexRaw,
    ],
    editorProps: {
      attributes: {
        class: "rich-editor-content",
        "aria-label": "Rich manuscript editor",
      },
      handleDoubleClickOn: (_view, _pos, node) => {
        const type = node.type.name as LatexNodeType;
        if ((LATEX_NODE_TYPES as readonly string[]).includes(type)) {
          openLatexDialog(type, String(node.attrs.latex ?? ""));
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => scheduleSync(e),
  });

  // Load (or reload) the document when the file switches or its content
  // changes externally (AI edits, git checkout, source-view edits).
  useEffect(() => {
    if (!editor || activeContent === null) return;
    if (activeContent === lastEmittedRef.current) return;
    const parsed = latexToRichDoc(activeContent);
    framesRef.current = {
      preamble: parsed.preamble,
      postamble: parsed.postamble,
    };
    lastEmittedRef.current = null;
    // setContent without emitting an update (no echo back to the store).
    editor.commands.setContent(parsed.doc as never, false);
  }, [editor, activeFileId, activeContent]);

  // Flush pending sync on unmount so no edits are lost when switching views.
  useEffect(() => {
    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        if (editor && !editor.isDestroyed) {
          const latex = richDocToLatex({
            ...framesRef.current,
            doc: editor.getJSON() as RichNode,
          });
          if (latex !== lastEmittedRef.current) {
            updateFileContent(activeFileIdRef.current, latex);
          }
        }
      }
    };
  }, [editor, updateFileContent]);

  useEffect(() => {
    if (!editor) return;
    const updateSelection = () => {
      setHasTextSelection(!editor.state.selection.empty);
    };
    editor.on("selectionUpdate", updateSelection);
    updateSelection();
    return () => {
      editor.off("selectionUpdate", updateSelection);
    };
  }, [editor]);

  const handleSummarizeSelection = useCallback(async () => {
    if (!editor || !aiSummarize || !canUseAiAssist()) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;

    const selectedText = editor.state.doc.textBetween(from, to, "\n");
    setSummarizing(true);
    try {
      const summary = (await summarizeSection(selectedText)).trim();
      if (!summary) {
        showWorkspaceError(
          "Summarize failed",
          "Could not summarize the selected text.",
          { dedupeKey: "rich-editor-summarize-empty" },
        );
        return;
      }
      const paragraphs = summary
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: line }],
        }));
      editor
        .chain()
        .focus()
        .setTextSelection(to)
        .insertContent(paragraphs)
        .run();
      scheduleSync(editor);
      toast.success("Summary inserted");
    } catch (err) {
      showWorkspaceError(
        "Summarize failed",
        err instanceof Error
          ? err.message
          : "Could not summarize the selection.",
        { dedupeKey: "rich-editor-summarize" },
      );
    } finally {
      setSummarizing(false);
    }
  }, [aiSummarize, editor, scheduleSync]);

  const runGrammarCheck = useCallback(async () => {
    if (!editor || !aiGrammarHints || !aiAssistEnabled || !canUseAiAssist()) {
      return;
    }
    const span = getGrammarCheckSpan(editor);
    if (!span) {
      toast.message("Select text or place the cursor in a paragraph to check.");
      return;
    }

    setGrammarOpen(true);
    setGrammarLoading(true);
    setGrammarIssues([]);
    setGrammarSpan(span);
    try {
      const issues = await checkGrammar(span.text);
      setGrammarIssues(issues);
      if (issues.length === 0) {
        toast.success("No grammar issues found");
      }
    } catch (err) {
      showWorkspaceError(
        "Grammar check failed",
        err instanceof Error ? err.message : "Could not check grammar.",
        { dedupeKey: "rich-editor-grammar" },
      );
      setGrammarOpen(false);
    } finally {
      setGrammarLoading(false);
    }
  }, [aiAssistEnabled, aiGrammarHints, editor]);

  const applyGrammarFix = useCallback(
    (fix: string) => {
      if (!editor || !grammarSpan) return;
      editor
        .chain()
        .focus()
        .insertContentAt({ from: grammarSpan.from, to: grammarSpan.to }, fix)
        .run();
      scheduleSync(editor);
      setGrammarIssues([]);
      setGrammarSpan(null);
      setGrammarOpen(false);
      toast.success("Fix applied");
    },
    [editor, grammarSpan, scheduleSync],
  );

  // ⌘/Ctrl+Shift+L → switch back to LaTeX source view.
  // ⌘/Ctrl+Enter → compile PDF.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const inEditor =
        el?.tagName === "TEXTAREA" ||
        el?.tagName === "INPUT" ||
        el?.isContentEditable;
      if (!inEditor) return;

      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        requestCompile();
        return;
      }

      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "l") return;
      e.preventDefault();
      setViewMode("source");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setViewMode]);

  const applyMathEdit = useCallback(() => {
    if (!editor || !mathDialog) return;
    editor
      .chain()
      .focus()
      .updateAttributes(mathDialog.nodeType, { latex: mathDraft })
      .run();
    setMathDialog(null);
    scheduleSync(editor);
  }, [editor, mathDialog, mathDraft, scheduleSync]);

  if (activeContent === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Rich editing is available for .tex files. Open a LaTeX file, or switch
        back to Source view.
      </div>
    );
  }

  const headingValue = editor
    ? (HEADING_OPTIONS.find(
        (o) =>
          o.value !== "0" &&
          editor.isActive("heading", { level: Number(o.value) }),
      )?.value ?? "0")
    : "0";

  const selectedLatexNode = editor
    ? LATEX_NODE_TYPES.find((t) => editor.isActive(t))
    : undefined;

  const wordCount = activeContent ? countWords(activeContent) : 0;
  const compileDiagnostics = useMemo(
    () =>
      compileErrorsToDiagnostics(compileError, activeContent ?? "", fileName),
    [compileError, activeContent, fileName],
  );
  const compileFixAvailable =
    aiAssistEnabled && aiCompileAssist && canUseAiAssist();
  const lintFixAvailable = aiAssistEnabled && aiLintFix && canUseAiAssist();

  const jumpToCompileLine = useCallback(
    (from: number) => {
      setViewMode("source");
      requestJumpToPosition(from);
    },
    [requestJumpToPosition, setViewMode],
  );

  // Track toolbar horizontal overflow so we can fade the edge(s) that hide
  // controls, signalling there is more to scroll to.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarOverflow, setToolbarOverflow] = useState({
    left: false,
    right: false,
  });
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const update = () => {
      setToolbarOverflow({
        left: el.scrollLeft > 1,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [editor]);

  if (!editor) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] items-center gap-2 border-border border-b bg-muted/30 px-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="ml-auto h-7 w-20" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-6">
          <Skeleton className="mx-auto h-[70vh] w-[min(52rem,92%)] rounded-md" />
        </div>
      </div>
    );
  }

  const toolbarMask =
    toolbarOverflow.left || toolbarOverflow.right
      ? `linear-gradient(to right, ${toolbarOverflow.left ? "transparent" : "#000"}, #000 1.5rem, #000 calc(100% - 1.5rem), ${toolbarOverflow.right ? "transparent" : "#000"})`
      : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Word-like toolbar */}
      <div
        ref={toolbarRef}
        style={
          toolbarMask
            ? { maskImage: toolbarMask, WebkitMaskImage: toolbarMask }
            : undefined
        }
        className="scrollbar-none flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] min-w-0 items-center gap-2 overflow-x-auto border-border border-b bg-muted/30 px-2"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-[10rem] truncate font-medium text-sm">
            {fileName}
          </span>
          {isSaving ? (
            <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
          ) : isDirty ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
              title="Unsaved changes"
            />
          ) : null}
        </div>

        <ToolbarGroup>
          <TooltipIconButton
            tooltip="Undo"
            onClick={() => editor?.chain().focus().undo().run()}
            disabled={!editor?.can().undo()}
          >
            <UndoIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Redo"
            onClick={() => editor?.chain().focus().redo().run()}
            disabled={!editor?.can().redo()}
          >
            <RedoIcon className="size-4" />
          </TooltipIconButton>
        </ToolbarGroup>

        <Select
          value={headingValue}
          onValueChange={(v) => {
            if (!editor) return;
            if (v === "0") editor.chain().focus().setParagraph().run();
            else
              editor
                .chain()
                .focus()
                .setHeading({ level: Number(v) as 1 | 2 | 3 | 4 })
                .run();
          }}
        >
          <SelectTrigger
            size="sm"
            className="h-7! w-[8.5rem] border-0 bg-transparent text-xs shadow-none hover:bg-accent"
            title="Paragraph style"
          >
            <SelectValue placeholder="Style" />
          </SelectTrigger>
          <SelectContent>
            {HEADING_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <ToolbarGroup>
          <TooltipIconButton
            tooltip="Bold (\textbf)"
            onClick={() => editor?.chain().focus().toggleBold().run()}
            className={cn(editor?.isActive("bold") && "bg-accent")}
          >
            <BoldIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Italic (\textit)"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            className={cn(editor?.isActive("italic") && "bg-accent")}
          >
            <ItalicIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Underline (\underline)"
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
            className={cn(editor?.isActive("underline") && "bg-accent")}
          >
            <UnderlineIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Monospace (\texttt)"
            onClick={() => editor?.chain().focus().toggleCode().run()}
            className={cn(editor?.isActive("code") && "bg-accent")}
          >
            <CodeIcon className="size-4" />
          </TooltipIconButton>
        </ToolbarGroup>

        <ToolbarGroup>
          <TooltipIconButton
            tooltip="Bullet list (itemize)"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            className={cn(editor?.isActive("bulletList") && "bg-accent")}
          >
            <ListIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Numbered list (enumerate)"
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            className={cn(editor?.isActive("orderedList") && "bg-accent")}
          >
            <ListOrderedIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Insert table (tabular)"
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
            }
          >
            <TableIcon className="size-4" />
          </TooltipIconButton>
        </ToolbarGroup>

        <ToolbarGroup>
          <TooltipIconButton
            tooltip="Insert inline math"
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "inlineMath",
                  attrs: { latex: "x^2", delim: "dollar" },
                })
                .run()
            }
          >
            <FunctionSquareIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Insert display math"
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "displayMath",
                  attrs: { latex: "f(x) = x^2", delim: "bracket" },
                })
                .run()
            }
          >
            <SigmaSquareIcon className="size-4" />
          </TooltipIconButton>
          {selectedLatexNode && (
            <TooltipIconButton
              tooltip="Edit LaTeX of selection"
              onClick={() => {
                if (!editor) return;
                openLatexDialog(
                  selectedLatexNode,
                  String(editor.getAttributes(selectedLatexNode).latex ?? ""),
                );
              }}
            >
              <PencilIcon className="size-4" />
            </TooltipIconButton>
          )}
        </ToolbarGroup>

        {(aiSummarize && canUseAiAssist() && hasTextSelection) ||
        (aiGrammarHints && aiAssistEnabled && canUseAiAssist()) ? (
          <ToolbarGroup>
            {aiSummarize && canUseAiAssist() && hasTextSelection && (
              <TooltipIconButton
                tooltip="Summarize selection"
                disabled={summarizing}
                onClick={() => void handleSummarizeSelection()}
              >
                {summarizing ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <FileTextIcon className="size-4" />
                )}
              </TooltipIconButton>
            )}
            {aiGrammarHints && aiAssistEnabled && canUseAiAssist() && (
              <Popover
                open={grammarOpen}
                onOpenChange={(open) => {
                  setGrammarOpen(open);
                  if (!open) {
                    setGrammarIssues([]);
                    setGrammarSpan(null);
                  }
                }}
              >
                <PopoverAnchor asChild>
                  <TooltipIconButton
                    tooltip="Check grammar"
                    disabled={grammarLoading}
                    onClick={() => void runGrammarCheck()}
                  >
                    {grammarLoading ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <SpellCheckIcon className="size-4" />
                    )}
                  </TooltipIconButton>
                </PopoverAnchor>
                <PopoverContent align="start" className="w-72 p-2">
                  <div className="mb-1.5 font-medium text-muted-foreground text-xs">
                    Grammar
                  </div>
                  {grammarLoading ? (
                    <div className="flex items-center gap-2 px-1 py-2 text-muted-foreground text-xs">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Checking…
                    </div>
                  ) : grammarIssues.length === 0 ? (
                    <p className="px-1 py-2 text-muted-foreground text-xs">
                      No issues found.
                    </p>
                  ) : (
                    <ul className="max-h-48 space-y-2 overflow-y-auto">
                      {grammarIssues.map((issue, idx) => (
                        <li
                          key={`${issue.message}-${idx}`}
                          className="rounded border border-border/60 bg-muted/30 p-2 text-xs"
                        >
                          <p className="text-foreground leading-snug">
                            {issue.message}
                          </p>
                          <p className="mt-1 text-muted-foreground leading-snug">
                            {issue.fix}
                          </p>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="mt-2 h-6 px-2 text-xs"
                            onClick={() => applyGrammarFix(issue.fix)}
                          >
                            Apply fix
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </ToolbarGroup>
        ) : null}

        <ToolbarGroup>
          <DocumentOutline
            editorView={nullEditorViewRef}
            onBeforeJump={() => setViewMode("source")}
          />
        </ToolbarGroup>

        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />

        {compileDiagnostics.length > 0 ? (
          <ProblemsPopover
            diagnostics={compileDiagnostics}
            fileName={fileName}
            aiFixAvailable={compileFixAvailable || lintFixAvailable}
            onNavigate={jumpToCompileLine}
            onFixWithChat={(message, line) => {
              void sendPrompt(
                `[Compile error in ${fileName}:${line}]\n[Error: ${message}]\n\nFix this LaTeX error.`,
              );
            }}
            onFixWithAi={
              compileFixAvailable
                ? () => {
                    const prompt = buildCompileFixPrompt();
                    if (prompt) void sendPrompt(prompt);
                  }
                : undefined
            }
            onFixAllWithChat={() => {
              const errorList = compileDiagnostics
                .map((d) => `- ${fileName}:${d.line} — ${d.message}`)
                .join("\n");
              void sendPrompt(
                `[Compile errors in ${fileName}]\n${errorList}\n\nFix all these LaTeX errors.`,
              );
            }}
            onFixAllWithAi={
              compileFixAvailable
                ? () => {
                    const prompt = buildCompileFixPrompt();
                    if (prompt) void sendPrompt(prompt);
                  }
                : undefined
            }
            onFixSpanWithAi={(d) => {
              if (!activeContent) return;
              jumpToCompileLine(lineToOffset(activeContent, d.line));
            }}
          />
        ) : null}

        <ToolbarGroup>
          <TooltipIconButton
            tooltip="Show cursor in PDF (⌘⇧J)"
            className="size-7 text-muted-foreground"
            onClick={() => void triggerForwardSync()}
          >
            <CrosshairIcon className="size-4" />
          </TooltipIconButton>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 shrink-0 gap-1.5 px-2.5 text-xs",
              compileError &&
                !isCompiling &&
                "text-destructive hover:text-destructive",
            )}
            onClick={() => requestCompile()}
            disabled={isCompiling}
            aria-label={
              isCompiling
                ? "Compiling"
                : compileError
                  ? "Retry compile"
                  : "Compile PDF"
            }
            title={
              isCompiling
                ? "Compiling…"
                : compileError
                  ? "Retry compile (⌘Enter)"
                  : "Compile PDF (⌘Enter)"
            }
          >
            {isCompiling ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
            <span className="@[32rem]/editor:inline hidden">
              {isCompiling ? "Compiling…" : compileError ? "Retry" : "Compile"}
            </span>
          </Button>
        </ToolbarGroup>

        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
          onClick={() => setViewMode("source")}
          title="Switch to LaTeX source view (⌘⇧L)"
        >
          <FileCode2Icon className="size-3.5" />
          Source
        </Button>
      </div>

      {/* Page */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20">
        <div className="mx-auto my-6 min-h-[80%] w-[min(52rem,92%)] rounded-md border border-border bg-background px-10 py-8 shadow-sm dark:shadow-none">
          <EditorContent editor={editor} />
        </div>
      </div>

      <EditorAiSuggestions content={activeContent ?? ""} />

      <div className="flex h-7 shrink-0 items-center justify-between border-border border-t bg-muted/20 px-3 text-[11px] text-muted-foreground dark:text-foreground/55">
        <span className="tabular-nums">
          {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
          {isSaving ? " · Saving…" : isDirty ? " · Unsaved" : ""}
        </span>
        <span className="hidden truncate sm:inline">
          Rich view · ⌘Enter compile · Double-click math to edit · ⌘⇧L for
          source
        </span>
      </div>

      {/* LaTeX edit dialog for math / raw nodes */}
      <Dialog
        open={mathDialog !== null}
        onOpenChange={(open) => {
          if (!open) setMathDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {mathDialog?.nodeType === "latexRaw"
                ? "Edit raw LaTeX block"
                : mathDialog?.nodeType === "latexInline"
                  ? "Edit LaTeX command"
                  : "Edit math"}
            </DialogTitle>
          </DialogHeader>
          <textarea
            value={mathDraft}
            onChange={(e) => setMathDraft(e.target.value)}
            rows={mathDialog?.nodeType === "latexRaw" ? 10 : 3}
            spellCheck={false}
            aria-label="LaTeX source"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                applyMathEdit();
              }
            }}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMathDialog(null)}>
              Cancel
            </Button>
            <Button onClick={applyMathEdit}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
