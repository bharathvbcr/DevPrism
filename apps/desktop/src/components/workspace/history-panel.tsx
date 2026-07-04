import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  HistoryIcon,
  LoaderIcon,
  TagIcon,
  RotateCcwIcon,
  CopyIcon,
  PlusIcon,
  XIcon,
  FileDownIcon,
  FileTextIcon,
  Loader2Icon,
  MoreVerticalIcon,
} from "lucide-react";
import { useHistoryStore, type SnapshotInfo } from "@/stores/history-store";
import { useDocumentStore } from "@/stores/document-store";
import { snapshotTypeLabel, isAgentSnapshotMessage } from "@/lib/chat-labels";
import { useSettingsStore } from "@/stores/settings-store";
import {
  exportTrackedTex,
  previewTrackedChangesPdf,
  toTexFileDiffs,
} from "@/lib/track-changes-export";
import {
  buildTrackChangesMeta,
  linearizeSnapshots,
} from "@/lib/track-changes-meta";
import { toast } from "sonner";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import { cn } from "@/lib/utils";
import { HistoryPanelSkeleton } from "./history-panel-skeleton";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// ─── Helpers ───

function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function snapshotTypeBadgeColor(message: string): string {
  if (isAgentSnapshotMessage(message))
    return "bg-violet-500/15 text-violet-600 dark:text-violet-400";
  if (message.startsWith("[restore]"))
    return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  if (message.startsWith("[manual]"))
    return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
  if (message.startsWith("[compile]"))
    return "bg-green-500/15 text-green-600 dark:text-green-400";
  return "bg-muted text-muted-foreground";
}

// ─── Panel ───

