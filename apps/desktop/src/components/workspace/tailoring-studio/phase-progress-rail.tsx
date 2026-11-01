import { TAILORING_PHASES } from "./types";
import { cn } from "@/lib/utils";
import {
  CheckCircle2Icon,
  Loader2Icon,
  CircleIcon,
  XCircleIcon,
  ClockIcon,
  BanIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface PhaseProgressRailProps {
  currentPhase: number;
  progressPercent: number; // 0.0 to 1.0
  stepDescription?: string;
  elapsedSeconds: number;
  status: "idle" | "running" | "completed" | "cancelled" | "error";
  onCancel: () => void;
  cancelling?: boolean;
}

export function PhaseProgressRail({
  currentPhase,
  progressPercent,
  stepDescription,
  elapsedSeconds,
  status,
  onCancel,
  cancelling = false,
}: PhaseProgressRailProps) {
  const safePercent = Number.isFinite(progressPercent) ? progressPercent : 0;
  const normalized = safePercent > 1 ? safePercent / 100 : safePercent;
  const percentInt = Math.min(100, Math.max(0, Math.round(normalized * 100)));

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-xs">
      {/* Top Header: Title, Percent, Timer, and Cancel */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-xs tracking-tight">
            Tailoring Pipeline Execution
          </span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono font-semibold text-primary text-xs">
            {percentInt}%
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 font-mono text-muted-foreground text-xs">
            <ClockIcon className="size-3.5" />
            <span>{formatTime(elapsedSeconds)}</span>
          </div>

          {status === "running" && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-destructive text-xs hover:bg-destructive/10 hover:text-destructive"
              onClick={onCancel}
              disabled={cancelling}
            >
              {cancelling ? (
                <>
                  <Loader2Icon className="mr-1.5 size-3 animate-spin" />
                  Cancelling...
                </>
              ) : (
                <>
                  <BanIcon className="mr-1.5 size-3" />
                  Cancel Run
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full transition-all duration-300 ease-out",
            status === "cancelled"
              ? "bg-zinc-400"
              : status === "error"
                ? "bg-destructive"
                : "bg-primary",
          )}
          style={{ width: `${percentInt}%` }}
        />
      </div>

      {/* Active Step description */}
      {stepDescription && status === "running" && (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Loader2Icon className="size-3.5 animate-spin text-primary" />
          <span className="truncate">{stepDescription}</span>
        </div>
      )}

      {/* 4 Phases Stepper */}
      <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2 lg:grid-cols-4">
        {TAILORING_PHASES.map((p) => {
          const isCompleted = status === "completed" || currentPhase > p.phase;
          const isCurrent = status === "running" && currentPhase === p.phase;
          const isCancelled =
            status === "cancelled" && currentPhase === p.phase;

          return (
            <div
              key={p.phase}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-2.5 text-xs transition-colors",
                isCurrent
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : isCompleted
                    ? "border-emerald-500/30 bg-emerald-500/5 text-muted-foreground"
                    : isCancelled
                      ? "border-zinc-400 bg-zinc-100/50 dark:bg-zinc-900/50"
                      : "border-border/60 bg-muted/20 text-muted-foreground/70",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[11px] text-foreground">
                  {p.title}
                </span>
                {isCompleted ? (
                  <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                ) : isCurrent ? (
                  <Loader2Icon className="size-3.5 animate-spin text-primary" />
                ) : isCancelled ? (
                  <XCircleIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <CircleIcon className="size-3.5 text-muted-foreground/40" />
                )}
              </div>
              <p className="line-clamp-2 text-[10px] text-muted-foreground">
                {p.description}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
