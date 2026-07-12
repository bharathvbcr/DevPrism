import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { resolveAiProvider } from "@/lib/ai-assist";
import {
  formatStageMs,
  listStageTimings,
  type MatchReport,
  type RewriteBlockProgress,
  type RunEvent,
  type SynthesisStage,
  type SynthesisStageId,
} from "@/lib/resume-synthesis";

export const SYNTHESIS_STAGE_ORDER: SynthesisStageId[] = [
  "analyzing",
  "scoring",
  "selecting",
  "evidence",
  "rewriting",
  "critic",
  "assembling",
  "done",
];

const STAGE_LABELS: Record<string, string> = {
  analyzing: "Analyze JD",
  scoring: "Score blocks",
  selecting: "Select",
  evidence: "Evidence",
  rewriting: "Rewrite",
  critic: "Critic",
  assembling: "Assemble",
  done: "Done",
};

const FALLBACK_LABELS: Record<string, string> = {
  "llm-failed": "LLM failed",
  "metrics-lost": "Metrics lost",
  "latex-rejected": "LaTeX rejected",
  "over-budget": "Over budget",
  locked: "Locked",
};

function backendLabel(backend: string): string {
  switch (backend) {
    case "ollama":
      return "Ollama";
    case "openai-compat":
      return "OpenAI-compat";
    case "claude-code":
      return "Claude Code";
    case "cursor-cli":
      return "Cursor CLI";
    default:
      return backend;
  }
}

function backendStreams(backend: string): boolean {
  return backend === "ollama" || backend === "openai-compat";
}

function stageEvents(events: RunEvent[], stageId: string): RunEvent[] {
  return events.filter((e) => {
    if (e.type === "error") {
      return !e.stage || e.stage === stageId;
    }
    if (e.type === "stage-start" || e.type === "stage-finish") {
      return e.stage === stageId;
    }
    if (stageId === "rewriting") {
      return (
        e.type === "block-rewrite-start" ||
        e.type === "block-rewrite-stream" ||
        e.type === "block-rewrite-done" ||
        e.type === "bullet-fallback"
      );
    }
    if (stageId === "scoring") {
      return e.type === "embeddings-disabled";
    }
    if (stageId === "evidence") {
      return e.type === "evidence-empty";
    }
    if (stageId === "analyzing") {
      return e.type === "jd-extraction-empty";
    }
    if (stageId === "critic") {
      return e.type === "critic-skipped";
    }
    if (stageId === "assembling") {
      return e.type === "compile-attempt" || e.type === "compile-retry";
    }
    return false;
  });
}

