import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyBlock, createEmptyPersona } from "@/lib/career";
import type {
  RunEvent,
  SynthesisStage,
  SynthesisStageId,
} from "@/lib/resume-synthesis";
import type { SynthesisReadiness } from "@/lib/resume-synthesis/preflight";

const cancel = vi.fn();
const reset = vi.fn();
const run = vi.fn();
const openStoredReport = vi.fn();
const refreshReadiness = vi.fn(async () => {});
const setSelectedPersonaId = vi.fn();
const setResumeHeader = vi.fn();

type SynthSlice = {
  running: boolean;
  stage: SynthesisStage | null;
  stageId: SynthesisStageId;
  error: string | null;
  result: null;
  report: null;
  events: RunEvent[];
  viewingStoredRunId: string | null;
  runStartedAt: number | null;
  pendingJdText: string | null;
  readiness: SynthesisReadiness | null;
  readinessLoading: boolean;
  run: typeof run;
  reset: typeof reset;
  cancel: typeof cancel;
  openStoredReport: typeof openStoredReport;
  refreshReadiness: typeof refreshReadiness;
  consumePendingJdText: () => string | null;
};

let synthState: SynthSlice;

const persona = createEmptyPersona({ id: "ai", label: "AI / ML" });
const block = createEmptyBlock({
  id: "exp_1",
  title: "ML Engineer",
  org: "Acme",
});

const settingsState = {
  resumeHeader: {
    fullName: "",
    email: "",
    phone: "",
    cityRegion: "",
  },
  setResumeHeader,
  aiAssistEnabled: true,
  nativeAgentEnabled: true,
  nativeNumCtx: null as number | null,
  nativeTemperature: null as number | null,
  nativeOllamaModel: "llama3.2",
};

vi.mock("@/stores/synthesis-store", () => {
  const useSynthesisStore = Object.assign(
    (selector: (s: SynthSlice) => unknown) => selector(synthState),
    { getState: () => synthState },
  );
  return { useSynthesisStore };
});

vi.mock("@/stores/career-store", () => ({
  useCareerStore: (
    selector: (s: {
      personas: (typeof persona)[];
      blocks: (typeof block)[];
      selectedPersonaId: string | null;
      setSelectedPersonaId: typeof setSelectedPersonaId;
      setActiveTab: (tab: string) => void;
      requestResumeImport: () => void;
      refreshMissingBlockEmbeddings: () => Promise<void>;
    }) => unknown,
  ) =>
    selector({
      personas: [persona],
      blocks: [block],
      selectedPersonaId: "ai",
      setSelectedPersonaId,
      setActiveTab: vi.fn(),
      requestResumeImport: vi.fn(),
      refreshMissingBlockEmbeddings: vi.fn(async () => {}),
    }),
}));

vi.mock("@/stores/settings-store", () => {
  const useSettingsStore = Object.assign(
    (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState },
  );
  return { useSettingsStore };
});

vi.mock("@/stores/claude-setup-store", () => ({
  useClaudeSetupStore: {
    getState: () => ({ openAiCredentials: [] }),
  },
}));

vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: {
    getState: () => ({
      selectedProviderCredentialId: null,
      selectedProviderModels: {},
    }),
  },
}));

vi.mock("@/stores/ollama-pull-store", () => ({
  useOllamaPullStore: (
    selector: (s: { pulling: boolean; pull: () => Promise<void> }) => unknown,
  ) =>
    selector({
      pulling: false,
      pull: vi.fn(async () => {}),
    }),
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: {
    getState: () => ({ lastProjectFolder: null }),
  },
}));

vi.mock("@/lib/ai-assist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-assist")>();
  return {
    ...actual,
    canUseAiAssist: vi.fn(() => true),
    resolveAiProvider: vi.fn(() => ({
      providerCredentialId: "ollama-1",
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
      numCtx: null,
      temperature: null,
      backend: "ollama" as const,
    })),
  };
});

vi.mock("@/lib/career", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/career")>();
  return {
    ...actual,
    listRuns: vi.fn(async () => []),
  };
});