export function HistoryPanel({ maxHeight }: { maxHeight?: string }) {
  const _nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const snapshots = useHistoryStore((s) => s.snapshots);
  const isLoading = useHistoryStore((s) => s.isLoading);
  const isRestoring = useHistoryStore((s) => s.isRestoring);
  const reviewingSnapshot = useHistoryStore((s) => s.reviewingSnapshot);
  const init = useHistoryStore((s) => s.init);
  const loadSnapshots = useHistoryStore((s) => s.loadSnapshots);
  const loadMoreSnapshots = useHistoryStore((s) => s.loadMoreSnapshots);
  const loadDiff = useHistoryStore((s) => s.loadDiff);
  const startReview = useHistoryStore((s) => s.startReview);
  const restoreSnapshot = useHistoryStore((s) => s.restoreSnapshot);
  const addLabel = useHistoryStore((s) => s.addLabel);
  const removeLabel = useHistoryStore((s) => s.removeLabel);
  const openProject = useDocumentStore((s) => s.openProject);

  // Linear history (restore-collapsed). Shared with the editor's track-changes
  // label via linearizeSnapshots so the two never diverge.
  const linearSnapshots = useMemo(
    () => linearizeSnapshots(snapshots),
    [snapshots],
  );

  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelTargetId, setLabelTargetId] = useState<string | null>(null);
  const [labelValue, setLabelValue] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [trackChangesBusyId, setTrackChangesBusyId] = useState<string | null>(
    null,
  );

  const hasTexChanges = useCallback((snap: SnapshotInfo) => {
    return snap.changed_files.some((f) => f.toLowerCase().endsWith(".tex"));
  }, []);

  const handleTrackChanges = useCallback(
    async (snap: SnapshotInfo, action: "export" | "preview") => {
      if (!projectRoot) return;
      const idx = linearSnapshots.findIndex((s) => s.id === snap.id);
      const parent = linearSnapshots[idx + 1];
      if (!parent) {
        showWorkspaceError(
          "Track changes unavailable",
          "No previous snapshot to compare against.",
          { dedupeKey: "history-track-changes-no-parent" },
        );
        return;
      }
      setTrackChangesBusyId(snap.id);
      // Toast covers the diff-loading prep only. exportTrackedTex /
      // previewTrackedChangesPdf own their own loading/success/error toasts, so
      // once we hand off we dismiss this one to avoid stacked duplicates.
      const toastId = toast.loading("Loading changes…");
      let handedOff = false;
      try {
        await loadDiff(projectRoot, parent.id, snap.id);
        const diffResult = useHistoryStore.getState().diffResult;
        if (!diffResult?.length) {
          toast.dismiss(toastId);
          showWorkspaceError(
            "No changes found",
            "This snapshot has no .tex changes to export or preview.",
            { dedupeKey: "history-track-changes-empty" },
          );
          return;
        }
        const meta = buildTrackChangesMeta(parent, snap);
        const texDiffs = toTexFileDiffs(diffResult);
        handedOff = true;
        toast.dismiss(toastId);
        if (action === "export") {
          await exportTrackedTex(projectRoot, texDiffs, meta, "word");
        } else {
          await previewTrackedChangesPdf(projectRoot, texDiffs, meta, "word");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // previewTrackedChangesPdf already surfaced its own error toast; only
        // show one here for prep/export failures that wouldn't otherwise toast.
        if (!handedOff) {
          toast.dismiss(toastId);
          showWorkspaceError("Track changes failed", message, {
            dedupeKey: "history-track-changes",
          });
        } else if (action === "export") {
          showWorkspaceError("Export failed", message, {
            dedupeKey: "history-track-changes-export",
          });
        }
      } finally {
        setTrackChangesBusyId(null);
      }
    },
    [projectRoot, linearSnapshots, loadDiff],
  );

  // Init history when project opens
  useEffect(() => {
    if (!projectRoot) return;
    init(projectRoot)
      .then(() => loadSnapshots(projectRoot))
      .catch(console.error);
  }, [projectRoot, init, loadSnapshots]);

  // Infinite scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !projectRoot || isLoading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      loadMoreSnapshots(projectRoot);
    }
  }, [projectRoot, isLoading, loadMoreSnapshots]);

  // Click to show diff in editor
  const handleClick = useCallback(
    async (snap: SnapshotInfo) => {
      if (!projectRoot) return;
      // Toggle off if already reviewing this snapshot
      if (reviewingSnapshot?.id === snap.id) {
        useHistoryStore.getState().stopReview();
        return;
      }
      // Find parent snapshot (the one right after in the linear list)
      const idx = linearSnapshots.findIndex((s) => s.id === snap.id);
      const parent = linearSnapshots[idx + 1];
      if (parent) {
        await loadDiff(projectRoot, parent.id, snap.id);
        startReview(snap);
      }
    },
    [projectRoot, linearSnapshots, reviewingSnapshot, loadDiff, startReview],
  );

  const handleRestore = useCallback(
    async (snapshotId: string) => {
      if (!projectRoot) return;
      // Stop any active review
      useHistoryStore.getState().stopReview();
      await restoreSnapshot(projectRoot, snapshotId);
      // Re-open project and reload snapshot list
      await openProject(projectRoot);
      await loadSnapshots(projectRoot);
    },
    [projectRoot, restoreSnapshot, openProject, loadSnapshots],
  );

  const handleAddLabel = useCallback(async () => {
    const label = labelValue.trim();
    if (!label || !labelTargetId || !projectRoot) return;
    await addLabel(projectRoot, labelTargetId, label);
    setLabelDialogOpen(false);
    setLabelValue("");
    setLabelTargetId(null);
  }, [projectRoot, labelTargetId, labelValue, addLabel]);

  const openLabelDialog = useCallback((snapshotId: string) => {
    setLabelTargetId(snapshotId);
    setLabelValue("");
    setLabelDialogOpen(true);
  }, []);

  if (!projectRoot) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
        <p className="text-muted-foreground text-xs">
          Open a project to view history.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", maxHeight || "h-full")}>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <HistoryIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">History</span>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        {linearSnapshots.length === 0 && !isLoading ? (
          <div className="px-3 py-4 text-center text-muted-foreground text-xs">
            No history yet
          </div>
        ) : (
          <div className="py-0.5">
            {linearSnapshots.map((snap) => (
              <SnapshotRow
                key={snap.id}
                snapshot={snap}
                isSelected={reviewingSnapshot?.id === snap.id}
                isRestoring={isRestoring}
                trackChangesBusy={trackChangesBusyId === snap.id}
                canTrackChanges={hasTexChanges(snap)}
                onClick={() => handleClick(snap)}
                onRestore={() => setRestoreTarget(snap.id)}
                onAddLabel={() => openLabelDialog(snap.id)}
                onRemoveLabel={(label) =>
                  projectRoot && removeLabel(projectRoot, label)
                }
                onCopySha={() => navigator.clipboard.writeText(snap.id)}
                onExportTrackedTex={() => handleTrackChanges(snap, "export")}
                onPreviewTrackedPdf={() => handleTrackChanges(snap, "preview")}
              />
            ))}
          </div>
        )}

        {isLoading && linearSnapshots.length === 0 && (
          <HistoryPanelSkeleton rows={4} />
        )}

        {isLoading && linearSnapshots.length > 0 && (
          <div className="flex items-center justify-center py-2">
            <LoaderIcon className="size-3 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Label dialog */}
      <Dialog open={labelDialogOpen} onOpenChange={setLabelDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Label</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g. Draft v1"
              value={labelValue}
              onChange={(e) => setLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddLabel();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLabelDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddLabel} disabled={!labelValue.trim()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore confirmation dialog */}
      <Dialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isRestoring) setRestoreTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Restore this version?</DialogTitle>
            <DialogDescription>
              This replaces your current working files with this version. Any
              unsaved changes will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRestoreTarget(null)}
              disabled={isRestoring}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!restoreTarget) return;
                await handleRestore(restoreTarget);
                setRestoreTarget(null);
              }}
              disabled={isRestoring}
            >
              {isRestoring && <Loader2Icon className="size-4 animate-spin" />}
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Snapshot Row ───

