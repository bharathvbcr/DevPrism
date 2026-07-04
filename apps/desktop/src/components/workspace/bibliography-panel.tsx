import { useMemo, useState } from "react";
import {
  BookOpenIcon,
  CopyIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  ClipboardPasteIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { canUseAiAssist, completeBibEntryFields } from "@/lib/ai-assist";
import { useDocumentStore } from "@/stores/document-store";
import { createFileOnDisk } from "@/lib/tauri/fs";
import {
  appendBibEntry,
  entryToFields,
  importBibEntries,
  parseBibFile,
  removeBibEntry,
  replaceBibEntry,
  serializeBibEntry,
  type BibEntry,
} from "@/lib/bibtex";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "sonner";
import { showWorkspaceError } from "@/stores/workspace-banner-store";

const ENTRY_TYPES = [
  "article",
  "book",
  "inproceedings",
  "incollection",
  "phdthesis",
  "mastersthesis",
  "techreport",
  "misc",
] as const;

const EDIT_FIELDS = [
  "title",
  "author",
  "year",
  "journal",
  "booktitle",
  "publisher",
  "volume",
  "number",
  "pages",
  "doi",
  "url",
] as const;

interface IndexedEntry extends BibEntry {
  bibFileId: string;
  bibFileName: string;
}

export function BibliographyPanel() {
  const files = useDocumentStore((s) => s.files);
  const updateFileContent = useDocumentStore((s) => s.updateFileContent);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);

  const [query, setQuery] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteImportError, setPasteImportError] = useState<string | null>(null);
  const [pasteTargetId, setPasteTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const aiBibAssist = useSettingsStore((s) => s.aiBibAssist);
  const [aiCitation, setAiCitation] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [addAiHint, setAddAiHint] = useState("");
  const [addAiLoading, setAddAiLoading] = useState(false);
  const [newEntry, setNewEntry] = useState({
    bibFileId: "",
    type: "article" as string,
    key: "",
    title: "",
    author: "",
    year: "",
  });

  const bibFiles = useMemo(
    () => files.filter((f) => f.type === "bib"),
    [files],
  );

  const entries = useMemo(() => {
    const all: IndexedEntry[] = [];
    for (const f of bibFiles) {
      if (!f.content) continue;
      for (const e of parseBibFile(f.content)) {
        all.push({
          ...e,
          bibFileId: f.id,
          bibFileName: f.name,
        });
      }
    }
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((e) => {
      const haystack = [e.key, e.title, e.author, e.year, e.journal]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [bibFiles, query]);

  const writeBib = (fileId: string, content: string) => {
    updateFileContent(fileId, content);
  };

  const existingKeys = useMemo(() => {
    const fileId = newEntry.bibFileId || bibFiles[0]?.id;
    const file = files.find((f) => f.id === fileId);
    if (!file?.content) return [] as string[];
    return parseBibFile(file.content).map((e) => e.key);
  }, [files, bibFiles, newEntry.bibFileId]);

  const trimmedKey = newEntry.key.trim();
  const keyValid = trimmedKey === "" || /^[A-Za-z0-9_:-]+$/.test(trimmedKey);
  const keyDup = existingKeys.includes(trimmedKey);

  const handleSaveEntry = (
    entry: IndexedEntry,
    fields: Record<string, string>,
  ) => {
    const file = files.find((f) => f.id === entry.bibFileId);
    if (!file?.content) return;
    const updated = replaceBibEntry(file.content, entry, {
      key: entry.key,
      type: entry.type,
      fields,
    });
    writeBib(entry.bibFileId, updated);
    toast.success("Bibliography entry updated");
  };

  const handleDelete = (entry: IndexedEntry) => {
    const file = files.find((f) => f.id === entry.bibFileId);
    if (!file?.content) return;
    writeBib(entry.bibFileId, removeBibEntry(file.content, entry));
    if (expandedKey === `${entry.bibFileId}:${entry.key}`) {
      setExpandedKey(null);
    }
    toast.success("Entry removed");
  };

  const handleCopyCite = async (key: string) => {
    await navigator.clipboard.writeText(`\\cite{${key}}`);
    toast.success(`Copied \\cite{${key}}`);
  };

  const handleCreateBib = async () => {
    const root = useDocumentStore.getState().projectRoot;
    if (!root) return;
    setBusy(true);
    try {
      await createFileOnDisk(root, "references.bib", "");
      await refreshFiles();
      const created = useDocumentStore
        .getState()
        .files.find((f) => f.name === "references.bib");
      if (created) {
        setNewEntry((n) => ({ ...n, bibFileId: created.id }));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleAddEntry = () => {
    const fileId = newEntry.bibFileId || bibFiles[0]?.id;
    if (!fileId || !newEntry.key.trim()) return;
    const file = files.find((f) => f.id === fileId);
    const fields: Record<string, string> = {};
    if (newEntry.title.trim()) fields.title = newEntry.title.trim();
    if (newEntry.author.trim()) fields.author = newEntry.author.trim();
    if (newEntry.year.trim()) fields.year = newEntry.year.trim();
    const body = appendBibEntry(file?.content ?? "", {
      key: newEntry.key.trim(),
      type: newEntry.type,
      fields,
    });
    writeBib(fileId, body);
    setAddOpen(false);
    setNewEntry({
      bibFileId: fileId,
      type: "article",
      key: "",
      title: "",
      author: "",
      year: "",
    });
    toast.success("Entry added");
  };

  const handleAiGenerate = async () => {
    const input = aiCitation.trim();
    if (!input || !aiBibAssist) return;
    setAiLoading(true);
    try {
      const fields = await completeBibEntryFields(input);
      const serialized = serializeBibEntry({
        key: fields.key?.trim() || "generatedKey",
        type: fields.type?.trim() || "article",
        fields: {
          ...(fields.title && { title: fields.title }),
          ...(fields.author && { author: fields.author }),
          ...(fields.year && { year: fields.year }),
          ...(fields.journal && { journal: fields.journal }),
          ...(fields.booktitle && { booktitle: fields.booktitle }),
          ...(fields.publisher && { publisher: fields.publisher }),
          ...(fields.doi && { doi: fields.doi }),
          ...(fields.url && { url: fields.url }),
        },
      });
      setPasteText(serialized.trim());
      setAiCitation("");
      toast.success("BibTeX generated! Review it below and click Import.");
    } catch (err) {
      showWorkspaceError(
        "BibTeX generation failed",
        err instanceof Error ? err.message : "AI generation failed.",
        { dedupeKey: "bib-ai-generate" },
      );
    } finally {
      setAiLoading(false);
    }
  };

  const handleAddEntryAiComplete = async () => {
    const hint = addAiHint.trim();
    if (!hint || !aiBibAssist || !canUseAiAssist()) return;
    setAddAiLoading(true);
    try {
      const fields = await completeBibEntryFields(hint);
      setNewEntry((n) => ({
        ...n,
        type: fields.type?.trim() || n.type,
        key: fields.key?.trim() || n.key,
        title: fields.title?.trim() || n.title,
        author: fields.author?.trim() || n.author,
        year: fields.year?.trim() || n.year,
      }));
      toast.success("Fields filled — review and save");
    } catch (err) {
      showWorkspaceError(
        "BibTeX completion failed",
        err instanceof Error ? err.message : "AI completion failed.",
        { dedupeKey: "bib-ai-complete" },
      );
    } finally {
      setAddAiLoading(false);
    }
  };

  const handlePasteImport = () => {
    const fileId = pasteTargetId || bibFiles[0]?.id;
    if (!fileId || !pasteText.trim()) return;
    const file = files.find((f) => f.id === fileId);
    const { content, added, skipped } = importBibEntries(
      file?.content ?? "",
      pasteText,
    );
    if (added === 0) {
      setPasteImportError(
        skipped > 0
          ? "All pasted entries already exist in this file."
          : "No BibTeX entries found in the pasted text.",
      );
      return;
    }
    setPasteImportError(null);
    writeBib(fileId, content);
    setPasteOpen(false);
    setPasteText("");
    toast.success(
      `Imported ${added} ${added === 1 ? "entry" : "entries"}` +
        (skipped > 0
          ? ` (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped)`
          : ""),
    );
  };

  if (bibFiles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-muted-foreground text-xs">
        <BookOpenIcon className="size-8 opacity-50" />
        <p>No .bib file in this project.</p>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={busy}
          onClick={handleCreateBib}
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
          Create references.bib
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 rounded-md border-sidebar-border border-b px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search citations…"
          className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 shrink-0"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="Paste BibTeX entries"
          aria-label="Paste BibTeX entries"
          onClick={() => {
            setPasteTargetId(bibFiles[0]?.id ?? "");
            setPasteOpen(true);
          }}
        >
          <ClipboardPasteIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="Add entry"
          aria-label="Add bibliography entry"
          onClick={() => {
            setNewEntry((n) => ({
              ...n,
              bibFileId: n.bibFileId || bibFiles[0]?.id || "",
            }));
            setAddOpen(true);
          }}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground text-xs">
            <span>
              {query ? "No matching entries" : "No bibliography entries yet"}
            </span>
            {query && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => setQuery("")}
              >
                Clear filter
              </Button>
            )}
          </div>
        ) : (
          entries.map((entry) => {
            const rowKey = `${entry.bibFileId}:${entry.key}`;
            const expanded = expandedKey === rowKey;
            const fields = entryToFields(entry).fields;
            return (
              <div
                key={rowKey}
                className="mb-0.5 rounded-md border border-transparent hover:border-sidebar-border"
              >
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent/50"
                  onClick={() => setExpandedKey(expanded ? null : rowKey)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-primary text-xs">
                        {entry.key}
                      </span>
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground uppercase">
                        {entry.type}
                      </span>
                    </div>
                    <div className="truncate text-muted-foreground text-xs">
                      {[entry.author, entry.title, entry.year]
                        .filter(Boolean)
                        .join(" · ") || entry.bibFileName}
                    </div>
                  </div>
                </button>
                {expanded && (
                  <EntryEditor
                    key={rowKey}
                    fields={fields}
                    onSave={(f) => handleSaveEntry(entry, f)}
                    onDelete={() => handleDelete(entry)}
                    onCopy={() => handleCopyCite(entry.key)}
                    onOpenSource={() => setActiveFile(entry.bibFileId)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add bibliography entry</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            {aiBibAssist && canUseAiAssist() && (
              <div className="flex gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
                <Input
                  className="h-8 flex-1 bg-background text-xs"
                  placeholder="DOI, URL, or citation hint"
                  value={addAiHint}
                  onChange={(e) => setAddAiHint(e.target.value)}
                  disabled={addAiLoading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddEntryAiComplete();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 text-xs"
                  disabled={addAiLoading || !addAiHint.trim()}
                  onClick={() => void handleAddEntryAiComplete()}
                >
                  {addAiLoading ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <SparklesIcon className="size-3.5" />
                  )}
                  Complete
                </Button>
              </div>
            )}
            <div className="grid gap-1.5">
              <span className="text-muted-foreground text-xs">Bib file</span>
              <Select
                value={newEntry.bibFileId || bibFiles[0]?.id}
                onValueChange={(v) =>
                  setNewEntry((n) => ({ ...n, bibFileId: v }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {bibFiles.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <span className="text-muted-foreground text-xs">Type</span>
                <Select
                  value={newEntry.type}
                  onValueChange={(v) => setNewEntry((n) => ({ ...n, type: v }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENTRY_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <span className="text-muted-foreground text-xs">Cite key</span>
                <Input
                  className="h-8 font-mono text-xs"
                  value={newEntry.key}
                  aria-invalid={!keyValid || keyDup}
                  onChange={(e) =>
                    setNewEntry((n) => ({ ...n, key: e.target.value }))
                  }
                  placeholder="smith2024"
                />
                {!keyValid && (
                  <span className="text-[10px] text-destructive">
                    Only letters, digits, _ : - allowed
                  </span>
                )}
                {keyValid && keyDup && (
                  <span className="text-[10px] text-destructive">
                    Key already exists in this file
                  </span>
                )}
              </div>
            </div>
            <Input
              className="h-8 text-xs"
              placeholder="Title"
              value={newEntry.title}
              onChange={(e) =>
                setNewEntry((n) => ({ ...n, title: e.target.value }))
              }
            />
            <Input
              className="h-8 text-xs"
              placeholder="Author"
              value={newEntry.author}
              onChange={(e) =>
                setNewEntry((n) => ({ ...n, author: e.target.value }))
              }
            />
            <Input
              className="h-8 text-xs"
              placeholder="Year"
              value={newEntry.year}
              onChange={(e) =>
                setNewEntry((n) => ({ ...n, year: e.target.value }))
              }
            />
            <p className="text-[10px] text-muted-foreground">
              Preview:{" "}
              <span className="font-mono">
                {
                  serializeBibEntry({
                    key: newEntry.key || "key",
                    type: newEntry.type,
                    fields: {
                      ...(newEntry.title && { title: newEntry.title }),
                      ...(newEntry.author && { author: newEntry.author }),
                      ...(newEntry.year && { year: newEntry.year }),
                    },
                  }).split("\n")[0]
                }
                …
              </span>
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddEntry}
              disabled={!trimmedKey || !keyValid || keyDup}
            >
              Add entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pasteOpen}
        onOpenChange={(open) => {
          setPasteOpen(open);
          if (!open) setPasteImportError(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import BibTeX</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {bibFiles.length > 1 && (
              <Select
                value={pasteTargetId || bibFiles[0]?.id}
                onValueChange={setPasteTargetId}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Target .bib file" />
                </SelectTrigger>
                <SelectContent>
                  {bibFiles.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {aiBibAssist && canUseAiAssist() && (
              <div className="flex gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
                <div className="min-w-0 flex-1">
                  <Input
                    className="h-8 bg-background text-xs"
                    placeholder="Describe paper, paste title, or enter DOI..."
                    value={aiCitation}
                    onChange={(e) => setAiCitation(e.target.value)}
                    disabled={aiLoading}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleAiGenerate();
                      }
                    }}
                  />
                </div>
                <Button
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 text-xs"
                  onClick={() => void handleAiGenerate()}
                  disabled={aiLoading || !aiCitation.trim()}
                >
                  {aiLoading ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <SparklesIcon className="size-3.5" />
                  )}
                  {aiLoading ? "Generating..." : "Generate with AI"}
                </Button>
              </div>
            )}
            <Textarea
              className="min-h-[200px] font-mono text-xs"
              placeholder={
                "@article{key,\n  title = {…},\n  author = {…},\n  year = {…},\n}"
              }
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                if (pasteImportError) setPasteImportError(null);
              }}
            />
            <p className="text-[10px] text-muted-foreground">
              Paste one or more @type{"{key, …}"} entries. Duplicate keys in the
              target file are skipped.
            </p>
            {pasteImportError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-destructive text-xs">
                {pasteImportError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handlePasteImport} disabled={!pasteText.trim()}>
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EntryEditor({
  fields,
  onSave,
  onDelete,
  onCopy,
  onOpenSource,
}: {
  fields: Record<string, string>;
  onSave: (fields: Record<string, string>) => void;
  onDelete: () => void;
  onCopy: () => void;
  onOpenSource: () => void;
}) {
  const [draft, setDraft] = useState(fields);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="space-y-2 border-sidebar-border border-t px-2 py-2">
      {EDIT_FIELDS.map((name) => (
        <div key={name} className="grid gap-0.5">
          <span className="text-[10px] text-muted-foreground capitalize">
            {name}
          </span>
          {name === "title" || name === "author" ? (
            <Textarea
              className="min-h-[52px] text-xs"
              value={draft[name] ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [name]: e.target.value }))
              }
            />
          ) : (
            <Input
              className="h-7 text-xs"
              value={draft[name] ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, [name]: e.target.value }))
              }
            />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-1 pt-1">
        <Button size="sm" className="h-7 text-xs" onClick={() => onSave(draft)}>
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={onCopy}
        >
          <CopyIcon className="size-3" />
          Cite
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onOpenSource}
        >
          Raw .bib
        </Button>
        <Button
          size="sm"
          variant={confirmDelete ? "destructive" : "ghost"}
          className={cn(
            "ml-auto h-7 text-xs",
            !confirmDelete && "text-destructive hover:text-destructive",
          )}
          onClick={() => {
            if (confirmDelete) {
              onDelete();
            } else {
              setConfirmDelete(true);
              setTimeout(() => setConfirmDelete(false), 3000);
            }
          }}
        >
          <Trash2Icon className="size-3" />
          {confirmDelete ? "Confirm delete?" : "Delete"}
        </Button>
      </div>
    </div>
  );
}

export function BibliographyHeader() {
  const count = useDocumentStore((s) => {
    let n = 0;
    for (const f of s.files) {
      if (f.type === "bib" && f.content) n += parseBibFile(f.content).length;
    }
    return n;
  });

  return (
    <div className="flex h-8 w-full items-center gap-1.5 px-3 text-muted-foreground text-xs uppercase tracking-wider">
      <BookOpenIcon className="size-3 shrink-0" />
      <span className="font-medium">Bibliography</span>
      {count > 0 && (
        <span className="rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] tracking-normal">
          {count}
        </span>
      )}
    </div>
  );
}
