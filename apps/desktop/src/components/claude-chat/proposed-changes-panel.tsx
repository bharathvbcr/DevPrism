import { type FC, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Columns2Icon,
  FileIcon,
  ListIcon,
  X,
} from "lucide-react";
import { type ProposedChange } from "@/stores/proposed-changes-store";
import { lineDiff, diffStats } from "@/lib/line-diff";
import { toDisplayDiffRows, type DisplayDiffRow } from "@/lib/diff-display";
import { InlineWordDiff } from "@/components/workspace/inline-word-diff";
import { cn } from "@/lib/utils";

type DiffViewMode = "unified" | "split";

interface ProposedChangesPanelProps {
  change: ProposedChange;
  allChanges: ProposedChange[];
  changeIndex: number;
  totalChanges: number;
  onKeep: () => void;
  onUndo: () => void;
  onKeepAllFiles?: () => void;
  onUndoAllFiles?: () => void;
  onSelectFile?: (relativePath: string) => void;
}

function DiffLinePrefix({ kind }: { kind: DisplayDiffRow["kind"] }) {
  return (
    <span className="w-4 shrink-0 select-none text-muted-foreground">
      {kind === "word"
        ? "~"
        : kind === "add"
          ? "+"
          : kind === "del"
            ? "−"
            : " "}
    </span>
  );
}

function UnifiedDiffView({ rows }: { rows: DisplayDiffRow[] }) {
  return (
    <pre className="min-w-full font-mono text-[11px] leading-relaxed">
      {rows.map((row, idx) => (
        <div
          key={idx}
          className={cn(
            "flex px-2",
            row.kind === "word" && "bg-amber-500/10",
            row.kind === "add" &&
              "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
            row.kind === "del" &&
              "bg-red-500/15 text-red-900 line-through dark:text-red-200",
          )}
        >
          <DiffLinePrefix kind={row.kind} />
          {row.kind === "word" ? (
            <InlineWordDiff oldLine={row.oldText} newLine={row.newText} />
          ) : (
            <span className="whitespace-pre-wrap break-words">
              {row.text || " "}
            </span>
          )}
        </div>
      ))}
    </pre>
  );
}

