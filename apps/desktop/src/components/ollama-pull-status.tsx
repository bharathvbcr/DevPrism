import type { OllamaPullProgress } from "@/lib/ollama";
import { cn } from "@/lib/utils";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} GB`;
}

/** Shared pull progress + error UI for Ollama model install strips. */
export function OllamaPullStatus({
  pulling,
  progress,
  onRetry,
}: {
  pulling: boolean;
  progress: OllamaPullProgress | null;
  onRetry?: () => void;
}) {
  const showProgress =
    pulling || (progress != null && !progress.done && !progress.error);

  if (showProgress && progress && !progress.error) {
    const percent =
      progress.percent ??
      (progress.completed != null &&
      progress.total != null &&
      progress.total > 0
        ? (progress.completed / progress.total) * 100
        : null);
    const byteLabel =
      progress.completed != null && progress.total != null
        ? `${formatBytes(progress.completed)} / ${formatBytes(progress.total)}`
        : null;

    return (
      <div className="mt-2 rounded-md border border-border/50 bg-background/80 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 text-[10px]">
          <span className="truncate font-medium text-foreground">
            Pulling {progress.model}
          </span>
          {percent != null ? (
            <span className="shrink-0 text-muted-foreground">
              {Math.round(percent)}%
            </span>
          ) : (
            byteLabel && (
              <span className="shrink-0 text-muted-foreground">
                {byteLabel}
              </span>
            )
          )}
        </div>
        {progress.status && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground capitalize">
            {progress.status.replace(/_/g, " ")}
          </p>
        )}
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full bg-primary transition-[width]",
              percent == null && pulling && "animate-pulse",
            )}
            style={{
              width:
                percent != null
                  ? `${Math.min(100, percent)}%`
                  : pulling
                    ? "35%"
                    : "0%",
            }}
          />
        </div>
      </div>
    );
  }

  if (progress?.error) {
    return (
      <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
        <p>Pull failed: {progress.error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 font-medium text-destructive underline underline-offset-2 hover:text-destructive/80"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  return null;
}
