import { type FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpIcon, SquareIcon, XIcon, FileTextIcon, FileCodeIcon, FileIcon, ImageIcon, FileSpreadsheetIcon, PaperclipIcon } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useClaudeChatStore, offsetToLineCol } from "@/stores/claude-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

interface PinnedContext {
  label: string;       // @file:line:col-line:col
  filePath: string;
  selectedText: string;
}

function getFileIcon(file: ProjectFile) {
  if (file.type === "image") return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "pdf") return <FileSpreadsheetIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "style") return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "other") return <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

export const ChatComposer: FC = () => {
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const cancelExecution = useClaudeChatStore((s) => s.cancelExecution);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Pinned contexts — supports multiple files/selections
  const [pinnedContexts, setPinnedContexts] = useState<PinnedContext[]>([]);

  // File drop state
  const [isDragOver, setIsDragOver] = useState(false);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<ProjectFile[]>([]);
  const mentionRef = useRef<HTMLDivElement>(null);

  // Watch selection changes to auto-pin context
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  const currentContextLabel = useMemo(() => {
    if (!selectionRange) return null;
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return null;
    const start = offsetToLineCol(file.content, selectionRange.start);
    const end = offsetToLineCol(file.content, selectionRange.end);
    return `@${file.relativePath}:${start.line}:${start.col}-${end.line}:${end.col}`;
  }, [selectionRange, activeFileId, files]);

  // Auto-pin when a new selection is made
  useEffect(() => {
    if (!selectionRange || !currentContextLabel) return;
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return;
    // Replace any existing selection-based context (keep file contexts)
    setPinnedContexts((prev) => {
      const filtered = prev.filter((c) => !c.label.includes(":") || c.label.startsWith("@attachments/"));
      return [
        ...filtered,
        {
          label: currentContextLabel,
          filePath: file.relativePath,
          selectedText: file.content!.slice(selectionRange.start, selectionRange.end),
        },
      ];
    });
  }, [selectionRange, currentContextLabel, activeFileId, files]);

  // Compute @ mention matches
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    const q = mentionQuery.toLowerCase();
    const matched = files
      .filter((f) => f.relativePath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
      .slice(0, 8);
    setMentionFiles(matched);
    setMentionIndex(0);
  }, [mentionQuery, files]);

  const selectMention = useCallback((file: ProjectFile) => {
    // Replace @query with empty and pin the file as context
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    // Find the @ position before cursor
    const textBefore = input.slice(0, cursorPos);
    const atIndex = textBefore.lastIndexOf("@");
    if (atIndex === -1) return;
    const newInput = input.slice(0, atIndex) + input.slice(cursorPos);
    setInput(newInput);
    setMentionQuery(null);

    // Pin the whole file as context
    const isTextFile = file.type === "tex" || file.type === "bib" || file.type === "style" || file.type === "other";
    setPinnedContexts((prev) => [
      ...prev,
      {
        label: `@${file.relativePath}`,
        filePath: file.relativePath,
        selectedText: isTextFile
          ? (file.content ?? "")
          : `[Referenced file: ${file.relativePath} (${file.type} file)]`,
      },
    ]);

    // Refocus textarea
    setTimeout(() => textarea.focus(), 0);
  }, [input]);

  // Handle file drops — guard against duplicate calls from stale HMR listeners
  const isProcessingDropRef = useRef(false);
  const handleFileDropRef = useRef<(paths: string[]) => Promise<void>>(async () => {});
  handleFileDropRef.current = async (paths: string[]) => {
    if (!projectRoot || paths.length === 0) return;
    if (isProcessingDropRef.current) return;
    isProcessingDropRef.current = true;

    try {
      // Import files to attachments/ folder — returns actual (deduplicated) relative paths
      const importedPaths = await importFiles(paths, "attachments");

      // Pin each file as context
      const storeFiles = useDocumentStore.getState().files;
      const newContexts: PinnedContext[] = [];

      for (const relativePath of importedPaths) {
        const imported = storeFiles.find((f) => f.relativePath === relativePath);

        if (imported) {
          const isText = imported.type === "tex" || imported.type === "bib" || imported.type === "style" || imported.type === "other";
          newContexts.push({
            label: `@${relativePath}`,
            filePath: relativePath,
            selectedText: isText
              ? (imported.content ?? "")
              : `[Attached file: ${relativePath} (${imported.type} file)]`,
          });
        } else {
          // File imported but type might be filtered out — still pin as reference
          newContexts.push({
            label: `@${relativePath}`,
            filePath: relativePath,
            selectedText: `[Attached file: ${relativePath}]`,
          });
        }
      }

      if (newContexts.length > 0) {
        setPinnedContexts((prev) => {
          // Deduplicate by label
          const existingLabels = new Set(prev.map((c) => c.label));
          const unique = newContexts.filter((c) => !existingLabels.has(c.label));
          return [...prev, ...unique];
        });
      }
    } finally {
      isProcessingDropRef.current = false;
    }
  };

  // Listen for Tauri drag-drop events (OS file drops)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter") {
          setIsDragOver(true);
        } else if (type === "drop") {
          setIsDragOver(false);
          // Skip if the sidebar already handled this drop (OS file dropped on sidebar file tree)
          if ((window as any).__sidebarHandledDrop) {
            console.log("[chat-drop] skipped — sidebar handled this drop");
            return;
          }
          const paths = (event.payload as { paths: string[] }).paths;
          if (paths?.length > 0) {
            await handleFileDropRef.current?.(paths);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Not in Tauri environment (dev mode), ignore
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    setMentionQuery(null);
    // Send with pinned context override
    if (pinnedContexts.length > 0) {
      const combinedLabel = pinnedContexts.map((c) => c.label).join(", ");
      const combinedText = pinnedContexts.map((c) => c.selectedText).join("\n\n---\n\n");
      sendPrompt(trimmed, {
        label: combinedLabel,
        filePath: pinnedContexts[0].filePath,
        selectedText: combinedText,
      });
    } else {
      sendPrompt(trimmed);
    }
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear pinned contexts after send
    setPinnedContexts([]);
  }, [input, isStreaming, sendPrompt, pinnedContexts]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // @ mention navigation
      if (mentionQuery !== null && mentionFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectMention(mentionFiles[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      // Backspace at start of empty input removes last pinned context
      if (e.key === "Backspace" && pinnedContexts.length > 0 && input === "") {
        e.preventDefault();
        setPinnedContexts((prev) => prev.slice(0, -1));
      }
    },
    [handleSend, pinnedContexts, input, mentionQuery, mentionFiles, mentionIndex, selectMention],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);

      // Detect @ mention trigger
      const cursorPos = e.target.selectionStart;
      const textBefore = value.slice(0, cursorPos);
      // Match @ at start of input or after a space
      const atMatch = textBefore.match(/(?:^|[\s])@([^\s]*)$/);
      if (atMatch) {
        setMentionQuery(atMatch[1]);
      } else {
        setMentionQuery(null);
      }

      // Auto-resize
      const el = e.target;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    },
    [],
  );

  // Scroll active mention into view
  useEffect(() => {
    if (mentionRef.current) {
      const active = mentionRef.current.querySelector("[data-active=true]");
      active?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionIndex]);

  return (
    <div className="relative shrink-0 p-3">
      {/* @ mention dropdown */}
      {mentionQuery !== null && mentionFiles.length > 0 && (
        <div
          ref={mentionRef}
          className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
        >
          {mentionFiles.map((file, i) => {
            const parts = file.relativePath.split("/");
            const fileName = parts.pop()!;
            const dirPath = parts.length > 0 ? parts.join("/") + "/" : "";
            return (
              <button
                key={file.id}
                data-active={i === mentionIndex}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                  i === mentionIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent textarea blur
                  selectMention(file);
                }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                {getFileIcon(file)}
                <span className="truncate font-mono text-sm">{fileName}</span>
                {dirPath && (
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{dirPath}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div
        className={cn(
          "flex w-full flex-col rounded-2xl border border-input bg-muted/30 transition-colors focus-within:border-ring focus-within:bg-background",
          isDragOver && "border-ring bg-accent/20",
        )}
      >
        {/* Pinned context chips */}
        {pinnedContexts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 px-4 pt-3 pb-0">
            {pinnedContexts.map((ctx, i) => (
              <span
                key={`${ctx.label}-${i}`}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {ctx.label}
                <button
                  onClick={() => setPinnedContexts((prev) => prev.filter((_, idx) => idx !== i))}
                  className="ml-0.5 rounded-sm p-0.5 transition-colors hover:bg-muted-foreground/20"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {isDragOver ? (
          <div className="flex min-h-10 items-center justify-center px-4 py-3 text-sm text-muted-foreground">
            <PaperclipIcon className="mr-2 size-4" />
            Drop files to attach
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anything (@ to mention, drop to attach)"
            className="max-h-40 min-h-10 w-full resize-none bg-transparent px-4 py-2 text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
            rows={1}
          />
        )}

        <div className="flex items-center justify-end px-2 pb-2">
          {isStreaming ? (
            <TooltipIconButton
              tooltip="Stop"
              side="top"
              variant="secondary"
              size="icon"
              className="size-8 rounded-full"
              onClick={cancelExecution}
            >
              <SquareIcon className="size-3 fill-current" />
            </TooltipIconButton>
          ) : (
            <TooltipIconButton
              tooltip="Send"
              side="top"
              variant="default"
              size="icon"
              className="size-8 rounded-full"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              <ArrowUpIcon className="size-4" />
            </TooltipIconButton>
          )}
        </div>
      </div>
    </div>
  );
};
