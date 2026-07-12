import { useMemo, useState } from "react";
import {
  BookOpenIcon,
  FileUpIcon,
  ListPlusIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BLOCK_KINDS,
  createEmptyBlock,
  distillFactsFromNotes,
  ingestFilePath,
  ingestMarkdownText,
  ingestMindmapText,
  type BlockFact,
  type BlockKind,
  type ExperienceBlock,
  type ProcessingProgress,
} from "@/lib/career";
import { canUseAiAssist } from "@/lib/ai-assist";
import { pickProjectFiles } from "@/lib/platform-dialog";
import { useCareerStore } from "@/stores/career-store";
import { useSynthesisStore } from "@/stores/synthesis-store";
import {
  IngestProgressList,
  type IngestProgressItem,
} from "../ingest-progress";

const CREATE_NEW = "__create_new__";

function fileLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

type DialogMode = "documents" | "quick-points";

export function AddKnowledgeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setActiveTab = useCareerStore((s) => s.setActiveTab);
  const blocks = useCareerStore((s) => s.blocks);
  const saveBlock = useCareerStore((s) => s.saveBlock);
  const saving = useCareerStore((s) => s.saving);
  const refreshReadiness = useSynthesisStore((s) => s.refreshReadiness);

  const [mode, setMode] = useState<DialogMode>("documents");
  const [busy, setBusy] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteKind, setPasteKind] = useState<"markdown" | "mindmap">(
    "markdown",
  );
  const [progressItems, setProgressItems] = useState<IngestProgressItem[]>([]);

  const [quickPoints, setQuickPoints] = useState("");
  const [targetBlockId, setTargetBlockId] = useState<string>(CREATE_NEW);
  const [newTitle, setNewTitle] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [newKind, setNewKind] = useState<BlockKind>("experience");
  const [distilling, setDistilling] = useState(false);
  const [factPreview, setFactPreview] = useState<BlockFact[] | null>(null);

  const sortedBlocks = useMemo(
    () =>
      [...blocks].sort((a, b) =>
        (a.title || a.org || a.id).localeCompare(b.title || b.org || b.id),
      ),
    [blocks],
  );

  const resetQuick = () => {
    setQuickPoints("");
    setTargetBlockId(CREATE_NEW);
    setNewTitle("");
    setNewOrg("");
    setNewKind("experience");
    setFactPreview(null);
    setDistilling(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setPasteText("");
      setProgressItems([]);
      resetQuick();
      setMode("documents");
    }
    onOpenChange(next);
  };

  const patchItem = (id: string, patch: Partial<IngestProgressItem>) => {
    setProgressItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const finishWithDeferred = (deferred: boolean, successLabel: string) => {
    if (deferred) {
      toast.warning(
        "Stored without embeddings. Pull an embedding model, then backfill from Knowledge.",
      );
    } else {
      toast.success(successLabel);
    }
    void refreshReadiness({ forceEmbedProbe: true });
  };

  const handleIngestFiles = async () => {
    const paths = await pickProjectFiles({
      title: "Add knowledge sources",
      multiple: true,
      filters: [
        {
          name: "Knowledge",
          extensions: ["md", "markdown", "txt", "pdf", "opml", "mm"],
        },
      ],
    });
    if (!paths?.length) return;
    setBusy(true);
    const items: IngestProgressItem[] = paths.map((path) => ({
      id: path,
      label: fileLabel(path),
      status: "pending",
    }));
    setProgressItems(items);
    try {
      let deferred = false;
      for (const path of paths) {
        patchItem(path, { status: "active" });
        const onProgress = (progress: ProcessingProgress) => {
          patchItem(path, { progress, status: "active" });
        };
        try {
          const out = await ingestFilePath(path, undefined, { onProgress });
          if (out.embed.deferred) {
            deferred = true;
            patchItem(path, {
              status: "deferred",
              error: out.embed.error,
            });
          } else {
            patchItem(path, { status: "done" });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          patchItem(path, { status: "error", error: message });
          throw err;
        }
      }
      finishWithDeferred(deferred, `Ingested ${paths.length} source(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePasteIngest = async () => {
    const text = pasteText.trim();
    if (!text) return;
    setBusy(true);
    const id = `paste-${Date.now()}`;
    setProgressItems([{ id, label: `Pasted ${pasteKind}`, status: "active" }]);
    const onProgress = (progress: ProcessingProgress) => {
      patchItem(id, { progress, status: "active" });
    };
    try {
      let deferred = false;
      if (pasteKind === "mindmap") {
        const out = await ingestMindmapText(text, {
          uri: `paste://mindmap-${Date.now()}`,
          title: "Pasted mind map",
          sourceType: "mindmap",
          onProgress,
        });
        deferred = out.embed.deferred;
      } else {
        const out = await ingestMarkdownText(text, {
          uri: `paste://markdown-${Date.now()}`,
          title: "Pasted markdown",
          sourceType: "markdown",
          onProgress,
        });
        deferred = out.embed.deferred;
      }
      patchItem(id, { status: deferred ? "deferred" : "done" });
      setPasteText("");
      finishWithDeferred(deferred, "Ingested pasted content");
    } catch (err) {
      patchItem(id, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDistillQuickPoints = async () => {
    if (!canUseAiAssist()) {
      toast.error("Enable an AI provider in Settings to structure points.");
      return;
    }
    setDistilling(true);
    setFactPreview(null);
    try {
      const facts = await distillFactsFromNotes(quickPoints);
      setFactPreview(facts);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDistilling(false);
    }
  };

  const handleCommitQuickPoints = async () => {
    if (!factPreview?.length) {
      toast.error("Distill points into a preview before committing.");
      return;
    }

    let next: ExperienceBlock;
    if (targetBlockId === CREATE_NEW) {
      const title = newTitle.trim();
      if (!title) {
        toast.error("Give the new block a title.");
        return;
      }
      next = createEmptyBlock({
        kind: newKind,
        title,
        org: newOrg.trim(),
        facts: factPreview,
      });
    } else {
      const existing = blocks.find((b) => b.id === targetBlockId);
      if (!existing) {
        toast.error("Selected block no longer exists.");
        return;
      }
      next = {
        ...existing,
        facts: [...(existing.facts ?? []), ...factPreview],
      };
    }

    setBusy(true);
    try {
      await saveBlock(next);
      toast.success(
        `Saved ${factPreview.length} fact(s) to ${next.title || "block"}`,
      );
      void refreshReadiness({ forceEmbedProbe: true });
      resetQuick();
      handleOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openFullKnowledge = () => {
    handleOpenChange(false);
    setActiveTab("knowledge");
  };

  const commitDisabled =
    busy ||
    saving ||
    !factPreview?.length ||
    (targetBlockId === CREATE_NEW && !newTitle.trim());

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpenIcon className="size-4" />
            Add knowledge
          </DialogTitle>
          <DialogDescription>
            Ingest documents into the global knowledge base, or attach quick
            points to an experience block as a fact pool.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(
            [
              ["documents", "Documents"],
              ["quick-points", "Quick points"],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={mode === id ? "secondary" : "ghost"}
              className="h-8 flex-1 text-xs"
              disabled={busy || distilling}
              onClick={() => setMode(id)}
            >
              {label}
            </Button>
          ))}
        </div>

        {mode === "documents" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="gap-1.5"
                disabled={busy}
                onClick={() => void handleIngestFiles()}
              >
                {busy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <FileUpIcon className="size-3.5" />
                )}
                Ingest files
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={openFullKnowledge}
              >
                Open Knowledge tab
              </Button>
            </div>

            <IngestProgressList items={progressItems} title="Processing" />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>Paste content</Label>
                <div className="flex gap-1">
                  {(
                    [
                      ["markdown", "Markdown"],
                      ["mindmap", "Mind map"],
                    ] as const
                  ).map(([id, label]) => (
                    <Button
                      key={id}
                      type="button"
                      size="sm"
                      variant={pasteKind === id ? "secondary" : "ghost"}
                      className="h-7 text-[11px]"
                      onClick={() => setPasteKind(id)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <Textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={
                  pasteKind === "mindmap"
                    ? "<opml>…</opml> or FreeMind XML"
                    : "# Notes\n\nPaste wiki / Obsidian markdown…"
                }
                className="min-h-[120px] font-mono text-xs"
                disabled={busy}
              />
            </div>

            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={openFullKnowledge}
              >
                Full Knowledge tab
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !pasteText.trim()}
                onClick={() => void handlePasteIngest()}
              >
                Ingest paste
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label>Paste points</Label>
              <Textarea
                value={quickPoints}
                onChange={(e) => {
                  setQuickPoints(e.target.value);
                  setFactPreview(null);
                }}
                placeholder={
                  "- Reduced p99 latency 40%\n- Owned Kubernetes rollout\n- Mentored 3 engineers…"
                }
                className="min-h-[120px] font-mono text-xs"
                disabled={busy || distilling}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Target block</Label>
              <Select
                value={targetBlockId}
                onValueChange={setTargetBlockId}
                disabled={busy || distilling}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a block" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CREATE_NEW}>Create new block…</SelectItem>
                  {sortedBlocks.map((block) => (
                    <SelectItem key={block.id} value={block.id}>
                      {block.title || "Untitled"}
                      {block.org ? ` · ${block.org}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {targetBlockId === CREATE_NEW ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>New block title</Label>
                  <Input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Project or role title"
                    disabled={busy || distilling}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Organization</Label>
                  <Input
                    value={newOrg}
                    onChange={(e) => setNewOrg(e.target.value)}
                    placeholder="Optional"
                    disabled={busy || distilling}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Kind</Label>
                  <Select
                    value={newKind}
                    onValueChange={(v) => setNewKind(v as BlockKind)}
                    disabled={busy || distilling}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BLOCK_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="gap-1.5"
                disabled={busy || distilling || quickPoints.trim().length < 8}
                onClick={() => void handleDistillQuickPoints()}
              >
                {distilling ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <SparklesIcon className="size-3.5" />
                )}
                Structure with AI
              </Button>
              {!canUseAiAssist() ? (
                <span className="text-[11px] text-muted-foreground">
                  AI provider required in Settings.
                </span>
              ) : null}
            </div>

            {factPreview && factPreview.length > 0 ? (
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border/60 p-2.5">
                <p className="font-medium text-xs">
                  Preview · {factPreview.length} fact
                  {factPreview.length === 1 ? "" : "s"}
                </p>
                <ul className="space-y-1">
                  {factPreview.map((fact) => (
                    <li
                      key={fact.id}
                      className="rounded border border-border/40 px-2 py-1 text-xs leading-snug"
                    >
                      {fact.text}
                      {(fact.skills.length > 0 || fact.metrics.length > 0) && (
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {fact.skills.length > 0 ? fact.skills.join(", ") : ""}
                          {fact.skills.length > 0 && fact.metrics.length > 0
                            ? " · "
                            : ""}
                          {fact.metrics.map((m) => m.value).join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <DialogFooter className="gap-2 sm:justify-end">
              <Button
                type="button"
                size="sm"
                className="gap-1.5"
                disabled={commitDisabled}
                onClick={() => void handleCommitQuickPoints()}
              >
                {busy || saving ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <ListPlusIcon className="size-3.5" />
                )}
                Commit facts
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