vi.mock("@/lib/resume-synthesis", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/resume-synthesis")>();
  return {
    ...actual,
    listResumeMasterOptions: vi.fn(() => []),
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { CareerSynthesizeTab } from "@/components/career/career-synthesize-tab";

function baseSynth(extras: Partial<SynthSlice> = {}): SynthSlice {
  return {
    running: false,
    stage: null,
    stageId: "idle",
    error: null,
    result: null,
    report: null,
    events: [],
    viewingStoredRunId: null,
    runStartedAt: null,
    pendingJdText: null,
    readiness: null,
    readinessLoading: false,
    run,
    reset,
    cancel,
    openStoredReport,
    refreshReadiness,
    consumePendingJdText: () => null,
    ...extras,
  };
}

function setRunningStage(
  stage: SynthesisStage,
  extras: Partial<SynthSlice> = {},
) {
  synthState = baseSynth({
    running: true,
    stage,
    stageId: stage.id,
    runStartedAt: Date.now() - 1500,
    ...extras,
  });
}

describe("CareerSynthesizeTab progress UI", () => {
  beforeEach(() => {
    cancel.mockClear();
    reset.mockClear();
    run.mockClear();
    openStoredReport.mockClear();
    refreshReadiness.mockClear();
    synthState = baseSynth();
  });

  it("renders stage checklist, progress bar, and cancel while analyzing with stream preview", () => {
    setRunningStage({
      id: "analyzing",
      label: "Analyzing job description",
      detail: "Extracting must-have skills",
      progress: 0.12,
      streamPreview: '{"roleTitle":"Senior ML Engineer"',
    });

    render(<CareerSynthesizeTab />);

    expect(
      screen.getAllByText("Analyzing job description").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("Extracting must-have skills")).toBeInTheDocument();
    expect(screen.getByText("Analyze JD")).toBeInTheDocument();
    expect(screen.getByText("Score blocks")).toBeInTheDocument();
    expect(screen.getByText("Live JD analysis")).toBeInTheDocument();
    expect(screen.getByText(/Senior ML Engineer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("shows stage-level critic stream preview", () => {
    setRunningStage({
      id: "critic",
      label: "Critiquing rewrite",
      detail: "critic repair round 1/2",
      progress: 0.8,
      streamPreview: "Flag: ungrounded metric claim",
    });

    render(<CareerSynthesizeTab />);

    expect(screen.getByText("Live critic")).toBeInTheDocument();
    expect(
      screen.getByText("Flag: ungrounded metric claim"),
    ).toBeInTheDocument();
    expect(screen.getByText("critic repair round 1/2")).toBeInTheDocument();
  });

  it("shows per-block rewrite stream preview and block checklist", () => {
    setRunningStage({
      id: "rewriting",
      label: "Rewriting selected blocks",
      progress: 0.55,
      blockProgress: [
        {
          blockId: "exp_1",
          label: "Acme · ML Engineer",
          index: 1,
          total: 2,
          status: "done",
        },
        {
          blockId: "exp_2",
          label: "Beta · Staff Eng",
          index: 2,
          total: 2,
          status: "active",
          streamPreview: "Led cross-functional ML platform…",
        },
      ],
    });

    render(<CareerSynthesizeTab />);

    expect(screen.getByText("Acme · ML Engineer")).toBeInTheDocument();
    expect(screen.getByText("Beta · Staff Eng")).toBeInTheDocument();
    expect(screen.getByText(/Live rewrite/)).toBeInTheDocument();
    expect(
      screen.getByText(/Led cross-functional ML platform/),
    ).toBeInTheDocument();
  });

  it("invokes cancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    setRunningStage({
      id: "scoring",
      label: "Scoring blocks",
      progress: 0.3,
    });

    render(<CareerSynthesizeTab />);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("hides cancel when not running", () => {
    synthState = baseSynth({
      running: false,
      stage: null,
      stageId: "idle",
    });
    render(<CareerSynthesizeTab />);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /run synthesis/i }),
    ).toBeInTheDocument();
    expect(refreshReadiness).toHaveBeenCalled();
  });

  it("always shows the idle pipeline board and run-blocked explainer", () => {
    synthState = baseSynth({
      running: false,
      stage: null,
      stageId: "idle",
      readiness: {
        checkedAt: Date.now(),
        text: {
          status: "ok",
          available: true,
          backend: "ollama",
          model: "llama3.2",
          streams: true,
          issue: null,
          message: "Ollama ready",
        },
        embeddings: {
          status: "ok",
          available: true,
          issue: null,
          message: "Embeddings ready",
        },
        data: {
          status: "ok",
          blockCount: 1,
          blocksMissingEmbeddings: 0,
          kbSourceCount: 0,
          kbChunksMissingEmbeddings: 0,
          message: "1 block",
        },
        canRunWithAi: true,
        embeddingsDown: false,
      },
    });
    render(<CareerSynthesizeTab />);
    expect(screen.getByText("Synthesis pipeline")).toBeInTheDocument();
    expect(screen.getByText("Run blocked")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Need at least 40 characters/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Extract must-have skills/)).toBeInTheDocument();
    expect(screen.getByText("Analyze JD")).toBeInTheDocument();
  });
});
