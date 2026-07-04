import {
  Fragment,
  type ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  BoldIcon,
  ItalicIcon,
  ListIcon,
  Heading1Icon,
  Heading2Icon,
  CodeIcon,
  CropIcon,
  FunctionSquareIcon,
  FileTextIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  BookMarkedIcon,
  ExternalLinkIcon,
  ChevronRightIcon,
  ListTreeIcon,
  Loader2Icon,
  PilcrowIcon,
  SpellCheckIcon,
  CrosshairIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { ToolbarGroup } from "@/components/ui/toolbar-group";
import { cn } from "@/lib/utils";
import vscodeIcon from "@/assets/vscode.svg";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDocumentStore, resolveTexRoot } from "@/stores/document-store";
import { useEditorViewModeStore } from "@/stores/editor-view-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import { snippetsForKind } from "@/lib/latex-snippets";
import { canUseAiAssist } from "@/lib/ai-assist";
import { fillSnippet } from "@/lib/ai-extras";
import {
  applyCompileProfile,
  compileProfilesForKind,
  defaultCompileProfileForKind,
  detectCompileProfile,
} from "@/lib/compile-profiles";
import { triggerForwardSync } from "@/lib/forward-sync";
import { DocumentOutline } from "./document-outline";
import { ExportMenu } from "./export-menu";

interface EditorInfo {
  id: string;
  name: string;
}

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

function OpenEditorIcon({ editor }: { editor: EditorInfo }) {
  if (editor.id === "vscode") {
    return (
      <img
        src={vscodeIcon}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="size-5"
      />
    );
  }

  return <ExternalLinkIcon className="size-4" />;
}

function getOpenEditorButtonClassName(editor: EditorInfo) {
  return editor.id === "vscode"
    ? "h-7 w-7 border border-border/70 bg-muted/30 p-1 hover:bg-muted/50"
    : undefined;
}

