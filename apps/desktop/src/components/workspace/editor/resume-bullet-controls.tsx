import { useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MinusIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import {
  bulletAdjustSummary,
  bulletTargetLabel,
  clampResumeBulletCount,
  MAX_RESUME_BULLETS,
  MIN_RESUME_BULLETS,
} from "@/lib/resume-bullets";
import type {
  BulletItemDiagnostic,
  ResumeBulletSuggestion,
} from "@/lib/resume-bullet-suggestions";
import { formatBulletIssue } from "@/lib/resume-bullet-suggestions";
import { cn } from "@/lib/utils";

const VISIBLE_SUGGESTIONS = 4;

export interface ResumeBulletControlsProps {
  currentCount: number;
  targetCount: number;
  suggestedTargets: number[];
  recommendedTarget?: number | null;
  roleLabel?: string | null;
  qualityScore?: number | null;
  qualityGrade?: string | null;
  insights?: string[];
  bulletDiagnostics?: BulletItemDiagnostic[];
  aiSuggestions?: ResumeBulletSuggestion[];
  insightSuggestionIds?: Record<string, string | null>;
  /** When set, selection is a subset of a larger bullet block. */
  blockItemCount?: number | null;
  shortcutHint?: string;
  onTargetChange: (count: number) => void;
  onApply: () => void;
  onQuickApply: (count: number) => void;
  onAiSuggestion: (suggestion: ResumeBulletSuggestion) => void;
  onInsightClick?: (insight: string) => void;
  onSelectAllInBlock?: () => void;
  pending?: boolean;
}

function scoreColor(score: number): string {
  if (score >= 85) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 65) return "text-sky-600 dark:text-sky-400";
  if (score >= 45) return "text-amber-600 dark:text-amber-400";
  return "text-destructive";
}

