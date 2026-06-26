import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { TrackChangesActions } from "@/components/workspace/track-changes-actions";
import { toast } from "sonner";
import { useVariantsStore } from "@/stores/variants-store";
import {
  diffVariant,
  type VariantInfo,
  type VariantFileDiff,
} from "@/lib/tauri/variants";
import { lineDiff, diffStats } from "@/lib/line-diff";
import { toDisplayDiffRows } from "@/lib/diff-display";
import { InlineWordDiff } from "@/components/workspace/inline-word-diff";
import { canUseAiAssist, summarizeDiff } from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STATUS_COLOR: Record<VariantFileDiff["status"], string> = {
  added: "#10b981",
  modified: "#f59e0b",
  deleted: "#ef4444",
};

/**
 * Compare a tailored version against its master, file by file, with a
 * dependency-free unified line diff. Read-only — for reviewing what a version
 * changed relative to the canonical document.
 */
export function VersionCompare({
  target,
  onClose,
  masterLabel,
}: {
  target: VariantInfo | null;
  onClose: () => void;
  masterLabel: string;
}) {
  const ownerRoot = useVariantsStore((s) => s.ownerRoot);
  const aiCommentAssist = useSettingsStore((s) => s.aiCommentAssist);
  const [loading, setLoading] = useState(false);
  const [diffs, setDiffs] = useState<VariantFileDiff[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const summaryRequestRef = useRef(0);

  useEffect(() => {
    if (!target || !ownerRoot) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiffs([]);
    setSelected(null);
    setSummary(null);
    summaryRequestRef.current += 1;
    diffVariant(ownerRoot, target.id)
      .then((result) => {
        if (cancelled) return;
        setDiffs(result);
        setSelected(result[0]?.filePath ?? null);
      })
      .catch((err) => !cancelled && setError(String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [target, ownerRoot]);

  const current = useMemo(
    () => diffs.find((d) => d.filePath === selected) ?? null,
    [diffs, selected],
  );

  const lines = useMemo(
    () =>
      current
        ? toDisplayDiffRows(
            lineDiff(current.oldContent ?? "", current.newContent ?? ""),
          )
        : [],
    [current],
  );

  const aiAvailable = aiCommentAssist && canUseAiAssist();

  // Combined unified diff text across all changed files, capped for the model.
  const combinedDiffText = useMemo(() => {
    if (diffs.length === 0) return "";
    const parts: string[] = [];
    for (const d of diffs) {
      const dl = lineDiff(d.oldContent ?? "", d.newContent ?? "");
      const body = dl
        .map((l) =>
          l.type === "add"
            ? `+${l.text}`
            : l.type === "del"
              ? `-${l.text}`
              : ` ${l.text}`,
        )
        .join("\n");
      parts.push(`--- ${d.filePath} (${d.status}) ---\n${body}`);
    }
    return parts.join("\n\n").slice(0, 6000);
  }, [diffs]);

  const handleSummarize = () => {
    if (!aiAvailable || summarizing) return;
    const text = combinedDiffText.trim();
    if (!text) return;
    const id = ++summaryRequestRef.current;
    setSummarizing(true);
    void summarizeDiff(text)
      .then((result) => {
        if (id === summaryRequestRef.current) setSummary(result.trim());
      })
      .catch((err) => {
        if (id === summaryRequestRef.current) {
          toast.error("Couldn't summarize the changes", {
            description: String(err),
          });
        }
      })
      .finally(() => {
        if (id === summaryRequestRef.current) setSummarizing(false);
      });
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[70vh] max-h-[70vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {target?.name} vs {masterLabel}
          </DialogTitle>
          <DialogDescription>
            What this version changed relative to your master document.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="py-6 text-center text-destructive text-sm">{error}</p>
        ) : diffs.length === 0 ? (
          <p className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
            No differences from {masterLabel}.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {ownerRoot && target && diffs.length > 0 && (
              <div className="shrink-0">
                {/* Compile/preview inside the VARIANT's own folder (target.path),
                    not the master root, so the variant's relative
                    \includegraphics/\input assets resolve. The diff content is
                    the variant's newContent. */}
                <TrackChangesActions
                  projectRoot={target.path}
                  diffs={diffs}
                  meta={{
                    fromLabel: masterLabel,
                    toLabel: target.name,
                  }}
                />
              </div>
            )}

            {aiAvailable && (
              <div className="shrink-0">
                {summary ? (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                    <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                      <SparklesIcon className="size-3" />
                      AI summary of changes
                    </span>
                    <p className="mt-1 text-foreground leading-relaxed">
                      {summary}
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleSummarize}
                    disabled={summarizing || combinedDiffText.length === 0}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/80 px-2.5 py-1 text-xs transition-colors",
                      "text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                    )}
                  >
                    {summarizing ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <SparklesIcon className="size-3.5" />
                    )}
                    Summarize changes
                  </button>
                )}
              </div>
            )}

            <div className="flex min-h-0 flex-1 gap-3">
              {/* Changed-file list */}
              <div className="w-56 shrink-0 overflow-auto border-border border-r pr-2">
                {diffs.map((d) => {
                  const stats = diffStats(
                    lineDiff(d.oldContent ?? "", d.newContent ?? ""),
                  );
                  return (
                    <button
                      key={d.filePath}
                      type="button"
                      onClick={() => setSelected(d.filePath)}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        d.filePath === selected
                          ? "bg-accent"
                          : "hover:bg-accent/50",
                      )}
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: STATUS_COLOR[d.status] }}
                        title={d.status}
                        aria-hidden
                      />
                      <span className="flex-1 truncate font-mono">
                        {d.filePath}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {stats.added > 0 && (
                          <span className="text-emerald-600">
                            +{stats.added}
                          </span>
                        )}{" "}
                        {stats.removed > 0 && (
                          <span className="text-red-600">−{stats.removed}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Unified diff for the selected file */}
              <div className="min-w-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30">
                {current && (
                  <pre className="min-w-full font-mono text-xs leading-relaxed">
                    {lines.map((row, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          "flex px-2",
                          row.kind === "word" && "bg-amber-500/10",
                          row.kind === "add" &&
                            "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
                          row.kind === "del" &&
                            "bg-red-500/15 text-red-900 line-through dark:text-red-200",
                        )}
                      >
                        <span className="w-4 shrink-0 select-none text-muted-foreground">
                          {row.kind === "word"
                            ? "~"
                            : row.kind === "add"
                              ? "+"
                              : row.kind === "del"
                                ? "−"
                                : " "}
                        </span>
                        {row.kind === "word" ? (
                          <InlineWordDiff
                            oldLine={row.oldText}
                            newLine={row.newText}
                          />
                        ) : (
                          <span className="whitespace-pre-wrap break-words">
                            {row.text || " "}
                          </span>
                        )}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