// Active-file context shown at the top-left of the editor: folder path as
// muted crumbs leading to the emphasized file name. Deep paths collapse the
// middle to an ellipsis so the file name always stays visible. When the file
// has a real project-relative path, every crumb is clickable to reveal that
// file/folder in the sidebar tree.
function FileBreadcrumb({
  path,
  fileName,
  icon: Icon,
  onReveal,
}: {
  path?: string;
  fileName: string;
  icon: LucideIcon;
  onReveal?: (path: string, type: "file" | "folder") => void;
}) {
  const hasPath = !!(path && path.length > 0);
  const segments = (hasPath ? (path as string) : fileName)
    .split("/")
    .filter(Boolean);
  const crumbs = segments.map((label, i) => ({
    label,
    fullPath: segments.slice(0, i + 1).join("/"),
    isFile: i === segments.length - 1,
  }));
  const fileCrumb = crumbs[crumbs.length - 1];
  const folderCrumbs = crumbs.slice(0, -1);
  const MAX_FOLDERS = 2;
  const collapsed = folderCrumbs.length > MAX_FOLDERS;
  const shownFolders = collapsed
    ? folderCrumbs.slice(-MAX_FOLDERS)
    : folderCrumbs;

  const clickable = hasPath && !!onReveal;

  const renderCrumb = (
    label: string,
    fullPath: string,
    type: "file" | "folder",
  ) => {
    const emphasis =
      type === "file" ? "font-medium text-foreground" : "text-muted-foreground";
    if (!clickable) {
      return (
        <span className={`max-w-[8rem] shrink truncate ${emphasis}`}>
          {label}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => onReveal?.(fullPath, type)}
        title={`Reveal ${fullPath} in sidebar`}
        aria-label={`Reveal ${label} in sidebar`}
        className={`max-w-[8rem] shrink truncate rounded px-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring ${emphasis}`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="flex min-w-0 max-w-[min(20rem,38vw)] items-center gap-0.5 text-sm"
      title={path ?? fileName}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {collapsed && (
        <>
          <span className="shrink-0 px-1 text-muted-foreground/70">…</span>
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
        </>
      )}
      {shownFolders.map((crumb) => (
        <Fragment key={crumb.fullPath}>
          {renderCrumb(crumb.label, crumb.fullPath, "folder")}
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
        </Fragment>
      ))}
      {renderCrumb(fileCrumb.label, fileCrumb.fullPath, "file")}
    </div>
  );
}

// Platform-aware modifier label so tooltips advertise the real shortcut.
const MOD =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/i.test(navigator.platform)
    ? "⌘"
    : "Ctrl";

// Compact save-state indicator shown beside the active file name: a spinner
// while a save is in flight, an amber dot when the buffer has unsaved edits,
// and nothing once the file is clean.
function SaveStatus({
  isDirty,
  isSaving,
}: {
  isDirty: boolean;
  isSaving: boolean;
}) {
  if (isSaving) {
    return (
      <span
        className="flex shrink-0 items-center text-muted-foreground"
        title="Saving…"
        aria-label="Saving"
        role="status"
      >
        <Loader2Icon className="size-3 animate-spin" aria-hidden />
      </span>
    );
  }
  if (isDirty) {
    return (
      <span
        role="status"
        className="size-2 shrink-0 rounded-full bg-amber-500 ring-1 ring-amber-500/30"
        title="Unsaved changes"
        aria-label="Unsaved changes"
      />
    );
  }
  return null;
}

interface EditorToolbarProps {
  editorView: RefObject<EditorView | null>;
  fileType?: "tex" | "image";
  imageScale?: number;
  onImageScaleChange?: (scale: number) => void;
  cropMode?: boolean;
  onCropToggle?: () => void;
  /** Diagnostics surface (Problems popover) shown in the tex toolbar's right cluster. */
  problemsSlot?: ReactNode;
}

export function EditorToolbar({
  editorView,
  fileType = "tex",
  imageScale = 1,
  onImageScaleChange,
  cropMode,
  onCropToggle,
  problemsSlot,
}: EditorToolbarProps) {
  const vimMode = useSettingsStore((s) => s.vimMode);
  const setVimMode = useSettingsStore((s) => s.setVimMode);
  const spellCheck = useSettingsStore((s) => s.spellCheck);
  const setSpellCheck = useSettingsStore((s) => s.setSpellCheck);
  const aiSnippetFill = useSettingsStore((s) => s.aiSnippetFill);
  const editorViewMode = useEditorViewModeStore((s) => s.mode);
  const setEditorViewMode = useEditorViewModeStore((s) => s.setMode);

  const fileName = useDocumentStore((s) => {
    const activeFile = s.files.find((f) => f.id === s.activeFileId);
    return activeFile?.name ?? "main.tex";
  });
  const activeFilePath = useDocumentStore((s) => {
    const activeFile = s.files.find((f) => f.id === s.activeFileId);
    return activeFile?.relativePath;
  });
  const isDirty = useDocumentStore((s) => {
    const activeFile = s.files.find((f) => f.id === s.activeFileId);
    return !!activeFile?.isDirty;
  });
  const isSaving = useDocumentStore((s) => s.isSaving);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const requestRevealInTree = useDocumentStore((s) => s.requestRevealInTree);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const updateFileContent = useDocumentStore((s) => s.updateFileContent);
  const activeTexContent = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.type === "tex" ? (f.content ?? "") : "";
  });

  const isCompileRoot = useMemo(
    () => resolveTexRoot(activeFileId, files) === activeFileId,
    [activeFileId, files],
  );
  const currentProfile = useMemo(
    () => detectCompileProfile(activeTexContent),
    [activeTexContent],
  );
  const showCompileProfiles =
    fileType === "tex" &&
    isCompileRoot &&
    /\\documentclass/.test(activeTexContent);

  const { kind: snippetKind } = useSpaceFeatures();
  const snippets = useMemo(() => snippetsForKind(snippetKind), [snippetKind]);
  const compileProfiles = useMemo(
    () => compileProfilesForKind(snippetKind),
    [snippetKind],
  );

  const [editors, setEditors] = useState<EditorInfo[]>([]);

  useEffect(() => {
    invoke<EditorInfo[]>("detect_editors")
      .then(setEditors)
      .catch(() => {});
  }, []);

  const openInEditor = useCallback(
    (editorId: string) => {
      if (!projectRoot) return;
      const view = editorView.current;
      const line = view
        ? view.state.doc.lineAt(view.state.selection.main.head).number
        : undefined;
      invoke("open_in_editor", {
        editorId,
        projectPath: projectRoot,
        filePath: activeFilePath,
        line,
      }).catch((err) => {
        console.error("open_in_editor failed:", err);
        showWorkspaceError(
          "Couldn't open external editor",
          err instanceof Error ? err.message : String(err),
          { dedupeKey: "editor-open-external" },
        );
      });
    },
    [projectRoot, activeFilePath, editorView],
  );

  const insertText = (before: string, after: string = "") => {
    const view = editorView.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const selectedText = view.state.sliceDoc(from, to);

    view.dispatch({
      changes: {
        from,
        to,
        insert: before + selectedText + after,
      },
      selection: {
        anchor: from + before.length,
        head: from + before.length + selectedText.length,
      },
    });
    view.focus();
  };

  const insertSnippet = (text: string) => {
    const view = editorView.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  };

  // "Insert with AI": fill the snippet's placeholders from the text surrounding
  // the cursor, then insert the filled LaTeX. Falls back to the blank skeleton
  // on any failure so the action never strands the user.
  const aiFillEnabled = aiSnippetFill && canUseAiAssist();
  const [aiFillingId, setAiFillingId] = useState<string | null>(null);
  const aiFillRequestId = useRef(0);

  const insertSnippetWithAI = async (snippetId: string, text: string) => {
    const view = editorView.current;
    if (!view) return;

    // Gather document context near the cursor (window before/after the caret).
    const { from } = view.state.selection.main;
    const docLength = view.state.doc.length;
    const context = view.state.sliceDoc(
      Math.max(0, from - 800),
      Math.min(docLength, from + 400),
    );

    const id = ++aiFillRequestId.current;
    setAiFillingId(snippetId);
    try {
      const filled = await fillSnippet({ snippet: text, context });
      // Stale request (another fill started, or selection changed) — ignore.
      if (id !== aiFillRequestId.current) return;
      insertSnippet(filled.trim() ? filled : text);
    } catch (err) {
      console.error("fillSnippet failed:", err);
      if (id !== aiFillRequestId.current) return;
      showWorkspaceError(
        "AI fill failed",
        "Inserted a blank snippet instead.",
        { dedupeKey: "editor-ai-fill" },
      );
      insertSnippet(text);
    } finally {
      if (id === aiFillRequestId.current) setAiFillingId(null);
    }
  };

  const handleProfileChange = (profileId: string) => {
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return;
    updateFileContent(
      activeFileId,
      applyCompileProfile(file.content, profileId),
    );
  };

  const wrapSelection = (wrapper: string) => {
    insertText(wrapper, wrapper);
  };

  const zoomIn = () => onImageScaleChange?.(Math.min(4, imageScale + 0.25));
  const zoomOut = () => onImageScaleChange?.(Math.max(0.25, imageScale - 0.25));

  if (fileType === "image") {
    return (
      <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] min-w-0 items-center gap-2 border-border border-b bg-muted/30 px-2">
        <div className="flex min-w-0 items-center gap-0.5">
          <FileBreadcrumb
            path={activeFilePath}
            fileName={fileName}
            icon={ImageIcon}
            onReveal={requestRevealInTree}
          />
          {activeFilePath && (
            <TooltipIconButton
              tooltip="Reveal in sidebar"
              className="size-6"
              onClick={() => requestRevealInTree(activeFilePath, "file")}
            >
              <ListTreeIcon className="size-3.5" />
            </TooltipIconButton>
          )}
        </div>
        <div data-tauri-drag-region className="h-full flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <ToolbarGroup>
            <TooltipIconButton
              tooltip="Zoom out"
              className="size-6"
              onClick={zoomOut}
              disabled={imageScale <= 0.25}
            >
              <MinusIcon className="size-3.5" />
            </TooltipIconButton>
            <Select
              value={imageScale.toString()}
              onValueChange={(v) => onImageScaleChange?.(Number(v))}
            >
              <SelectTrigger
                size="sm"
                className="h-6! w-auto border-0 bg-transparent px-1.5 text-xs tabular-nums shadow-none hover:bg-accent"
              >
                <SelectValue>{Math.round(imageScale * 100)}%</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ZOOM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <TooltipIconButton
              tooltip="Zoom in"
              className="size-6"
              onClick={zoomIn}
              disabled={imageScale >= 4}
            >
              <PlusIcon className="size-3.5" />
            </TooltipIconButton>
          </ToolbarGroup>
          {onCropToggle && !fileName.toLowerCase().endsWith(".svg") && (
            <Button
              variant={cropMode ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={onCropToggle}
              aria-pressed={cropMode}
            >
              <CropIcon className="size-3.5" />
              Crop
            </Button>
          )}
          {editors.length === 1 && (
            <TooltipIconButton
              tooltip={`Open in ${editors[0].name}`}
              onClick={() => openInEditor(editors[0].id)}
              className={getOpenEditorButtonClassName(editors[0])}
            >
              <OpenEditorIcon editor={editors[0]} />
            </TooltipIconButton>
          )}
          {editors.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 p-1"
                  title="Open in Editor"
                  aria-label="Open in editor"
                >
                  <ExternalLinkIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editors.map((editor) => (
                  <DropdownMenuItem
                    key={editor.id}
                    onClick={() => openInEditor(editor.id)}
                  >
                    {editor.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }

  // Structure + insert actions are shared between the inline (wide) toolbar
  // groups and the collapsed (narrow) "Insert" dropdown so behaviour stays in
  // one place.
  const displayMathIcon = (
    <span
      aria-hidden
      className="flex size-4 items-center justify-center font-mono text-sm leading-none"
    >
      ∫
    </span>
  );
  const structureActions = [
    {
      label: "Section",
      icon: <Heading1Icon className="size-4" />,
      run: () => insertText("\\section{", "}"),
    },
    {
      label: "Subsection",
      icon: <Heading2Icon className="size-4" />,
      run: () => insertText("\\subsection{", "}"),
    },
    {
      label: "List item",
      icon: <ListIcon className="size-4" />,
      run: () => insertText("\\item "),
    },
  ];
  const insertActions = [
    {
      label: "Inline math ($…$)",
      icon: <FunctionSquareIcon className="size-4" />,
      run: () => wrapSelection("$"),
    },
    {
      label: "Display math (\\[…\\])",
      icon: displayMathIcon,
      run: () => insertText("\\[\n  ", "\n\\]"),
    },
    {
      label: "Citation (\\cite)",
      icon: <BookMarkedIcon className="size-4" />,
      run: () => insertText("\\cite{", "}"),
    },
  ];

  return (
    <div className="@container/tb flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] min-w-0 items-center gap-2 border-border border-b bg-muted/30 px-2">
      {/* Active file context */}
      <div className="flex min-w-0 items-center gap-1.5">
        <FileBreadcrumb
          path={activeFilePath}
          fileName={fileName}
          icon={FileTextIcon}
          onReveal={requestRevealInTree}
        />
        <SaveStatus isDirty={isDirty} isSaving={isSaving} />
        {activeFilePath && (
          <TooltipIconButton
            tooltip="Reveal in sidebar"
            className="size-7 text-muted-foreground"
            onClick={() => requestRevealInTree(activeFilePath, "file")}
          >
            <ListTreeIcon className="size-3.5" />
          </TooltipIconButton>
        )}
      </div>

      {/* Formatting / insert actions, grouped into segments */}
      <div className="flex shrink-0 items-center gap-1.5">
        <ToolbarGroup>
          <TooltipIconButton
            tooltip={`Bold  ${MOD}B`}
            className="size-7"
            onClick={() => insertText("\\textbf{", "}")}
          >
            <BoldIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip={`Italic  ${MOD}I`}
            className="size-7"
            onClick={() => insertText("\\textit{", "}")}
          >
            <ItalicIcon className="size-4" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Inline code (\\texttt)"
            className="size-7"
            onClick={() => insertText("\\texttt{", "}")}
          >
            <CodeIcon className="size-4" />
          </TooltipIconButton>
        </ToolbarGroup>

        {/* Wide layout: structure + insert shown inline */}
        <ToolbarGroup className="@[46rem]/tb:flex hidden">
          {structureActions.map((a) => (
            <TooltipIconButton
              key={a.label}
              tooltip={a.label}
              className="size-7"
              onClick={a.run}
            >
              {a.icon}
            </TooltipIconButton>
          ))}
        </ToolbarGroup>
        <ToolbarGroup className="@[46rem]/tb:flex hidden">
          {insertActions.map((a) => (
            <TooltipIconButton
              key={a.label}
              tooltip={a.label}
              className="size-7"
              onClick={a.run}
            >
              {a.icon}
            </TooltipIconButton>
          ))}
        </ToolbarGroup>

        {/* Narrow layout: collapse structure + insert into one menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="@[46rem]/tb:hidden h-7 gap-1 px-2 text-xs"
            >
              <PlusIcon className="size-3.5" />
              Insert
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[70vh] overflow-y-auto"
          >
            {structureActions.map((a) => (
              <DropdownMenuItem key={a.label} onClick={a.run}>
                {a.icon}
                {a.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {insertActions.map((a) => (
              <DropdownMenuItem key={a.label} onClick={a.run}>
                {a.icon}
                {a.label}
              </DropdownMenuItem>
            ))}
            {snippets.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Snippets</DropdownMenuLabel>
                {snippets.map((s) => (
                  <Fragment key={s.id}>
                    <DropdownMenuItem
                      onClick={() => insertSnippet(s.insert)}
                      title={s.description}
                    >
                      {s.label}
                    </DropdownMenuItem>
                    {aiFillEnabled && (
                      <DropdownMenuItem
                        title="Insert with AI (fill from surrounding context)"
                        aria-label={`Insert ${s.label} with AI`}
                        disabled={aiFillingId !== null}
                        onClick={() => void insertSnippetWithAI(s.id, s.insert)}
                        className="text-muted-foreground"
                      >
                        {aiFillingId === s.id ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <SparklesIcon className="size-3.5" />
                        )}
                        Insert {s.label} with AI
                      </DropdownMenuItem>
                    )}
                  </Fragment>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Wide layout: snippet menu for document-type structures */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="@[46rem]/tb:inline-flex hidden h-7 gap-1 px-2 text-xs"
            >
              <PlusIcon className="size-3.5" />
              Snippets
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[70vh] w-56 overflow-y-auto"
          >
            <DropdownMenuLabel>Insert snippet</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {snippets.map((s) => (
              <Fragment key={s.id}>
                <DropdownMenuItem
                  onClick={() => insertSnippet(s.insert)}
                  title={s.description}
                >
                  <span className="font-medium">{s.label}</span>
                  <span className="ml-auto truncate pl-2 text-muted-foreground text-xs">
                    {s.description}
                  </span>
                </DropdownMenuItem>
                {aiFillEnabled && (
                  <DropdownMenuItem
                    title="Insert with AI (fill from surrounding context)"
                    aria-label={`Insert ${s.label} with AI`}
                    disabled={aiFillingId !== null}
                    onClick={() => void insertSnippetWithAI(s.id, s.insert)}
                    className="text-muted-foreground"
                  >
                    {aiFillingId === s.id ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <SparklesIcon className="size-3.5" />
                    )}
                    Insert {s.label} with AI
                  </DropdownMenuItem>
                )}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Draggable spacer keeps the window movable from the toolbar */}
      <div data-tauri-drag-region className="h-full min-w-2 flex-1" />

      {showCompileProfiles && (
        <ToolbarGroup className="@[40rem]/tb:flex hidden">
          <Select
            value={currentProfile ?? defaultCompileProfileForKind(snippetKind)}
            onValueChange={handleProfileChange}
          >
            <SelectTrigger
              size="sm"
              className="h-7! w-[7.5rem] border-0 bg-transparent text-xs shadow-none hover:bg-accent"
              title="Document class preset for this space type"
            >
              <SelectValue placeholder="Class" />
            </SelectTrigger>
            <SelectContent>
              {compileProfiles.map((p) => (
                <SelectItem key={p.id} value={p.id} title={p.description}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ToolbarGroup>
      )}

      {/* Right-side utilities: outline, export, diagnostics, editor mode, external editor */}
      <div className="flex shrink-0 items-center gap-1.5">
        {problemsSlot}
        <DocumentOutline editorView={editorView} />
        {fileType === "tex" && (
          <TooltipIconButton
            tooltip="Rich editor (Word-like view)"
            className={cn(
              "size-7",
              editorViewMode === "rich"
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "text-muted-foreground",
            )}
            aria-pressed={editorViewMode === "rich"}
            onClick={() => setEditorViewMode("rich")}
          >
            <PilcrowIcon className="size-4" />
          </TooltipIconButton>
        )}
        {fileType === "tex" && (
          <TooltipIconButton
            tooltip={`Show cursor in PDF (${MOD === "⌘" ? "⌘⇧J" : "Ctrl+Shift+J"})`}
            className="size-7 text-muted-foreground"
            onClick={() => void triggerForwardSync()}
          >
            <CrosshairIcon className="size-4" />
          </TooltipIconButton>
        )}
        <ExportMenu />
        <TooltipIconButton
          tooltip={spellCheck ? "Spell check on" : "Spell check off"}
          onClick={() => setSpellCheck(!spellCheck)}
          aria-pressed={spellCheck}
          className={cn(
            "size-7",
            spellCheck
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "text-muted-foreground",
          )}
        >
          <SpellCheckIcon className="size-4" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip={vimMode ? "Vim mode on" : "Vim mode off"}
          onClick={() => setVimMode(!vimMode)}
          aria-pressed={vimMode}
          className={cn(
            "h-7 w-auto gap-1 px-2 font-mono text-[11px] tracking-wide",
            vimMode
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "text-muted-foreground",
          )}
        >
          VIM
        </TooltipIconButton>
        {editors.length === 1 && (
          <TooltipIconButton
            tooltip={`Open in ${editors[0].name}`}
            onClick={() => openInEditor(editors[0].id)}
            className={getOpenEditorButtonClassName(editors[0])}
          >
            <OpenEditorIcon editor={editors[0]} />
          </TooltipIconButton>
        )}
        {editors.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 p-1"
                title="Open in Editor"
                aria-label="Open in editor"
              >
                <ExternalLinkIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {editors.map((editor) => (
                <DropdownMenuItem
                  key={editor.id}
                  onClick={() => openInEditor(editor.id)}
                >
                  {editor.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