export function ResumeBulletControls({
  currentCount,
  targetCount,
  suggestedTargets,
  recommendedTarget,
  roleLabel,
  qualityScore,
  qualityGrade,
  insights = [],
  bulletDiagnostics = [],
  aiSuggestions = [],
  insightSuggestionIds = {},
  blockItemCount,
  shortcutHint,
  onTargetChange,
  onApply,
  onQuickApply,
  onAiSuggestion,
  onInsightClick,
  onSelectAllInBlock,
  pending = false,
}: ResumeBulletControlsProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  const effectiveCount =
    blockItemCount != null && blockItemCount > currentCount
      ? blockItemCount
      : currentCount;
  const isPartial = blockItemCount != null && blockItemCount > currentCount;
  const canDecrease = targetCount > MIN_RESUME_BULLETS;
  const canIncrease = targetCount < MAX_RESUME_BULLETS;
  const canApply = targetCount !== effectiveCount && !pending;
  const showRecommended =
    recommendedTarget != null &&
    recommendedTarget !== effectiveCount &&
    recommendedTarget === targetCount;

  const visibleSuggestions = showAllSuggestions
    ? aiSuggestions
    : aiSuggestions.slice(0, VISIBLE_SUGGESTIONS);
  const hiddenSuggestionCount = Math.max(
    0,
    aiSuggestions.length - VISIBLE_SUGGESTIONS,
  );

  const flaggedBullets = bulletDiagnostics.filter((d) => d.issues.length > 0);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canApply) {
      e.preventDefault();
      onApply();
    }
  };

  return (
    <div className="border-border border-t px-2 py-2" onKeyDown={handleKeyDown}>
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-[11px] text-foreground">
              Bullet count
            </span>
            {qualityScore != null && qualityGrade && (
              <span
                className={cn(
                  "rounded-full bg-muted px-1.5 py-0.5 font-medium text-[10px] tabular-nums",
                  scoreColor(qualityScore),
                )}
                title={`Local quality: ${qualityScore}/100 (${qualityGrade}) — based on metrics, verbs, length`}
              >
                {qualityScore} · {qualityGrade}
              </span>
            )}
          </div>
          {roleLabel && (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {roleLabel}
            </p>
          )}
        </div>
        {isPartial && onSelectAllInBlock && (
          <button
            type="button"
            disabled={pending}
            onClick={onSelectAllInBlock}
            className="shrink-0 text-[10px] text-primary hover:underline disabled:opacity-30"
          >
            Select all {blockItemCount}
          </button>
        )}
      </div>

      {shortcutHint && (
        <p className="mb-1 text-[10px] text-muted-foreground">{shortcutHint}</p>
      )}

      {insights.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {insights.map((insight) => {
            const fixId = insightSuggestionIds[insight];
            const clickable = !!fixId && !!onInsightClick;
            return (
              <button
                key={insight}
                type="button"
                disabled={pending || !clickable}
                onClick={() => clickable && onInsightClick?.(insight)}
                aria-label={clickable ? `Apply fix: ${insight}` : insight}
                title={clickable ? "Apply suggested fix" : insight}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] leading-snug",
                  clickable
                    ? "bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
                    : "text-amber-700 dark:text-amber-400",
                  clickable &&
                    "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/50",
                  !clickable && "cursor-default",
                )}
              >
                {insight}
              </button>
            );
          })}
        </div>
      )}

      {isPartial && (
        <p className="mb-1.5 text-[10px] text-muted-foreground">
          {currentCount} of {blockItemCount} selected — Apply uses all{" "}
          {blockItemCount} in this role
        </p>
      )}

      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {bulletAdjustSummary(effectiveCount, targetCount)}
          {showRecommended && (
            <span className="ml-1 text-primary">· suggested</span>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Fewer bullets"
            disabled={!canDecrease || pending}
            onClick={() =>
              onTargetChange(clampResumeBulletCount(targetCount - 1))
            }
            className={cn(
              "flex size-6 items-center justify-center rounded-md outline-none transition-colors",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30",
            )}
          >
            <MinusIcon className="size-3.5" />
          </button>
          <span
            className={cn(
              "min-w-[1.25rem] text-center font-medium text-sm tabular-nums",
              showRecommended ? "text-primary" : "text-foreground",
            )}
          >
            {targetCount}
          </span>
          <button
            type="button"
            aria-label="More bullets"
            disabled={!canIncrease || pending}
            onClick={() =>
              onTargetChange(clampResumeBulletCount(targetCount + 1))
            }
            className={cn(
              "flex size-6 items-center justify-center rounded-md outline-none transition-colors",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30",
            )}
          >
            <PlusIcon className="size-3.5" />
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={onApply}
            aria-label="Apply bullet count change"
            title="Enter"
            className={cn(
              "ml-1 rounded-md px-2 py-0.5 font-medium text-[11px] transition-colors",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30",
            )}
          >
            Apply
          </button>
        </div>
      </div>

      {suggestedTargets.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {suggestedTargets.map((n) => (
            <button
              key={n}
              type="button"
              disabled={pending}
              onClick={() => onQuickApply(n)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                n === targetCount
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border/70 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
                recommendedTarget === n &&
                  "border-primary/40 bg-primary/5 text-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30",
              )}
            >
              {bulletTargetLabel(n)}
            </button>
          ))}
        </div>
      )}

      {flaggedBullets.length > 0 && (
        <div className="mb-1.5 border-border border-t pt-1.5">
          <button
            type="button"
            onClick={() => setShowDiagnostics((v) => !v)}
            aria-label={`Per-bullet issues (${flaggedBullets.length})`}
            aria-expanded={showDiagnostics}
            className="flex w-full items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider"
          >
            <span>Per-bullet issues ({flaggedBullets.length})</span>
            {showDiagnostics ? (
              <ChevronUpIcon className="size-3" />
            ) : (
              <ChevronDownIcon className="size-3" />
            )}
          </button>
          {showDiagnostics && (
            <ul className="mt-1 space-y-1">
              {flaggedBullets.map((item) => (
                <li
                  key={item.index}
                  className="text-[10px] text-muted-foreground leading-snug"
                >
                  <span className="text-foreground">{item.index}.</span>{" "}
                  {item.preview}
                  <span className="text-amber-700 dark:text-amber-400">
                    {" "}
                    — {item.issues.map(formatBulletIssue).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {aiSuggestions.length > 0 && (
        <div className="border-border border-t pt-1.5">
          <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
            <SparklesIcon className="size-3" />
            AI suggestions
          </div>
          <div className="flex flex-wrap gap-1">
            {visibleSuggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                disabled={pending}
                title={suggestion.title}
                aria-label={suggestion.title}
                onClick={() => onAiSuggestion(suggestion)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  suggestion.kind === "count"
                    ? "border-violet-500/30 bg-violet-500/10 text-foreground hover:bg-violet-500/15"
                    : suggestion.kind === "advice"
                      ? "border-border/70 text-muted-foreground hover:bg-muted hover:text-foreground"
                      : "border-sky-500/30 bg-sky-500/10 text-foreground hover:bg-sky-500/15",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30",
                )}
              >
                {suggestion.label}
              </button>
            ))}
          </div>
          {hiddenSuggestionCount > 0 && !showAllSuggestions && (
            <button
              type="button"
              disabled={pending}
              onClick={() => setShowAllSuggestions(true)}
              className="mt-1 text-[10px] text-primary hover:underline disabled:opacity-30"
            >
              Show {hiddenSuggestionCount} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
