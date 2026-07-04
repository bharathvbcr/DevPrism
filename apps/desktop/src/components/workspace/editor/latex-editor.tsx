import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { latexStyling } from "./latex-styling-extension";
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
  toggleComment,
} from "@codemirror/commands";
import { syntaxHighlighting, syntaxTreeAvailable } from "@codemirror/language";
import { oneDark, oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { defaultHighlightStyle } from "@codemirror/language";
import { useTheme } from "next-themes";
import {
  search,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery as setSearchQueryEffect,
  findNext,
  findPrevious,
} from "@codemirror/search";
import {
  unifiedMergeView,
  getChunks,
  acceptChunk,
  rejectChunk,
} from "@codemirror/merge";
import { latex, latexLinter } from "codemirror-lang-latex";
import { bibtex } from "./lang-bibtex";
import { latexAutocomplete } from "./latex-autocomplete";
import {
  linter,
  lintGutter,
  forEachDiagnostic,
  type Diagnostic,
} from "@codemirror/lint";
import {
  useDocumentStore,
  resolveTexRoot,
  type ProjectFile,
} from "@/stores/document-store";
import {
  useProposedChangesStore,
  type ProposedChange,
} from "@/stores/proposed-changes-store";
import {
  useClaudeChatStore,
  type PromptContextOverride,
} from "@/stores/claude-chat-store";
import { useHistoryStore, type FileDiff } from "@/stores/history-store";
import { compileLatex, formatCompileError } from "@/lib/latex-compiler";
import { triggerForwardSync } from "@/lib/forward-sync";
import {
  resolveActiveCompileTarget,
  resolvePreviewCompileRoot,
} from "@/lib/compile-root-preference";
import { getChatLabels } from "@/lib/chat-labels";
import { useSettingsStore } from "@/stores/settings-store";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import { EditorToolbar } from "./editor-toolbar";
import { SelectionToolbar, type ToolbarAction } from "./selection-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  SpellCheckIcon,
  RotateCcwIcon,
  TagIcon,
  CopyIcon,
  XIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  CheckIcon,
  RefreshCwIcon,
  ExpandIcon,
  Minimize2Icon,
  BriefcaseIcon,
  SparklesIcon,
  FileTextIcon,
} from "lucide-react";
import { ClaudeChatDrawer } from "@/components/claude-chat/claude-chat-drawer";
import { ProposedChangesPanel } from "@/components/claude-chat/proposed-changes-panel";
import { ImagePreview } from "./image-preview";
import { filterImagePaths, insertDroppedImages } from "./image-drop";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";
import { SearchPanel } from "./search-panel";
import { EditorStatusBar } from "./editor-status-bar";
import { EditorAiSuggestions } from "./editor-ai-suggestions";
import {
  aiPredictiveCompartment,
  aiPredictiveExtension,
} from "./ai-predictive-extension";
import {
  aiGrammarCompartment,
  aiGrammarExtension,
} from "./ai-grammar-extension";
import { ProblemsPopover, type DiagnosticItem } from "./problems-panel";
import { PdfViewer } from "@/components/workspace/preview/pdf-viewer";
import { readFile } from "@tauri-apps/plugin-fs";
import { createLogger } from "@/lib/debug/logger";
import { commentsExtension, setCommentsEffect } from "./comments-extension";
import { CommentComposer } from "./comment-composer";
import { useCommentsStore } from "@/stores/comments-store";
import { MessageSquareIcon, LightbulbIcon } from "lucide-react";
import { TrackChangesActions } from "@/components/workspace/track-changes-actions";
import {
  buildTrackChangesMeta,
  linearParentOf,
} from "@/lib/track-changes-meta";
import { InlineWordDiff } from "@/components/workspace/inline-word-diff";
import {
  runInlineEdit,
  inlineEditSuccessMessage,
  proposeLineReplacement,
  applyLintLineFix,
  type InlineEditAction,
  type InlineEditSelection,
} from "@/lib/inline-edit";
import { canUseAiAssist, summarizeSection } from "@/lib/ai-assist";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import {
  analyzeSelectionBullets,
  buildBulletCountInstruction,
  bulletCountSuccessMessage,
  findEnclosingBulletList,
  findRoleContextBefore,
  suggestedBulletTargets,
  type BulletListEnv,
} from "@/lib/resume-bullets";
import {
  analyzeBulletQuality,
  buildResumeBulletSuggestions,
  bulletQualityGrade,
  bulletQualityInsights,
  bulletQualityScore,
  diagnoseBulletItems,
  findSuggestionById,
  recommendedBulletTarget,
  refinementSuccessMessage,
  suggestionIdForInsight,
  type ResumeBulletSuggestion,
} from "@/lib/resume-bullet-suggestions";

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const INLINE_REPHRASE_HINT = IS_MAC ? "⇧⌘R" : "Ctrl+Shift+R";
const INLINE_EXPAND_HINT = IS_MAC ? "⇧⌘E" : "Ctrl+Shift+E";
const INLINE_PROOFREAD_HINT = IS_MAC ? "⇧⌘P" : "Ctrl+Shift+P";
const INLINE_SIMPLIFY_HINT = IS_MAC ? "⇧⌘Y" : "Ctrl+Shift+Y";
const INLINE_FORMALIZE_HINT = IS_MAC ? "⇧⌘O" : "Ctrl+Shift+O";
const INLINE_SHORTEN_HINT = IS_MAC ? "⇧⌘T" : "Ctrl+Shift+T";
const INLINE_GRAMMAR_HINT = IS_MAC ? "⇧⌘G" : "Ctrl+Shift+G";
const BULLET_BLOCK_HINT = IS_MAC ? "⌥⇧B" : "Alt+Shift+B";

const log = createLogger("merge-view");

function getActiveFileContent(): string {
  const state = useDocumentStore.getState();
  const activeFile = state.files.find((f) => f.id === state.activeFileId);
  return activeFile?.content ?? "";
}

/**
 * Toggle native (OS/Chromium) spell checking on the editor's contenteditable.
 * Autocorrect/autocapitalize stay off so the engine never rewrites LaTeX source.
 */
function spellCheckExtension(enabled: boolean) {
  return EditorView.contentAttributes.of({
    spellcheck: enabled ? "true" : "false",
    autocorrect: "off",
    autocapitalize: "off",
  });
}

/** Per-file editor state cache: fileId → { cursor, scrollTop } */
const editorStateCache = new Map<
  string,
  { cursor: number; scrollTop: number }
>();

/** Clear editor state cache (e.g., on project close). */
export function clearEditorStateCache(): void {
  editorStateCache.clear();
}

