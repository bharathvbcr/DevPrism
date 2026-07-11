import { useRef, useState } from "react";
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
import { extractBlocksFromResume, type ExperienceBlock } from "@/lib/career";
import { canUseAiAssist } from "@/lib/ai-assist";
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
  const [extracting, setExtracting] = useState(false);
  const [drafts, setDrafts] = useState<ExperienceBlock[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [commitProgress, setCommitProgress] = useState<IngestProgressItem[]>(
    [],
  );

  const reset = () => {
    setStep("source");
    setSource("");
    setDrafts([]);
    setSelected(new Set());
    setError(null);
    setExtracting(false);
    setCommitProgress([]);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (
      !file.name.toLowerCase().endsWith(".tex") &&
      file.type !== "text/plain"
    ) {
      toast.error("Please upload a .tex (or plain text) file");
      return;
    }
    try {
      const text = await file.text();
      setSource(text);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
      await commitBlocks(chosen, {
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
        prev.map((item) => ({ ...item, status: "done" as const })),
      );
      toast.success(
        `Saved ${chosen.length} block${chosen.length === 1 ? "" : "s"}`,
      );
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
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Import resume</DialogTitle>
          <DialogDescription>
            Paste or upload LaTeX source. AI extracts draft experience blocks
            for your review — nothing is saved until you confirm.
          </DialogDescription>
        </DialogHeader>

        {step === "source" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon className="size-3.5" />
                Upload .tex
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".tex,text/plain,text/x-tex"
                className="hidden"
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
              <span className="text-muted-foreground text-xs">
                or paste below
              </span>
            </div>
            <Textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="\documentclass{article} …"
              className="min-h-[220px] font-mono text-xs"
            />
            {!canUseAiAssist() && (
              <p className="text-warning-foreground text-xs">
                AI assist is off or no provider is configured. Enable one in
                Settings before extracting.
              </p>
            )}
            {error && (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
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
              disabled={extracting || source.trim().length < 40}
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
