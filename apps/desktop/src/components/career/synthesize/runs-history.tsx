import { HistoryIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  atsScoreFromReport,
  parseStoredMatchReport,
} from "@/lib/resume-synthesis";
import type { SynthesisRun } from "@/lib/career";

export function RunsHistory({
  runs,
  loading,
  error,
  activeRunId,
  personaLabel,
  onRefresh,
  onOpen,
  disabled,
}: {
  runs: SynthesisRun[];
  loading: boolean;
  error: string | null;
  activeRunId: string | null;
  personaLabel: (id: string) => string;
  onRefresh: () => void;
  onOpen: (run: SynthesisRun) => void;
  disabled?: boolean;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HistoryIcon className="size-3.5 text-muted-foreground" />
          <div>
            <h2 className="font-medium text-sm">Runs</h2>
            <p className="text-muted-foreground text-xs">
              Past synthesis runs from the career database.
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || disabled}
          onClick={onRefresh}
        >
          {loading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            "Refresh"
          )}
        </Button>
      </div>
      {error && (
        <p className="text-amber-700 text-xs dark:text-amber-400">{error}</p>
      )}
      {runs.length === 0 && !loading && !error && (
        <p className="text-muted-foreground text-xs">No saved runs yet.</p>
      )}
      <ul className="space-y-1.5">
        {runs.slice(0, 20).map((r) => {
          const stored = parseStoredMatchReport(r.reportJson);
          const ats = atsScoreFromReport(stored);
          const role = stored?.profile.roleTitle;
          const when = new Date(r.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          const active = activeRunId === r.id;
          return (
            <li key={r.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpen(r)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  active ? "bg-primary/10" : "bg-muted/30 hover:bg-muted/50",
                  disabled && "opacity-50",
                )}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate font-medium">
                    {role || "Untitled role"}
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {personaLabel(r.personaId)}
                    </span>
                  </p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {r.jdHash} · {when}
                  </p>
                </div>
                {ats != null && (
                  <Badge
                    variant="outline"
                    className="shrink-0 font-mono text-[10px] tabular-nums"
                  >
                    ATS {ats}%
                  </Badge>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