function SnapshotRow({
  snapshot,
  isSelected,
  isRestoring,
  trackChangesBusy,
  canTrackChanges,
  onClick,
  onRestore,
  onAddLabel,
  onRemoveLabel,
  onCopySha,
  onExportTrackedTex,
  onPreviewTrackedPdf,
}: {
  snapshot: SnapshotInfo;
  isSelected: boolean;
  isRestoring: boolean;
  trackChangesBusy: boolean;
  canTrackChanges: boolean;
  onClick: () => void;
  onRestore: () => void;
  onAddLabel: () => void;
  onRemoveLabel: (label: string) => void;
  onCopySha: () => void;
  onExportTrackedTex: () => void;
  onPreviewTrackedPdf: () => void;
}) {
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const hasFiles = snapshot.changed_files.length > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group relative flex w-full items-start transition-colors",
            isSelected ? "bg-accent" : "hover:bg-accent/50",
          )}
        >
          <button
            className="flex min-w-0 flex-1 items-start py-2 pr-9 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={onClick}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-medium text-xs leading-tight",
                    snapshotTypeBadgeColor(snapshot.message),
                  )}
                >
                  {snapshotTypeLabel(snapshot.message, nativeAgentEnabled)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatRelativeTime(snapshot.timestamp)}
                </span>
              </div>

              {/* Labels */}
              {snapshot.labels.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-0.5">
                  {snapshot.labels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground text-xs"
                    >
                      <TagIcon className="size-2" />
                      {label}
                      <button
                        aria-label={`Remove label ${label}`}
                        className="ml-0.5 rounded-sm opacity-0 hover:text-destructive group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveLabel(label);
                        }}
                      >
                        <XIcon className="size-2" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Changed files summary */}
              {hasFiles && (
                <div className="mt-0.5 truncate text-muted-foreground text-xs">
                  {snapshot.changed_files
                    .map((f) => f.split(/[/\\]/).pop())
                    .join(", ")}
                </div>
              )}
            </div>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Snapshot actions"
                onClick={(e) => e.stopPropagation()}
                className="absolute top-1.5 right-1.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreVerticalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onRestore} disabled={isRestoring}>
                <RotateCcwIcon className="mr-2 size-3.5" />
                Restore this version
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onAddLabel}>
                <PlusIcon className="mr-2 size-3.5" />
                Add label
              </DropdownMenuItem>
              {canTrackChanges && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={onExportTrackedTex}
                    disabled={trackChangesBusy}
                  >
                    {trackChangesBusy ? (
                      <LoaderIcon className="mr-2 size-3.5 animate-spin" />
                    ) : (
                      <FileDownIcon className="mr-2 size-3.5" />
                    )}
                    Export tracked .tex
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={onPreviewTrackedPdf}
                    disabled={trackChangesBusy}
                  >
                    {trackChangesBusy ? (
                      <LoaderIcon className="mr-2 size-3.5 animate-spin" />
                    ) : (
                      <FileTextIcon className="mr-2 size-3.5" />
                    )}
                    Preview changes PDF
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onCopySha}>
                <CopyIcon className="mr-2 size-3.5" />
                Copy SHA
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRestore} disabled={isRestoring}>
          <RotateCcwIcon className="mr-2 size-3.5" />
          Restore this version
        </ContextMenuItem>
        <ContextMenuItem onClick={onAddLabel}>
          <PlusIcon className="mr-2 size-3.5" />
          Add label
        </ContextMenuItem>
        {canTrackChanges && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={onExportTrackedTex}
              disabled={trackChangesBusy}
            >
              {trackChangesBusy ? (
                <LoaderIcon className="mr-2 size-3.5 animate-spin" />
              ) : (
                <FileDownIcon className="mr-2 size-3.5" />
              )}
              Export tracked .tex
            </ContextMenuItem>
            <ContextMenuItem
              onClick={onPreviewTrackedPdf}
              disabled={trackChangesBusy}
            >
              {trackChangesBusy ? (
                <LoaderIcon className="mr-2 size-3.5 animate-spin" />
              ) : (
                <FileTextIcon className="mr-2 size-3.5" />
              )}
              Preview changes PDF
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onCopySha}>
          <CopyIcon className="mr-2 size-3.5" />
          Copy SHA
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