function formatEventLine(e: RunEvent): string {
  switch (e.type) {
    case "stage-start":
      return e.detail ? `Started — ${e.detail}` : "Started";
    case "stage-finish":
      return `Finished in ${formatStageMs(e.durationMs)}${e.detail ? ` — ${e.detail}` : ""}`;
    case "block-rewrite-start":
      return `Rewrite ${e.index}/${e.total}: ${e.label}`;
    case "block-rewrite-done":
      return e.fallbackCount > 0
        ? `Done — ${e.fallbackCount}/${e.bulletCount} fell back`
        : `Done — ${e.bulletCount} bullets kept`;
    case "bullet-fallback":
      return `Fallback ${e.bulletId}: ${FALLBACK_LABELS[e.reason] ?? e.reason}`;
    case "embeddings-disabled":
      return `Embeddings disabled: ${e.reason}`;
    case "evidence-empty":
      return e.blockId ? `No evidence for ${e.blockId}: ${e.reason}` : e.reason;
    case "critic-skipped":
      return e.reason;
    case "jd-extraction-empty":
      return "JD extraction returned empty skills/keywords";
    case "compile-attempt":
      return `Compile: ${e.detail}`;
    case "compile-retry":
      return `Compile retry ${e.attempt}: ${e.detail}`;
    case "error":
      return e.message;
    case "block-rewrite-stream":
      return "Streaming…";
  }
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

export interface RunProgressViewProps {
  stage: SynthesisStage | null;
  stageId: SynthesisStageId;
  events: RunEvent[];
  report: MatchReport | null;
  elapsedMs: number;
  running: boolean;
  /** When false, hide the live output pane (stored / terminal review). */
  showLivePane?: boolean;
  /** Compact header-only when collapsed by parent. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  error?: string | null;
}

/**
 * Dual-pane run activity view: stage timeline (left) + backend-aware live output (right).
 * Survives completion / cancel / error when the parent keeps it mounted.
 */
export function RunProgressView({
  stage,
  stageId,
  events,
  report,
  elapsedMs,
  running,
  showLivePane = true,
  collapsed = false,
  onToggleCollapsed,
  error,
}: RunProgressViewProps) {
  // Re-resolve on each render so provider switches mid-session are reflected.
  const provider = resolveAiProvider();
  const streams = backendStreams(provider.backend);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const progressPct =
    stage?.progress != null
      ? Math.round(Math.min(1, Math.max(0, stage.progress)) * 100)
      : stageId === "done"
        ? 100
        : SYNTHESIS_STAGE_ORDER.includes(stageId)
          ? Math.round(
              ((SYNTHESIS_STAGE_ORDER.indexOf(stageId) + 0.5) /
                SYNTHESIS_STAGE_ORDER.length) *
                100,
            )
          : undefined;

  const outcomeBadge = (() => {
    if (running) return { label: "Running", variant: "default" as const };
    if (stageId === "cancelled")
      return { label: "Cancelled", variant: "outline" as const };
    if (stageId === "error" || error)
      return { label: "Failed", variant: "destructive" as const };
    if (stageId === "done")
      return { label: "Done", variant: "secondary" as const };
    return null;
  })();

  const livePreview = useMemo(() => {
    if (stageId === "rewriting") {
      const active = [...(stage?.blockProgress ?? [])]
        .reverse()
        .find((b) => b.status === "active" && b.streamPreview);
      if (active?.streamPreview) {
        return {
          title: `Live rewrite · ${active.label}`,
          text: active.streamPreview,
        };
      }
    }
    if (
      (stageId === "analyzing" || stageId === "critic") &&
      stage?.streamPreview
    ) {
      return {
        title: stageId === "analyzing" ? "Live JD analysis" : "Live critic",
        text: stage.streamPreview,
      };
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "block-rewrite-stream" && e.preview) {
        return { title: "Rewrite preview", text: e.preview };
      }
    }
    return null;
  }, [stage, stageId, events]);

  const failedStageIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) {
      if (e.type === "error" && e.stage) set.add(e.stage);
    }
    if (stageId === "error" && stage?.id) set.add(stage.id);
    return set;
  }, [events, stageId, stage?.id]);

  const idx = SYNTHESIS_STAGE_ORDER.indexOf(stageId);
  const stageChips = listStageTimings(report?.stageTimingsMs).slice(0, 5);

  if (collapsed) {
    return (
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5 text-left"
        onClick={onToggleCollapsed}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {outcomeBadge && (
            <Badge variant={outcomeBadge.variant} className="text-[10px]">
              {outcomeBadge.label}
            </Badge>
          )}
          <span className="truncate font-medium text-sm">
            {stage?.label ?? "Run activity"}
          </span>
          {elapsedMs > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {formatStageMs(elapsedMs)}
            </span>
          )}
          {stageChips.map((t) => (
            <Badge
              key={t.id}
              variant="outline"
              className="font-mono text-[9px] tabular-nums"
            >
              {t.label} {formatStageMs(t.ms)}
            </Badge>
          ))}
        </div>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div className="flex min-h-[420px] flex-1 flex-col gap-0 overflow-hidden rounded-lg border border-border/60 bg-muted/10">
      <div className="flex flex-wrap items-center justify-between gap-2 border-border/50 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {outcomeBadge && (
            <Badge variant={outcomeBadge.variant} className="text-[10px]">
              {outcomeBadge.label}
            </Badge>
          )}
          <p className="font-medium text-sm">{stage?.label ?? "Working…"}</p>
          {(running || elapsedMs > 0) && (
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {formatStageMs(elapsedMs)}
            </span>
          )}
          {progressPct != null && (
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {progressPct}%
            </span>
          )}
        </div>
        {onToggleCollapsed && !running && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={onToggleCollapsed}
          >
            Collapse
          </Button>
        )}
      </div>

      {(error || stageId === "error") && (
        <div className="border-border/50 border-b bg-destructive/5 px-3 py-2">
          <p className="flex items-start gap-1.5 text-destructive text-xs">
            <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{error ?? stage?.detail ?? "Synthesis failed"}</span>
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="w-[min(42%,380px)] shrink-0 border-border/50 border-r">
          <div className="space-y-3 p-3">
            <Progress value={running ? progressPct : (progressPct ?? 100)} />
            {stage?.detail && (
              <p className="text-muted-foreground text-xs">{stage.detail}</p>
            )}

            <LiveStageTimings
              timings={report?.stageTimingsMs}
              running={running}
            />

            <ol className="space-y-1.5 border-border/40 border-t pt-2">
              {SYNTHESIS_STAGE_ORDER.filter((id) => id !== "done").map((id) => {
                const i = SYNTHESIS_STAGE_ORDER.indexOf(id);
                const done =
                  stageId === "done" ||
                  stageId === "cancelled" ||
                  (idx >= 0 && i < idx);
                const active = id === stageId && running;
                const failed = failedStageIds.has(id);
                const finish = [...events]
                  .reverse()
                  .find(
                    (e): e is Extract<RunEvent, { type: "stage-finish" }> =>
                      e.type === "stage-finish" && e.stage === id,
                  );
                const stageLog = stageEvents(events, id);
                const isOpen = expanded[id] ?? (active || failed);
                const blockProgress =
                  id === "rewriting" ? stage?.blockProgress : undefined;

                return (
                  <li
                    key={id}
                    className={cn(
                      "rounded-md border border-transparent px-2 py-1.5",
                      active && "border-border/60 bg-background/70",
                      failed && "border-destructive/40 bg-destructive/5",
                    )}
                  >
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 text-left"
                      onClick={() =>
                        setExpanded((prev) => ({ ...prev, [id]: !isOpen }))
                      }
                    >
                      <StageStatusIcon
                        done={done && !failed}
                        active={active}
                        failed={failed}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "text-xs",
                              active
                                ? "font-medium text-foreground"
                                : "text-muted-foreground",
                              failed && "font-medium text-destructive",
                              !done && !active && !failed && "opacity-60",
                            )}
                          >
                            {STAGE_LABELS[id] ?? id}
                          </span>
                          {finish && (
                            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                              {formatStageMs(finish.durationMs)}
                            </span>
                          )}
                          {stageLog.length > 0 && (
                            <ChevronDownIcon
                              className={cn(
                                "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
                                isOpen && "rotate-180",
                              )}
                            />
                          )}
                        </div>
                        {finish?.detail && (active || failed) && (
                          <p className="truncate text-[10px] text-muted-foreground">
                            {finish.detail}
                          </p>
                        )}
                      </div>
                    </button>

                    {isOpen && blockProgress && blockProgress.length > 0 && (
                      <BlockRewriteRows
                        blockProgress={blockProgress}
                        events={events}
                      />
                    )}

                    {isOpen && stageLog.length > 0 && (
                      <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto border-border/30 border-l pl-3">
                        {stageLog
                          .filter((e) => e.type !== "block-rewrite-stream")
                          .slice(-12)
                          .map((e, ei) => (
                            <li
                              key={`${e.type}-${e.at}-${ei}`}
                              className={cn(
                                "truncate text-[10px] text-muted-foreground",
                                e.type === "error" && "text-destructive",
                              )}
                            >
                              {formatEventLine(e)}
                            </li>
                          ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </ScrollArea>

        {showLivePane && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-border/50 border-b px-3 py-2">
              <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                {running ? "Live output" : "Last output"}
              </p>
              <Badge variant="outline" className="font-normal text-[10px]">
                {backendLabel(provider.backend)}
                {streams ? " · streaming" : " · no stream"}
              </Badge>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-3">
                {livePreview ? (
                  <div className="space-y-2">
                    <p className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                      {livePreview.title}
                    </p>
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/90 leading-relaxed">
                      {livePreview.text}
                    </pre>
                  </div>
                ) : running ? (
                  <WaitingPanel
                    backend={provider.backend}
                    elapsedMs={elapsedMs}
                    streams={streams}
                    detail={stage?.detail}
                    llmCall={stage?.llmCall}
                  />
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {events.length > 0
                      ? "Expand a stage on the left to review the timeline."
                      : "No activity logged for this run."}
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
}

function WaitingPanel({
  backend,
  elapsedMs,
  streams,
  detail,
  llmCall,
}: {
  backend: string;
  elapsedMs: number;
  streams: boolean;
  detail?: string;
  llmCall?: SynthesisStage["llmCall"];
}) {
  const [tick, setTick] = useState(elapsedMs);
  useEffect(() => {
    setTick(elapsedMs);
  }, [elapsedMs]);

  const callElapsed =
    llmCall != null ? Math.max(0, Date.now() - llmCall.startedAt) : tick;

  if (streams && !llmCall) {
    return (
      <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <Loader2Icon className="size-5 animate-spin text-primary" />
        <p className="text-xs">{detail ?? "Waiting for model tokens…"}</p>
        <p className="font-mono text-[10px] tabular-nums">
          {formatStageMs(tick)}
        </p>
      </div>
    );
  }

  const heartbeatChars = llmCall?.charsReceived ?? 0;
  const nonStreamCopy = !streams
    ? heartbeatChars > 0
      ? `provider does not stream — heartbeat: ${formatChars(heartbeatChars)} received`
      : "provider does not stream — heartbeat: waiting for response"
    : null;

  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-center">
      <Loader2Icon className="size-5 animate-spin text-primary" />
      <div className="space-y-1 px-4">
        <p className="text-foreground text-sm">
          {llmCall
            ? `Waiting on model · ${llmCall.label}`
            : `Waiting for ${backendLabel(backend)}`}
        </p>
        {nonStreamCopy ? (
          <p className="font-mono text-muted-foreground text-xs tabular-nums">
            {formatStageMs(callElapsed)} · {nonStreamCopy}
          </p>
        ) : (
          <p className="font-mono text-muted-foreground text-xs tabular-nums">
            {formatStageMs(callElapsed)}
            {heartbeatChars > 0 ? ` · ${formatChars(heartbeatChars)}` : ""}
          </p>
        )}
        {detail && (
          <p className="text-[11px] text-muted-foreground">{detail}</p>
        )}
      </div>
    </div>
  );
}

function StageStatusIcon({
  done,
  active,
  failed,
}: {
  done: boolean;
  active: boolean;
  failed?: boolean;
}) {
  if (failed) {
    return (
      <XCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
    );
  }
  if (active) {
    return (
      <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
    );
  }
  if (done) {
    return (
      <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
    );
  }
  return <CircleIcon className="mt-0.5 size-3.5 shrink-0 opacity-35" />;
}

function BlockRewriteRows({
  blockProgress,
  events,
}: {
  blockProgress: RewriteBlockProgress[];
  events: RunEvent[];
}) {
  const fallbacksByBlock = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of events) {
      if (e.type !== "bullet-fallback") continue;
      const list = map.get(e.blockId) ?? [];
      list.push(FALLBACK_LABELS[e.reason] ?? e.reason);
      map.set(e.blockId, list);
    }
    return map;
  }, [events]);

  return (
    <ul className="mt-1.5 space-y-1 border-border/30 border-l pl-3">
      {blockProgress.map((b) => {
        const badges = fallbacksByBlock.get(b.blockId) ?? [];
        return (
          <li
            key={b.blockId}
            className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            {b.status === "active" ? (
              <Loader2Icon className="size-3 shrink-0 animate-spin text-primary" />
            ) : b.status === "done" ? (
              <CheckCircle2Icon className="size-3 shrink-0 text-emerald-600" />
            ) : b.status === "error" ? (
              <AlertTriangleIcon className="size-3 shrink-0 text-amber-600" />
            ) : (
              <CircleIcon className="size-3 shrink-0 opacity-40" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                b.status === "active" && "text-foreground",
              )}
            >
              {b.label}
            </span>
            {badges.slice(0, 3).map((label) => (
              <Badge
                key={`${b.blockId}-${label}`}
                variant="outline"
                className="border-amber-600/40 bg-amber-600/10 px-1 py-0 text-[9px] text-amber-800 dark:text-amber-300"
              >
                {label}
              </Badge>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

function LiveStageTimings({
  timings,
  running,
}: {
  timings: MatchReport["stageTimingsMs"];
  running: boolean;
}) {
  const rows = listStageTimings(timings);
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, t) => sum + t.ms, 0);
  return (
    <div className="space-y-1 border-border/40 border-t pt-2">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wide">
        <span>{running ? "Stage timings (live)" : "Stage timings"}</span>
        <span className="font-mono normal-case tabular-nums tracking-normal">
          {formatStageMs(total)}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
        {rows.map((t) => (
          <li
            key={t.id}
            className="font-mono text-[10px] text-muted-foreground tabular-nums"
          >
            {t.label} {formatStageMs(t.ms)}
          </li>
        ))}
      </ul>
    </div>
  );
}
