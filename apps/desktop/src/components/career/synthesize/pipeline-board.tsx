import {
  AlertTriangleIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  CircleIcon,
  DatabaseIcon,
  SettingsIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dispatchOpenSettings } from "@/lib/home-flow-events";
import { canUseAiAssist } from "@/lib/ai-assist";
import {
  formatStageMs,
  listStageTimings,
  type MatchReport,
  type RunEvent,
  type SynthesisStage,
  type SynthesisStageId,
} from "@/lib/resume-synthesis";
import type { SynthesisReadiness } from "@/lib/resume-synthesis/preflight";
import { RunProgressView, SYNTHESIS_STAGE_ORDER } from "./run-progress-view";

const PIPELINE_STAGES = SYNTHESIS_STAGE_ORDER.filter((id) => id !== "done");

const STAGE_LABELS: Record<string, string> = {
  analyzing: "Analyze JD",
  scoring: "Score blocks",
  selecting: "Select",
  evidence: "Evidence",
  rewriting: "Rewrite",
  critic: "Critic",
  assembling: "Assemble",
};

const STAGE_DESCRIPTIONS: Record<string, string> = {
  analyzing: "Extract must-have skills, seniority, and role title from the JD",
  scoring: "Hybrid-score every career block against the JD facets",
  selecting: "Knapsack-select blocks to fit the template budget",
  evidence: "Retrieve KB chunks and block facts for grounding",
  rewriting: "Distill facts + evidence into tailored bullets",
  critic: "Critique grounding and repair invariant failures",
  assembling: "Assemble LaTeX and compile-verify the PDF",
};

export interface PipelineBoardProps {
  stage: SynthesisStage | null;
  stageId: SynthesisStageId;
  events: RunEvent[];
  report: MatchReport | null;
  elapsedMs: number;
  running: boolean;
  error?: string | null;
  showLivePane?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** When viewing a stored run (affects live-pane / activity gate). */
  viewingStoredRunId?: string | null;
  /** Run gating — when false, show the blocked explainer. */
  canRun: boolean;
  jdLength: number;
  blockCount: number;
  hasPersona: boolean;
  hasTemplate: boolean;
  readiness: SynthesisReadiness | null;
  onFocusJd?: () => void;
  onOpenDatabase?: () => void;
  onImportResume?: () => void;
  onAddKnowledge?: () => void;
}

/**
 * Always-visible synthesis pipeline board.
 * Idle → stage descriptions; running/done → live RunProgressView; blocked → fix checklist.
 */
export function PipelineBoard({
  stage,
  stageId,
  events,
  report,
  elapsedMs,
  running,
  error,
  showLivePane = true,
  collapsed = false,
  onToggleCollapsed,
  viewingStoredRunId,
  canRun,
  jdLength,
  blockCount,
  hasPersona,
  hasTemplate,
  readiness,
  onFocusJd,
  onOpenDatabase,
  onImportResume,
  onAddKnowledge,
}: PipelineBoardProps) {
  const hasActivity =
    running ||
    events.length > 0 ||
    stageId === "done" ||
    stageId === "cancelled" ||
    stageId === "error" ||
    Boolean(viewingStoredRunId);

  const showBlocked = !running && !canRun;

  return (
    <section className="flex flex-col gap-3" aria-label="Synthesis pipeline">
      {showBlocked && (
        <RunBlockedExplainer
          jdLength={jdLength}
          blockCount={blockCount}
          hasPersona={hasPersona}
          hasTemplate={hasTemplate}
          readiness={readiness}
          onFocusJd={onFocusJd}
          onOpenDatabase={onOpenDatabase}
          onImportResume={onImportResume}
          onAddKnowledge={onAddKnowledge}
        />
      )}

      {hasActivity ? (
        <RunProgressView
          stage={stage}
          stageId={stageId}
          events={events}
          report={report}
          elapsedMs={elapsedMs}
          running={running}
          showLivePane={showLivePane}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          error={error}
        />
      ) : (
        <IdleStageBoard report={report} />
      )}
    </section>
  );
}

