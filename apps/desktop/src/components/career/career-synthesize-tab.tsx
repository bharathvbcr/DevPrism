import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { InlineBanner } from "@/components/ui/inline-banner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listRuns, type SynthesisRun } from "@/lib/career";
import { listResumeTemplates } from "@/lib/resume-templates";
import {
  extractStoredCompileMeta,
  extractStoredRunEvents,
  extractStoredRunTex,
  listResumeMasterOptions,
  materializeSynthesis,
  parseStoredMatchReport,
  versionNameFromJd,
} from "@/lib/resume-synthesis";
import { useCareerStore } from "@/stores/career-store";
import { useSynthesisStore } from "@/stores/synthesis-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist } from "@/lib/ai-assist";
import {
  AddKnowledgeDialog,
  AiReadinessCard,
  BlockDiffCards,
  CREATE_NEW_MASTER,
  KnowledgePanel,
  LiveScoredBlocksTable,
  MatchReportPanel,
  PipelineBoard,
  ResultPreviewPanel,
  RunsHistory,
  SYNTHESIS_STAGE_ORDER,
  SynthesizeForm,
} from "./synthesize";

/**
 * Career → Synthesize tab.
 *
 * Layout: readiness → knowledge → form → always-visible pipeline board →
 * results (diffs / gaps) → history.
 */
