import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  FolderOpenIcon,
  Loader2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/ui/inline-banner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type {
  RenderedBlock,
  ResumeContent,
} from "@/lib/resume-templates/types";
import {
  atsScoreFromReport,
  coverageHeatLabel,
  coverageHeatLevel,
  formatStageMs,
  listStageTimings,
  type BlockBulletDiff,
  type GapAnalysis,
  type GapCoverageStatus,
  type MatchReport,
} from "@/lib/resume-synthesis";

const FALLBACK_REASON_LABEL: Record<string, string> = {
  "llm-failed": "LLM failed",
  "metrics-lost": "metrics lost",
  "latex-rejected": "LaTeX rejected",
  "over-budget": "over budget",
  locked: "locked",
  "invalid-provenance": "invalid provenance",
};

export function MatchReportPanel({
  report,
  compileOk,
  compileSummary,
  materializing,
  onOpen,
  hideScores,
  canOpen = true,
}: {
  report: MatchReport;
  compileOk: boolean;
  compileSummary: string;
  materializing: boolean;
  onOpen: () => void;
  hideScores?: boolean;
  canOpen?: boolean;
}) {
  const selected = report.scored.filter((s) => s.selected);
  const skipped = report.scored
    .filter((s) => !s.selected)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const aiCount = report.aiRewrittenCount;
  const fallbackCount = report.canonicalFallbackCount;
  const totalBullets =
    aiCount != null && fallbackCount != null ? aiCount + fallbackCount : null;
  const ats = atsScoreFromReport(report);

  const reasonSummary = (() => {
    const reasons = report.bulletFallbackReasons ?? [];
    if (reasons.length === 0) return null;
    const counts = new Map<string, number>();
    for (const r of reasons) {
      counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([reason, n]) => `${n}× ${FALLBACK_REASON_LABEL[reason] ?? reason}`)
      .join(", ");
  })();

  return (
    <section className="space-y-4 rounded-lg border border-border/70 bg-card/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-sm">Match report</h2>
          <p className="text-muted-foreground text-xs">
            {report.profile.roleTitle || "Role"}
            {report.profile.seniority ? ` · ${report.profile.seniority}` : ""}
            {" · "}
            {selected.length} block{selected.length === 1 ? "" : "s"} selected
          </p>
          {totalBullets != null && totalBullets > 0 && (
            <p className="mt-1 text-foreground/90 text-xs">
              <span className="font-medium tabular-nums">
                {aiCount} of {totalBullets}
              </span>{" "}
              bullets AI-rewritten
              {fallbackCount != null && fallbackCount > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  · {fallbackCount} used canonical
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ats != null && (
            <Badge
              variant="outline"
              className="font-mono text-[10px] tabular-nums"
              title="Programmatic ATS keyword coverage"
            >
              ATS {ats}%
            </Badge>
          )}
          {compileOk ? (
            <Badge className="gap-1 bg-emerald-600/90 text-white">
              <CheckCircle2Icon className="size-3" />
              Compile verified
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-amber-600">
              <AlertTriangleIcon className="size-3" />
              Compile needs review
            </Badge>
          )}
          {canOpen && (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={materializing}
              onClick={onOpen}
            >
              {materializing ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <FolderOpenIcon className="size-3.5" />
              )}
              Open in workspace
            </Button>
          )}
        </div>
      </div>

      {fallbackCount != null && fallbackCount > 0 && reasonSummary && (
        <InlineBanner
          kind="warning"
          title={`${fallbackCount} bullet${fallbackCount === 1 ? "" : "s"} fell back to canonical`}
          message={reasonSummary}
        />
      )}

      {report.semanticMatchingDisabled && (
        <InlineBanner
          kind="info"
          title="Semantic matching disabled"
          message="No embedding provider available — scoring used skills and tags only."
        />
      )}

      {report.notices.length > 0 && (
        <ul className="space-y-1 text-muted-foreground text-xs">
          {report.notices.map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      )}

      {compileSummary && (
        <p className="text-[11px] text-muted-foreground">{compileSummary}</p>
      )}

      <GapAnalysisPanel gapAnalysis={report.gapAnalysis} />

      <BlockEvidenceSection report={report} />

      {!hideScores && (
        <>
          <div className="space-y-2">
            <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Selected blocks
            </h3>
            <div className="space-y-1.5">
              {selected.map((s) => (
                <ScoreRow key={s.blockId} row={s} highlight />
              ))}
              {selected.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No blocks selected.
                </p>
              )}
            </div>
          </div>

          {skipped.length > 0 && (
            <div className="space-y-2">
              <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Other scored blocks
              </h3>
              <div className="space-y-1.5 opacity-80">
                {skipped.map((s) => (
                  <ScoreRow key={s.blockId} row={s} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <CoverageHeatmap report={report} />

      {report.critique && (
        <div className="space-y-2 border-border/50 border-t pt-3">
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Critique
          </h3>
          <p className="text-xs">
            ATS keyword coverage:{" "}
            <span className="font-medium tabular-nums">
              {Math.round(report.critique.atsCoveragePct)}%
            </span>
            {report.critique.llmSkipped && (
              <span className="text-muted-foreground">
                {" "}
                (programmatic — LLM critic skipped)
              </span>
            )}
          </p>
          {report.critique.programmaticFlags.length > 0 && (
            <ul className="space-y-1 text-amber-700 text-xs dark:text-amber-400">
              {report.critique.programmaticFlags.map((f) => (
                <li key={f}>• {f}</li>
              ))}
            </ul>
          )}
          {report.critique.verdicts.some((v) => v.flags.length > 0) && (
            <ul className="space-y-1 text-muted-foreground text-xs">
              {report.critique.verdicts
                .filter((v) => v.flags.length > 0)
                .slice(0, 6)
                .map((v) => (
                  <li key={`${v.blockId}-${v.bulletId}`}>
                    • {v.flags.join("; ")}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {(report.repairs?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Repairs
          </h3>
          <ul className="space-y-1 text-muted-foreground text-xs">
            {report.repairs?.map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
        </div>
      )}

      <PipelineDetails report={report} />
    </section>
  );
}

function BlockEvidenceSection({ report }: { report: MatchReport }) {
  const rows = report.blockEvidence;
  if (!rows) return null;

  const totalChunks = rows.reduce((sum, r) => sum + r.chunks.length, 0);
  const grounded = rows.filter((r) => r.chunks.length > 0);

  if (totalChunks === 0) {
    return (
      <p className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-muted-foreground text-xs">
        No knowledge-base evidence used
        {report.semanticMatchingDisabled
          ? " (no KB / embeddings down)"
          : " (no matching chunks)"}
        .
      </p>
    );
  }

  return (
    <details className="group rounded-md border border-border/40 bg-muted/10 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
        <span className="font-medium">
          Grounded by {totalChunks} knowledge chunk
          {totalChunks === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground">
          across {grounded.length} block{grounded.length === 1 ? "" : "s"}
        </span>
      </summary>
      <ul className="mt-2 space-y-2">
        {rows.map((row) => (
          <li key={row.blockId} className="text-xs">
            <p className="font-medium">
              {row.title}
              {row.org ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {row.org}
                </span>
              ) : null}
              <span className="ml-1 font-normal text-muted-foreground">
                ({row.chunks.length})
              </span>
            </p>
            {row.chunks.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No chunks</p>
            ) : (
              <ul className="mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
                {row.chunks.map((c, i) => (
                  <li key={`${row.blockId}-${i}`} className="line-clamp-2">
                    • {c}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function LiveScoredBlocksTable({
  report,
  live,
}: {
  report: MatchReport;
  live?: boolean;
}) {
  const selected = report.scored.filter((s) => s.selected);
  const skipped = report.scored
    .filter((s) => !s.selected)
    .sort((a, b) => b.score - a.score);

  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-card/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-medium text-sm">
            {live ? "Live match scores" : "Match scores"}
          </h2>
          <p className="text-muted-foreground text-xs">
            {selected.length} selected · {skipped.length} skipped
            {report.profile.roleTitle ? ` · ${report.profile.roleTitle}` : ""}
          </p>
        </div>
        {live && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Loader2Icon className="size-3 animate-spin" />
            Updating
          </Badge>
        )}
      </div>
      <div className="space-y-1.5">
        {selected.map((s) => (
          <ScoreRow key={s.blockId} row={s} highlight />
        ))}
        {skipped.slice(0, 12).map((s) => (
          <ScoreRow key={s.blockId} row={s} />
        ))}
        {report.scored.length === 0 && (
          <p className="text-muted-foreground text-xs">No scored blocks yet.</p>
        )}
      </div>
    </section>
  );
}

export function ResultPreviewPanel({
  tex,
  pdfUrl,
  previewTab,
  onPreviewTab,
}: {
  tex: string;
  pdfUrl: string | null;
  previewTab: "tex" | "pdf";
  onPreviewTab: (tab: "tex" | "pdf") => void;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/70 bg-card/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium text-sm">Result preview</h2>
          <p className="text-muted-foreground text-xs">
            Review before opening in the workspace.
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={previewTab === "tex" ? "default" : "outline"}
            className="gap-1.5"
            onClick={() => onPreviewTab("tex")}
          >
            .tex
          </Button>
          <Button
            size="sm"
            variant={previewTab === "pdf" ? "default" : "outline"}
            className="gap-1.5"
            disabled={!pdfUrl}
            onClick={() => onPreviewTab("pdf")}
            title={pdfUrl ? undefined : "PDF not available from compile"}
          >
            PDF
          </Button>
        </div>
      </div>

      {previewTab === "tex" ? (
        <ScrollArea className="h-[320px] rounded-md border border-border/50 bg-muted/20">
          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-foreground/90 leading-relaxed">
            {tex}
          </pre>
        </ScrollArea>
      ) : pdfUrl ? (
        <iframe
          title="Resume PDF preview"
          src={pdfUrl}
          className="h-[420px] w-full rounded-md border border-border/50 bg-background"
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          No PDF bytes returned from compile verify.
        </p>
      )}
    </section>
  );
}

function CoverageHeatmap({ report }: { report: MatchReport }) {
  const rows = report.mustHaveCoverage;
  if (!rows || rows.length === 0) {
    if (report.profile.mustHaveSkills.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1">
        {report.profile.mustHaveSkills.map((sk) => (
          <Badge key={sk} variant="secondary" className="text-[10px]">
            {sk}
          </Badge>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Must-have coverage
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((row) => {
          const level = coverageHeatLevel(row);
          return (
            <span
              key={row.skill}
              title={coverageHeatLabel(level)}
              className={cn(
                "inline-flex items-center rounded-md px-2 py-0.5 font-medium text-[10px]",
                level === "selection" &&
                  "bg-emerald-600/15 text-emerald-800 dark:text-emerald-300",
                level === "rewrite" &&
                  "bg-sky-600/15 text-sky-800 dark:text-sky-300",
                level === "uncovered" &&
                  "bg-amber-600/15 text-amber-800 dark:text-amber-300",
              )}
            >
              {row.skill}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-emerald-600/50" />
          Selection
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-sky-600/50" />
          After rewrite
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-amber-600/50" />
          Uncovered
        </span>
      </div>
    </div>
  );
}

function PipelineDetails({ report }: { report: MatchReport }) {
  const timings = listStageTimings(report.stageTimingsMs);
  if (timings.length === 0) return null;
  const total = timings.reduce((sum, t) => sum + t.ms, 0);
  return (
    <details className="group border-border/50 border-t pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
        Pipeline details
        <span className="ml-auto font-mono font-normal normal-case tabular-nums tracking-normal opacity-80">
          {formatStageMs(total)} total
        </span>
      </summary>
      <ul className="mt-2 space-y-1">
        {timings.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between gap-3 text-muted-foreground text-xs"
          >
            <span>{t.label}</span>
            <span className="font-mono tabular-nums">
              {formatStageMs(t.ms)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ScoreRow({
  row,
  highlight,
}: {
  row: MatchReport["scored"][number];
  highlight?: boolean;
}) {
  const pct = Math.round(row.score * 100);
  const emb = Math.round(row.components.embedding * 100);
  const skills = Math.round(row.components.skills * 100);
  const persona = Math.round(row.components.persona * 100);
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-1.5 text-xs",
        highlight ? "bg-primary/5" : "bg-muted/30",
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate font-medium">
            {row.title}
            {row.org ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {row.org}
              </span>
            ) : null}
          </p>
          {highlight ? (
            <Badge variant="secondary" className="shrink-0 text-[9px]">
              selected
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 text-[9px] opacity-70">
              skipped
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground tabular-nums">
          <ScoreBar label="emb" value={emb} />
          <ScoreBar label="skills" value={skills} />
          <ScoreBar label="persona" value={persona} />
        </div>
      </div>
      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
        {pct}
      </span>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <span
        className="inline-block h-1 w-10 overflow-hidden rounded-full bg-muted"
        title={`${value}%`}
      >
        <span
          className="block h-full bg-primary/70"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </span>
      <span>{value}</span>
    </span>
  );
}

function collectRenderedBlocks(content: ResumeContent): RenderedBlock[] {
  return [
    ...content.experience,
    ...(content.projects ?? []),
    ...(content.education ?? []),
    ...(content.publications ?? []),
    ...(content.leadership ?? []),
  ];
}

/**
 * Build per-block before/after diffs from ResumeContent and optional MatchReport
 * provenance / precomputed blockDiffs.
 */
export function buildBlockDiffs(
  content: ResumeContent | null | undefined,
  report?: MatchReport | null,
): BlockBulletDiff[] {
  if (report?.blockDiffs && report.blockDiffs.length > 0) {
    return report.blockDiffs;
  }
  if (!content) return [];

  const provenance = report?.bulletProvenance ?? [];
  return collectRenderedBlocks(content)
    .map((block) => {
      const blockProv = provenance.filter((p) => p.blockId === block.id);
      const bullets = block.bullets.map((tailored, i) => {
        const canonical = block.canonicalBullets?.[i] ?? tailored;
        const bulletId = `${block.id}:${i}`;
        const matched =
          provenance.find(
            (p) => p.blockId === block.id && p.bulletId === bulletId,
          ) ?? blockProv[i];
        return {
          bulletId,
          canonical,
          tailored,
          changed: canonical.trim() !== tailored.trim(),
          provenance: matched
            ? {
                sourceFactIds: matched.sourceFactIds,
                sourceBulletId: matched.sourceBulletId,
                evidenceSnippets: matched.evidenceSnippets,
              }
            : undefined,
        };
      });
      return {
        blockId: block.id,
        title: block.title,
        org: block.org,
        bullets,
      };
    })
    .filter((d) => d.bullets.length > 0);
}

/** "What's missing" panel — only renders when gapAnalysis is present. */
export function GapAnalysisPanel({
  gapAnalysis,
}: {
  gapAnalysis?: GapAnalysis | null;
}) {
  const items = gapAnalysis?.items;
  if (!items || items.length === 0) return null;

  const missing = items.filter((i) => i.status === "missing");
  const weak = items.filter((i) => i.status === "weak");
  const covered = items.filter((i) => i.status === "covered");

  return (
    <section className="space-y-3 rounded-lg border border-border/70 bg-card/40 p-4">
      <div>
        <h2 className="font-medium text-sm">What&apos;s missing</h2>
        <p className="text-muted-foreground text-xs">
          {gapAnalysis?.summary ??
            `${missing.length} missing · ${weak.length} weak · ${covered.length} covered`}
        </p>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.skill}
            className={cn(
              "rounded-md border px-3 py-2 text-xs",
              gapStatusClass(item.status),
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <GapStatusBadge status={item.status} />
              <span className="font-medium">{item.skill}</span>
            </div>
            {item.evidence && item.evidence.length > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {item.evidence.slice(0, 3).join(" · ")}
              </p>
            )}
            {item.suggestion && (
              <p className="mt-1 text-[11px] text-foreground/90">
                {item.suggestion}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function gapStatusClass(status: GapCoverageStatus): string {
  switch (status) {
    case "covered":
      return "border-emerald-600/30 bg-emerald-600/5";
    case "weak":
      return "border-amber-600/30 bg-amber-600/5";
    case "missing":
      return "border-destructive/30 bg-destructive/5";
  }
}

function GapStatusBadge({ status }: { status: GapCoverageStatus }) {
  const label =
    status === "covered" ? "Covered" : status === "weak" ? "Weak" : "Missing";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[9px]",
        status === "covered" &&
          "border-emerald-600/40 text-emerald-800 dark:text-emerald-300",
        status === "weak" &&
          "border-amber-600/40 text-amber-800 dark:text-amber-300",
        status === "missing" && "border-destructive/40 text-destructive",
      )}
    >
      {label}
    </Badge>
  );
}

/** Per-block before/after (canonical vs tailored) with optional provenance chips. */
export function BlockDiffCards({
  content,
  report,
}: {
  content?: ResumeContent | null;
  report?: MatchReport | null;
}) {
  const diffs = buildBlockDiffs(content, report);
  if (diffs.length === 0) return null;

  const changedCount = diffs.reduce(
    (n, d) => n + d.bullets.filter((b) => b.changed).length,
    0,
  );

  return (
    <section className="space-y-3 rounded-lg border border-border/70 bg-card/40 p-4">
      <div>
        <h2 className="font-medium text-sm">Before / after</h2>
        <p className="text-muted-foreground text-xs">
          Canonical vs tailored bullets
          {changedCount > 0
            ? ` · ${changedCount} changed across ${diffs.length} block${diffs.length === 1 ? "" : "s"}`
            : ` · ${diffs.length} block${diffs.length === 1 ? "" : "s"}`}
        </p>
      </div>
      <div className="space-y-3">
        {diffs.map((block) => (
          <BlockDiffCard key={block.blockId} block={block} />
        ))}
      </div>
    </section>
  );
}

function BlockDiffCard({ block }: { block: BlockBulletDiff }) {
  const changed = block.bullets.filter((b) => b.changed).length;
  return (
    <details
      className="group rounded-md border border-border/50 bg-muted/10"
      open={changed > 0}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {block.title}
          {block.org ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {block.org}
            </span>
          ) : null}
        </span>
        <Badge variant="outline" className="shrink-0 text-[9px] tabular-nums">
          {changed}/{block.bullets.length} changed
        </Badge>
      </summary>
      <ul className="space-y-2 border-border/40 border-t px-3 py-2">
        {block.bullets.map((b, i) => (
          <li key={b.bulletId ?? i} className="space-y-1.5 text-[11px]">
            {b.changed ? (
              <div className="grid gap-1.5 sm:grid-cols-2">
                <div className="rounded-md border border-border/40 bg-muted/30 px-2 py-1.5">
                  <p className="mb-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                    Canonical
                  </p>
                  <p className="whitespace-pre-wrap text-muted-foreground leading-relaxed">
                    {b.canonical}
                  </p>
                </div>
                <div className="rounded-md border border-sky-600/30 bg-sky-600/5 px-2 py-1.5">
                  <p className="mb-0.5 font-medium text-[10px] text-sky-800 uppercase tracking-wide dark:text-sky-300">
                    Tailored
                  </p>
                  <p className="whitespace-pre-wrap leading-relaxed">
                    {b.tailored}
                  </p>
                </div>
              </div>
            ) : (
              <p className="rounded-md border border-border/30 bg-muted/20 px-2 py-1.5 text-muted-foreground leading-relaxed">
                {b.tailored}
              </p>
            )}
            <ProvenanceChips provenance={b.provenance} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function ProvenanceChips({
  provenance,
}: {
  provenance?: BlockBulletDiff["bullets"][number]["provenance"];
}) {
  if (!provenance) return null;
  const facts = provenance.sourceFactIds ?? [];
  const evidence = provenance.evidenceSnippets ?? [];
  if (
    facts.length === 0 &&
    evidence.length === 0 &&
    !provenance.sourceBulletId
  ) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {facts.map((id) => (
        <Badge
          key={`fact-${id}`}
          variant="secondary"
          className="max-w-[14rem] truncate font-mono text-[9px]"
          title={id}
        >
          fact {id.length > 12 ? `${id.slice(0, 10)}…` : id}
        </Badge>
      ))}
      {provenance.sourceBulletId && (
        <Badge variant="outline" className="font-mono text-[9px]">
          from {provenance.sourceBulletId}
        </Badge>
      )}
      {evidence.slice(0, 2).map((snip, i) => (
        <Badge
          key={`ev-${i}`}
          variant="outline"
          className="max-w-[16rem] truncate text-[9px]"
          title={snip}
        >
          evidence: {snip.slice(0, 48)}
          {snip.length > 48 ? "…" : ""}
        </Badge>
      ))}
    </div>
  );
}
