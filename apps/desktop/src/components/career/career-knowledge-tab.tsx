import { useCallback, useEffect, useState } from "react";
import {
  BookMarkedIcon,
  BookOpenIcon,
  FileUpIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InlineBanner } from "@/components/ui/inline-banner";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  backfillKbEmbeddings,
  deleteKbSource,
  ingestFilePath,
  ingestMarkdownText,
  ingestMindmapText,
  listKbChunks,
  listKbSources,
  seedPublicationsFromBibtex,
  type KbSourceRow,
  type ProcessingProgress,
} from "@/lib/career";
import { pickProjectFiles } from "@/lib/platform-dialog";
import {
  RECOMMENDED_EMBED_MODEL,
  getOllamaBaseUrl,
  resolveOllamaCredential,
} from "@/lib/ollama";
import { dispatchOpenSettings } from "@/lib/home-flow-events";
import { useOllamaPullStore } from "@/stores/ollama-pull-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { IngestProgressList, type IngestProgressItem } from "./ingest-progress";
import { PublicationImportWizard } from "./publication-import-wizard";

function fileLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function CareerKnowledgeTab() {
  const [sources, setSources] = useState<KbSourceRow[]>([]);
  const [missingBySource, setMissingBySource] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteKind, setPasteKind] = useState<"markdown" | "mindmap" | "bibtex">(
    "markdown",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [progressItems, setProgressItems] = useState<IngestProgressItem[]>([]);
  const [pubImportOpen, setPubImportOpen] = useState(false);
  const pulling = useOllamaPullStore((s) => s.pulling);
  const pull = useOllamaPullStore((s) => s.pull);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSources, missingChunks] = await Promise.all([
        listKbSources(),
        listKbChunks(undefined, true).catch(() => []),
      ]);
      const counts = new Map<string, number>();
      for (const chunk of missingChunks) {
        counts.set(chunk.sourceId, (counts.get(chunk.sourceId) ?? 0) + 1);
      }
      setSources(nextSources);
      setMissingBySource(counts);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchItem = (
    id: string,
    patch:
      | Partial<IngestProgressItem>
      | ((prev: IngestProgressItem) => IngestProgressItem),
  ) => {
    setProgressItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        return typeof patch === "function"
          ? patch(item)
          : { ...item, ...patch };
      }),
    );
  };

  const handleIngestFiles = async () => {
    const paths = await pickProjectFiles({
      title: "Ingest knowledge sources",
      multiple: true,
      filters: [
        {
          name: "Knowledge",
          extensions: ["md", "markdown", "txt", "pdf", "opml", "mm", "bib"],
        },
      ],
    });
    if (!paths?.length) return;
    setBusy(true);
    setNotice(null);
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
          const lower = path.toLowerCase();
          if (lower.endsWith(".bib")) {
            const { readTexFileContent } = await import("@/lib/tauri/fs");
            const bib = await readTexFileContent(path);
            const seeded = await seedPublicationsFromBibtex(bib, {
              uri: path,
              title: fileLabel(path),
              onProgress,
            });
            if (seeded.embed.deferred) {
              deferred = true;
              patchItem(path, {
                status: "deferred",
                error: seeded.embed.error,
                progress: {
                  phase: "done",
                  current: 1,
                  total: 1,
                  itemLabel: fileLabel(path),
                  chunks: seeded.report.chunkCount,
                  detail: "Stored; embeddings deferred",
                },
              });
            } else {
              patchItem(path, {
                status: "done",
                progress: {
                  phase: "done",
                  current: 1,
                  total: 1,
                  itemLabel: fileLabel(path),
                  chunks: seeded.report.chunkCount,
                  detail: `Embedded ${seeded.embed.embedded}`,
                },
              });
            }
          } else {
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
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          patchItem(path, { status: "error", error: message });
          throw err;
        }
      }
      if (deferred) {
        setNotice(
          "Chunks stored without embeddings. Install an embedding model (or configure Gemini embeddings) then backfill.",
        );
        toast.warning(
          `Ingested ${paths.length} source(s), but embeddings were deferred`,
        );
      } else {
        toast.success(`Ingested ${paths.length} source(s)`);
      }
      await refresh();
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
    setNotice(null);
    const id = `paste-${Date.now()}`;
    setProgressItems([
      {
        id,
        label: `Pasted ${pasteKind}`,
        status: "active",
      },
    ]);
    const onProgress = (progress: ProcessingProgress) => {
      patchItem(id, { progress, status: "active" });
    };
    try {
      let deferred = false;
      if (pasteKind === "bibtex") {
        const seeded = await seedPublicationsFromBibtex(text, {
          uri: `paste://bibtex-${Date.now()}`,
          title: "Pasted bibliography",
          onProgress,
        });
        deferred = seeded.embed.deferred;
      } else if (pasteKind === "mindmap") {
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
      patchItem(id, {
        status: deferred ? "deferred" : "done",
      });
      if (deferred) {
        setNotice(
          "Chunks stored without embeddings. Install an embedding model then backfill.",
        );
        toast.warning("Ingested content, but embeddings were deferred");
      } else {
        toast.success("Ingested pasted content");
      }
      setPasteText("");
      await refresh();
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

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      await deleteKbSource(id);
      toast.success("Source removed");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleBackfill = async () => {
    setBusy(true);
    const id = "backfill";
    setProgressItems([{ id, label: "Backfill embeddings", status: "active" }]);
    try {
      const out = await backfillKbEmbeddings({
        onProcessingProgress: (progress) => {
          patchItem(id, { progress, status: "active" });
        },
      });
      if (out.deferred) {
        patchItem(id, { status: "deferred", error: out.error });
        setNotice(
          out.error ??
            "Still no embedding provider. Pull nomic-embed-text or use a Gemini credential.",
        );
        toast.warning(
          out.error ??
            "Embeddings still unavailable. Pull nomic-embed-text or open AI settings.",
        );
      } else {
        patchItem(id, {
          status: "done",
          progress: {
            phase: "done",
            current: out.embedded,
            total: Math.max(1, out.embedded),
            chunks: out.embedded,
            detail: `Embedded ${out.embedded} chunk(s)`,
          },
        });
        setNotice(null);
        toast.success(`Embedded ${out.embedded} chunk(s)`);
      }
      await refresh();
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

  const handlePullEmbed = async () => {
    try {
      const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
      const baseUrl = getOllamaBaseUrl(resolveOllamaCredential(creds, null));
      await pull(RECOMMENDED_EMBED_MODEL.id, baseUrl);
      toast.success(`Pulling ${RECOMMENDED_EMBED_MODEL.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
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
            className="gap-1.5"
            disabled={busy}
            onClick={() => setPubImportOpen(true)}
          >
            <BookMarkedIcon className="size-3.5" />
            Import publications from BibTeX
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="gap-1.5"
            disabled={busy}
            onClick={() => void handleBackfill()}
          >
            <RefreshCwIcon className="size-3.5" />
            Backfill embeddings
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pulling || busy}
            onClick={() => void handlePullEmbed()}
          >
            Pull {RECOMMENDED_EMBED_MODEL.id}
          </Button>
        </div>

        <PublicationImportWizard
          open={pubImportOpen}
          onOpenChange={setPubImportOpen}
        />

        {notice && (
          <InlineBanner
            kind="warning"
            title="Embeddings deferred"
            message={notice}
            actionLabel="Pull embedding model"
            onAction={() => void handlePullEmbed()}
            secondaryActionLabel="AI settings"
            onSecondaryAction={() => dispatchOpenSettings("ai")}
            onDismiss={() => setNotice(null)}
          />
        )}

        <IngestProgressList items={progressItems} title="Processing" />

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label>Paste content</Label>
            <div className="flex gap-1">
              {(
                [
                  ["markdown", "Markdown"],
                  ["mindmap", "OPML / mind map"],
                  ["bibtex", "BibTeX"],
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
              pasteKind === "bibtex"
                ? "@article{…}"
                : pasteKind === "mindmap"
                  ? "<opml>…</opml> or FreeMind XML"
                  : "# Notes\n\nPaste wiki / Obsidian markdown…"
            }
            className="min-h-[140px] font-mono text-xs"
            disabled={busy}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !pasteText.trim()}
            onClick={() => void handlePasteIngest()}
          >
            Ingest paste
          </Button>
        </div>
      </div>

      <aside className="flex w-[min(100%,340px)] shrink-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Sources</h2>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        {loading && sources.length === 0 ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : sources.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-border/60 border-dashed bg-muted/20 px-4 py-8 text-center">
            <BookOpenIcon className="size-6 text-muted-foreground/40" />
            <p className="text-muted-foreground text-xs leading-relaxed">
              No sources yet. Ingest markdown, PDFs, mind maps, or BibTeX to
              ground synthesis rewrites.
            </p>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border/60">
            <ul className="space-y-1 p-2">
              {sources.map((s) => {
                const missing = missingBySource.get(s.id) ?? 0;
                return (
                  <li
                    key={s.id}
                    className="flex items-start gap-2 rounded-md border border-border/40 px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-xs">
                        {s.title || s.uri || s.id}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[10px]">
                          {s.sourceType}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          {s.chunkCount} chunks
                        </Badge>
                        {missing > 0 && (
                          <Badge
                            variant="destructive"
                            className="text-[10px]"
                            title="Chunks without embeddings"
                          >
                            {missing} missing embeds
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0 text-muted-foreground"
                      disabled={busy}
                      onClick={() => void handleDelete(s.id)}
                      aria-label="Delete source"
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </aside>
    </div>
  );
}
