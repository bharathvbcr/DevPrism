import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  Loader2Icon,
  SparklesIcon,
  AlertTriangleIcon,
  FolderOpenIcon,
  FileTextIcon,
  ChevronDownIcon,
  HistoryIcon,
  CircleIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InlineBanner } from "@/components/ui/inline-banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { listRuns, type SynthesisRun } from "@/lib/career";
import { listResumeTemplates } from "@/lib/resume-templates";
import {
  atsScoreFromReport,
  coverageHeatLabel,
  coverageHeatLevel,
  extractStoredRunTex,
  formatStageMs,
  listResumeMasterOptions,
  listStageTimings,
  materializeSynthesis,
  parseStoredMatchReport,
  templateDisplayName,
  versionNameFromJd,
  type MatchReport,
  type RewriteBlockProgress,
  type SynthesisStageId,
} from "@/lib/resume-synthesis";
import { useCareerStore } from "@/stores/career-store";
import { useSynthesisStore } from "@/stores/synthesis-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";

const STAGE_ORDER: SynthesisStageId[] = [
  "analyzing",
  "scoring",
  "selecting",
  "evidence",
  "rewriting",
  "critic",
  "assembling",
  "done",
];

const CREATE_NEW = "__create_new__";

export function CareerSynthesizeTab() {
  const personas = useCareerStore((s) => s.personas);
  const blocks = useCareerStore((s) => s.blocks);
  const selectedPersonaId = useCareerStore((s) => s.selectedPersonaId);
  const setSelectedPersonaId = useCareerStore((s) => s.setSelectedPersonaId);

  const running = useSynthesisStore((s) => s.running);
  const stage = useSynthesisStore((s) => s.stage);
  const stageId = useSynthesisStore((s) => s.stageId);
  const error = useSynthesisStore((s) => s.error);
  const result = useSynthesisStore((s) => s.result);
  const report = useSynthesisStore((s) => s.report);
  const viewingStoredRunId = useSynthesisStore((s) => s.viewingStoredRunId);
  const runStartedAt = useSynthesisStore((s) => s.runStartedAt);
  const run = useSynthesisStore((s) => s.run);
  const reset = useSynthesisStore((s) => s.reset);
  const cancel = useSynthesisStore((s) => s.cancel);
  const openStoredReport = useSynthesisStore((s) => s.openStoredReport);

  const resumeHeader = useSettingsStore((s) => s.resumeHeader);
  const setResumeHeader = useSettingsStore((s) => s.setResumeHeader);

  const templates = useMemo(() => listResumeTemplates(), []);
  const masters = useMemo(() => listResumeMasterOptions(), [result, running]);

  const [jdText, setJdText] = useState("");
  const [personaId, setPersonaId] = useState(
    selectedPersonaId ?? personas[0]?.id ?? "",
  );
  const [templateId, setTemplateId] = useState(
    templates[0]?.id ?? "ats-single-column",
  );
  const [masterPath, setMasterPath] = useState<string>(
    () => masters[0]?.path ?? CREATE_NEW,
  );
  const [versionName, setVersionName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [previewTab, setPreviewTab] = useState<"tex" | "pdf">("tex");
  const [runs, setRuns] = useState<SynthesisRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const pdfUrl = useMemo(() => {
    if (!result?.pdfBytes || result.pdfBytes.length === 0) return null;
    const bytes = result.pdfBytes;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], { type: "application/pdf" });
    return URL.createObjectURL(blob);
  }, [result?.pdfBytes]);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const refreshRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const list = await listRuns();
      setRuns(
        [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
      );
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  // Live elapsed clock while synthesis is running.
  useEffect(() => {
    if (!running || !runStartedAt) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - runStartedAt);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - runStartedAt);
    }, 250);
    return () => window.clearInterval(id);
  }, [running, runStartedAt]);

  // Refresh history after a successful run.
  useEffect(() => {
    if (!running && result) {
      void refreshRuns();
    }
  }, [running, result, refreshRuns]);

  // Keep persona in sync when career store loads.
  useEffect(() => {
    if (!personaId && personas[0]) {
      setPersonaId(personas[0].id);
    }
  }, [personas, personaId]);

  // When persona changes, prefer its default template if registered.
  useEffect(() => {
    const persona = personas.find((p) => p.id === personaId);
    if (
      persona?.defaultTemplateId &&
      templates.some((t) => t.id === persona.defaultTemplateId)
    ) {
      setTemplateId(persona.defaultTemplateId);
    }
  }, [personaId, personas, templates]);

  // Suggest version name from JD while the user hasn't edited it.
  useEffect(() => {
    if (nameTouched) return;
    setVersionName(versionNameFromJd(jdText));
  }, [jdText, nameTouched]);

  const canRun =
    !running &&
    jdText.trim().length >= 40 &&
    Boolean(personaId) &&
    Boolean(templateId) &&
    blocks.length > 0;

  const handleRun = async () => {
    if (!canRun) return;
    setSelectedPersonaId(personaId);
    setPreviewTab("tex");
    const out = await run({
      jdText: jdText.trim(),
      personaId,
      templateId,
      header: resumeHeader,
    });
    if (out) {
      if (!nameTouched) {
        setVersionName(versionNameFromJd(jdText, out.report.profile.roleTitle));
      }
      if (out.pdfBytes && out.pdfBytes.length > 0) {
        setPreviewTab("pdf");
      }
      toast.success("Synthesis complete");
    }
  };

  const handleOpenWorkspace = async () => {
    if (!result) return;
    setMaterializing(true);
    try {
      const parentFolder = useProjectStore.getState().lastProjectFolder;
      const materialized = await materializeSynthesis({
        result,
        jdText: jdText.trim(),
        versionName: versionName.trim() || versionNameFromJd(jdText),
        masterProjectPath: masterPath === CREATE_NEW ? null : masterPath,
        parentFolder,
      });
      toast.success(
        materialized.usedProposedChange
          ? "Opened with merge review — accept or reject the generated .tex"
          : `Opened ${materialized.texRelativePath}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setMaterializing(false);
    }
  };

  const handleOpenRun = (runRow: SynthesisRun) => {
    const parsed = parseStoredMatchReport(runRow.reportJson);
    if (!parsed) {
      toast.error("Could not read stored match report");
      return;
    }
    const tex = extractStoredRunTex(runRow.reportJson);
    openStoredReport(runRow.id, parsed, tex);
    toast.success(
      tex
        ? "Opened stored run — Open in workspace available"
        : "Opened stored match report",
    );
  };

  const progressPct =
    stage?.progress != null
      ? Math.round(Math.min(1, Math.max(0, stage.progress)) * 100)
      : stageId === "done"
        ? 100
        : stageId === "error"
          ? undefined
          : STAGE_ORDER.includes(stageId)
            ? Math.round(
                ((STAGE_ORDER.indexOf(stageId) + 0.5) / STAGE_ORDER.length) *
                  100,
              )
            : undefined;

  const showLiveScores =
    report &&
    (running || stageId === "done") &&
    STAGE_ORDER.indexOf(stageId === "done" ? "done" : stageId) >=
      STAGE_ORDER.indexOf("selecting");

  const personaLabel = (id: string) =>
    personas.find((p) => p.id === id)?.label ?? id;

  return (
    <div className="flex h-full min-h-0 gap-4">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex max-w-3xl flex-col gap-5 pr-3 pb-8">
          {blocks.length === 0 && (
            <InlineBanner
              kind="info"
              title="Add experience blocks first"
              message="Synthesis picks from your Career database. Switch to the Database tab and add or import blocks before running."
            />
          )}

          <section className="space-y-2">
            <Label htmlFor="synth-jd">Job description</Label>
            <Textarea
              id="synth-jd"
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              placeholder="Paste the full job description here…"
              className="min-h-[160px] resize-y font-mono text-xs leading-relaxed"
              disabled={running}
            />
            <p className="text-[11px] text-muted-foreground">
              {jdText.trim().length < 40
                ? `Need at least 40 characters (${jdText.trim().length}/40)`
                : `${jdText.trim().length} characters`}
            </p>
          </section>

          <ContactHeaderEditor
            header={resumeHeader}
            onChange={setResumeHeader}
            disabled={running}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <section className="space-y-2">
              <Label>Persona</Label>
              <Select
                value={personaId || undefined}
                onValueChange={setPersonaId}
                disabled={running || personas.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select persona" />
                </SelectTrigger>
                <SelectContent>
                  {personas.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {personas.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Create a persona in the Database tab.
                </p>
              )}
            </section>

            <section className="space-y-2">
              <Label>Template</Label>
              <Select
                value={templateId}
                onValueChange={setTemplateId}
                disabled={running}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {templateDisplayName(t.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <section className="space-y-2">
              <Label>Save as</Label>
              <Select
                value={masterPath}
                onValueChange={setMasterPath}
                disabled={running}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Destination" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CREATE_NEW}>
                    New resume project…
                  </SelectItem>
                  {masters.map((m) => (
                    <SelectItem key={m.path} value={m.path}>
                      {m.isOpen ? `${m.name} (open)` : m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {masterPath === CREATE_NEW
                  ? "Creates a folder with resume.tex under your last project location."
                  : "Creates a tailored variant under the master — master stays untouched."}
              </p>
            </section>

            <section className="space-y-2">
              <Label htmlFor="synth-version-name">Version name</Label>
              <Input
                id="synth-version-name"
                value={versionName}
                onChange={(e) => {
                  setNameTouched(true);
                  setVersionName(e.target.value);
                }}
                placeholder="e.g. Acme — Senior ML Eng"
                disabled={running}
              />
            </section>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => void handleRun()}
              disabled={!canRun}
              className="gap-1.5"
            >
              {running ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              {running ? "Synthesizing…" : "Run synthesis"}
            </Button>
            {running && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => cancel()}
              >
                <XIcon className="size-3.5" />
                Cancel
              </Button>
            )}
            {(result ||
              error ||
              viewingStoredRunId ||
              stageId === "cancelled") &&
              !running && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    reset();
                  }}
                >
                  Clear result
                </Button>
              )}
          </div>

          {(running || stage) && (
            <section className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-sm">
                  {stage?.label ?? "Working…"}
                </p>
                <div className="flex items-center gap-2 font-mono text-muted-foreground text-xs tabular-nums">
                  {running && elapsedMs > 0 && (
                    <span title="Elapsed">{formatStageMs(elapsedMs)}</span>
                  )}
                  {progressPct != null && <span>{progressPct}%</span>}
                </div>
              </div>
              <Progress value={running ? progressPct : (progressPct ?? 100)} />
              {stage?.detail && (
                <p className="text-muted-foreground text-xs">{stage.detail}</p>
              )}
              <LiveStageTimings
                timings={report?.stageTimingsMs}
                running={running}
              />
              <StageChecklist
                current={stageId}
                blockProgress={stage?.blockProgress}
              />
              {stageId === "rewriting" &&
                stage?.blockProgress?.some((b) => b.streamPreview) && (
                  <RewriteStreamPreview
                    blockProgress={stage.blockProgress ?? []}
                  />
                )}
              {(stageId === "analyzing" || stageId === "critic") &&
                stage?.streamPreview && (
                  <StageStreamPreview
                    stageId={stageId}
                    preview={stage.streamPreview}
                  />
                )}
            </section>
          )}

          {showLiveScores && report && (
            <LiveScoredBlocksTable
              report={report}
              live={running && stageId !== "done"}
            />
          )}

          {error && (
            <InlineBanner
              kind="error"
              title="Synthesis failed"
              message={error}
            />
          )}

          {result && !running && (
            <ResultPreviewPanel
              tex={result.tex}
              pdfUrl={pdfUrl}
              previewTab={previewTab}
              onPreviewTab={setPreviewTab}
            />
          )}

          {report && !running && (
            <MatchReportPanel
              report={report}
              compileOk={result?.compileOk ?? true}
              compileSummary={
                result?.compileSummary ??
                (viewingStoredRunId
                  ? result
                    ? "Stored run — rematerialize via Open in workspace"
                    : "Historical run — no stored .tex; re-run synthesis to rematerialize"
                  : "")
              }
              materializing={materializing}
              onOpen={handleOpenWorkspace}
              canOpen={Boolean(result)}
              hideScores
            />
          )}

          <RunsPanel
            runs={runs}
            loading={runsLoading}
            error={runsError}
            activeRunId={viewingStoredRunId}
            personaLabel={personaLabel}
            onRefresh={() => void refreshRuns()}
            onOpen={handleOpenRun}
            disabled={running}
          />
        </div>
      </ScrollArea>
    </div>
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

function ContactHeaderEditor({
  header,
  onChange,
  disabled,
}: {
  header: ReturnType<typeof useSettingsStore.getState>["resumeHeader"];
  onChange: (patch: Partial<typeof header>) => void;
  disabled?: boolean;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div>
        <h2 className="font-medium text-sm">Contact header</h2>
        <p className="text-muted-foreground text-xs">
          Shown at the top of the generated resume. Saved in local settings.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="synth-full-name">Full name</Label>
          <Input
            id="synth-full-name"
            value={header.fullName}
            onChange={(e) => onChange({ fullName: e.target.value })}
            placeholder="Ada Lovelace"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-email">Email</Label>
          <Input
            id="synth-email"
            type="email"
            value={header.email}
            onChange={(e) => onChange({ email: e.target.value })}
            placeholder="ada@example.com"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-phone">Phone</Label>
          <Input
            id="synth-phone"
            value={header.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder="+1 555 0100"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="synth-city">City / region</Label>
          <Input
            id="synth-city"
            value={header.cityRegion}
            onChange={(e) => onChange({ cityRegion: e.target.value })}
            placeholder="San Francisco, CA"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-linkedin">LinkedIn URL</Label>
          <Input
            id="synth-linkedin"
            value={header.linkedinUrl ?? ""}
            onChange={(e) => onChange({ linkedinUrl: e.target.value })}
            placeholder="https://linkedin.com/in/…"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-github">GitHub URL</Label>
          <Input
            id="synth-github"
            value={header.githubUrl ?? ""}
            onChange={(e) => onChange({ githubUrl: e.target.value })}
            placeholder="https://github.com/…"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="synth-portfolio">Portfolio URL</Label>
          <Input
            id="synth-portfolio"
            value={header.portfolioUrl ?? ""}
            onChange={(e) => onChange({ portfolioUrl: e.target.value })}
            placeholder="https://…"
            disabled={disabled}
          />
        </div>
      </div>
    </section>
  );
}

function StageChecklist({
  current,
  blockProgress,
}: {
  current: SynthesisStageId;
  blockProgress?: RewriteBlockProgress[];
}) {
  const labels: Record<string, string> = {
    analyzing: "Analyze JD",
    scoring: "Score blocks",
    selecting: "Select",
    evidence: "Evidence",
    rewriting: "Rewrite",
    critic: "Critic",
    assembling: "Assemble",
    done: "Done",
  };
  const idx = STAGE_ORDER.indexOf(current);
  const showBlocks =
    current === "rewriting" && blockProgress && blockProgress.length > 0;

  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap gap-1.5">
        {STAGE_ORDER.filter((id) => id !== "done").map((id) => {
          const i = STAGE_ORDER.indexOf(id);
          const done = current === "done" || (idx >= 0 && i < idx);
          const active = id === current;
          return (
            <Badge
              key={id}
              variant={done || active ? "default" : "outline"}
              className={cn(
                "font-normal text-[10px]",
                active && "ring-1 ring-ring",
                !done && !active && "opacity-50",
              )}
            >
              {labels[id] ?? id}
            </Badge>
          );
        })}
      </div>
      {showBlocks && (
        <ul className="space-y-1 border-border/40 border-t pt-2">
          {blockProgress.map((b) => (
            <li
              key={b.blockId}
              className="flex items-center gap-2 text-[11px] text-muted-foreground"
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
              <span className="shrink-0 font-mono tabular-nums opacity-70">
                {b.index}/{b.total}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RewriteStreamPreview({
  blockProgress,
}: {
  blockProgress: RewriteBlockProgress[];
}) {
  const active = [...blockProgress]
    .reverse()
    .find((b) => b.status === "active" && b.streamPreview);
  if (!active?.streamPreview) return null;
  return (
    <div className="rounded-md border border-border/50 bg-background/60 p-2">
      <p className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        Live rewrite · {active.label}
      </p>
      <p className="line-clamp-4 font-mono text-[11px] text-foreground/85 leading-relaxed">
        {active.streamPreview}
      </p>
    </div>
  );
}

function StageStreamPreview({
  stageId,
  preview,
}: {
  stageId: "analyzing" | "critic";
  preview: string;
}) {
  const label = stageId === "analyzing" ? "Live JD analysis" : "Live critic";
  return (
    <div className="rounded-md border border-border/50 bg-background/60 p-2">
      <p className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      <p className="line-clamp-4 font-mono text-[11px] text-foreground/85 leading-relaxed">
        {preview}
      </p>
    </div>
  );
}

function LiveScoredBlocksTable({
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

function ResultPreviewPanel({
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
            <FileTextIcon className="size-3.5" />
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

function RunsPanel({
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

function MatchReportPanel({
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
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      {report.repairs.length > 0 && (
        <div className="space-y-1">
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Repairs
          </h3>
          <ul className="space-y-1 text-muted-foreground text-xs">
            {report.repairs.map((r) => (
              <li key={r}>• {r}</li>
            ))}
          </ul>
        </div>
      )}

      <PipelineDetails report={report} />
    </section>
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
