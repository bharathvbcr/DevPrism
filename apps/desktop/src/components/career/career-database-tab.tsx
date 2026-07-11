import { useMemo, useState } from "react";
import {
  FileUpIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UserRoundIcon,
  BriefcaseIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  backfillBlockEmbeddings,
  createEmptyBlock,
  createEmptyPersona,
  isSeededPersonaId,
} from "@/lib/career";
import { useCareerStore } from "@/stores/career-store";
import { BlockEditor } from "./block-editor";
import { PersonaEditor } from "./persona-editor";
import { ResumeImportWizard } from "./resume-import-wizard";
import { IngestProgressList, type IngestProgressItem } from "./ingest-progress";

type DatabasePane = "blocks" | "personas";

export function CareerDatabaseTab() {
  const blocks = useCareerStore((s) => s.blocks);
  const personas = useCareerStore((s) => s.personas);
  const selectedBlockId = useCareerStore((s) => s.selectedBlockId);
  const selectedPersonaId = useCareerStore((s) => s.selectedPersonaId);
  const setSelectedBlockId = useCareerStore((s) => s.setSelectedBlockId);
  const setSelectedPersonaId = useCareerStore((s) => s.setSelectedPersonaId);
  const saveBlock = useCareerStore((s) => s.saveBlock);
  const removeBlock = useCareerStore((s) => s.removeBlock);
  const savePersona = useCareerStore((s) => s.savePersona);
  const removePersona = useCareerStore((s) => s.removePersona);
  const blocksMissingEmbeddings = useCareerStore(
    (s) => s.blocksMissingEmbeddings,
  );
  const refreshMissingBlockEmbeddings = useCareerStore(
    (s) => s.refreshMissingBlockEmbeddings,
  );
  const saving = useCareerStore((s) => s.saving);

  const [pane, setPane] = useState<DatabasePane>("blocks");
  const [importOpen, setImportOpen] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [embedProgress, setEmbedProgress] = useState<IngestProgressItem[]>([]);

  const selectedBlock = useMemo(
    () => blocks.find((b) => b.id === selectedBlockId) ?? null,
    [blocks, selectedBlockId],
  );
  const selectedPersona = useMemo(
    () => personas.find((p) => p.id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId],
  );

  const handleNewBlock = async () => {
    const block = createEmptyBlock({
      title: "New role",
      org: "",
    });
    try {
      await saveBlock(block);
      toast.success("Block created");
    } catch {
      toast.error("Failed to create block");
    }
  };

  const handleDeleteBlock = async (id: string) => {
    try {
      await removeBlock(id);
      toast.success("Block deleted");
    } catch {
      toast.error("Failed to delete block");
    }
  };

  const handleEmbedAllBlocks = async () => {
    setEmbeddingBusy(true);
    const id = "embed-all";
    setEmbedProgress([{ id, label: "Embed all blocks", status: "active" }]);
    try {
      const out = await backfillBlockEmbeddings({
        onProcessingProgress: (progress) => {
          setEmbedProgress([
            {
              id,
              label: progress.itemLabel ?? "Embed all blocks",
              status: "active",
              progress,
            },
          ]);
        },
      });
      if (out.deferred) {
        setEmbedProgress([
          {
            id,
            label: "Embed all blocks",
            status: "deferred",
            error: out.error,
          },
        ]);
        toast.error(
          out.error ??
            "Embeddings unavailable. Pull nomic-embed-text or configure a cloud embed provider.",
        );
      } else if (out.embedded === 0) {
        setEmbedProgress([
          {
            id,
            label: "Embed all blocks",
            status: "done",
            progress: {
              phase: "done",
              current: 1,
              total: 1,
              detail: "All blocks already have embeddings",
            },
          },
        ]);
        toast.message("All blocks already have embeddings");
      } else {
        setEmbedProgress([
          {
            id,
            label: "Embed all blocks",
            status: "done",
            progress: {
              phase: "done",
              current: out.embedded,
              total: out.embedded,
              chunks: out.embedded,
              detail: `Embedded ${out.embedded} block(s)`,
            },
          },
        ]);
        toast.success(`Embedded ${out.embedded} block(s)`);
      }
      await refreshMissingBlockEmbeddings();
    } catch (err) {
      setEmbedProgress([
        {
          id,
          label: "Embed all blocks",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      ]);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setEmbeddingBusy(false);
    }
  };

  const handleNewPersona = async () => {
    const persona = createEmptyPersona();
    try {
      await savePersona(persona);
      toast.success("Persona created");
    } catch {
      toast.error("Failed to create persona");
    }
  };

  const handleDeletePersona = async (id: string) => {
    if (isSeededPersonaId(id)) {
      toast.error("Built-in personas cannot be deleted");
      return;
    }
    try {
      await removePersona(id);
      toast.success("Persona deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-4">
      <aside className="flex w-64 shrink-0 flex-col gap-2">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-xs transition-colors",
              pane === "blocks"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setPane("blocks")}
          >
            <BriefcaseIcon className="size-3.5" />
            Blocks
          </button>
          <button
            type="button"
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-xs transition-colors",
              pane === "personas"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setPane("personas")}
          >
            <UserRoundIcon className="size-3.5" />
            Personas
          </button>
        </div>

        {pane === "blocks" ? (
          <>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="flex-1 gap-1"
                onClick={() => void handleNewBlock()}
                disabled={saving}
              >
                <PlusIcon className="size-3.5" />
                New
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => setImportOpen(true)}
              >
                <FileUpIcon className="size-3.5" />
                Import
              </Button>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              disabled={embeddingBusy || saving}
              onClick={() => void handleEmbedAllBlocks()}
            >
              {embeddingBusy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              Embed all blocks
              {blocksMissingEmbeddings > 0 && (
                <Badge variant="outline" className="ml-0.5 text-[10px]">
                  {blocksMissingEmbeddings}
                </Badge>
              )}
            </Button>
            <IngestProgressList items={embedProgress} />
            <ScrollArea className="min-h-0 flex-1 rounded-md border border-border/60">
              <div className="flex flex-col gap-0.5 p-1">
                {blocks.length === 0 ? (
                  <p className="px-2 py-4 text-center text-muted-foreground text-xs">
                    No experience blocks yet. Create one or import a resume.
                  </p>
                ) : (
                  blocks.map((block) => (
                    <button
                      key={block.id}
                      type="button"
                      onClick={() => setSelectedBlockId(block.id)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors",
                        selectedBlockId === block.id
                          ? "bg-sidebar-accent text-foreground"
                          : "hover:bg-muted/60",
                      )}
                    >
                      <span className="truncate font-medium text-sm">
                        {block.title || "Untitled"}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {block.org || "No org"} · {block.kind}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={() => void handleNewPersona()}
              disabled={saving}
            >
              <PlusIcon className="size-3.5" />
              New persona
            </Button>
            <ScrollArea className="min-h-0 flex-1 rounded-md border border-border/60">
              <div className="flex flex-col gap-0.5 p-1">
                {personas.map((persona) => (
                  <button
                    key={persona.id}
                    type="button"
                    onClick={() => setSelectedPersonaId(persona.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left transition-colors",
                      selectedPersonaId === persona.id
                        ? "bg-sidebar-accent text-foreground"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <span className="truncate font-medium text-sm">
                      {persona.label}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {persona.id}
                    </Badge>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </aside>

      <div className="min-w-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-card/30 p-4">
        {pane === "blocks" ? (
          selectedBlock ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-medium text-sm">Edit block</h2>
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-destructive hover:text-destructive"
                  onClick={() => void handleDeleteBlock(selectedBlock.id)}
                  disabled={saving}
                >
                  <Trash2Icon className="size-3.5" />
                  Delete
                </Button>
              </div>
              <BlockEditor
                key={selectedBlock.id}
                block={selectedBlock}
                personas={personas}
                saving={saving}
                onSave={async (next) => {
                  try {
                    await saveBlock(next);
                    toast.success("Block saved");
                  } catch {
                    toast.error("Failed to save block");
                  }
                }}
              />
            </div>
          ) : (
            <EmptyEditor hint="Select or create an experience block." />
          )
        ) : selectedPersona ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium text-sm">Edit persona</h2>
              {!isSeededPersonaId(selectedPersona.id) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-destructive hover:text-destructive"
                  onClick={() => void handleDeletePersona(selectedPersona.id)}
                  disabled={saving}
                >
                  <Trash2Icon className="size-3.5" />
                  Delete
                </Button>
              )}
            </div>
            <PersonaEditor
              key={selectedPersona.id}
              persona={selectedPersona}
              saving={saving}
              onSave={async (next) => {
                try {
                  await savePersona(next);
                  toast.success("Persona saved");
                } catch {
                  toast.error("Failed to save persona");
                }
              }}
            />
          </div>
        ) : (
          <EmptyEditor hint="Select or create a persona." />
        )}
      </div>

      <ResumeImportWizard open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

function EmptyEditor({ hint }: { hint: string }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center text-muted-foreground text-sm">
      {hint}
    </div>
  );
}
