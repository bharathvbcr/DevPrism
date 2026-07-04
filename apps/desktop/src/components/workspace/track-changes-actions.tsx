import { useState } from "react";
import { FileDownIcon, FileTextIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  exportTrackedTex,
  previewTrackedChangesPdf,
  toTexFileDiffs,
  type TrackChangesGranularity,
  type TrackChangesMeta,
} from "@/lib/track-changes-export";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import { cn } from "@/lib/utils";

interface TrackChangesActionsProps {
  projectRoot: string;
  diffs: Array<{
    file_path?: string;
    filePath?: string;
    status: string;
    old_content?: string | null;
    oldContent?: string | null;
    new_content?: string | null;
    newContent?: string | null;
  }>;
  meta: TrackChangesMeta;
  /** compact = icon-only buttons for the history review bar */
  variant?: "default" | "compact";
  className?: string;
}

/**
 * Export a tracked .tex or compile a PDF that shows deletions (strikethrough)
 * and additions (colored) for a version comparison.
 */
export function TrackChangesActions({
  projectRoot,
  diffs,
  meta,
  variant = "default",
  className,
}: TrackChangesActionsProps) {
  const [busy, setBusy] = useState<"export" | "preview" | null>(null);
  const [granularity, setGranularity] =
    useState<TrackChangesGranularity>("word");
  const texDiffs = toTexFileDiffs(diffs).filter((d) =>
    d.filePath.toLowerCase().endsWith(".tex"),
  );

  if (texDiffs.length === 0) return null;

  const run = async (action: "export" | "preview") => {
    setBusy(action);
    try {
      if (action === "export") {
        await exportTrackedTex(projectRoot, texDiffs, meta, granularity);
      } else {
        await previewTrackedChangesPdf(
          projectRoot,
          texDiffs,
          meta,
          granularity,
        );
      }
    } catch (err) {
      if (action === "export") {
        const message = err instanceof Error ? err.message : String(err);
        showWorkspaceError("Track changes export failed", message, {
          dedupeKey: "track-changes-export-inline",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const granularityToggle = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            variant === "compact" ? "h-6 px-2 text-xs" : "h-8 px-2 text-xs",
          )}
          disabled={busy !== null}
        >
          {granularity === "word" ? "Word-level" : "Line-level"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={granularity === "word"}
          onCheckedChange={(checked) =>
            setGranularity(checked ? "word" : "line")
          }
        >
          Word-level changes
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={granularity === "line"}
          onCheckedChange={(checked) =>
            setGranularity(checked ? "line" : "word")
          }
        >
          Line-level changes
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (variant === "compact") {
    return (
      <div className={cn("flex items-center gap-0.5", className)}>
        {granularityToggle}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={busy !== null}
          onClick={() => run("export")}
          title="Export tracked changes as .tex (shareable)"
        >
          {busy === "export" ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <FileDownIcon className="size-3" />
          )}
          Export .tex
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={busy !== null}
          onClick={() => run("preview")}
          title="Compile PDF with strikethrough deletions and colored additions"
        >
          {busy === "preview" ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <FileTextIcon className="size-3" />
          )}
          Preview PDF
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {granularityToggle}
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={busy !== null}
        onClick={() => run("export")}
      >
        {busy === "export" ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <FileDownIcon className="size-3.5" />
        )}
        Export tracked .tex
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={busy !== null}
        onClick={() => run("preview")}
      >
        {busy === "preview" ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <FileTextIcon className="size-3.5" />
        )}
        Preview changes PDF
      </Button>
    </div>
  );
}
