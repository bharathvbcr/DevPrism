import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { FileDownIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { resolveActiveCompileTarget } from "@/lib/compile-root-preference";
import { generateAbstract } from "@/lib/ai-extras";
import { canUseAiAssist } from "@/lib/ai-assist";
import { writeTexFileContent, deleteFileFromDisk, join } from "@/lib/tauri/fs";
import { cn } from "@/lib/utils";
import { showWorkspaceError } from "@/stores/workspace-banner-store";

type ExportFormat = "docx" | "html" | "markdown";

const FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: "docx", label: "Word (.docx)", ext: "docx" },
  { id: "html", label: "HTML (.html)", ext: "html" },
  { id: "markdown", label: "Markdown (.md)", ext: "md" },
];

/**
 * Build a copy of the root LaTeX source with an `\begin{abstract}` block
 * inserted right after `\begin{document}`. pandoc renders this as an "Abstract"
 * section for every prose format (docx/html/markdown). Returns null when the
 * document has no `\begin{document}` so we can fall back to the plain export.
 */
function injectAbstract(source: string, abstract: string): string | null {
  const match = source.match(/\\begin\{document\}[^\n]*\n?/);
  if (!match || match.index == null) return null;
  // Escape characters that would otherwise be interpreted as LaTeX syntax.
  const safe = abstract
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([%${}&#_])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
  const block = `\\begin{abstract}\n${safe}\n\\end{abstract}\n\n`;
  const insertAt = match.index + match[0].length;
  return source.slice(0, insertAt) + block + source.slice(insertAt);
}

export function ExportMenu() {
  const [busy, setBusy] = useState(false);
  const [withAbstract, setWithAbstract] = useState(false);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const hasTex = useDocumentStore((s) => s.files.some((f) => f.type === "tex"));
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);

  const canAbstract = aiSummarize && canUseAiAssist();

  if (!projectRoot || !hasTex) return null;

  const runExport = async (format: ExportFormat, ext: string) => {
    const state = useDocumentStore.getState();
    const root = state.projectRoot;
    if (!root) return;
    const target = resolveActiveCompileTarget(
      root,
      state.activeFileId,
      state.files,
    );
    if (!target) {
      showWorkspaceError("Export failed", "No .tex file found to export.", {
        dedupeKey: "export-no-tex",
      });
      return;
    }
    const baseName =
      target.targetPath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.tex$/i, "") || "document";
    const outputPath = await save({
      defaultPath: `${root}/${baseName}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!outputPath) return; // user cancelled

    const bib = state.files.find((f) => f.type === "bib")?.relativePath ?? null;
    setBusy(true);
    const toastId = toast.loading(`Exporting to ${ext.toUpperCase()}…`);
    // Path of a throwaway .tex that carries the AI abstract; cleaned up below.
    let tempRelPath: string | null = null;
    let tempAbsPath: string | null = null;
    try {
      // Persist edits so the export reflects the current buffer.
      await state.saveAllFiles();

      let texPath = target.targetPath;

      // Optionally prepend an AI-generated abstract by exporting a temporary
      // copy of the root .tex — the user's source file is never modified.
      if (withAbstract && canAbstract) {
        const rootEntry = useDocumentStore
          .getState()
          .files.find((f) => f.id === target.rootId);
        const source = rootEntry?.content ?? "";
        if (source) {
          toast.loading("Generating AI abstract…", { id: toastId });
          let abstract = "";
          try {
            abstract = (await generateAbstract(source)).trim();
          } catch {
            // Degrade silently — fall through to a plain export.
            abstract = "";
          }
          const augmented = abstract ? injectAbstract(source, abstract) : null;
          if (augmented) {
            const dir = target.targetPath.includes("/")
              ? target.targetPath.slice(0, target.targetPath.lastIndexOf("/"))
              : "";
            const fileName = `.devprism-export-${Date.now()}.tex`;
            tempRelPath = dir ? `${dir}/${fileName}` : fileName;
            tempAbsPath = await join(root, tempRelPath);
            await writeTexFileContent(tempAbsPath, augmented);
            texPath = tempRelPath;
          } else if (!abstract) {
            toast.message(
              "Couldn't generate an abstract — exporting without it.",
            );
          }
        }
      }

      toast.loading(`Exporting to ${ext.toUpperCase()}…`, { id: toastId });
      await invoke("export_document", {
        projectRoot: root,
        texPath,
        format,
        outputPath,
        bibPath: bib,
      });
      toast.success(`Exported ${baseName}.${ext}`, { id: toastId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showWorkspaceError("Export failed", message, {
        dedupeKey: `export-${format}`,
      });
      toast.dismiss(toastId);
    } finally {
      if (tempAbsPath) {
        try {
          await deleteFileFromDisk(tempAbsPath);
        } catch {
          // Best-effort cleanup of the throwaway export file.
        }
      }
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton
          tooltip="Export document"
          disabled={busy}
          className={cn("size-7 text-muted-foreground")}
        >
          {busy ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <FileDownIcon className="size-4" />
          )}
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Export as</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {FORMATS.map((f) => (
          <DropdownMenuItem
            key={f.id}
            onClick={() => runExport(f.id, f.ext)}
            disabled={busy}
          >
            {f.label}
          </DropdownMenuItem>
        ))}
        {canAbstract && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={withAbstract}
              onCheckedChange={setWithAbstract}
              onSelect={(e) => e.preventDefault()}
              disabled={busy}
            >
              <SparklesIcon className="size-4" />
              Add AI abstract
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