export function LatexEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const setContent = useDocumentStore((s) => s.setContent);
  const setCursorPosition = useDocumentStore((s) => s.setCursorPosition);
  const setSelectionRange = useDocumentStore((s) => s.setSelectionRange);
  const jumpToPosition = useDocumentStore((s) => s.jumpToPosition);
  const clearJumpRequest = useDocumentStore((s) => s.clearJumpRequest);

  const setIsCompiling = useDocumentStore((s) => s.setIsCompiling);
  const setPdfData = useDocumentStore((s) => s.setPdfData);
  const setCompileError = useDocumentStore((s) => s.setCompileError);
  const saveAllFiles = useDocumentStore((s) => s.saveAllFiles);

  const activeFile = files.find((f) => f.id === activeFileId);
  const jobDescription = useDocumentStore((s) => {
    const f = s.files.find(
      (file) =>
        file.name.toLowerCase() === "job_description.md" ||
        file.relativePath?.toLowerCase().endsWith("/job_description.md"),
    );
    return f?.content?.trim() ?? "";
  });
  const compiledPageCount = useDocumentStore((s) => {
    const rootId = resolvePreviewCompileRoot(
      s.projectRoot,
      s.activeFileId,
      s.files,
    );
    return s.compiledPageCounts.get(rootId) ?? null;
  });
  const isTextFile =
    activeFile?.type === "tex" ||
    activeFile?.type === "bib" ||
    activeFile?.type === "style" ||
    activeFile?.type === "other";
  const activeFileContent = activeFile?.content;
  const isLargeFileNotLoaded =
    isTextFile && activeFileContent === undefined && !!activeFile;
  const loadFileContent = useDocumentStore((s) => s.loadFileContent);

  // History review state
  const reviewingSnapshot = useHistoryStore((s) => s.reviewingSnapshot);
  const historyDiffResult = useHistoryStore((s) => s.diffResult);
  const historySnapshots = useHistoryStore((s) => s.snapshots);
  const trackChangesMeta = useMemo(() => {
    if (!reviewingSnapshot) return null;
    // Derive the parent from the LINEAR (restore-collapsed) list — the same one
    // the diff was computed against — so the "from" label names the diffed
    // parent rather than the raw-array neighbor at a restore boundary.
    const parent = linearParentOf(historySnapshots, reviewingSnapshot.id);
    return buildTrackChangesMeta(parent, reviewingSnapshot);
  }, [reviewingSnapshot, historySnapshots]);

  const [imageScale, setImageScale] = useState(1.0);
  const [cropMode, setCropMode] = useState(false);

  // Reset scale and crop mode when switching files
  useEffect(() => {
    setImageScale(1.0);
    setCropMode(false);
  }, [activeFileId]);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [mergeChunkInfo, setMergeChunkInfo] = useState({
    total: 0,
    current: 0,
  });
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  // True while an OS image drag is hovering over the text editor.
  const [isImageDropActive, setIsImageDropActive] = useState(false);
  const [selectionCoords, setSelectionCoords] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [inlineEditPending, setInlineEditPending] = useState(false);
  const [bulletTargetCount, setBulletTargetCount] = useState(1);
  // When the selection toolbar is visible, prevent CM selection changes from clearing it.
  // Only explicit dismiss/send/action should clear the toolbar.
  const toolbarStickyRef = useRef(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const expandBulletBlockRef = useRef<() => void>(() => {});

  const { resolvedTheme } = useTheme();
  const { kind: spaceKind } = useSpaceFeatures();
  const spaceKindRef = useRef(spaceKind);
  const vimMode = useSettingsStore((s) => s.vimMode);
  const spellCheck = useSettingsStore((s) => s.spellCheck);
  const aiAssistEnabled = useSettingsStore((s) => s.aiAssistEnabled);
  const aiGrammarHints = useSettingsStore((s) => s.aiGrammarHints);
  const aiPredictiveText = useSettingsStore((s) => s.aiPredictiveText);
  const aiLintFix = useSettingsStore((s) => s.aiLintFix);
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);

  const compileRef = useRef<() => void>(() => {});
  const isSearchOpenRef = useRef(false);
  const themeCompartmentRef = useRef(new Compartment());
  const mergeCompartmentRef = useRef(new Compartment());
  const vimCompartmentRef = useRef(new Compartment());
  const spellCompartmentRef = useRef(new Compartment());
  const aiPredictiveCompartmentRef = useRef(aiPredictiveCompartment);
  const aiGrammarCompartmentRef = useRef(aiGrammarCompartment);
  const isMergeActiveRef = useRef(false);
  const pendingChangeRef = useRef<ProposedChange | null>(null);
  const handleKeepAllRef = useRef<() => void>(() => {});
  const handleUndoAllRef = useRef<() => void>(() => {});
  const handleKeepAllFilesRef = useRef<() => void>(() => {});
  const handleUndoAllFilesRef = useRef<() => void>(() => {});
  const diagnosticsRef = useRef<DiagnosticItem[]>([]);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  // Proposed changes for active file
  const proposedChanges = useProposedChangesStore((s) => s.changes);
  const activeFileChange = useMemo(() => {
    if (!activeFile) return null;
    return (
      proposedChanges.find((c) => c.filePath === activeFile.relativePath) ??
      null
    );
  }, [proposedChanges, activeFile]);

  // Keep all changes (⌘Y)
  handleKeepAllRef.current = () => {
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    if (!view || !change) return;
    isMergeActiveRef.current = false;
    setMergeChunkInfo({ total: 0, current: 0 });
    view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
    setContent(change.newContent);
    useProposedChangesStore.getState().keepChange(change.id);
    pendingChangeRef.current = null;
    // Auto-navigate to next file with pending changes (only if file exists)
    const remaining = useProposedChangesStore.getState().changes;
    if (remaining.length > 0) {
      const docStore = useDocumentStore.getState();
      const nextFile = remaining.find((c) =>
        docStore.files.some((f) => f.relativePath === c.filePath),
      );
      if (nextFile) {
        docStore.setActiveFile(nextFile.filePath);
      }
    }
  };

  // Undo all changes (⌘N)
  handleUndoAllRef.current = () => {
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    if (!view || !change) return;
    isMergeActiveRef.current = false;
    setMergeChunkInfo({ total: 0, current: 0 });
    view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: change.oldContent,
      },
      annotations: Transaction.addToHistory.of(false),
    });
    setContent(change.oldContent);
    useProposedChangesStore.getState().undoChange(change.id);
    pendingChangeRef.current = null;
    // Auto-navigate to next file with pending changes (only if file exists)
    const remaining = useProposedChangesStore.getState().changes;
    if (remaining.length > 0) {
      const docStore = useDocumentStore.getState();
      const nextFile = remaining.find((c) =>
        docStore.files.some((f) => f.relativePath === c.filePath),
      );
      if (nextFile) {
        docStore.setActiveFile(nextFile.filePath);
      }
    }
  };

  handleKeepAllFilesRef.current = () => {
    const view = viewRef.current;
    if (isMergeActiveRef.current && view) {
      isMergeActiveRef.current = false;
      setMergeChunkInfo({ total: 0, current: 0 });
      view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
      pendingChangeRef.current = null;
    }
    useProposedChangesStore.getState().keepAll();
  };

  handleUndoAllFilesRef.current = () => {
    const view = viewRef.current;
    if (isMergeActiveRef.current && view) {
      isMergeActiveRef.current = false;
      setMergeChunkInfo({ total: 0, current: 0 });
      view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
      pendingChangeRef.current = null;
    }
    void useProposedChangesStore.getState().undoAll();
  };

  // Navigate to a specific chunk by index
  const goToChunk = (index: number) => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    if (!chunks || index < 0 || index >= chunks.chunks.length) return;
    const chunk = chunks.chunks[index];
    view.dispatch({
      selection: { anchor: chunk.fromB },
      effects: EditorView.scrollIntoView(chunk.fromB, { y: "center" }),
    });
    view.focus();
  };

  // After individual accept/reject, navigate to next chunk or auto-resolve
  const afterChunkAction = (view: EditorView, prevIdx: number) => {
    const remaining = getChunks(view.state);
    if (!remaining || remaining.chunks.length === 0) {
      // All chunks resolved — clean up merge view
      const change = pendingChangeRef.current;
      if (change) {
        isMergeActiveRef.current = false;
        setMergeChunkInfo({ total: 0, current: 0 });
        const finalContent = view.state.doc.toString();
        view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
        setContent(finalContent);
        if (finalContent === change.oldContent) {
          useProposedChangesStore.getState().undoChange(change.id);
        } else {
          useProposedChangesStore.getState().keepChange(change.id);
        }
        pendingChangeRef.current = null;
        // Auto-navigate to next file with pending changes
        const pendingChanges = useProposedChangesStore.getState().changes;
        if (pendingChanges.length > 0) {
          useDocumentStore.getState().setActiveFile(pendingChanges[0].filePath);
        }
      }
    } else {
      // Focus the next remaining chunk
      const nextIdx = Math.min(prevIdx, remaining.chunks.length - 1);
      const next = remaining.chunks[nextIdx];
      view.dispatch({
        selection: { anchor: next.fromB },
        effects: EditorView.scrollIntoView(next.fromB, { y: "center" }),
      });
    }
    view.focus();
  };

  const acceptCurrentChunk = () => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    const idx = mergeChunkInfo.current - 1;
    if (!chunks || idx < 0 || idx >= chunks.chunks.length) return;
    acceptChunk(view, chunks.chunks[idx].fromB);
    afterChunkAction(view, idx);
  };

  const rejectCurrentChunk = () => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getChunks(view.state);
    const idx = mergeChunkInfo.current - 1;
    if (!chunks || idx < 0 || idx >= chunks.chunks.length) return;
    rejectChunk(view, chunks.chunks[idx].fromB);
    afterChunkAction(view, idx);
  };

  useEffect(() => {
    if (!searchQuery || !activeFileContent) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const regex = new RegExp(
      searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    const matches = activeFileContent.match(regex);
    setMatchCount(matches?.length ?? 0);
    setCurrentMatch(matches && matches.length > 0 ? 1 : 0);
  }, [searchQuery, activeFileContent]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const query = new SearchQuery({
      search: searchQuery,
      caseSensitive: false,
      literal: true,
    });
    view.dispatch({ effects: setSearchQueryEffect.of(query) });
    if (searchQuery) findNext(view);
  }, [searchQuery]);

  const handleFindNext = (options?: { focusEditor?: boolean }) => {
    const view = viewRef.current;
    if (view) {
      findNext(view);
      if (matchCount > 0) {
        setCurrentMatch((current) => (current % matchCount) + 1);
      }
      if (options?.focusEditor !== false) view.focus();
    }
  };
  const handleFindPrevious = (options?: { focusEditor?: boolean }) => {
    const view = viewRef.current;
    if (view) {
      findPrevious(view);
      if (matchCount > 0) {
        setCurrentMatch((current) => (current <= 1 ? matchCount : current - 1));
      }
      if (options?.focusEditor !== false) view.focus();
    }
  };

  // Compile: save all files first, then compile via Tauri command
  compileRef.current = async () => {
    const state = useDocumentStore.getState();
    if (!projectRoot || activeFile?.type !== "tex") return;
    if (state.isCompiling) {
      // Queue a recompile after the current one finishes
      state.setPendingRecompile(true);
      return;
    }
    const { files: allFiles } = state;
    const resolved = resolveActiveCompileTarget(
      state.projectRoot,
      activeFile.id,
      allFiles,
    );
    if (!resolved) {
      setCompileError(
        "No .tex file found in this project. Create a main.tex file to compile.",
        activeFile.id,
      );
      return;
    }
    const { rootId, targetPath } = resolved;
    useHistoryStore.getState().stopReview();
    setIsCompiling(true);
    state.setPendingRecompile(false);
    const compileStart = Date.now();
    try {
      await saveAllFiles();
      // Pre-compile snapshot (fire-and-forget to avoid blocking compilation start)
      useHistoryStore
        .getState()
        .createSnapshot(projectRoot, "[compile] Pre-compile")
        .catch(() => {});
      const useTexlive =
        useSettingsStore.getState().compilerBackend === "texlive";
      const data = await compileLatex(projectRoot, targetPath, useTexlive);
      setPdfData(data, rootId);
    } catch (error) {
      setCompileError(formatCompileError(error), rootId);
    } finally {
      // Ensure the spinner is visible for at least 500ms for visual feedback
      const elapsed = Date.now() - compileStart;
      if (elapsed < 500) {
        await new Promise((r) => setTimeout(r, 500 - elapsed));
      }
      setIsCompiling(false);
      // If a recompile was requested while we were compiling, trigger it now
      // Use setTimeout to avoid unbounded recursion on the call stack
      if (useDocumentStore.getState().pendingRecompile) {
        setTimeout(() => compileRef.current?.(), 0);
      }
    }
  };

  useEffect(() => {
    if (!containerRef.current || !isTextFile) return;
    const currentContent = getActiveFileContent();

    const updateListener = EditorView.updateListener.of((update) => {
      if (isMergeActiveRef.current) {
        const chunks = getChunks(update.state);
        if (chunks) {
          const total = chunks.chunks.length;
          // Track current chunk based on cursor position
          const cursorPos = update.state.selection.main.head;
          let current = 0;
          for (let i = 0; i < chunks.chunks.length; i++) {
            if (cursorPos >= chunks.chunks[i].fromB) current = i + 1;
          }
          setMergeChunkInfo({
            total,
            current: Math.min(Math.max(1, current), total),
          });

          // Auto-resolve when all chunks have been individually accepted/rejected
          // Note: acceptChunk doesn't change the main doc (only the original),
          // so we check total === 0 regardless of docChanged
          if (total === 0) {
            const change = pendingChangeRef.current;
            if (change) {
              setTimeout(() => {
                const v = viewRef.current;
                if (!v || !isMergeActiveRef.current) return;
                // Guard: bail if already resolved by afterChunkAction or a new stacked edit arrived
                if (pendingChangeRef.current !== change) return;
                isMergeActiveRef.current = false;
                setMergeChunkInfo({ total: 0, current: 0 });
                const finalContent = v.state.doc.toString();
                v.dispatch({
                  effects: mergeCompartmentRef.current.reconfigure([]),
                });
                setContent(finalContent);
                if (finalContent === change.oldContent) {
                  useProposedChangesStore.getState().undoChange(change.id);
                } else {
                  useProposedChangesStore.getState().keepChange(change.id);
                }
                pendingChangeRef.current = null;
                // Auto-navigate to next file with pending changes
                const remaining = useProposedChangesStore.getState().changes;
                if (remaining.length > 0) {
                  useDocumentStore
                    .getState()
                    .setActiveFile(remaining[0].filePath);
                }
              }, 0);
            }
          }
        }
        return;
      }
      if (update.docChanged) setContent(update.state.doc.toString());
      if (update.selectionSet) {
        const { from, to, head } = update.state.selection.main;
        setCursorPosition(head);

        // Compute toolbar position below the selection end
        // Skip toolbar for "select all" (Cmd+A) to avoid overlay issues
        const isSelectAll = from === 0 && to === update.state.doc.length;
        if (from !== to && !isSelectAll) {
          setSelectionRange({ start: from, end: to });
          const startCoords = update.view.coordsAtPos(from);
          const endCoords = update.view.coordsAtPos(to);
          if (endCoords && startCoords) {
            setSelectionCoords({
              top: endCoords.bottom, // below last line of selection
              left: startCoords.left, // aligned to selection start
            });
          }
          toolbarStickyRef.current = true;
        } else if (!toolbarStickyRef.current) {
          // Only clear selection/coords if the toolbar is not being interacted with.
          // Clicking the toolbar input causes CM to lose focus and collapse the selection,
          // but we want to keep the toolbar visible until explicitly dismissed.
          setSelectionRange(null);
          setSelectionCoords(null);
        }
      }

      // Sync diagnostics for Problems panel
      const diags: DiagnosticItem[] = [];
      forEachDiagnostic(update.state, (d, from) => {
        diags.push({
          from,
          to: d.to,
          severity: d.severity,
          message: d.message,
          line: update.state.doc.lineAt(from).number,
        });
      });
      if (
        diags.length !== diagnosticsRef.current.length ||
        diags.some(
          (d, i) =>
            d.from !== diagnosticsRef.current[i]?.from ||
            d.message !== diagnosticsRef.current[i]?.message,
        )
      ) {
        diagnosticsRef.current = diags;
        setDiagnostics(diags);
      }
    });

    // Wrap selected text with a LaTeX command, or insert empty command at cursor
    const wrapSelection = (view: EditorView, cmd: string): boolean => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      const wrapped = `\\${cmd}{${selected}}`;
      const cursorPos = selected
        ? from + wrapped.length
        : from + cmd.length + 2;
      view.dispatch({
        changes: { from, to, insert: wrapped },
        selection: { anchor: cursorPos },
      });
      return true;
    };

    const compileKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            compileRef.current();
            return true;
          },
        },
        {
          key: "Mod-Shift-j",
          run: (view) => {
            const line = view.state.doc.lineAt(
              view.state.selection.main.head,
            ).number;
            void triggerForwardSync({ line });
            return true;
          },
        },
        {
          key: "Mod-s",
          run: () => {
            const state = useDocumentStore.getState();
            state.setIsSaving(true);
            state
              .saveCurrentFile()
              .finally(() => setTimeout(() => state.setIsSaving(false), 500));
            return true;
          },
        },
        {
          key: "Mod-f",
          run: () => {
            setIsSearchOpen(true);
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            if (isSearchOpenRef.current) {
              setIsSearchOpen(false);
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-y",
          run: () => {
            if (isMergeActiveRef.current) {
              handleKeepAllRef.current();
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-n",
          run: () => {
            if (isMergeActiveRef.current) {
              handleUndoAllRef.current();
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-b",
          run: (view) => wrapSelection(view, "textbf"),
        },
        {
          key: "Mod-i",
          run: (view) => wrapSelection(view, "textit"),
        },
        {
          key: "Mod-/",
          run: toggleComment,
        },
        {
          key: "Alt-Shift-b",
          run: () => {
            expandBulletBlockRef.current();
            return true;
          },
        },
      ]),
    );

    const state = EditorState.create({
      doc: currentContent,
      extensions: [
        compileKeymap,
        EditorView.domEventHandlers({
          dblclick(event, view) {
            if (spaceKindRef.current !== "resume") return false;
            const pos = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            if (pos == null) return false;
            const line = view.state.doc.lineAt(pos);
            if (!/\\item\b/.test(line.text)) return false;
            const block = findEnclosingBulletList(
              view.state.doc.toString(),
              pos,
            );
            if (!block) return false;
            view.dispatch({
              selection: { anchor: block.start, head: block.end },
              effects: EditorView.scrollIntoView(block.start, { y: "nearest" }),
            });
            return true;
          },
        }),
        lineNumbers(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([
          { key: "Tab", run: indentMore, shift: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        activeFile?.type === "bib"
          ? bibtex()
          : latex({ enableLinting: false, enableAutocomplete: false }),
        ...(activeFile?.type === "tex" ? [latexAutocomplete()] : []),
        ...(activeFile?.type === "tex"
          ? [
              linter((view) => {
                // Wait until the Lezer parser has fully parsed the document
                // to avoid false positives from incomplete syntax trees
                if (!syntaxTreeAvailable(view.state, view.state.doc.length)) {
                  return [];
                }
                const baseLinter = latexLinter();
                const diagnostics = baseLinter(view);
                return diagnostics.map((d: Diagnostic) => ({
                  ...d,
                  actions: [
                    ...(d.actions ?? []),
                    {
                      name:
                        useSettingsStore.getState().aiLintFix &&
                        canUseAiAssist()
                          ? "Fix with AI"
                          : getChatLabels(
                              useSettingsStore.getState().nativeAgentEnabled,
                            ).fixWithChat,
                      apply: (v: EditorView, from: number, _to: number) => {
                        const line = v.state.doc.lineAt(from);
                        const docState = useDocumentStore.getState();
                        const file = docState.files.find(
                          (f) => f.id === docState.activeFileId,
                        );
                        const fileName = file?.relativePath ?? "main.tex";
                        const content = file?.content;
                        if (
                          useSettingsStore.getState().aiLintFix &&
                          canUseAiAssist() &&
                          file?.absolutePath &&
                          content != null
                        ) {
                          void applyLintLineFix({
                            content,
                            line: line.number,
                            message: d.message,
                            filePath: fileName,
                            absolutePath: file.absolutePath,
                          })
                            .then(() =>
                              toast.success(
                                "Lint fix ready — review the change",
                              ),
                            )
                            .catch((err) => {
                              showWorkspaceError(
                                "Lint fix failed",
                                err instanceof Error
                                  ? err.message
                                  : "AI lint fix could not be applied.",
                                { dedupeKey: "editor-lint-fix" },
                              );
                              const ctx = `[Lint error in ${fileName}:${line.number}]\n[Error: ${d.message}]`;
                              useClaudeChatStore
                                .getState()
                                .sendPrompt(`${ctx}\n\nFix this lint error.`);
                            });
                          return;
                        }
                        const ctx = `[Lint error in ${fileName}:${line.number}]\n[Error: ${d.message}]`;
                        useClaudeChatStore
                          .getState()
                          .sendPrompt(`${ctx}\n\nFix this lint error.`);
                      },
                    },
                  ],
                }));
              }),
              lintGutter(),
            ]
          : []),
        themeCompartmentRef.current.of(
          resolvedTheme === "dark"
            ? [oneDark, syntaxHighlighting(oneDarkHighlightStyle)]
            : [syntaxHighlighting(defaultHighlightStyle)],
        ),
        search(),
        highlightSelectionMatches(),
        mergeCompartmentRef.current.of([]),
        vimCompartmentRef.current.of([]),
        spellCompartmentRef.current.of(spellCheckExtension(spellCheck)),
        ...(activeFile?.type === "tex"
          ? [
              aiPredictiveCompartmentRef.current.of(
                aiPredictiveExtension(aiAssistEnabled && aiPredictiveText),
              ),
              aiGrammarCompartmentRef.current.of(
                aiGrammarExtension(aiAssistEnabled && aiGrammarHints, {
                  fileId: activeFileId,
                  getAbsolutePath: () => {
                    const f = useDocumentStore
                      .getState()
                      .files.find((file) => file.id === activeFileId);
                    return f?.absolutePath ?? "";
                  },
                  getRelativePath: () => {
                    const f = useDocumentStore
                      .getState()
                      .files.find((file) => file.id === activeFileId);
                    return f?.relativePath ?? "main.tex";
                  },
                  getContent: getActiveFileContent,
                }),
              ),
            ]
          : []),
        latexStyling(),
        ...commentsExtension,
        updateListener,
        EditorView.lineWrapping,
        scrollPastEnd(),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "14px",
            color: "var(--foreground)",
            backgroundColor: "var(--background)",
            WebkitBackfaceVisibility: "hidden",
            backfaceVisibility: "hidden",
          },
          ".cm-scroller": {
            overflow: "auto",
            WebkitTransform: "translateZ(0)",
            transform: "translateZ(0)",
          },
          ".cm-gutters": { paddingRight: "4px" },
          ".cm-lineNumbers .cm-gutterElement": {
            paddingLeft: "8px",
            paddingRight: "4px",
          },
          ".cm-content": {
            paddingLeft: "8px",
            paddingRight: "12px",
          },
          ".cm-searchMatch": {
            backgroundColor: "var(--warning) !important",
            color: "var(--warning-foreground) !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 1px var(--ring)",
          },
          ".cm-searchMatch-selected": {
            backgroundColor: "var(--primary) !important",
            color: "var(--primary-foreground) !important",
            borderRadius: "2px",
            boxShadow: "0 0 0 2px var(--ring)",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "rgba(100, 150, 255, 0.3)",
          },
          ".cm-changedLine": {
            backgroundColor: "rgba(34, 197, 94, 0.08) !important",
          },
          ".cm-deletedChunk": {
            backgroundColor: "rgba(239, 68, 68, 0.12) !important",
            paddingLeft: "6px",
            position: "relative",
          },
          ".cm-insertedLine": {
            backgroundColor: "rgba(34, 197, 94, 0.15) !important",
          },
          ".cm-deletedLine": {
            backgroundColor: "rgba(239, 68, 68, 0.15) !important",
          },
          ".cm-changedText": {
            backgroundColor: "rgba(34, 197, 94, 0.25) !important",
          },
          ".cm-chunkButtons": {
            position: "absolute",
            insetInlineEnd: "5px",
            top: "2px",
            zIndex: "10",
          },
          ".cm-chunkButtons button": {
            border: "none",
            cursor: "pointer",
            color: "white",
            margin: "0 2px",
            borderRadius: "3px",
            padding: "2px 8px",
            fontSize: "12px",
            lineHeight: "1.4",
          },
          ".cm-chunkButtons button[name=accept]": {
            backgroundColor: "#22c55e",
          },
          ".cm-chunkButtons button[name=reject]": {
            backgroundColor: "#ef4444",
          },
          ".cm-changeGutter": { width: "3px", minWidth: "3px" },
          ".cm-changedLineGutter": { backgroundColor: "#22c55e" },
          ".cm-deletedLineGutter": { backgroundColor: "#ef4444" },
          ".cm-diagnostic": {
            padding: "8px 10px",
          },
          ".cm-diagnosticAction": {
            display: "inline-block",
            padding: "4px 12px",
            borderRadius: "6px",
            fontSize: "12px",
            fontWeight: "500",
            cursor: "pointer",
            backgroundColor: "var(--muted, rgba(255,255,255,0.08))",
            color: "var(--foreground, #e5e5e5)",
            border: "1px solid var(--border, rgba(255,255,255,0.1))",
            marginTop: "8px",
            transition: "background-color 0.15s, border-color 0.15s",
          },
          ".cm-diagnosticAction:hover": {
            backgroundColor: "var(--accent, rgba(255,255,255,0.15))",
            borderColor: "var(--foreground, rgba(255,255,255,0.3))",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    // Restore per-file cursor + scroll from cache
    const cached = editorStateCache.get(activeFileId);
    if (cached) {
      const pos = Math.min(cached.cursor, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos, head: pos } });
      // Scroll restoration needs layout to settle
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = cached.scrollTop;
      });
    }

    return () => {
      // Save per-file cursor + scroll before destroying
      editorStateCache.set(activeFileId, {
        cursor: view.state.selection.main.head,
        scrollTop: view.scrollDOM.scrollTop,
      });
      view.destroy();
      viewRef.current = null;
    };
  }, [
    activeFileId,
    isTextFile,
    setContent,
    setCursorPosition,
    setSelectionRange,
  ]);

  // Dynamically switch editor theme when resolvedTheme changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const extensions =
      resolvedTheme === "dark"
        ? [oneDark, syntaxHighlighting(oneDarkHighlightStyle)]
        : [syntaxHighlighting(defaultHighlightStyle)];
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(extensions),
    });
  }, [resolvedTheme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!vimMode) {
      view.dispatch({
        effects: vimCompartmentRef.current.reconfigure([]),
      });
      return;
    }
    import("@replit/codemirror-vim").then(({ vim }) => {
      if (viewRef.current !== view) return;
      view.dispatch({
        effects: vimCompartmentRef.current.reconfigure(vim()),
      });
    });
  }, [vimMode, activeFileId, isTextFile]);

  // Toggle native spell checking without recreating the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: spellCompartmentRef.current.reconfigure(
        spellCheckExtension(spellCheck),
      ),
    });
  }, [spellCheck, isTextFile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || activeFile?.type !== "tex") return;
    view.dispatch({
      effects: aiPredictiveCompartmentRef.current.reconfigure(
        aiPredictiveExtension(aiAssistEnabled && aiPredictiveText),
      ),
    });
  }, [aiAssistEnabled, aiPredictiveText, activeFile?.type, activeFileId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || activeFile?.type !== "tex") return;
    view.dispatch({
      effects: aiGrammarCompartmentRef.current.reconfigure(
        aiGrammarExtension(aiAssistEnabled && aiGrammarHints, {
          fileId: activeFileId,
          getAbsolutePath: () => {
            const f = useDocumentStore
              .getState()
              .files.find((file) => file.id === activeFileId);
            return f?.absolutePath ?? "";
          },
          getRelativePath: () => {
            const f = useDocumentStore
              .getState()
              .files.find((file) => file.id === activeFileId);
            return f?.relativePath ?? "main.tex";
          },
          getContent: getActiveFileContent,
        }),
      ),
    });
  }, [aiAssistEnabled, aiGrammarHints, activeFile?.type, activeFileId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile || isMergeActiveRef.current) return;
    const content = activeFileContent ?? "";
    const currentContent = view.state.doc.toString();
    if (currentContent !== content) {
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: content },
      });
    }
  }, [activeFileContent, isTextFile]);

  // === Drag-and-drop image insertion ===
  // OS file drops are delivered through Tauri's webview event (the browser's
  // native DataTransfer is empty for real files). We claim the drop only when
  // it lands over the editor's scroller, copy any images into images/, and
  // insert a figure environment at the drop position.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const isOverEditor = (physX: number, physY: number): boolean => {
      const scroller = viewRef.current?.scrollDOM;
      if (!scroller) return false;
      const logicalX = physX / window.devicePixelRatio;
      const logicalY = physY / window.devicePixelRatio;
      const el = document.elementFromPoint(logicalX, logicalY);
      return !!el && scroller.contains(el);
    };

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;

        if (type === "over" || type === "enter") {
          const { position } = event.payload as {
            position: { x: number; y: number };
          };
          setIsImageDropActive(
            !isMergeActiveRef.current && isOverEditor(position.x, position.y),
          );
        } else if (type === "leave") {
          setIsImageDropActive(false);
        } else if (type === "drop") {
          setIsImageDropActive(false);
          const { paths, position } = event.payload as {
            paths: string[];
            position: { x: number; y: number };
          };
          const view = viewRef.current;
          if (!view || isMergeActiveRef.current) return;
          if (!isOverEditor(position.x, position.y)) return;
          // Only intercept image drops; leave other files to the sidebar/chat.
          if (filterImagePaths(paths).length === 0) return;
          // Only the LaTeX/text editor accepts figure insertion.
          const docState = useDocumentStore.getState();
          const file = docState.files.find(
            (f) => f.id === docState.activeFileId,
          );
          if (file?.type !== "tex") return;

          // Claim the drop so the chat composer doesn't also attach the files.
          (
            window as Window & { __sidebarHandledDrop?: boolean }
          ).__sidebarHandledDrop = true;
          setTimeout(() => {
            (
              window as Window & { __sidebarHandledDrop?: boolean }
            ).__sidebarHandledDrop = false;
          }, 200);

          const logicalX = position.x / window.devicePixelRatio;
          const logicalY = position.y / window.devicePixelRatio;
          const dropPos =
            view.posAtCoords({ x: logicalX, y: logicalY }) ??
            view.state.selection.main.head;

          try {
            const count = await insertDroppedImages(view, paths, dropPos);
            if (count > 0) {
              toast.success(
                count === 1 ? "Image inserted" : `${count} images inserted`,
              );
            }
          } catch (err) {
            log.error("image drop failed", { error: String(err) });
            showWorkspaceError(
              "Image insert failed",
              "The dropped image could not be added to the document.",
              { dedupeKey: "editor-image-drop" },
            );
          }
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running inside Tauri (e.g. plain browser dev) — no native drops.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Watch for proposed changes → activate/deactivate/update merge view
  useEffect(() => {
    const view = viewRef.current;
    log.debug("effect fired", {
      hasView: !!view,
      isTextFile,
      activeFileChange: activeFileChange
        ? { id: activeFileChange.id, filePath: activeFileChange.filePath }
        : null,
      isMergeActive: isMergeActiveRef.current,
      pendingId: pendingChangeRef.current?.id,
    });
    if (!view || !isTextFile) return;

    if (activeFileChange && !isMergeActiveRef.current) {
      // Activate merge view: load newContent + enable merge extension in ONE atomic dispatch
      log.debug(`ACTIVATING merge view for: ${activeFileChange.filePath}`);
      pendingChangeRef.current = activeFileChange;
      isMergeActiveRef.current = true;
      try {
        const scrollTop = view.scrollDOM.scrollTop;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: activeFileChange.newContent,
          },
          effects: mergeCompartmentRef.current.reconfigure(
            unifiedMergeView({
              original: activeFileChange.oldContent,
              highlightChanges: true,
              gutter: true,
              mergeControls: true,
            }),
          ),
          annotations: Transaction.addToHistory.of(false),
        });
        view.scrollDOM.scrollTop = scrollTop;
        log.debug("merge view activated successfully");
        // Auto-scroll to first chunk
        setTimeout(() => goToChunk(0), 50);
      } catch (err) {
        log.error("failed to activate merge view", { error: String(err) });
        isMergeActiveRef.current = false;
        pendingChangeRef.current = null;
      }
    } else if (
      activeFileChange &&
      isMergeActiveRef.current &&
      pendingChangeRef.current?.id !== activeFileChange.id
    ) {
      // Stacked edit: the change was updated while merge was already active.
      // Re-dispatch the merge view with the accumulated diff (original → latest).
      log.debug(
        `UPDATING merge view (stacked edit) for: ${activeFileChange.filePath}`,
      );
      pendingChangeRef.current = activeFileChange;
      try {
        const scrollTop = view.scrollDOM.scrollTop;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: activeFileChange.newContent,
          },
          effects: mergeCompartmentRef.current.reconfigure(
            unifiedMergeView({
              original: activeFileChange.oldContent,
              highlightChanges: true,
              gutter: true,
              mergeControls: true,
            }),
          ),
          annotations: Transaction.addToHistory.of(false),
        });
        view.scrollDOM.scrollTop = scrollTop;
        log.debug("merge view updated successfully (stacked edit)");
      } catch (err) {
        log.error("failed to update merge view", { error: String(err) });
      }
    } else if (!activeFileChange && isMergeActiveRef.current) {
      // Deactivate merge view (externally resolved)
      log.debug("DEACTIVATING merge view");
      view.dispatch({ effects: mergeCompartmentRef.current.reconfigure([]) });
      isMergeActiveRef.current = false;
      pendingChangeRef.current = null;
    }
  }, [activeFileChange, isTextFile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || jumpToPosition === null) return;
    view.dispatch({
      selection: { anchor: jumpToPosition },
      effects: EditorView.scrollIntoView(jumpToPosition, { y: "center" }),
    });
    view.focus();
    clearJumpRequest();
  }, [jumpToPosition, clearJumpRequest]);

  // === Comments: attach/detach the store to the current project ===
  useEffect(() => {
    if (!projectRoot) return;
    useCommentsStore
      .getState()
      .attachToProject(projectRoot)
      .catch((e) => log.error("comments attach failed", { error: String(e) }));
    return () => {
      useCommentsStore
        .getState()
        .detach()
        .catch(() => {});
    };
  }, [projectRoot]);

  // === Comments: re-dispatch decoration set when comments for the active
  //     file change. The CodeMirror StateField only renders what we feed it. ===
  const allComments = useCommentsStore((s) => s.comments);
  const activeFileRelPath = activeFile?.relativePath ?? null;
  const commentsForActiveFile = useMemo(
    () =>
      activeFileRelPath
        ? allComments.filter((c) => c.file_path === activeFileRelPath)
        : [],
    [allComments, activeFileRelPath],
  );
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setCommentsEffect.of(commentsForActiveFile),
    });
  }, [commentsForActiveFile]);

  // === Comments: dispatch active-comment-id based on cursor position so the
  //     sidebar can highlight the matching row. ===
  const cursorPosition = useDocumentStore((s) => s.cursorPosition);
  useEffect(() => {
    if (!activeFileRelPath) {
      window.dispatchEvent(
        new CustomEvent("comments:active-set", { detail: { id: null } }),
      );
      return;
    }
    const hit = commentsForActiveFile.find(
      (c) =>
        c.status !== "rejected" &&
        c.anchor.char_start <= cursorPosition &&
        cursorPosition <= c.anchor.char_end,
    );
    window.dispatchEvent(
      new CustomEvent("comments:active-set", {
        detail: { id: hit?.id ?? null },
      }),
    );
  }, [cursorPosition, commentsForActiveFile, activeFileRelPath]);

  // === Comments: keyboard shortcuts (Cmd+Shift+M / Cmd+Shift+S) and inline AI
  //     (Cmd+Shift+R/E/P for rephrase / expand / proofread). ===
  // Uses a ref so we can reference handleToolbarAction (declared later in
  // the function) without TDZ issues.
  const toolbarActionRef = useRef<((actionId: string) => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (!["m", "s", "r", "e", "p", "y", "o", "t", "g"].includes(key)) return;
      const view = viewRef.current;
      if (!view) return;
      const active = document.activeElement;
      const editorDom = view.dom;
      if (active && active !== document.body && !editorDom.contains(active)) {
        return;
      }
      const sel = view.state.selection.main;
      if (sel.empty) return;
      e.preventDefault();
      if (key === "s") toolbarActionRef.current?.("suggest");
      else if (key === "m") toolbarActionRef.current?.("comment");
      else if (key === "r") toolbarActionRef.current?.("rephrase");
      else if (key === "e") toolbarActionRef.current?.("expand");
      else if (key === "p") toolbarActionRef.current?.("proofread");
      else if (key === "y") toolbarActionRef.current?.("simplify");
      else if (key === "o") toolbarActionRef.current?.("formalize");
      else if (key === "t") toolbarActionRef.current?.("shorten");
      else if (key === "g") toolbarActionRef.current?.("grammar");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // === Comments: open the composer from a PDF-side selection. The
  //     pdf-preview component resolved the source location via SyncTeX
  //     and pre-computed the anchor; we just pop the composer here. ===
  useEffect(() => {
    const onStartFromPdf = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          mode: "comment" | "suggestion";
          filePath: string;
          anchor: {
            line_start: number;
            line_end: number;
            char_start: number;
            char_end: number;
            quoted_text: string;
          };
        }>
      ).detail;
      if (!detail) return;
      setComposerState({
        open: true,
        mode: detail.mode,
        filePath: detail.filePath,
        anchor: detail.anchor,
      });
    };
    window.addEventListener(
      "comments:start-from-pdf",
      onStartFromPdf as EventListener,
    );
    return () =>
      window.removeEventListener(
        "comments:start-from-pdf",
        onStartFromPdf as EventListener,
      );
  }, []);

  // === Comments: listen for "jump to comment" + "apply suggestion" events
  //     dispatched by the CommentsPanel sidebar. ===
  useEffect(() => {
    const onJump = (e: Event) => {
      const view = viewRef.current;
      if (!view) return;
      const detail = (e as CustomEvent<{ from: number; to: number }>).detail;
      if (!detail) return;
      const docLen = view.state.doc.length;
      const from = Math.max(0, Math.min(detail.from, docLen));
      const to = Math.max(from, Math.min(detail.to, docLen));
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
      view.focus();
    };
    const onApply = (e: Event) => {
      const view = viewRef.current;
      if (!view) return;
      const detail = (
        e as CustomEvent<{ from: number; to: number; replacement: string }>
      ).detail;
      if (!detail) return;
      const docLen = view.state.doc.length;
      const from = Math.max(0, Math.min(detail.from, docLen));
      const to = Math.max(from, Math.min(detail.to, docLen));
      view.dispatch({
        changes: { from, to, insert: detail.replacement },
        selection: { anchor: from + detail.replacement.length },
      });
      view.focus();
    };
    window.addEventListener("comments:jump", onJump as EventListener);
    window.addEventListener(
      "comments:apply-suggestion",
      onApply as EventListener,
    );
    return () => {
      window.removeEventListener("comments:jump", onJump as EventListener);
      window.removeEventListener(
        "comments:apply-suggestion",
        onApply as EventListener,
      );
    };
  }, []);

  // Selection toolbar: compute context label and container-relative position
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const selectionLabel = useMemo(() => {
    const view = viewRef.current;
    if (!selectionRange || !view || !activeFile) return null;
    try {
      const startLine = view.state.doc.lineAt(selectionRange.start);
      const endLine = view.state.doc.lineAt(selectionRange.end);
      const startCol = selectionRange.start - startLine.from + 1;
      const endCol = selectionRange.end - endLine.from + 1;
      const fileName = activeFile.relativePath;
      return `@${fileName}:${startLine.number}:${startCol}-${endLine.number}:${endCol}`;
    } catch {
      return null;
    }
  }, [selectionRange, activeFile]);

  const toolbarPosition = useMemo(() => {
    if (!selectionCoords || !parentRef.current) return null;
    const parentRect = parentRef.current.getBoundingClientRect();
    const relTop = selectionCoords.top - parentRect.top + 4; // 4px gap below selection
    const relLeft = Math.max(
      8,
      Math.min(selectionCoords.left - parentRect.left, parentRect.width - 392),
    );
    return { top: relTop, left: relLeft };
  }, [selectionCoords]);

  const buildSelectionContext =
    useCallback((): PromptContextOverride | null => {
      if (!selectionRange || !selectionLabel || !activeFile?.content) {
        return null;
      }
      const start = Math.min(selectionRange.start, selectionRange.end);
      const end = Math.max(selectionRange.start, selectionRange.end);
      const selectedText = activeFile.content.slice(start, end);
      if (!selectedText) return null;
      return {
        label: selectionLabel,
        filePath: activeFile.relativePath,
        selectedText,
      };
    }, [selectionRange, selectionLabel, activeFile]);

  const buildInlineEditSelection =
    useCallback((): InlineEditSelection | null => {
      if (!selectionRange || !selectionLabel || !activeFile?.content) {
        return null;
      }
      const from = Math.min(selectionRange.start, selectionRange.end);
      const to = Math.max(selectionRange.start, selectionRange.end);
      const selectedText = activeFile.content.slice(from, to);
      if (!selectedText.trim()) return null;
      return {
        filePath: activeFile.relativePath,
        absolutePath: activeFile.absolutePath,
        content: activeFile.content,
        from,
        to,
        selectedText,
        contextLabel: selectionLabel,
      };
    }, [selectionRange, selectionLabel, activeFile]);

  const selectionBulletStats = useMemo(() => {
    if (!selectionRange || !activeFile?.content) return null;
    const from = Math.min(selectionRange.start, selectionRange.end);
    const to = Math.max(selectionRange.start, selectionRange.end);
    return analyzeSelectionBullets(activeFile.content, from, to);
  }, [selectionRange, activeFile]);

  const effectiveBulletCount = useMemo(() => {
    if (!selectionBulletStats?.block) {
      return selectionBulletStats?.selectedCount ?? 0;
    }
    const block = selectionBulletStats.block;
    if (
      selectionBulletStats.selectedCount === 0 ||
      selectionBulletStats.isPartialBlock
    ) {
      return block.itemCount;
    }
    return selectionBulletStats.selectedCount;
  }, [selectionBulletStats]);

  const showResumeBulletAdjust =
    spaceKind === "resume" &&
    effectiveBulletCount > 0 &&
    selectionRange != null &&
    !!selectionBulletStats?.block;

  useEffect(() => {
    if (showResumeBulletAdjust) {
      const recommended = selectionBulletStats?.block
        ? recommendedBulletTarget(
            {
              bulletText:
                activeFile?.content?.slice(
                  selectionBulletStats.block.start,
                  selectionBulletStats.block.end,
                ) ?? "",
              itemCount: effectiveBulletCount,
              compiledPageCount,
              hasJobDescription: jobDescription.length > 0,
            },
            analyzeBulletQuality(
              activeFile?.content?.slice(
                selectionBulletStats.block.start,
                selectionBulletStats.block.end,
              ) ?? "",
            ),
          )
        : null;
      setBulletTargetCount(recommended ?? effectiveBulletCount);
    }
  }, [
    showResumeBulletAdjust,
    effectiveBulletCount,
    selectionRange,
    selectionBulletStats,
    activeFile?.content,
    compiledPageCount,
    jobDescription,
  ]);

  const dismissSelectionToolbar = useCallback(() => {
    toolbarStickyRef.current = false;
    setSelectionCoords(null);
    setSelectionRange(null);
  }, [setSelectionRange]);

  const runSelectionInlineEdit = useCallback(
    async (
      action: InlineEditAction,
      customInstruction?: string,
      selectionOverride?: InlineEditSelection,
      successMessage?: string,
    ) => {
      const selection = selectionOverride ?? buildInlineEditSelection();
      const context = buildSelectionContext();
      if (!selection) return;

      dismissSelectionToolbar();
      setInlineEditPending(true);
      try {
        const mode = await runInlineEdit({
          action,
          selection,
          customInstruction,
          contextOverride: context ?? undefined,
        });
        if (mode === "applied") {
          toast.success(successMessage ?? inlineEditSuccessMessage(action));
        }
      } catch (err) {
        showWorkspaceError(
          "Inline edit failed",
          err instanceof Error ? err.message : "The edit could not be applied.",
          { dedupeKey: "editor-inline-edit" },
        );
      } finally {
        setInlineEditPending(false);
      }
    },
    [buildInlineEditSelection, buildSelectionContext, dismissSelectionToolbar],
  );

  // Summarize the current selection and insert the result as a LaTeX comment
  // block (each line prefixed with "% ") immediately after the selection.
  const summarizeSelection = useCallback(async () => {
    if (!aiSummarize || !canUseAiAssist()) return;
    const selection = buildInlineEditSelection();
    if (!selection) return;

    dismissSelectionToolbar();
    setInlineEditPending(true);
    try {
      const summary = (await summarizeSection(selection.selectedText)).trim();
      if (!summary) {
        showWorkspaceError(
          "Summarize failed",
          "Could not summarize the selected text.",
          { dedupeKey: "editor-summarize-empty" },
        );
        return;
      }
      const view = viewRef.current;
      if (!view) return;
      // Anchor the comment to the start of the line after the selection end so
      // it reads as an independent block rather than trailing the prose.
      const insertAt = Math.min(selection.to, view.state.doc.length);
      const endLine = view.state.doc.lineAt(insertAt);
      const commentBody = summary
        .split(/\r?\n/)
        .map((line) => `% ${line}`.trimEnd())
        .join("\n");
      const block = `\n% --- AI summary ---\n${commentBody}\n% --- end summary ---\n`;
      view.dispatch({
        changes: { from: endLine.to, insert: block },
        selection: { anchor: endLine.to + block.length },
        effects: EditorView.scrollIntoView(endLine.to, { y: "center" }),
      });
      view.focus();
      toast.success("Summary inserted as a comment");
    } catch (err) {
      showWorkspaceError(
        "Summarize failed",
        err instanceof Error
          ? err.message
          : "Could not summarize the selection.",
        { dedupeKey: "editor-summarize" },
      );
    } finally {
      setInlineEditPending(false);
    }
  }, [aiSummarize, buildInlineEditSelection, dismissSelectionToolbar]);

  const buildBulletEditSelection = useCallback((): {
    selection: InlineEditSelection;
    currentCount: number;
    env?: BulletListEnv;
  } | null => {
    const base = buildInlineEditSelection();
    if (!base || !activeFile?.content) return null;

    const stats = analyzeSelectionBullets(
      activeFile.content,
      base.from,
      base.to,
    );
    const block = stats.block;
    if (
      block &&
      stats.selectedCount > 0 &&
      stats.selectedCount < block.itemCount
    ) {
      const blockText = activeFile.content.slice(block.start, block.end);
      return {
        selection: {
          ...base,
          from: block.start,
          to: block.end,
          selectedText: blockText,
        },
        currentCount: block.itemCount,
        env: block.env,
      };
    }

    return {
      selection: base,
      currentCount: stats.selectedCount,
      env: block?.env,
    };
  }, [buildInlineEditSelection, activeFile]);

  const expandSelectionToBulletBlock = useCallback(() => {
    const view = viewRef.current;
    if (!view || !activeFile?.content || spaceKind !== "resume") return;

    const sel = view.state.selection.main;
    const anchor =
      sel.from === sel.to ? sel.head : Math.floor((sel.from + sel.to) / 2);
    const block = findEnclosingBulletList(activeFile.content, anchor);
    if (!block) return;

    view.dispatch({
      selection: { anchor: block.start, head: block.end },
      effects: EditorView.scrollIntoView(block.start, { y: "nearest" }),
    });
    setSelectionRange({ start: block.start, end: block.end });
    const startCoords = view.coordsAtPos(block.start);
    const endCoords = view.coordsAtPos(block.end);
    if (endCoords && startCoords) {
      setSelectionCoords({
        top: endCoords.bottom,
        left: startCoords.left,
      });
    }
    toolbarStickyRef.current = true;
  }, [activeFile, spaceKind, setSelectionRange]);

  useEffect(() => {
    spaceKindRef.current = spaceKind;
  }, [spaceKind]);

  useEffect(() => {
    expandBulletBlockRef.current = expandSelectionToBulletBlock;
  }, [expandSelectionToBulletBlock]);

  const runBulletCountEdit = useCallback(
    (targetCount: number) => {
      const edit = buildBulletEditSelection();
      if (!edit || targetCount === edit.currentCount) return;

      const role =
        activeFile?.content && edit.selection
          ? findRoleContextBefore(activeFile.content, edit.selection.from)
          : null;

      const instruction = buildBulletCountInstruction(
        edit.currentCount,
        targetCount,
        { env: edit.env, roleLabel: role?.label },
      );
      void runSelectionInlineEdit(
        "edit",
        instruction,
        edit.selection,
        bulletCountSuccessMessage(edit.currentCount, targetCount),
      );
    },
    [buildBulletEditSelection, runSelectionInlineEdit, activeFile?.content],
  );

  const handleToolbarSendPrompt = useCallback(
    (prompt: string) => {
      void runSelectionInlineEdit("edit", prompt);
    },
    [runSelectionInlineEdit],
  );

  const handleBulletCountApply = useCallback(() => {
    runBulletCountEdit(bulletTargetCount);
  }, [bulletTargetCount, runBulletCountEdit]);

  const handleBulletQuickApply = useCallback(
    (target: number) => {
      setBulletTargetCount(target);
      runBulletCountEdit(target);
    },
    [runBulletCountEdit],
  );

  const resumeBulletSuggestionPack = useMemo(() => {
    if (!showResumeBulletAdjust || !selectionBulletStats?.block) {
      return null;
    }
    const block = selectionBulletStats.block;
    const bulletText = activeFile?.content?.slice(block.start, block.end) ?? "";
    const role = activeFile?.content
      ? findRoleContextBefore(activeFile.content, block.start)
      : null;
    const context = {
      bulletText,
      itemCount: effectiveBulletCount,
      compiledPageCount,
      hasJobDescription: jobDescription.length > 0,
      roleLabel: role?.label,
    };
    const quality = analyzeBulletQuality(bulletText);
    const suggestions = buildResumeBulletSuggestions(context, {
      env: block.env,
    });
    const insights = bulletQualityInsights(quality, context);
    return {
      roleLabel: role?.label ?? null,
      qualityScore: bulletQualityScore(quality),
      qualityGrade: bulletQualityGrade(bulletQualityScore(quality)),
      insights,
      insightSuggestionIds: Object.fromEntries(
        insights.map((insight) => [insight, suggestionIdForInsight(insight)]),
      ),
      bulletDiagnostics: diagnoseBulletItems(bulletText),
      recommended: recommendedBulletTarget(context, quality),
      suggestions,
    };
  }, [
    showResumeBulletAdjust,
    selectionBulletStats,
    activeFile?.content,
    effectiveBulletCount,
    compiledPageCount,
    jobDescription,
  ]);

  const handleBulletAiSuggestion = useCallback(
    (suggestion: ResumeBulletSuggestion) => {
      if (suggestion.kind === "count" && suggestion.targetCount != null) {
        setBulletTargetCount(suggestion.targetCount);
        runBulletCountEdit(suggestion.targetCount);
        return;
      }

      if (suggestion.kind === "advice") {
        const context = buildSelectionContext();
        dismissSelectionToolbar();
        const chat = useClaudeChatStore.getState();
        void chat.sendPrompt(suggestion.instruction, context ?? undefined);
        if (context) {
          chat.requestPinnedContextRemoval([context.label]);
        }
        return;
      }

      const edit = buildBulletEditSelection();
      if (!edit) return;
      void runSelectionInlineEdit(
        "edit",
        suggestion.instruction,
        edit.selection,
        refinementSuccessMessage(suggestion.label),
      );
    },
    [
      runBulletCountEdit,
      buildBulletEditSelection,
      runSelectionInlineEdit,
      buildSelectionContext,
      dismissSelectionToolbar,
    ],
  );

  const handleBulletInsightClick = useCallback(
    (insight: string) => {
      const id = resumeBulletSuggestionPack?.insightSuggestionIds[insight];
      if (!id) return;
      const suggestion = findSuggestionById(
        resumeBulletSuggestionPack?.suggestions ?? [],
        id,
      );
      if (suggestion) {
        handleBulletAiSuggestion(suggestion);
      }
    },
    [resumeBulletSuggestionPack, handleBulletAiSuggestion],
  );

  const resumeBulletAdjust = useMemo(() => {
    if (!showResumeBulletAdjust || !selectionBulletStats) return undefined;
    return {
      currentCount: selectionBulletStats.selectedCount || effectiveBulletCount,
      targetCount: bulletTargetCount,
      blockItemCount: selectionBulletStats.isPartialBlock
        ? selectionBulletStats.block?.itemCount
        : null,
      roleLabel: resumeBulletSuggestionPack?.roleLabel ?? null,
      qualityScore: resumeBulletSuggestionPack?.qualityScore ?? null,
      qualityGrade: resumeBulletSuggestionPack?.qualityGrade ?? null,
      suggestedTargets: suggestedBulletTargets(effectiveBulletCount),
      recommendedTarget: resumeBulletSuggestionPack?.recommended ?? null,
      insights: resumeBulletSuggestionPack?.insights ?? [],
      insightSuggestionIds:
        resumeBulletSuggestionPack?.insightSuggestionIds ?? {},
      bulletDiagnostics: resumeBulletSuggestionPack?.bulletDiagnostics ?? [],
      aiSuggestions: resumeBulletSuggestionPack?.suggestions ?? [],
      shortcutHint: `Double-click a bullet line or press ${BULLET_BLOCK_HINT} to select the full role`,
      onTargetChange: setBulletTargetCount,
      onApply: handleBulletCountApply,
      onQuickApply: handleBulletQuickApply,
      onAiSuggestion: handleBulletAiSuggestion,
      onInsightClick: handleBulletInsightClick,
      onSelectAllInBlock: selectionBulletStats.isPartialBlock
        ? expandSelectionToBulletBlock
        : undefined,
      pending: inlineEditPending,
    };
  }, [
    showResumeBulletAdjust,
    selectionBulletStats,
    effectiveBulletCount,
    bulletTargetCount,
    resumeBulletSuggestionPack,
    handleBulletCountApply,
    handleBulletQuickApply,
    handleBulletAiSuggestion,
    handleBulletInsightClick,
    expandSelectionToBulletBlock,
    inlineEditPending,
  ]);

  const editorToolbarActions: ToolbarAction[] = useMemo(
    () => [
      {
        id: "rephrase",
        label: "Rephrase",
        icon: <RefreshCwIcon className="size-4" />,
        hint: INLINE_REPHRASE_HINT,
      },
      {
        id: "expand",
        label: "Expand",
        icon: <ExpandIcon className="size-4" />,
        hint: INLINE_EXPAND_HINT,
      },
      {
        id: "proofread",
        label: "Proofread",
        icon: <SpellCheckIcon className="size-4" />,
        hint: INLINE_PROOFREAD_HINT,
      },
      {
        id: "grammar",
        label: "Grammar",
        icon: <SparklesIcon className="size-4" />,
        hint: INLINE_GRAMMAR_HINT,
      },
      {
        id: "shorten",
        label: "Shorten",
        icon: <Minimize2Icon className="size-4" />,
        hint: INLINE_SHORTEN_HINT,
      },
      {
        id: "formalize",
        label: "Formalize",
        icon: <BriefcaseIcon className="size-4" />,
        hint: INLINE_FORMALIZE_HINT,
      },
      {
        id: "simplify",
        label: "Simplify",
        icon: <SparklesIcon className="size-4" />,
        hint: INLINE_SIMPLIFY_HINT,
      },
      ...(aiSummarize && canUseAiAssist()
        ? [
            {
              id: "summarize",
              label: "Summarize",
              icon: <FileTextIcon className="size-4" />,
            },
          ]
        : []),
      {
        id: "comment",
        label: "Comment",
        icon: <MessageSquareIcon className="size-4" />,
      },
      {
        id: "suggest",
        label: "Suggest",
        icon: <LightbulbIcon className="size-4" />,
      },
    ],
    [aiSummarize],
  );

  const [composerState, setComposerState] = useState<{
    open: boolean;
    mode: "comment" | "suggestion";
    filePath: string;
    anchor: {
      line_start: number;
      line_end: number;
      char_start: number;
      char_end: number;
      quoted_text: string;
    };
  } | null>(null);

  const handleToolbarAction = useCallback(
    (actionId: string) => {
      if (actionId === "comment" || actionId === "suggest") {
        const view = viewRef.current;
        const docState = useDocumentStore.getState();
        const file = docState.files.find((f) => f.id === docState.activeFileId);
        const sel = view?.state.selection.main;
        if (!view || !file || !sel || sel.empty) return;
        const startLine = view.state.doc.lineAt(sel.from);
        const endLine = view.state.doc.lineAt(sel.to);
        const quoted = view.state.doc.sliceString(sel.from, sel.to);
        setComposerState({
          open: true,
          mode: actionId === "suggest" ? "suggestion" : "comment",
          filePath: file.relativePath,
          anchor: {
            line_start: startLine.number,
            line_end: endLine.number,
            char_start: sel.from,
            char_end: sel.to,
            quoted_text: quoted,
          },
        });
        // Dismiss the toolbar but keep selection visible behind the dialog
        toolbarStickyRef.current = false;
        setSelectionCoords(null);
        return;
      }
      toolbarStickyRef.current = false;
      setSelectionCoords(null);
      setSelectionRange(null);
      if (actionId === "rephrase") {
        void runSelectionInlineEdit("rephrase");
      } else if (actionId === "expand") {
        void runSelectionInlineEdit("expand");
      } else if (actionId === "proofread") {
        void runSelectionInlineEdit("proofread");
      } else if (actionId === "grammar") {
        void runSelectionInlineEdit("grammar");
      } else if (actionId === "shorten") {
        void runSelectionInlineEdit("shorten");
      } else if (actionId === "formalize") {
        void runSelectionInlineEdit("formalize");
      } else if (actionId === "simplify") {
        void runSelectionInlineEdit("simplify");
      } else if (actionId === "summarize") {
        void summarizeSelection();
      }
    },
    [runSelectionInlineEdit, summarizeSelection],
  );

  const handleToolbarDismiss = useCallback(() => {
    if (inlineEditPending) return;
    dismissSelectionToolbar();
  }, [inlineEditPending, dismissSelectionToolbar]);

  const lintAiAvailable = aiAssistEnabled && aiLintFix && canUseAiAssist();

  const handleFixLintWithAi = useCallback(
    async (message: string, line: number) => {
      const file = activeFile;
      const content = file?.content;
      if (!file || content == null || !file.absolutePath) return;
      try {
        await applyLintLineFix({
          content,
          line,
          message,
          filePath: file.relativePath,
          absolutePath: file.absolutePath,
        });
        toast.success("Lint fix ready — review the change");
      } catch (err) {
        showWorkspaceError(
          "Lint fix failed",
          err instanceof Error
            ? err.message
            : "AI lint fix could not be applied.",
          { dedupeKey: "editor-lint-fix" },
        );
        const fileName = file.relativePath;
        const ctx = `[Lint error in ${fileName}:${line}]\n[Error: ${message}]`;
        useClaudeChatStore
          .getState()
          .sendPrompt(`${ctx}\n\nFix this lint error.`);
      }
    },
    [activeFile],
  );

  const handleFixAllLintWithAi = useCallback(async () => {
    const file = activeFile;
    const content = file?.content;
    if (
      !file ||
      content == null ||
      !file.absolutePath ||
      diagnostics.length === 0
    ) {
      return;
    }
    let fixed = 0;
    for (const d of diagnostics) {
      try {
        await applyLintLineFix({
          content,
          line: d.line,
          message: d.message,
          filePath: file.relativePath,
          absolutePath: file.absolutePath,
        });
        fixed++;
      } catch {
        // continue with remaining diagnostics
      }
    }
    if (fixed > 0) {
      toast.success(
        `${fixed} lint fix${fixed === 1 ? "" : "es"} ready — review changes`,
      );
    } else {
      const fileName = file.relativePath;
      const errorList = diagnostics
        .map((d) => `- ${fileName}:${d.line} — ${d.message}`)
        .join("\n");
      useClaudeChatStore
        .getState()
        .sendPrompt(
          `[Lint errors in ${fileName}]\n${errorList}\n\nFix all these lint errors.`,
        );
    }
  }, [activeFile, diagnostics]);

  // Keep the keyboard-shortcut ref in sync with the latest handleToolbarAction
  useEffect(() => {
    toolbarActionRef.current = handleToolbarAction;
  }, [handleToolbarAction]);

  // History review action handlers
  const handleHistoryRestore = useCallback(async () => {
    if (!reviewingSnapshot || !projectRoot) return;
    useHistoryStore.getState().stopReview();
    await useHistoryStore
      .getState()
      .restoreSnapshot(projectRoot, reviewingSnapshot.id);
    await useDocumentStore.getState().openProject(projectRoot);
    await useHistoryStore.getState().loadSnapshots(projectRoot);
  }, [reviewingSnapshot, projectRoot]);

  const [historyLabelDialogOpen, setHistoryLabelDialogOpen] = useState(false);
  const [historyLabelValue, setHistoryLabelValue] = useState("");

  const handleHistoryAddLabel = useCallback(async () => {
    const label = historyLabelValue.trim();
    if (!label || !reviewingSnapshot || !projectRoot) return;
    await useHistoryStore
      .getState()
      .addLabel(projectRoot, reviewingSnapshot.id, label);
    setHistoryLabelDialogOpen(false);
    setHistoryLabelValue("");
  }, [reviewingSnapshot, projectRoot, historyLabelValue]);

  const handleHistoryCopySha = useCallback(() => {
    if (!reviewingSnapshot) return;
    navigator.clipboard.writeText(reviewingSnapshot.id);
  }, [reviewingSnapshot]);

  const handleHistoryClose = useCallback(() => {
    useHistoryStore.getState().stopReview();
  }, []);

  const isPdf = activeFile?.type === "pdf";
  const isImage = !isTextFile && !isPdf && !!activeFile;

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {/* Toolbar — adapts to file type */}
      <EditorToolbar
        editorView={viewRef}
        fileType={isPdf || isImage ? "image" : undefined}
        imageScale={isPdf || isImage ? imageScale : undefined}
        onImageScaleChange={isPdf || isImage ? setImageScale : undefined}
        cropMode={isImage ? cropMode : undefined}
        onCropToggle={isImage ? () => setCropMode((v) => !v) : undefined}
        problemsSlot={
          !isPdf &&
          !isImage &&
          !isLargeFileNotLoaded &&
          diagnostics.length > 0 ? (
            <ProblemsPopover
              diagnostics={diagnostics}
              fileName={activeFile?.relativePath ?? "main.tex"}
              aiFixAvailable={lintAiAvailable}
              onNavigate={(from) => {
                const view = viewRef.current;
                if (!view) return;
                view.dispatch({
                  selection: { anchor: from },
                  effects: EditorView.scrollIntoView(from, { y: "center" }),
                });
                view.focus();
              }}
              onFixWithAi={(message, line) => {
                void handleFixLintWithAi(message, line);
              }}
              onFixSpanWithAi={(d) => {
                if (!activeFile?.content) return;
                const from = Math.min(d.from, d.to);
                const to = Math.max(d.from, d.to);
                const selectedText = activeFile.content.slice(from, to);
                if (!selectedText.trim()) return;
                const selection: InlineEditSelection = {
                  filePath: activeFile.relativePath,
                  absolutePath: activeFile.absolutePath,
                  content: activeFile.content,
                  from,
                  to,
                  selectedText,
                  contextLabel: `@${activeFile.relativePath}:${d.line}`,
                };
                void runSelectionInlineEdit(
                  "edit",
                  `Fix this LaTeX error: ${d.message}`,
                  selection,
                  "Fix ready — review the change",
                );
              }}
              onFixAllWithAi={() => {
                void handleFixAllLintWithAi();
              }}
              onFixWithChat={(message, line) => {
                const fileName = activeFile?.relativePath ?? "main.tex";
                const ctx = `[Lint error in ${fileName}:${line}]\n[Error: ${message}]`;
                useClaudeChatStore
                  .getState()
                  .sendPrompt(`${ctx}\n\nFix this lint error.`);
              }}
              onFixAllWithChat={() => {
                const fileName = activeFile?.relativePath ?? "main.tex";
                const errorList = diagnostics
                  .map((d) => `- ${fileName}:${d.line} — ${d.message}`)
                  .join("\n");
                useClaudeChatStore
                  .getState()
                  .sendPrompt(
                    `[Lint errors in ${fileName}]\n${errorList}\n\nFix all these lint errors.`,
                  );
              }}
            />
          ) : undefined
        }
      />
      {/* Text-editor-only panels */}
      {!isPdf && !isImage && !isLargeFileNotLoaded && isSearchOpen && (
        <SearchPanel
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onClose={() => {
            setIsSearchOpen(false);
            setSearchQuery("");
            viewRef.current?.focus();
          }}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          matchCount={matchCount}
          currentMatch={currentMatch}
        />
      )}
      {!isPdf && !isImage && !isLargeFileNotLoaded && reviewingSnapshot && (
        <div className="flex h-9 shrink-0 items-center justify-between border-border border-b bg-amber-500/10 px-3">
          <div className="flex items-center gap-2 text-xs">
            <RotateCcwIcon className="size-3.5 text-amber-600 dark:text-amber-400" />
            <span className="font-medium text-amber-700 dark:text-amber-300">
              Reviewing history
            </span>
            <span className="text-muted-foreground">
              {reviewingSnapshot.message.replace(/^\[.*?\]\s*/, "")} &middot;{" "}
              {reviewingSnapshot.id.slice(0, 7)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleHistoryRestore}
            >
              <RotateCcwIcon className="size-3" />
              Restore
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => {
                setHistoryLabelDialogOpen(true);
                setHistoryLabelValue("");
              }}
            >
              <TagIcon className="size-3" />
              Label
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleHistoryCopySha}
            >
              <CopyIcon className="size-3" />
              SHA
            </Button>
            {projectRoot && historyDiffResult && trackChangesMeta && (
              <>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <TrackChangesActions
                  projectRoot={projectRoot}
                  diffs={historyDiffResult}
                  meta={trackChangesMeta}
                  variant="compact"
                  className="flex items-center gap-0.5"
                />
              </>
            )}
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={handleHistoryClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
      {/* Main content area — single wrapper keeps ClaudeChatDrawer stable */}
      <div
        ref={isPdf || isImage ? undefined : parentRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {/* PDF content */}
        {isPdf && activeFile && (
          <InlinePdfContent
            file={activeFile}
            imageScale={imageScale}
            onImageScaleChange={setImageScale}
          />
        )}
        {/* Image content */}
        {isImage && activeFile && (
          <ImagePreview
            file={activeFile}
            scale={imageScale}
            onScaleChange={setImageScale}
            cropMode={cropMode}
            onCropModeChange={setCropMode}
          />
        )}
        {/* Large file warning */}
        {isLargeFileNotLoaded && activeFile && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="max-w-md rounded-lg border border-border bg-card/50 p-6 shadow-sm">
              <p className="mb-1 font-medium text-foreground text-sm">
                {activeFile.name}
              </p>
              <p className="mb-4 text-muted-foreground text-xs">
                This file is large (
                {activeFile.fileSize != null
                  ? `${(activeFile.fileSize / (1024 * 1024)).toFixed(1)} MB`
                  : "unknown size"}
                ). Opening it may slow down the editor.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadFileContent(activeFile.id)}
              >
                Open Anyway
              </Button>
            </div>
          </div>
        )}
        {/* Text editor content */}
        {!isPdf && !isImage && !isLargeFileNotLoaded && (
          <>
            <div
              ref={containerRef}
              className={reviewingSnapshot ? "hidden" : "absolute inset-0"}
            />
            {isImageDropActive && !reviewingSnapshot && (
              <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-primary border-dashed bg-primary/10 backdrop-blur-[1px]">
                <span className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm shadow-lg">
                  Drop image to insert as a figure
                </span>
              </div>
            )}
            {reviewingSnapshot && historyDiffResult && (
              <HistoryDiffView diffs={historyDiffResult} />
            )}
            {toolbarPosition &&
              selectionLabel &&
              !isMergeActiveRef.current &&
              !isSearchOpen &&
              !inlineEditPending && (
                <SelectionToolbar
                  position={toolbarPosition}
                  contextLabel={selectionLabel}
                  actions={editorToolbarActions}
                  onSendPrompt={handleToolbarSendPrompt}
                  onAction={handleToolbarAction}
                  onDismiss={handleToolbarDismiss}
                  resumeBulletAdjust={resumeBulletAdjust}
                />
              )}
            {inlineEditPending && toolbarPosition && (
              <div
                className="absolute z-30 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-xl"
                style={{
                  top: toolbarPosition.top,
                  left: toolbarPosition.left,
                }}
              >
                <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span className="text-muted-foreground">
                  Rewriting selection…
                </span>
              </div>
            )}
            {composerState?.open && (
              <CommentComposer
                open={composerState.open}
                mode={composerState.mode}
                quotedText={composerState.anchor.quoted_text}
                initialReplacement={
                  composerState.mode === "suggestion"
                    ? composerState.anchor.quoted_text
                    : undefined
                }
                onCancel={() => {
                  setComposerState(null);
                  setSelectionRange(null);
                }}
                onSubmit={async ({ comment, replacement }) => {
                  const snap = composerState;
                  if (!snap) return;
                  try {
                    await useCommentsStore.getState().addComment({
                      filePath: snap.filePath,
                      anchor: snap.anchor,
                      type: snap.mode,
                      author: "user",
                      comment,
                      proposedReplacement:
                        snap.mode === "suggestion" ? replacement : null,
                    });
                  } catch (e) {
                    log.error("add comment failed", { error: String(e) });
                  } finally {
                    setComposerState(null);
                    setSelectionRange(null);
                  }
                }}
              />
            )}
            {activeFileChange && mergeChunkInfo.total > 0 && (
              <div className="absolute top-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-background/95 px-2 py-1 shadow-lg backdrop-blur-sm">
                <span className="px-1 font-mono text-muted-foreground text-xs">
                  ±&nbsp;{mergeChunkInfo.current}/{mergeChunkInfo.total}
                </span>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <button
                  onClick={() =>
                    goToChunk(
                      mergeChunkInfo.current <= 1
                        ? mergeChunkInfo.total - 1
                        : mergeChunkInfo.current - 2,
                    )
                  }
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="Previous change"
                  aria-label="Previous change"
                >
                  <ChevronUpIcon className="size-3.5" />
                </button>
                <button
                  onClick={() =>
                    goToChunk(
                      mergeChunkInfo.current >= mergeChunkInfo.total
                        ? 0
                        : mergeChunkInfo.current,
                    )
                  }
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="Next change"
                  aria-label="Next change"
                >
                  <ChevronDownIcon className="size-3.5" />
                </button>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <button
                  onClick={acceptCurrentChunk}
                  className="rounded p-0.5 text-emerald-500 transition-colors hover:bg-emerald-500/10"
                  title="Accept this change"
                  aria-label="Accept this change"
                >
                  <CheckIcon className="size-3.5" />
                </button>
                <button
                  onClick={rejectCurrentChunk}
                  className="rounded p-0.5 text-destructive transition-colors hover:bg-destructive/10"
                  title="Reject this change"
                  aria-label="Reject this change"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            )}
          </>
        )}
        {/* Chat drawer — single stable instance across all file types */}
        <ClaudeChatDrawer />
      </div>
      {/* Text-editor-only bottom panels */}
      {!isPdf && !isImage && !isLargeFileNotLoaded && activeFileChange && (
        <ProposedChangesPanel
          change={activeFileChange}
          allChanges={proposedChanges}
          changeIndex={proposedChanges.findIndex(
            (c) => c.filePath === activeFile?.relativePath,
          )}
          totalChanges={proposedChanges.length}
          onKeep={() => handleKeepAllRef.current()}
          onUndo={() => handleUndoAllRef.current()}
          onKeepAllFiles={() => handleKeepAllFilesRef.current()}
          onUndoAllFiles={() => handleUndoAllFilesRef.current()}
          onSelectFile={(relativePath) =>
            useDocumentStore.getState().setActiveFile(relativePath)
          }
        />
      )}
      {/* Live document statistics */}
      {!isPdf &&
        !isImage &&
        !isLargeFileNotLoaded &&
        !reviewingSnapshot &&
        activeFile && (
          <>
            <EditorAiSuggestions content={activeFileContent ?? ""} />
            <EditorStatusBar content={activeFileContent ?? ""} />
          </>
        )}
      {/* History label dialog */}
      <Dialog
        open={historyLabelDialogOpen}
        onOpenChange={setHistoryLabelDialogOpen}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Label</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g. Draft v1"
              value={historyLabelValue}
              onChange={(e) => setHistoryLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleHistoryAddLabel();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setHistoryLabelDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleHistoryAddLabel}
              disabled={!historyLabelValue.trim()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Inline PDF Content (data loading + MuPDF PdfViewer) ───

function InlinePdfContent({
  file,
  imageScale,
  onImageScaleChange,
}: {
  file: ProjectFile;
  imageScale: number;
  onImageScaleChange: (scale: number) => void;
}) {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitted, setFitted] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPdfData(null);
    setError(null);
    setFitted(false);

    readFile(file.absolutePath)
      .then((data) => {
        if (!cancelled) setPdfData(new Uint8Array(data));
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [file.absolutePath]);

  const handleFirstPageSize = useCallback(
    (pageWidth: number) => {
      const containerWidth = wrapperRef.current?.clientWidth;
      if (!containerWidth || !onImageScaleChange) return;
      const fitScale = (containerWidth - 32) / pageWidth; // 32px padding
      onImageScaleChange(Math.max(0.25, Math.min(2, fitScale)));
      setFitted(true);
    },
    [onImageScaleChange],
  );

  if (pdfData) {
    return (
      <div
        ref={wrapperRef}
        className="flex min-h-0 flex-1 flex-col"
        style={{ opacity: fitted ? 1 : 0 }}
      >
        <PdfViewer
          data={pdfData}
          scale={imageScale}
          onScaleChange={onImageScaleChange}
          onFirstPageSize={handleFirstPageSize}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Failed to load PDF: {error}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
      Loading PDF...
    </div>
  );
}

// ─── History Diff View (git-diff style combined view) ───

function HistoryDiffView({ diffs }: { diffs: FileDiff[] }) {
  return (
    <div className="absolute inset-0 overflow-y-auto bg-background font-mono text-xs leading-relaxed">
      {diffs.map((diff) => (
        <div key={diff.file_path} className="border-border border-b">
          {/* File header */}
          <div className="sticky top-0 z-10 flex items-center gap-2 border-border border-b bg-muted/80 px-4 py-1.5 backdrop-blur-sm">
            <span
              className={
                diff.status === "added"
                  ? "font-bold text-green-600 dark:text-green-400"
                  : diff.status === "deleted"
                    ? "font-bold text-red-600 dark:text-red-400"
                    : "font-bold text-blue-600 dark:text-blue-400"
              }
            >
              {diff.status === "added"
                ? "+"
                : diff.status === "deleted"
                  ? "−"
                  : "~"}
            </span>
            <span className="font-medium text-foreground">
              {diff.file_path}
            </span>
            <span className="text-muted-foreground">({diff.status})</span>
          </div>
          {/* Diff lines */}
          <DiffLines diff={diff} />
        </div>
      ))}
      {diffs.length === 0 && (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          No changes in this snapshot
        </div>
      )}
    </div>
  );
}

function DiffLines({ diff }: { diff: FileDiff }) {
  const oldLines = diff.old_content?.split("\n") ?? [];
  const newLines = diff.new_content?.split("\n") ?? [];

  if (diff.status === "added") {
    return (
      <div className="px-1">
        {newLines.map((line, i) => (
          <div key={i} className="flex bg-green-500/10">
            <span className="w-12 shrink-0 select-none pr-2 text-right text-green-500/50">
              {i + 1}
            </span>
            <span className="mr-1 select-none text-green-500/50">+</span>
            <span className="text-green-700 dark:text-green-400">
              {line || " "}
            </span>{" "}
          </div>
        ))}
      </div>
    );
  }

  if (diff.status === "deleted") {
    return (
      <div className="px-1">
        {oldLines.map((line, i) => (
          <div key={i} className="flex bg-red-500/10">
            <span className="w-12 shrink-0 select-none pr-2 text-right text-red-500/50">
              {i + 1}
            </span>
            <span className="mr-1 select-none text-red-500/50">−</span>
            <span className="text-red-700 line-through dark:text-red-400">
              {line || " "}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Modified: compute unified diff with context
  const hunks = computeUnifiedHunks(oldLines, newLines, 3);

  return (
    <div className="px-1">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          {/* Hunk header */}
          <div className="bg-blue-500/10 px-1 text-blue-600 dark:text-blue-400">
            @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount}{" "}
            @@
          </div>
          {mergeDelAddPairs(hunk.lines).map((entry, li) => (
            <div
              key={li}
              className={
                entry.wordPair
                  ? "flex bg-amber-500/10"
                  : entry.line.type === "del"
                    ? "flex bg-red-500/10"
                    : entry.line.type === "add"
                      ? "flex bg-green-500/10"
                      : "flex"
              }
            >
              <span
                className={`w-12 shrink-0 select-none pr-2 text-right ${
                  entry.line.type === "del"
                    ? "text-red-500/50"
                    : entry.line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/50"
                }`}
              >
                {entry.line.type !== "add" ? entry.line.oldNum : ""}
              </span>
              <span
                className={`w-12 shrink-0 select-none pr-2 text-right ${
                  entry.line.type === "del"
                    ? "text-red-500/50"
                    : entry.line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/50"
                }`}
              >
                {entry.line.type !== "del" ? entry.line.newNum : ""}
              </span>
              <span
                className={`mr-1 select-none ${
                  entry.wordPair
                    ? "text-amber-600/50"
                    : entry.line.type === "del"
                      ? "text-red-500/50"
                      : entry.line.type === "add"
                        ? "text-green-500/50"
                        : "text-muted-foreground/30"
                }`}
              >
                {entry.wordPair
                  ? "~"
                  : entry.line.type === "del"
                    ? "−"
                    : entry.line.type === "add"
                      ? "+"
                      : " "}
              </span>
              {entry.wordPair ? (
                <InlineWordDiff
                  oldLine={entry.wordPair.old}
                  newLine={entry.wordPair.new}
                />
              ) : (
                <span
                  className={
                    entry.line.type === "del"
                      ? "text-red-700 line-through dark:text-red-400"
                      : entry.line.type === "add"
                        ? "text-green-700 dark:text-green-400"
                        : "text-muted-foreground"
                  }
                >
                  {entry.line.text || " "}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface DiffLine {
  type: "ctx" | "del" | "add";
  text: string;
  oldNum?: number;
  newNum?: number;
}

function mergeDelAddPairs(lines: DiffLine[]): Array<{
  line: DiffLine;
  wordPair?: { old: string; new: string };
}> {
  const rows: Array<{
    line: DiffLine;
    wordPair?: { old: string; new: string };
  }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "del" && lines[i + 1]?.type === "add") {
      const next = lines[i + 1];
      rows.push({
        line: {
          type: "ctx",
          text: "",
          oldNum: line.oldNum,
          newNum: next.newNum,
        },
        wordPair: { old: line.text, new: next.text },
      });
      i += 2;
    } else {
      rows.push({ line });
      i++;
    }
  }
  return rows;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

function computeUnifiedHunks(
  oldLines: string[],
  newLines: string[],
  context: number,
): Hunk[] {
  // Simple line-by-line diff to find changed regions
  const ops: {
    type: "eq" | "del" | "add";
    oldIdx?: number;
    newIdx?: number;
    text: string;
  }[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j, text: oldLines[i] });
      i++;
      j++;
    } else {
      // Find the next matching line
      let foundOld = -1;
      let foundNew = -1;
      const searchLimit = Math.min(
        50,
        Math.max(oldLines.length - i, newLines.length - j),
      );
      for (let look = 1; look <= searchLimit; look++) {
        if (
          i + look < oldLines.length &&
          j < newLines.length &&
          oldLines[i + look] === newLines[j]
        ) {
          foundOld = i + look;
          break;
        }
        if (
          j + look < newLines.length &&
          i < oldLines.length &&
          newLines[j + look] === oldLines[i]
        ) {
          foundNew = j + look;
          break;
        }
      }

      if (foundOld >= 0) {
        // Delete lines from old until match
        while (i < foundOld) {
          ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
          i++;
        }
      } else if (foundNew >= 0) {
        // Add lines from new until match
        while (j < foundNew) {
          ops.push({ type: "add", newIdx: j, text: newLines[j] });
          j++;
        }
      } else {
        // No match found nearby, emit del+add
        if (i < oldLines.length) {
          ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
          i++;
        }
        if (j < newLines.length) {
          ops.push({ type: "add", newIdx: j, text: newLines[j] });
          j++;
        }
      }
    }
  }

  // Group into hunks with context lines
  const changedIndices = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.type !== "eq") {
      for (
        let c = Math.max(0, idx - context);
        c <= Math.min(ops.length - 1, idx + context);
        c++
      ) {
        changedIndices.add(c);
      }
    }
  });

  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (let idx = 0; idx < ops.length; idx++) {
    if (!changedIndices.has(idx)) {
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
      continue;
    }

    const op = ops[idx];
    if (!currentHunk) {
      const oldStart =
        op.type !== "add"
          ? (op.oldIdx ?? 0) + 1
          : (ops[idx + 1]?.oldIdx ?? 0) + 1;
      const newStart =
        op.type !== "del"
          ? (op.newIdx ?? 0) + 1
          : (ops[idx + 1]?.newIdx ?? 0) + 1;
      currentHunk = { oldStart, oldCount: 0, newStart, newCount: 0, lines: [] };
    }

    if (op.type === "eq") {
      currentHunk.lines.push({
        type: "ctx",
        text: op.text,
        oldNum: (op.oldIdx ?? 0) + 1,
        newNum: (op.newIdx ?? 0) + 1,
      });
      currentHunk.oldCount++;
      currentHunk.newCount++;
    } else if (op.type === "del") {
      currentHunk.lines.push({
        type: "del",
        text: op.text,
        oldNum: (op.oldIdx ?? 0) + 1,
      });
      currentHunk.oldCount++;
    } else {
      currentHunk.lines.push({
        type: "add",
        text: op.text,
        newNum: (op.newIdx ?? 0) + 1,
      });
      currentHunk.newCount++;
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return hunks;
}
