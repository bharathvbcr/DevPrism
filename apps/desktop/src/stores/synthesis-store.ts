import { create } from "zustand";
import {
  isAbortError,
  synthesizeResume,
  type MatchReport,
  type SynthesisResult,
  type SynthesisStage,
  type SynthesisStageId,
  type SynthesizeResumeOptions,
} from "@/lib/resume-synthesis";

interface SynthesisState {
  running: boolean;
  stage: SynthesisStage | null;
  stageId: SynthesisStageId;
  error: string | null;
  result: SynthesisResult | null;
  report: MatchReport | null;
  /** Last JD text (for UI re-display). */
  lastJdText: string;
  lastPersonaId: string | null;
  lastTemplateId: string | null;
  /** When viewing a historical run (no live pdf). */
  viewingStoredRunId: string | null;
  /** Wall-clock start of the active run (for live elapsed display). */
  runStartedAt: number | null;
  abortController: AbortController | null;

  setStage: (stage: SynthesisStage) => void;
  reset: () => void;
  /** Abort the in-flight synthesis (no-op when idle). */
  cancel: () => void;
  /**
   * Re-open a MatchReport from `career_list_runs` without re-running.
   * When `tex` is provided, Open-in-workspace rematerialization is enabled.
   */
  openStoredReport: (
    runId: string,
    report: MatchReport,
    tex?: string | null,
  ) => void;
  run: (
    options: Omit<SynthesizeResumeOptions, "onProgress" | "signal"> & {
      onProgress?: SynthesizeResumeOptions["onProgress"];
    },
  ) => Promise<SynthesisResult | null>;
}

export const useSynthesisStore = create<SynthesisState>((set, get) => ({
  running: false,
  stage: null,
  stageId: "idle",
  error: null,
  result: null,
  report: null,
  lastJdText: "",
  lastPersonaId: null,
  lastTemplateId: null,
  viewingStoredRunId: null,
  runStartedAt: null,
  abortController: null,

  setStage: (stage) =>
    set((state) => ({
      stage,
      stageId: stage.id,
      // Promote partial report as soon as selection finishes (live scored table).
      report: stage.partialReport ?? state.report,
    })),

  reset: () => {
    get().abortController?.abort();
    set({
      running: false,
      stage: null,
      stageId: "idle",
      error: null,
      result: null,
      report: null,
      viewingStoredRunId: null,
      runStartedAt: null,
      abortController: null,
    });
  },

  cancel: () => {
    const { running, abortController } = get();
    if (!running || !abortController) return;
    abortController.abort();
  },

  openStoredReport: (runId, report, tex) => {
    const hasTex = typeof tex === "string" && tex.trim().length > 0;
    set({
      running: false,
      error: null,
      report,
      viewingStoredRunId: runId,
      runStartedAt: null,
      abortController: null,
      result: hasTex
        ? {
            runId,
            tex: tex!,
            content: {
              header: {
                fullName: "",
                cityRegion: "",
                email: "",
                phone: "",
              },
              skills: [],
              experience: [],
            },
            report,
            compileOk: true,
            compileSummary: "Stored run — rematerialized from career DB",
            pdfBytes: null,
          }
        : null,
      stage: {
        id: "done",
        label: "Stored run",
        detail: hasTex
          ? "Opened from run history (Open in workspace available)"
          : "Opened from run history (no stored .tex — re-run to rematerialize)",
        progress: 1,
        partialReport: report,
      },
      stageId: "done",
    });
  },

  run: async (options) => {
    if (get().running) return null;
    const abortController = new AbortController();
    set({
      running: true,
      error: null,
      result: null,
      report: null,
      viewingStoredRunId: null,
      runStartedAt: Date.now(),
      abortController,
      stageId: "analyzing",
      stage: { id: "analyzing", label: "Starting…", progress: 0 },
      lastJdText: options.jdText,
      lastPersonaId: options.personaId,
      lastTemplateId: options.templateId,
    });

    try {
      const result = await synthesizeResume({
        ...options,
        signal: abortController.signal,
        onProgress: (stage) => {
          set((state) => ({
            stage,
            stageId: stage.id,
            report: stage.partialReport ?? state.report,
          }));
          options.onProgress?.(stage);
        },
      });
      set({
        running: false,
        result,
        report: result.report,
        viewingStoredRunId: null,
        abortController: null,
        stage: {
          id: "done",
          label: "Done",
          progress: 1,
          partialReport: result.report,
        },
        stageId: "done",
      });
      return result;
    } catch (err) {
      if (isAbortError(err)) {
        set({
          running: false,
          error: null,
          abortController: null,
          stage: {
            id: "cancelled",
            label: "Cancelled",
            detail: "Synthesis stopped",
            progress: get().stage?.progress,
            partialReport: get().report ?? undefined,
          },
          stageId: "cancelled",
        });
        return null;
      }
      const message = err instanceof Error ? err.message : String(err);
      set({
        running: false,
        error: message,
        abortController: null,
        stage: { id: "error", label: "Failed", detail: message },
        stageId: "error",
      });
      return null;
    }
  },
}));
