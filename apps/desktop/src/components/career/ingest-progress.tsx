/** Shared progress list for ingest / embed long-running jobs. */

import { CheckCircle2Icon, Loader2Icon, AlertTriangleIcon } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ProcessingPhase, ProcessingProgress } from "@/lib/career";

export type IngestItemStatus =
  | "pending"
  | "active"
  | "done"
  | "deferred"
  | "error";

export interface IngestProgressItem {
  id: string;
  label: string;
  status: IngestItemStatus;
  progress?: ProcessingProgress | null;
  error?: string;
}

const PHASE_LABELS: Record<ProcessingPhase, string> = {
  parse: "Parsing",
  chunk: "Chunking",
  hash: "Hashing",
  upsert: "Saving",
  embed: "Embedding",
  done: "Done",
  error: "Error",
};

export function phaseLabel(phase: ProcessingPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

export function IngestProgressList({
  items,
  title,
}: {
  items: IngestProgressItem[];
  title?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
      {title && <p className="font-medium text-sm">{title}</p>}
      <ul className="space-y-2">
        {items.map((item) => {
          const p = item.progress;
          const pct =
            p && p.total > 0
              ? Math.round(Math.min(1, Math.max(0, p.current / p.total)) * 100)
              : item.status === "done" || item.status === "deferred"
                ? 100
                : item.status === "active"
                  ? 35
                  : 0;
          return (
            <li key={item.id} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                {item.status === "active" ? (
                  <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
                ) : item.status === "done" ? (
                  <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-600" />
                ) : item.status === "deferred" || item.status === "error" ? (
                  <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-600" />
                ) : (
                  <span className="size-3.5 shrink-0 rounded-full border border-border/60" />
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-medium",
                    item.status === "pending" && "text-muted-foreground",
                  )}
                >
                  {item.label}
                </span>
                {p && (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                    {phaseLabel(p.phase)}
                    {p.chunks != null ? ` · ${p.chunks} chunks` : ""}
                  </span>
                )}
              </div>
              {(item.status === "active" ||
                item.status === "done" ||
                item.status === "deferred") && (
                <Progress value={pct} className="h-1" />
              )}
              {(p?.detail || item.error) && (
                <p className="truncate text-[10px] text-muted-foreground">
                  {item.error ?? p?.detail}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
