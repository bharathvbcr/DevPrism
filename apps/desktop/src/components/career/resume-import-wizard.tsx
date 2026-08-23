import { useEffect, useRef, useState } from "react";
import { Loader2Icon, UploadIcon } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  extractBlocksFromResume,
  readResumeSourceFromFile,
  type ExperienceBlock,
} from "@/lib/career";
import { canUseAiAssist } from "@/lib/ai-assist";
import { dispatchOpenSettings } from "@/lib/home-flow-events";
import { useCareerStore } from "@/stores/career-store";
import { IngestProgressList, type IngestProgressItem } from "./ingest-progress";

type WizardStep = "source" | "review";

export function ResumeImportWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const commitBlocks = useCareerStore((s) => s.commitBlocks);
  const saving = useCareerStore((s) => s.saving);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<WizardStep>("source");
  const [source, setSource] = useState("");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [drafts, setDrafts] = useState<ExperienceBlock[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [commitProgress, setCommitProgress] = useState<IngestProgressItem[]>(
    [],
  );

  // Source dropped/picked elsewhere in Career (e.g. a .zip onto the window)
  // arrives through the store; consume it once the wizard is visible.
  const pendingImportSource = useCareerStore((s) => s.resumeImportSource);
  const clearResumeImportSource = useCareerStore(
    (s) => s.clearResumeImportSource,
  );
  useEffect(() => {
    if (!open || !pendingImportSource) return;
    setStep("source");
    setSource(pendingImportSource);
    setSourceLabel(null);
    setError(null);
    clearResumeImportSource();
  }, [open, pendingImportSource, clearResumeImportSource]);

  const reset = () => {
    setStep("source");
    setSource("");
    setSourceLabel(null);
    setDrafts([]);
    setSelected(new Set());
    setError(null);
    setExtracting(false);
    setDragActive(false);
    setCommitProgress([]);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const applyResumeFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const out = await readResumeSourceFromFile(file);
      setStep("source");
      setSource(out.source);
      setSourceLabel(out.label);
      setError(null);
      toast.success(`Loaded ${out.label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    }
  };

  const handleDialogDragOver = (event: React.DragEvent) => {
    if (step !== "source") return;
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  };

  const handleDialogDrop = async (event: React.DragEvent) => {
    if (step !== "source") return;
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    // Keep the Career window-level drop handler from double-importing.
    event.stopPropagation();
    setDragActive(false);
    await applyResumeFile(event.dataTransfer.files[0]);
  };

  const handleExtract = async () => {
    setError(null);
    setExtracting(true);
    try {
      const blocks = await extractBlocksFromResume(source);
      setDrafts(blocks);
      setSelected(new Set(blocks.map((b) => b.id)));
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  const handleCommit = async () => {
    const chosen = drafts.filter((b) => selected.has(b.id));
    if (chosen.length === 0) {
      toast.error("Select at least one block to save");
      return;
    }
    setCommitProgress(
      chosen.map((b) => ({
        id: b.id,
        label: b.title || b.org || b.id,
        status: "pending" as const,
      })),
    );
    try {
      const commit = await commitBlocks(chosen, {
        onProgress: ({ current, total, label, phase }) => {
          setCommitProgress((prev) =>
            prev.map((item, idx) => {
              const i = current - 1;
              if (idx < i) return { ...item, status: "done" };
              if (idx === i) {
                return {
                  ...item,
                  label,
                  status: phase === "done" ? "done" : "active",
                  progress: {
                    phase:
                      phase === "embed"
                        ? "embed"
                        : phase === "done"
                          ? "done"
                          : "upsert",
                    current,
                    total,
                    itemLabel: label,
                    detail:
                      phase === "save"
                        ? `Saving block ${current}/${total}`
                        : phase === "embed"
                          ? `Embedding block ${current}/${total}`
                          : `Done ${current}/${total}`,
                  },
                };
              }
              return item;
            }),
          );
        },
      });
      setCommitProgress((prev) =>
        prev.map((item) => ({
          ...item,
          status:
            commit.deferredEmbeddings > 0
              ? ("deferred" as const)
              : ("done" as const),
          error:
            commit.deferredEmbeddings > 0 ? commit.deferredError : undefined,
        })),
      );
      if (commit.deferredEmbeddings > 0) {
        toast.warning(
          `Saved ${commit.saved} block${commit.saved === 1 ? "" : "s"}, but embeddings were deferred for ${commit.deferredEmbeddings}. Pull an embedding model, then embed from Database.`,
        );
      } else {
        toast.success(
          `Saved ${commit.saved} block${commit.saved === 1 ? "" : "s"}`,
        );
      }
      handleClose(false);
    } catch {
      toast.error("Failed to save imported blocks");
    }
  };

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col gap-4"
        onDragOver={handleDialogDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDragActive(false);
          }
        }}
        onDrop={(e) => void handleDialogDrop(e)}
      >
        <DialogHeader>
          <DialogTitle>Import resume</DialogTitle>
          <DialogDescription>
            Paste, upload, or drag a LaTeX .tex file or a .zip archive. AI
            extracts draft experience blocks for your review — nothing is saved
            until you confirm.
          </DialogDescription>
        </DialogHeader>

        {step === "source" ? (
          <div className="relative space-y-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon className="size-3.5" />
                Upload .tex / .zip
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".tex,.ltx,.zip,text/plain,text/x-tex,application/zip,application/x-zip-compressed"
                className="hidden"
                onChange={(e) => void applyResumeFile(e.target.files?.[0])}
              />
              <span className="text-muted-foreground text-xs">
                or paste below — you can also drop files here
              </span>
            </div>
            {sourceLabel && (
              <p className="truncate text-[11px] text-muted-foreground">
                Loaded from{" "}
                <span className="font-medium text-foreground">
                  {sourceLabel}
                </span>
              </p>
            )}
            <Textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="\documentclass{article} …"
              className="min-h-[220px] font-mono text-xs"
            />
            {!canUseAiAssist() && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-2">
                <p className="min-w-0 flex-1 text-muted-foreground text-xs">
                  AI assist is off or no provider is configured. Enable one in
                  Settings before extracting.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    useCareerStore.getState().closeCareer();
                    dispatchOpenSettings("ai");
                  }}
                >
                  Open AI settings
                </Button>
              </div>
            )}
            {error && (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            )}
            {dragActive && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-primary/60 border-dashed bg-background/80">
                <p className="font-medium text-sm">
                  Drop a .zip archive or .tex file
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-2">
            <p className="text-muted-foreground text-xs">
              Review drafts and uncheck any you do not want to keep. Edits can
              be refined in the block editor after import.
            </p>
            <ScrollArea className="h-[min(50vh,360px)] rounded-md border border-border/60">
              <div className="space-y-2 p-2">
                {drafts.map((block) => (
                  <label
                    key={block.id}
                    className="flex cursor-pointer gap-3 rounded-md border border-border/40 bg-muted/20 p-3"
                  >
                    <Checkbox
                      checked={selected.has(block.id)}
                      onCheckedChange={(v) => toggle(block.id, v === true)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">
                          {block.title}
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {block.kind}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {block.org || "No org"}
                        {block.dateRange.start
                          ? ` · ${block.dateRange.start}${
                              block.dateRange.end
                                ? `–${block.dateRange.end}`
                                : "–present"
                            }`
                          : ""}
                      </p>
                      <ul className="list-inside list-disc text-xs leading-relaxed">
                        {block.bullets
                          .filter((b) => b.canonical.trim())
                          .slice(0, 4)
                          .map((b) => (
                            <li key={b.id} className="truncate">
                              {b.canonical}
                            </li>
                          ))}
                      </ul>
                      {(block.facts ?? []).length > 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          +{(block.facts ?? []).length} raw fact
                          {(block.facts ?? []).length === 1 ? "" : "s"} for
                          knowledge pool
                        </p>
                      ) : null}
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>
            <IngestProgressList items={commitProgress} title="Saving blocks" />
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {step === "review" && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStep("source");
                setError(null);
              }}
            >
              Back
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => handleClose(false)}
          >
            Cancel
          </Button>
          {step === "source" ? (
            <Button
              type="button"
              disabled={
                extracting || source.trim().length < 40 || !canUseAiAssist()
              }
              onClick={() => void handleExtract()}
            >
              {extracting ? (
                <>
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Extracting…
                </>
              ) : (
                "Extract drafts"
              )}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={saving || selected.size === 0}
              onClick={() => void handleCommit()}
            >
              {saving
                ? "Saving…"
                : `Save ${selected.size} block${selected.size === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