function SplitDiffView({ rows }: { rows: DisplayDiffRow[] }) {
  return (
    <div className="grid min-w-full grid-cols-2 divide-x divide-border/60 font-mono text-[11px] leading-relaxed">
      <div className="min-w-0">
        <div className="sticky top-0 border-border/60 border-b bg-muted/40 px-2 py-1 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
          Before
        </div>
        {rows.map((row, idx) => {
          if (row.kind === "add") return null;
          return (
            <div
              key={`l-${idx}`}
              className={cn(
                "flex px-2",
                row.kind === "del" &&
                  "bg-red-500/15 text-red-900 dark:text-red-200",
                row.kind === "word" && "bg-amber-500/10",
              )}
            >
              <DiffLinePrefix kind={row.kind === "word" ? "del" : row.kind} />
              <span
                className={cn(
                  "whitespace-pre-wrap break-words",
                  row.kind === "del" && "line-through",
                )}
              >
                {row.kind === "word" ? row.oldText : row.text || " "}
              </span>
            </div>
          );
        })}
      </div>
      <div className="min-w-0">
        <div className="sticky top-0 border-border/60 border-b bg-muted/40 px-2 py-1 font-sans text-[10px] text-muted-foreground uppercase tracking-wide">
          After
        </div>
        {rows.map((row, idx) => {
          if (row.kind === "del") return null;
          return (
            <div
              key={`r-${idx}`}
              className={cn(
                "flex px-2",
                row.kind === "add" &&
                  "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
                row.kind === "word" && "bg-amber-500/10",
              )}
            >
              <DiffLinePrefix kind={row.kind === "word" ? "add" : row.kind} />
              <span className="whitespace-pre-wrap break-words">
                {row.kind === "word" ? row.newText : row.text || " "}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ProposedChangesPanel: FC<ProposedChangesPanelProps> = ({
  change,
  allChanges,
  changeIndex,
  totalChanges,
  onKeep,
  onUndo,
  onKeepAllFiles,
  onUndoAllFiles,
  onSelectFile,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [showDiff, setShowDiff] = useState(true);
  const [diffMode, setDiffMode] = useState<DiffViewMode>("unified");
  const [confirmUndoAll, setConfirmUndoAll] = useState(false);
  const compactTitle = containerWidth > 0 && containerWidth < 680;
  const hideToolName = containerWidth > 0 && containerWidth < 920;
  const canSplit = containerWidth === 0 || containerWidth >= 520;
  const multipleFiles = totalChanges > 1;

  const rawDiff = useMemo(
    () => lineDiff(change.oldContent, change.newContent),
    [change.oldContent, change.newContent],
  );
  const diffRows = useMemo(() => toDisplayDiffRows(rawDiff), [rawDiff]);
  const stats = useMemo(() => diffStats(rawDiff), [rawDiff]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = () => setContainerWidth(element.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canSplit && diffMode === "split") setDiffMode("unified");
  }, [canSplit, diffMode]);

  // Reset the "Undo all" confirmation whenever the change set changes so a
  // stale confirm state can't carry over onto a different batch.
  useEffect(() => {
    setConfirmUndoAll(false);
  }, [totalChanges, allChanges.length]);

  // Auto-clear the confirmation prompt shortly after it appears.
  useEffect(() => {
    if (!confirmUndoAll) return;
    const timer = setTimeout(() => setConfirmUndoAll(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmUndoAll]);

  const keepLabel = multipleFiles ? "Keep file" : "Keep";
  const undoLabel = multipleFiles ? "Undo file" : "Undo";

  return (
    <div
      ref={containerRef}
      className="flex min-w-0 shrink-0 flex-col overflow-hidden border-border border-t bg-muted/50"
    >
      <div className="grid min-h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-1.5">
        <div className="flex shrink-0 items-center gap-2 text-sm">
          <span className="whitespace-nowrap font-medium text-foreground">
            {compactTitle ? "Changes" : "Proposed Changes"}
          </span>
          {multipleFiles && (
            <span className="shrink-0 whitespace-nowrap rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-violet-600 text-xs dark:text-violet-400">
              {changeIndex + 1}/{totalChanges} files
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden text-sm">
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            className="flex min-w-0 items-center gap-1 text-left text-muted-foreground transition-colors hover:text-foreground"
            title={showDiff ? "Hide diff preview" : "Show diff preview"}
            aria-expanded={showDiff}
          >
            {showDiff ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronUp className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{change.filePath}</span>
          </button>
          {!hideToolName && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {change.toolName}
            </span>
          )}
          {stats.added > 0 && (
            <span className="shrink-0 text-green-500 text-xs">
              +{stats.added}
            </span>
          )}
          {stats.removed > 0 && (
            <span className="shrink-0 text-red-500 text-xs">
              −{stats.removed}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {showDiff && canSplit && diffRows.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setDiffMode((m) => (m === "unified" ? "split" : "unified"))
              }
              className={cn(
                "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                diffMode === "split" && "bg-muted text-foreground",
              )}
              title={
                diffMode === "unified" ? "Side-by-side diff" : "Unified diff"
              }
              aria-label={
                diffMode === "unified"
                  ? "Switch to side-by-side diff"
                  : "Switch to unified diff"
              }
            >
              {diffMode === "unified" ? (
                <Columns2Icon className="size-3.5" />
              ) : (
                <ListIcon className="size-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onKeep}
            className="flex items-center justify-center gap-1 rounded-md bg-green-600/20 px-2.5 py-1 text-green-600 text-xs transition-colors hover:bg-green-600/30 dark:text-green-400"
            title={keepLabel}
            aria-label={keepLabel}
          >
            <Check className="size-3.5" />
            <span className="whitespace-nowrap">{keepLabel}</span>
            <kbd className="ml-1 rounded bg-green-600/20 px-1 py-0.5 font-mono text-[10px]">
              ⌘Y
            </kbd>
          </button>
          <button
            type="button"
            onClick={onUndo}
            className="flex items-center justify-center gap-1 rounded-md bg-red-600/20 px-2.5 py-1 text-red-600 text-xs transition-colors hover:bg-red-600/30 dark:text-red-400"
            title={undoLabel}
            aria-label={undoLabel}
          >
            <X className="size-3.5" />
            <span className="whitespace-nowrap">{undoLabel}</span>
            <kbd className="ml-1 rounded bg-red-600/20 px-1 py-0.5 font-mono text-[10px]">
              ⌘N
            </kbd>
          </button>
        </div>
      </div>

      {multipleFiles && onSelectFile && (
        <div className="flex gap-1 overflow-x-auto border-border/60 border-t px-3 py-1.5">
          {allChanges.map((item, idx) => {
            const active = item.id === change.id;
            const fileName =
              item.filePath.split(/[/\\]/).pop() ?? item.filePath;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectFile(item.filePath)}
                className={cn(
                  "flex max-w-[10rem] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
                  active
                    ? "border-violet-500/40 bg-violet-500/10 text-foreground"
                    : "border-border/60 bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title={item.filePath}
              >
                <FileIcon className="size-3 shrink-0" />
                <span className="truncate">{fileName}</span>
                <span className="shrink-0 text-[10px] opacity-60">
                  {idx + 1}
                </span>
              </button>
            );
          })}
          {onKeepAllFiles && onUndoAllFiles && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onKeepAllFiles}
                className="rounded-md px-2 py-1 text-[10px] text-green-600 transition-colors hover:bg-green-600/10 dark:text-green-400"
              >
                Keep all {totalChanges}
              </button>
              {confirmUndoAll ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmUndoAll(false);
                      onUndoAllFiles();
                    }}
                    className="rounded-md px-2 py-1 font-medium text-destructive text-xs transition-colors hover:bg-destructive/10"
                    aria-label={`Confirm undo all ${totalChanges} files`}
                  >
                    Undo all {totalChanges}?
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmUndoAll(false)}
                    className="rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted"
                    aria-label="Cancel undo all"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmUndoAll(true)}
                  className="rounded-md px-2 py-1 text-red-600 text-xs transition-colors hover:bg-red-600/10 dark:text-red-400"
                  aria-label={`Undo all ${totalChanges} files`}
                >
                  Undo all {totalChanges}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showDiff && diffRows.length > 0 && (
        <div className="max-h-56 min-h-0 overflow-auto border-border/60 border-t bg-background/80">
          {diffMode === "split" && canSplit ? (
            <SplitDiffView rows={diffRows} />
          ) : (
            <UnifiedDiffView rows={diffRows} />
          )}
        </div>
      )}

      {showDiff && diffRows.length === 0 && (
        <div className="border-border/60 border-t px-3 py-2 text-muted-foreground text-xs">
          No line-level diff available for this change.
        </div>
      )}
    </div>
  );
};
