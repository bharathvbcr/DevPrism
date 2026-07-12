import { create } from "zustand";
import {
  isAbortError,
  synthesizeResume,
  type MatchReport,
  type RunEvent,
  type SynthesisResult,
  type SynthesisStage,
  type SynthesisStageId,
  type SynthesizeResumeOptions,
} from "@/lib/resume-synthesis";
import {
  checkSynthesisReadiness,
  type SynthesisReadiness,
} from "@/lib/resume-synthesis/preflight";

const PROGRESS_THROTTLE_MS = 100;

interface SynthesisState {
  running: boolean;
  stage: SynthesisStage | null;
  stageId: SynthesisStageId;
  error: string | null;
  result: SynthesisResult | null;
  report: MatchReport | null;
  /** Append-only run telemetry for the activity view. */
  events: RunEvent[];
  /** Last JD text (for UI re-display). */
  lastJdText: string;
  lastPersonaId: string | null;
  lastTemplateId: string | null;
  /**
   * One-shot JD prefill for the Synthesize tab (e.g. from resume quick action).
   * Call `consumePendingJdText()` on mount / when the tab becomes active.
   */
  pendingJdText: string | null;
  /** When viewing a historical run (no live pdf). */
  viewingStoredRunId: string | null;
  /** Wall-clock start of the active run (for live elapsed display). */
  runStartedAt: number | null;
  abortController: AbortController | null;
  /** Latest AI / data readiness snapshot for the Synthesize tab. */
  readiness: SynthesisReadiness | null;
  readinessLoading: boolean;

  setStage: (stage: SynthesisStage) => void;
  reset: () => void;
  /** Queue JD text for the Synthesize tab to pick up (does not clear on reset). */
  setPendingJdText: (text: string | null) => void;
  /**
   * Return and clear any pending JD prefill. Safe to call when null.
   * Synthesize tab should apply the result to its local JD textarea.
   */
  consumePendingJdText: () => string | null;
  /** Refresh preflight (chat, embeddings, career/KB data). */
  refreshReadiness: (options?: { forceEmbedProbe?: boolean }) => Promise<void>;
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
    events?: RunEvent[] | null,
    compile?: { compileOk: boolean; compileSummary: string } | null,
  ) => void;
  run: (
    options: Omit<
      SynthesizeResumeOptions,
      "onProgress" | "onEvent" | "signal"
    > & {
      onProgress?: SynthesizeResumeOptions["onProgress"];
      onEvent?: SynthesizeResumeOptions["onEvent"];
    },
  ) => Promise<SynthesisResult | null>;
}

function isTerminalStage(id: SynthesisStageId): boolean {
  return id === "done" || id === "error" || id === "cancelled";
}

export const useSynthesisStore = create<SynthesisState>((set, get) => ({
  running: false,
  stage: null,
  stageId: "idle",
  error: null,
  result: null,
  report: null,
  events: [],
  lastJdText: "",
  lastPersonaId: null,
  lastTemplateId: null,
  pendingJdText: null,
  viewingStoredRunId: null,
  runStartedAt: null,
  abortController: null,
  readiness: null,
  readinessLoading: false,

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
      events: [],
      viewingStoredRunId: null,
      runStartedAt: null,
      abortController: null,
    });
  },

  setPendingJdText: (text) =>
    set({
      pendingJdText:
        typeof text === "string" && text.trim().length > 0 ? text : null,
    }),

  consumePendingJdText: () => {
    const pending = get().pendingJdText;
    if (pending == null) return null;
    set({ pendingJdText: null });
    return pending;
  },

  refreshReadiness: async (options) => {
    set({ readinessLoading: true });
    try {
      const readiness = await checkSynthesisReadiness({
        forceEmbedProbe: options?.forceEmbedProbe,
      });
      set({ readiness, readinessLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        readinessLoading: false,
        readiness: {
          checkedAt: Date.now(),
          text: {
            status: "error",
            available: false,
            backend: null,
            model: null,
            streams: false,
            issue: "no-provider",
            message: `Readiness check failed: ${message}`,
          },
          embeddings: {
            status: "warn",
            available: false,
            issue: "error",
            message: "Could not probe embeddings",
          },
          data: {
            status: "warn",
            blockCount: 0,
            blocksMissingEmbeddings: 0,
            kbSourceCount: 0,
            kbChunksMissingEmbeddings: 0,
            message: "Could not load career data",
          },
          canRunWithAi: false,
          embeddingsDown: true,
        },
      });
    }
  },

  cancel: () => {
    const { running, abortController } = get();
    if (!running || !abortController) return;
    abortController.abort();
  },

  openStoredReport: (runId, report, tex, events, compile) => {
    const hasTex = typeof tex === "string" && tex.trim().length > 0;
    const compileOk = compile?.compileOk ?? true;
    const compileSummary =
      compile?.compileSummary ??
      (hasTex
        ? "Stored run — rematerialized from career DB"
        : "Opened from run history");
    set({
      running: false,
      error: null,
      report,
      events: Array.isArray(events) ? events : [],
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
            compileOk,
            compileSummary,
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
      events: [],
      viewingStoredRunId: null,
      runStartedAt: Date.now(),
      abortController,
      stageId: "analyzing",
      stage: { id: "analyzing", label: "Starting…", progress: 0 },
      lastJdText: options.jdText,
      lastPersonaId: options.personaId,
      lastTemplateId: options.templateId,
    });

    let pendingStage: SynthesisStage | null = null;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    const flushProgress = () => {
      if (throttleTimer != null) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      if (!pendingStage) return;
      const stage = pendingStage;
      pendingStage = null;
      set((state) => ({
        stage,
        stageId: stage.id,
        report: stage.partialReport ?? state.report,
      }));
      options.onProgress?.(stage);
    };

    const applyProgress = (stage: SynthesisStage) => {
      pendingStage = stage;
      if (isTerminalStage(stage.id)) {
        flushProgress();
        return;
      }
      if (throttleTimer == null) {
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          flushProgress();
        }, PROGRESS_THROTTLE_MS);
      }
    };

    try {
      const result = await synthesizeResume({
        ...options,
        signal: abortController.signal,
        onProgress: applyProgress,
        onEvent: (event) => {
          set((state) => ({ events: [...state.events, event] }));
          options.onEvent?.(event);
        },
      });
      flushProgress();
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
      flushProgress();
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
      set((state) => ({
        running: false,
        error: message,
        abortController: null,
        events: [
          ...state.events,
          {
            type: "error",
            message,
            at: Date.now(),
            stage: state.stageId,
          },
        ],
        stage: { id: "error", label: "Failed", detail: message },
        stageId: "error",
      }));
      return null;
    }
  },
}));
