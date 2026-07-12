import { useRef, useState } from "react";
import { BookMarkedIcon, Loader2Icon, UploadIcon } from "lucide-react";
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
  parseBibtexToPublicationBlocks,
  type ExperienceBlock,
} from "@/lib/career";
import { pickProjectFiles } from "@/lib/platform-dialog";
import { useCareerStore } from "@/stores/career-store";
import { IngestProgressList, type IngestProgressItem } from "./ingest-progress";

type WizardStep = "source" | "review";

function fileLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function PublicationImportWizard({
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
  const [parsing, setParsing] = useState(false);
  const [drafts, setDrafts] = useState<ExperienceBlock[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [commitProgress, setCommitProgress] = useState<IngestProgressItem[]>(
    [],
  );

  const reset = () => {
    setStep("source");
    setSource("");
    setSourceLabel(null);
    setDrafts([]);
    setSelected(new Set());
    setError(null);
    setParsing(false);
    setCommitProgress([]);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleBrowserFile = async (file: File | undefined) => {
    if (!file) return;
    if (
      !file.name.toLowerCase().endsWith(".bib") &&
      file.type !== "text/plain" &&
      file.type !== "application/x-bibtex"
    ) {
      toast.error("Please upload a .bib (BibTeX) file");
      return;
    }
    try {
      const text = await file.text();
      setSource(text);
      setSourceLabel(file.name);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickDesktopFile = async () => {
    const paths = await pickProjectFiles({
      title: "Import publications from BibTeX",
      multiple: false,
      filters: [{ name: "BibTeX", extensions: ["bib"] }],
    });
    if (!paths?.length) return;
    const path = paths[0]!;
    try {
      const { readTexFileContent } = await import("@/lib/tauri/fs");
      const bib = await readTexFileContent(path);
      setSource(bib);
      setSourceLabel(fileLabel(path));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleParse = () => {
    setError(null);
    setParsing(true);
    try {
      const blocks = parseBibtexToPublicationBlocks(source);
      setDrafts(blocks);
      setSelected(new Set(blocks.map((b) => b.id)));
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const handleCommit = async () => {
    const chosen = drafts.filter((b) => selected.has(b.id));
    if (chosen.length === 0) {
      toast.error("Select at least one publication to save");
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
                        ? `Saving publication ${current}/${total}`
                        : phase === "embed"
                          ? `Embedding publication ${current}/${total}`
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
          `Saved ${commit.saved} publication${commit.saved === 1 ? "" : "s"}, but embeddings were deferred for ${commit.deferredEmbeddings}. Pull an embedding model, then embed from Database.`,
        );
      } else {
        toast.success(
          `Saved ${commit.saved} publication${commit.saved === 1 ? "" : "s"}`,
        );
      }
      handleClose(false);
    } catch {
      toast.error("Failed to save publication blocks");
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
          <DialogTitle className="flex items-center gap-2">
            <BookMarkedIcon className="size-4" />
            Import publications from BibTeX
          </DialogTitle>
          <DialogDescription>
            Parse a Zotero / BibTeX export into draft publication blocks. Review
            entries, then commit — each selected entry is saved with embeddings.
            This is separate from BibTeX-to-knowledge-base ingest.
          </DialogDescription>
        </DialogHeader>

        {step === "source" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => void handlePickDesktopFile()}
              >
                <UploadIcon className="size-3.5" />
                Choose .bib file
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={() => fileInputRef.current?.click()}
              >
                Browser upload
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".bib,text/plain,application/x-bibtex"
                className="hidden"
                onChange={(e) => void handleBrowserFile(e.target.files?.[0])}
              />
              <span className="text-muted-foreground text-xs">
                or paste BibTeX below
                {sourceLabel ? ` · ${sourceLabel}` : ""}
              </span>
            </div>
            <Textarea
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setSourceLabel(null);
              }}
              placeholder={
                "@article{smith2024,\n  title = {…},\n  author = {…},\n  year = {2024},\n}"
              }
              className="min-h-[220px] font-mono text-xs"
            />
            {error && (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-2">
            <p className="text-muted-foreground text-xs">
              {drafts.length} entr{drafts.length === 1 ? "y" : "ies"} parsed.
              Uncheck any you do not want as career database publication blocks.
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
                        {block.domains[0] && (
                          <Badge variant="secondary" className="text-[10px]">
                            {block.domains[0]}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {block.org || "No venue"}
                        {block.dateRange.start
                          ? ` · ${block.dateRange.start}`
                          : ""}
                      </p>
                      <ul className="list-inside list-disc text-xs leading-relaxed">
                        {block.bullets
                          .filter((b) => b.canonical.trim())
                          .slice(0, 3)
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
            <IngestProgressList
              items={commitProgress}
              title="Saving publications"
            />
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
                setCommitProgress([]);
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
              disabled={parsing || source.trim().length < 8}
              onClick={() => handleParse()}
            >
              {parsing ? (
                <>
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Parsing…
                </>
              ) : (
                "Preview entries"
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
                : `Save ${selected.size} publication${selected.size === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
