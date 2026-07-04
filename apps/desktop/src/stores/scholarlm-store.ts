import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("scholarlm");

export interface WisdevStatus {
  available: boolean;
  mode: "binary" | "go" | "unavailable";
  binary: string | null;
  dist_binary: boolean;
  go_available: boolean;
  repo_path: string | null;
  detail: string;
}

export interface Hypothesis {
  id: string;
  claim: string;
  confidence_score: number;
  status: string;
}

export interface CoverageGaps {
  sufficient: boolean;
  reasoning: string;
  missing_aspects: string[];
}

export interface ResearchReport {
  final_answer: string;
  original_query: string;
  requested_iterations: number;
  iterations: number;
  converged: boolean;
  stop_reason: string;
  synthesis_mode: string;
  papers_found: number;
  executed_queries: string[];
  hypotheses: Hypothesis[];
  gaps: CoverageGaps;
}

/** Live research-loop progress event streamed from the WisDev runtime. */
export interface StageEvent {
  stage: string;
  message: string;
  degraded: boolean;
}

/** Tauri event channel for {@link StageEvent}s (matches `wisdev.rs`). */
export const WISDEV_STAGE_EVENT = "wisdev-stage";

export type DocFormat = "latex" | "markdown" | "json";

interface ScholarLMConfig {
  /** Path to the WisDev ARC repo (contains `orchestrator/` and `dist/`). */
  repoPath: string;
  /** Optional explicit path to a prebuilt `wisdev` binary. */
  binaryPath: string;
  /** Run the research loop fully local (no cloud/search providers). */
  offline: boolean;
  /** Max iterations of the YOLO research loop (0 = runtime default). */
  maxIterations: number;
}

interface ScholarLMState extends ScholarLMConfig {
  setRepoPath: (path: string) => void;
  setBinaryPath: (path: string) => void;
  setOffline: (offline: boolean) => void;
  setMaxIterations: (n: number) => void;

  check: () => Promise<WisdevStatus>;
  build: () => Promise<string>;
  research: (query: string) => Promise<ResearchReport>;
  docgen: (topic: string, format: DocFormat) => Promise<string>;
}

function invokeArgs(config: ScholarLMConfig) {
  return {
    repoPath: config.repoPath.trim(),
    binary: config.binaryPath.trim() || null,
  };
}

export const useScholarLMStore = create<ScholarLMState>()(
  persist(
    (set, get) => ({
      repoPath: "",
      binaryPath: "",
      offline: true,
      maxIterations: 0,

      setRepoPath: (path) => set({ repoPath: path }),
      setBinaryPath: (path) => set({ binaryPath: path }),
      setOffline: (offline) => set({ offline }),
      setMaxIterations: (n) =>
        set({ maxIterations: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 }),

      check: async () => {
        const status = await invoke<WisdevStatus>(
          "wisdev_check",
          invokeArgs(get()),
        );
        log.info("wisdev check", {
          mode: status.mode,
          available: status.available,
        });
        return status;
      },

      build: async () => {
        const { repoPath } = get();
        return invoke<string>("wisdev_build", {
          repoPath: repoPath.trim(),
        });
      },

      research: async (query) => {
        const state = get();
        return invoke<ResearchReport>("wisdev_research", {
          ...invokeArgs(state),
          query,
          offline: state.offline,
          iterations: state.maxIterations > 0 ? state.maxIterations : null,
        });
      },

      docgen: async (topic, format) => {
        const state = get();
        return invoke<string>("wisdev_docgen", {
          ...invokeArgs(state),
          topic,
          format,
          offline: state.offline,
        });
      },
    }),
    {
      name: "devprism.scholarlm",
      version: 1,
      // v1: earlier builds shipped a hardcoded author-machine path as the
      // default repoPath, which persisted for every user. Clear it so an
      // unconfigured runtime falls back to the "set it in Settings" prompt.
      migrate: (persisted) => {
        const s = (persisted ?? {}) as Partial<ScholarLMConfig>;
        if (s.repoPath === "/Users/bharath/Code/scholarlm/wisdev-arc") {
          return { ...s, repoPath: "" };
        }
        return s;
      },
      partialize: (s) => ({
        repoPath: s.repoPath,
        binaryPath: s.binaryPath,
        offline: s.offline,
        maxIterations: s.maxIterations,
      }),
    },
  ),
);
