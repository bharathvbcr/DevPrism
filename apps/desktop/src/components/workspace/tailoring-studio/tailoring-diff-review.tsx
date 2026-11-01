import { useState, useMemo } from "react";
import { lineDiff, diffStats } from "@/lib/line-diff";
import { toDisplayDiffRows } from "@/lib/diff-display";
import { InlineWordDiff } from "@/components/workspace/inline-word-diff";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckCircle2Icon,
  AlertTriangleIcon,
  SparklesIcon,
  ColumnsIcon,
  AlignLeftIcon,
  Loader2Icon,
  FileCheckIcon,
} from "lucide-react";

interface TailoringDiffReviewProps {
  masterContent: string;
  tailoredContent: string;
  atsScore: number;
  metricsPreserved: boolean;
  phasesCompleted: number;
  onAccept: () => Promise<void>;
  onDiscard: () => void;
  accepting?: boolean;
}

export function TailoringDiffReview({
  masterContent,
  tailoredContent,
  atsScore,
  metricsPreserved,
  phasesCompleted,
  onAccept,
  onDiscard,
  accepting = false,
}: TailoringDiffReviewProps) {
  const [viewMode, setViewMode] = useState<"split" | "unified">("unified");

  // Compute diffs
  const rawDiff = useMemo(
    () => lineDiff(masterContent, tailoredContent),
    [masterContent, tailoredContent],
  );

  const displayRows = useMemo(() => toDisplayDiffRows(rawDiff), [rawDiff]);

  const stats = useMemo(() => diffStats(rawDiff), [rawDiff]);

  return (
    <div className="flex h-full min-h-0 flex-col space-y-4">
      {/* Top Banner: Verification Metrics & View Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* ATS Match Gauge */}
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5">
            <SparklesIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
            <div>
              <span className="font-bold text-emerald-700 text-xs dark:text-emerald-300">
                {atsScore}% ATS Match
              </span>
              <span className="ml-1 text-[10px] text-emerald-600/80 dark:text-emerald-400/80">
                (Readiness Scored)
              </span>
            </div>
          </div>

          {/* Metric Preservation Summary */}
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium text-xs",
              metricsPreserved
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            )}
          >
            {metricsPreserved ? (
              <>
                <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />
                <span>Metrics Preserved (checkSafe Passed)</span>
              </>
            ) : (
              <>
                <AlertTriangleIcon className="size-4 text-amber-600 dark:text-amber-400" />
                <span>Metric Invariant Warning</span>
              </>
            )}
          </div>

          {/* Diff Stats */}
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{stats.added}
            </span>
            <span className="text-rose-600 dark:text-rose-400">
              -{stats.removed}
            </span>
            <span>({phasesCompleted} phases)</span>
          </div>
        </div>

        {/* View Mode Switcher */}
        <div className="flex items-center gap-1 rounded-lg border bg-background p-1 text-xs">
          <Button
            type="button"
            variant={viewMode === "unified" ? "default" : "ghost"}
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => setViewMode("unified")}
          >
            <AlignLeftIcon className="size-3" />
            Unified Diff
          </Button>
          <Button
            type="button"
            variant={viewMode === "split" ? "default" : "ghost"}
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => setViewMode("split")}
          >
            <ColumnsIcon className="size-3" />
            Side-by-Side
          </Button>
        </div>
      </div>

      {/* Diff Content Box */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
        {viewMode === "unified" ? (
          /* Unified Diff View */
          <div className="h-full overflow-y-auto font-mono text-xs">
            <table className="w-full border-collapse">
              <tbody>
                {displayRows.map((row, idx) => {
                  if (row.kind === "context") {
                    return (
                      <tr key={idx} className="hover:bg-muted/30">
                        <td className="w-10 select-none border-border/50 border-r px-2 py-0.5 text-right text-[10px] text-muted-foreground">
                          {idx + 1}
                        </td>
                        <td className="px-3 py-0.5 text-muted-foreground">
                          {row.text}
                        </td>
                      </tr>
                    );
                  }

                  if (row.kind === "word") {
                    return (
                      <tr
                        key={idx}
                        className="bg-amber-500/5 hover:bg-amber-500/10"
                      >
                        <td className="w-10 select-none border-border/50 border-r px-2 py-0.5 text-right text-[10px] text-amber-600">
                          {idx + 1}
                        </td>
                        <td className="px-3 py-0.5">
                          <InlineWordDiff
                            oldLine={row.oldText}
                            newLine={row.newText}
                          />
                        </td>
                      </tr>
                    );
                  }

                  // Pure add or del line
                  const isAdd = row.kind === "add";
                  return (
                    <tr
                      key={idx}
                      className={cn(
                        isAdd
                          ? "bg-emerald-500/10 text-emerald-950 hover:bg-emerald-500/15 dark:text-emerald-100"
                          : "bg-rose-500/10 text-rose-950 line-through hover:bg-rose-500/15 dark:text-rose-100",
                      )}
                    >
                      <td className="w-10 select-none border-border/50 border-r px-2 py-0.5 text-right text-[10px] text-muted-foreground">
                        {isAdd ? "+" : "-"}
                      </td>
                      <td className="whitespace-pre-wrap break-words px-3 py-0.5">
                        {row.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          /* Side-by-Side Split View */
          <div className="grid h-full grid-cols-2 divide-x divide-border font-mono text-xs">
            {/* Master Original */}
            <div className="flex flex-col overflow-hidden">
              <div className="border-b bg-muted/40 px-3 py-1.5 font-sans font-semibold text-[11px] text-muted-foreground">
                Canonical Master Document
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <pre className="whitespace-pre-wrap break-words text-muted-foreground leading-relaxed">
                  {masterContent}
                </pre>
              </div>
            </div>

            {/* Tailored Output */}
            <div className="flex flex-col overflow-hidden bg-primary/2">
              <div className="border-b bg-primary/10 px-3 py-1.5 font-sans font-semibold text-[11px] text-primary">
                Tailored Variant Output ({atsScore}% ATS)
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <pre className="whitespace-pre-wrap break-words text-foreground leading-relaxed">
                  {tailoredContent}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="flex items-center justify-between border-t pt-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onDiscard}
          disabled={accepting}
        >
          Discard / Edit Prompt
        </Button>

        <Button
          size="sm"
          onClick={onAccept}
          disabled={accepting}
          className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
        >
          {accepting ? (
            <>
              <Loader2Icon className="size-4 animate-spin" />
              Opening in Editor...
            </>
          ) : (
            <>
              <FileCheckIcon className="size-4" />
              Accept & Open in Editor
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