export function CareerSynthesizeTab() {
  const personas = useCareerStore((s) => s.personas);
  const blocks = useCareerStore((s) => s.blocks);
  const selectedPersonaId = useCareerStore((s) => s.selectedPersonaId);
  const setSelectedPersonaId = useCareerStore((s) => s.setSelectedPersonaId);
  const setActiveTab = useCareerStore((s) => s.setActiveTab);
  const requestResumeImport = useCareerStore((s) => s.requestResumeImport);

  const running = useSynthesisStore((s) => s.running);
  const stage = useSynthesisStore((s) => s.stage);
  const stageId = useSynthesisStore((s) => s.stageId);
  const error = useSynthesisStore((s) => s.error);
  const result = useSynthesisStore((s) => s.result);
  const report = useSynthesisStore((s) => s.report);
  const events = useSynthesisStore((s) => s.events);
  const viewingStoredRunId = useSynthesisStore((s) => s.viewingStoredRunId);
  const runStartedAt = useSynthesisStore((s) => s.runStartedAt);
  const pendingJdText = useSynthesisStore((s) => s.pendingJdText);
  const run = useSynthesisStore((s) => s.run);
  const reset = useSynthesisStore((s) => s.reset);
  const cancel = useSynthesisStore((s) => s.cancel);
  const openStoredReport = useSynthesisStore((s) => s.openStoredReport);
  const readiness = useSynthesisStore((s) => s.readiness);
  const refreshReadiness = useSynthesisStore((s) => s.refreshReadiness);

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
    () => masters[0]?.path ?? CREATE_NEW_MASTER,
  );
  const [versionName, setVersionName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [previewTab, setPreviewTab] = useState<"tex" | "pdf">("tex");
  const [runs, setRuns] = useState<SynthesisRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [addKnowledgeOpen, setAddKnowledgeOpen] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(true);
  const autoOpenAttempted = useRef(false);

  // Consume one-shot JD prefill from resume workspace quick actions / deep links.
  useEffect(() => {
    if (pendingJdText == null) return;
    const text = useSynthesisStore.getState().consumePendingJdText();
    if (text) setJdText(text);
  }, [pendingJdText]);

  useEffect(() => {
    void refreshReadiness();
  }, [refreshReadiness]);

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

  useEffect(() => {
    if (!running || !runStartedAt) return;
    setElapsedMs(Date.now() - runStartedAt);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - runStartedAt);
    }, 250);
    return () => window.clearInterval(id);
  }, [running, runStartedAt]);

  useEffect(() => {
    if (running) {
      setActivityExpanded(true);
    }
  }, [running]);

  useEffect(() => {
    if (!running && result) {
      void refreshRuns();
      if (result.runId == null) {
        toast.warning("Run finished but could not be saved to history");
      }
    }
  }, [running, result, refreshRuns]);

  useEffect(() => {
    if (!personaId && personas[0]) {
      setPersonaId(personas[0].id);
    }
  }, [personas, personaId]);

  useEffect(() => {
    const persona = personas.find((p) => p.id === personaId);
    if (
      persona?.defaultTemplateId &&
      templates.some((t) => t.id === persona.defaultTemplateId)
    ) {
      setTemplateId(persona.defaultTemplateId);
    }
  }, [personaId, personas, templates]);

  useEffect(() => {
    if (nameTouched) return;
    setVersionName(versionNameFromJd(jdText));
  }, [jdText, nameTouched]);

  const canRun =
    !running &&
    jdText.trim().length >= 40 &&
    Boolean(personaId) &&
    Boolean(templateId) &&
    blocks.length > 0 &&
    (readiness?.canRunWithAi ?? canUseAiAssist());

  const openRunRow = useCallback(
    (runRow: SynthesisRun, opts?: { silent?: boolean }) => {
      const parsed = parseStoredMatchReport(runRow.reportJson);
      if (!parsed) {
        if (!opts?.silent) {
          toast.error("Could not read stored match report");
        }
        return false;
      }
      const tex = extractStoredRunTex(runRow.reportJson);
      const storedEvents = extractStoredRunEvents(runRow.reportJson);
      const compileMeta = extractStoredCompileMeta(runRow.reportJson);
      openStoredReport(
        runRow.id,
        runRow.templateId,
        parsed,
        tex,
        storedEvents,
        compileMeta,
      );
      setActivityExpanded(true);
      if (!opts?.silent) {
        toast.success(
          tex
            ? "Opened stored run — Open in workspace available"
            : "Opened stored match report",
        );
      }
      return true;
    },
    [openStoredReport],
  );

  const handleOpenRun = useCallback(
    (runRow: SynthesisRun) => {
      openRunRow(runRow);
    },
    [openRunRow],
  );

  // Auto-open the most recent stored run once when the tab is idle.
  useEffect(() => {
    if (autoOpenAttempted.current) return;
    if (running) return;
    if (viewingStoredRunId || report || result) {
      autoOpenAttempted.current = true;
      return;
    }
    if (runsLoading) return;
    autoOpenAttempted.current = true;
    const latest = runs[0];
    if (!latest) return;
    openRunRow(latest, { silent: true });
  }, [
    running,
    viewingStoredRunId,
    report,
    result,
    runsLoading,
    runs,
    openRunRow,
  ]);

  const handleRun = async () => {
    if (!canRun) return;
    if (readiness?.embeddingsDown) {
      const ok = window.confirm(
        "Embeddings are unavailable. Synthesis will run in degraded mode (no knowledge evidence / weaker hybrid scoring). Continue?",
      );
      if (!ok) return;
    }
    setSelectedPersonaId(personaId);
    setPreviewTab("tex");
    setActivityExpanded(true);
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
      return;
    }
    const { stageId: afterId, error: afterError } =
      useSynthesisStore.getState();
    if (afterId === "cancelled") {
      toast.message("Synthesis cancelled");
    } else if (afterError) {
      toast.error(afterError);
    } else {
      toast.error("Synthesis failed");
    }
  };

  const handleCancel = () => {
    cancel();
    toast.message("Cancelling synthesis…");
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
        masterProjectPath: masterPath === CREATE_NEW_MASTER ? null : masterPath,
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

  const focusJd = useCallback(() => {
    const el = document.getElementById(
      "synth-jd",
    ) as HTMLTextAreaElement | null;
    el?.focus();
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const showLiveScores =
    report &&
    (running ||
      stageId === "done" ||
      stageId === "cancelled" ||
      stageId === "error") &&
    SYNTHESIS_STAGE_ORDER.indexOf(stageId === "done" ? "done" : stageId) >=
      SYNTHESIS_STAGE_ORDER.indexOf("selecting");

  const personaLabel = (id: string) =>
    personas.find((p) => p.id === id)?.label ?? id;

  const showClear =
    Boolean(result || error || viewingStoredRunId || stageId === "cancelled") &&
    !running;

  const activityCollapsed = !running && !activityExpanded;

  // Fresh live result has content; stored reopen may only have report.blockDiffs.
  const showBlockDiffs =
    Boolean(result?.content) || Boolean(report?.blockDiffs?.length);

  return (
    <div className="flex h-full min-h-0 gap-4">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex max-w-4xl flex-col gap-5 pr-3 pb-8">
          <AiReadinessCard onAddKnowledge={() => setAddKnowledgeOpen(true)} />
          <KnowledgePanel onAddKnowledge={() => setAddKnowledgeOpen(true)} />

          {blocks.length === 0 && (
            <InlineBanner
              kind="info"
              title="Add experience blocks first"
              message="Synthesis picks from your Career database. Import a resume or open Database to add blocks before running."
              actionLabel="Import resume"
              onAction={() => requestResumeImport()}
              secondaryActionLabel="Open Database"
              onSecondaryAction={() => setActiveTab("database")}
            />
          )}

          <SynthesizeForm
            jdText={jdText}
            onJdTextChange={setJdText}
            personaId={personaId}
            onPersonaIdChange={setPersonaId}
            templateId={templateId}
            onTemplateIdChange={setTemplateId}
            masterPath={masterPath}
            onMasterPathChange={setMasterPath}
            versionName={versionName}
            onVersionNameChange={setVersionName}
            onVersionNameTouched={() => setNameTouched(true)}
            personas={personas}
            templates={templates}
            masters={masters}
            header={resumeHeader}
            onHeaderChange={setResumeHeader}
            running={running}
            canRun={canRun}
            embeddingsDown={Boolean(readiness?.embeddingsDown)}
            onRun={() => void handleRun()}
            onCancel={handleCancel}
            showClear={showClear}
            onClear={() => {
              reset();
              setActivityExpanded(false);
            }}
            onAddKnowledge={() => setAddKnowledgeOpen(true)}
          />

          <PipelineBoard
            stage={stage}
            stageId={stageId}
            events={events}
            report={report}
            elapsedMs={elapsedMs}
            running={running}
            error={error}
            showLivePane={!viewingStoredRunId || running}
            collapsed={activityCollapsed}
            onToggleCollapsed={() => setActivityExpanded((v) => !v)}
            viewingStoredRunId={viewingStoredRunId}
            canRun={canRun}
            jdLength={jdText.trim().length}
            blockCount={blocks.length}
            hasPersona={Boolean(personaId)}
            hasTemplate={Boolean(templateId)}
            readiness={readiness}
            onFocusJd={focusJd}
            onOpenDatabase={() => setActiveTab("database")}
            onImportResume={() => requestResumeImport()}
            onAddKnowledge={() => setAddKnowledgeOpen(true)}
          />

          {showLiveScores && report && !activityCollapsed && (
            <LiveScoredBlocksTable report={report} live={running} />
          )}

          {error && !activityExpanded && (
            <InlineBanner
              kind="error"
              title="Synthesis failed"
              message={error}
              actionLabel="Show activity"
              onAction={() => setActivityExpanded(true)}
            />
          )}

          {result && (
            <ResultPreviewPanel
              tex={result.tex}
              pdfUrl={pdfUrl}
              previewTab={previewTab}
              onPreviewTab={setPreviewTab}
            />
          )}

          {showBlockDiffs && (
            <BlockDiffCards content={result?.content} report={report} />
          )}

          {report && (
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

          <RunsHistory
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
      <AddKnowledgeDialog
        open={addKnowledgeOpen}
        onOpenChange={setAddKnowledgeOpen}
      />
    </div>
  );
}
