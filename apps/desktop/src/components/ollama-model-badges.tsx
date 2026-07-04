import { EyeIcon, MessageCircleIcon, WrenchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface OllamaModelBadgesProps {
  tools?: boolean;
  vision?: boolean;
  /** Whether capabilities came from Ollama `/api/show` or name heuristics. */
  source?: "api" | "heuristic";
  /** Show chat-only badge when the model lacks tool support. */
  chatOnly?: boolean;
  className?: string;
}

export function OllamaModelBadges({
  tools,
  vision,
  source,
  chatOnly,
  className,
}: OllamaModelBadgesProps) {
  if (!tools && !vision && !source && !chatOnly) return null;
  const badgeClass =
    "inline-flex h-4.5 items-center rounded border border-border px-0.5 text-muted-foreground";

  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
    >
      {source && (
        <span
          className={cn(
            badgeClass,
            "px-1 font-medium text-[9px] uppercase tracking-wide",
            source === "heuristic" &&
              "border-amber-500/40 text-amber-700 dark:text-amber-300",
          )}
          role="img"
          aria-label={
            source === "api"
              ? "Capabilities detected from Ollama API"
              : "Capabilities guessed from model name"
          }
          title={
            source === "api"
              ? "Capabilities detected from Ollama /api/show"
              : "Capabilities guessed from model name — /api/show unavailable"
          }
        >
          {source === "api" ? "detected" : "guessed"}
        </span>
      )}
      {chatOnly && (
        <span
          className={cn(
            badgeClass,
            "gap-0.5 px-1 font-medium text-[9px] text-sky-800 uppercase tracking-wide dark:text-sky-200",
          )}
          role="img"
          aria-label="Chat-only — no tool calling"
          title="Chat-only — this model cannot run file tools"
        >
          <MessageCircleIcon className="size-2.5" aria-hidden="true" />
          chat
        </span>
      )}
      {tools && (
        <span
          className={badgeClass}
          role="img"
          aria-label="Supports tool calling"
          title="Tool calling"
        >
          <WrenchIcon className="size-3" aria-hidden="true" />
        </span>
      )}
      {vision && (
        <span
          className={badgeClass}
          role="img"
          aria-label="Supports vision input"
          title="Vision input"
        >
          <EyeIcon className="size-3" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