function IdleStageBoard({ report }: { report: MatchReport | null }) {
  const timings = listStageTimings(report?.stageTimingsMs);

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/10">
      <div className="flex flex-wrap items-center justify-between gap-2 border-border/50 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            Idle
          </Badge>
          <p className="font-medium text-sm">Synthesis pipeline</p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {PIPELINE_STAGES.length} stages · ready when run is unblocked
        </p>
      </div>
      <ol className="divide-y divide-border/40">
        {PIPELINE_STAGES.map((id, index) => {
          const timing = timings.find((t) => t.id === id);
          return (
            <li key={id} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-xs">
                    {STAGE_LABELS[id] ?? id}
                  </span>
                  {timing && (
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      last {formatStageMs(timing.ms)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                  {STAGE_DESCRIPTIONS[id] ?? ""}
                </p>
              </div>
              <CircleIcon className="mt-1 size-3.5 shrink-0 opacity-30" />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type BlockedRow = {
  id: string;
  ok: boolean;
  warn?: boolean;
  label: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
};

function RunBlockedExplainer({
  jdLength,
  blockCount,
  hasPersona,
  hasTemplate,
  readiness,
  onFocusJd,
  onOpenDatabase,
  onImportResume,
  onAddKnowledge,
}: {
  jdLength: number;
  blockCount: number;
  hasPersona: boolean;
  hasTemplate: boolean;
  readiness: SynthesisReadiness | null;
  onFocusJd?: () => void;
  onOpenDatabase?: () => void;
  onImportResume?: () => void;
  onAddKnowledge?: () => void;
}) {
  const jdOk = jdLength >= 40;
  const blocksOk = blockCount > 0;
  const aiOk = readiness?.canRunWithAi ?? canUseAiAssist();
  const embeddingsProbed = readiness != null;
  const embeddingsDown = readiness?.embeddingsDown === true;
  const aiMessage =
    readiness?.text.message ??
    (aiOk ? "AI provider ready" : "Configure an AI chat provider in Settings");

  const rows: BlockedRow[] = [
    {
      id: "jd",
      ok: jdOk,
      label: "Job description",
      detail: jdOk
        ? `${jdLength} characters`
        : `Need at least 40 characters (${jdLength}/40)`,
      actionLabel: jdOk ? undefined : "Focus JD",
      onAction: jdOk ? undefined : onFocusJd,
    },
    {
      id: "blocks",
      ok: blocksOk,
      label: "Experience blocks",
      detail: blocksOk
        ? `${blockCount} block${blockCount === 1 ? "" : "s"} in Career DB`
        : "Add experience blocks before synthesizing",
      actionLabel: blocksOk ? undefined : "Open Database",
      onAction: blocksOk ? undefined : onOpenDatabase,
    },
    {
      id: "persona",
      ok: hasPersona,
      label: "Persona",
      detail: hasPersona ? "Selected" : "Pick a persona in the form above",
    },
    {
      id: "template",
      ok: hasTemplate,
      label: "Template",
      detail: hasTemplate ? "Selected" : "Pick a resume template",
    },
    {
      id: "ai",
      ok: aiOk,
      label: "AI provider",
      detail: aiMessage,
      actionLabel: aiOk ? undefined : "Open AI settings",
      onAction: aiOk ? undefined : () => dispatchOpenSettings("ai"),
    },
    {
      id: "embeddings",
      ok: embeddingsProbed && !embeddingsDown,
      warn: !embeddingsProbed || embeddingsDown,
      label: "Embeddings",
      detail: !embeddingsProbed
        ? "Still checking availability…"
        : embeddingsDown
          ? "Optional — run will continue in degraded mode (weaker scoring / no KB evidence)"
          : "Available for hybrid scoring and evidence",
      actionLabel: embeddingsDown ? "Add knowledge" : undefined,
      onAction: embeddingsDown ? onAddKnowledge : undefined,
    },
  ];

  // Optional secondary CTA when blocks missing
  const showImport = !blocksOk && typeof onImportResume === "function";

  return (
    <div className="rounded-lg border border-amber-600/30 bg-amber-600/5 px-3 py-3">
      <div className="mb-2 flex items-start gap-2">
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
        <div>
          <p className="font-medium text-sm">Run blocked</p>
          <p className="text-[11px] text-muted-foreground">
            Fix the items below — the Run button stays disabled until required
            checks pass. Embeddings are optional.
          </p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.id}
            className={cn(
              "flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs",
              row.ok && !row.warn
                ? "bg-emerald-600/5"
                : row.warn
                  ? "bg-amber-600/10"
                  : "bg-destructive/5",
            )}
          >
            {row.ok && !row.warn ? (
              <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-600" />
            ) : row.warn ? (
              <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-600" />
            ) : (
              <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
            )}
            <span className="min-w-[7rem] font-medium">{row.label}</span>
            <span className="min-w-0 flex-1 text-muted-foreground">
              {row.detail}
            </span>
            {row.actionLabel && row.onAction && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-2 text-[10px]"
                onClick={row.onAction}
              >
                {row.id === "ai" ? (
                  <SettingsIcon className="size-3" />
                ) : row.id === "blocks" ? (
                  <DatabaseIcon className="size-3" />
                ) : row.id === "embeddings" ? (
                  <BookOpenIcon className="size-3" />
                ) : row.id === "jd" ? (
                  <SparklesIcon className="size-3" />
                ) : null}
                {row.actionLabel}
              </Button>
            )}
            {row.id === "blocks" && showImport && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={onImportResume}
              >
                Import resume
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
