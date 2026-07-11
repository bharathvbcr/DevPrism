import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyBlock, createEmptyPersona } from "@/lib/career";
import type { SynthesisStage, SynthesisStageId } from "@/lib/resume-synthesis";

const cancel = vi.fn();
const reset = vi.fn();
const run = vi.fn();
const openStoredReport = vi.fn();
const setSelectedPersonaId = vi.fn();
const setResumeHeader = vi.fn();

type SynthSlice = {
  running: boolean;
  stage: SynthesisStage | null;
  stageId: SynthesisStageId;
  error: string | null;
  result: null;
  report: null;
  viewingStoredRunId: string | null;
  runStartedAt: number | null;
  run: typeof run;
  reset: typeof reset;
  cancel: typeof cancel;
  openStoredReport: typeof openStoredReport;
};

let synthState: SynthSlice;

const persona = createEmptyPersona({ id: "ai", label: "AI / ML" });
const block = createEmptyBlock({
  id: "exp_1",
  title: "ML Engineer",
  org: "Acme",
});

vi.mock("@/stores/synthesis-store", () => ({
  useSynthesisStore: (selector: (s: SynthSlice) => unknown) =>
    selector(synthState),
}));

vi.mock("@/stores/career-store", () => ({
  useCareerStore: (
    selector: (s: {
      personas: (typeof persona)[];
      blocks: (typeof block)[];
      selectedPersonaId: string | null;
      setSelectedPersonaId: typeof setSelectedPersonaId;
    }) => unknown,
  ) =>
    selector({
      personas: [persona],
      blocks: [block],
      selectedPersonaId: "ai",
      setSelectedPersonaId,
    }),
}));

vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: (
    selector: (s: {
      resumeHeader: {
        fullName: string;
        email: string;
        phone: string;
        cityRegion: string;
        linkedinUrl?: string;
        githubUrl?: string;
        portfolioUrl?: string;
      };
      setResumeHeader: typeof setResumeHeader;
    }) => unknown,
  ) =>
    selector({
      resumeHeader: {
        fullName: "",
        email: "",
        phone: "",
        cityRegion: "",
      },
      setResumeHeader,
    }),
}));

vi.mock("@/stores/project-store", () => ({
  useProjectStore: {
    getState: () => ({ lastProjectFolder: null }),
  },
}));

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
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { CareerSynthesizeTab } from "@/components/career/career-synthesize-tab";

function setRunningStage(
  stage: SynthesisStage,
  extras: Partial<SynthSlice> = {},
) {
  synthState = {
    running: true,
    stage,
    stageId: stage.id,
    error: null,
    result: null,
    report: null,
    viewingStoredRunId: null,
    runStartedAt: Date.now() - 1500,
    run,
    reset,
    cancel,
    openStoredReport,
    ...extras,
  };
}

describe("CareerSynthesizeTab progress UI", () => {
  beforeEach(() => {
    cancel.mockClear();
    reset.mockClear();
    run.mockClear();
    openStoredReport.mockClear();
    synthState = {
      running: false,
      stage: null,
      stageId: "idle",
      error: null,
      result: null,
      report: null,
      viewingStoredRunId: null,
      runStartedAt: null,
      run,
      reset,
      cancel,
      openStoredReport,
    };
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

    expect(screen.getByText("Analyzing job description")).toBeInTheDocument();
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
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
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
    synthState = {
      ...synthState,
      running: false,
      stage: null,
      stageId: "idle",
    };
    render(<CareerSynthesizeTab />);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /run synthesis/i }),
    ).toBeInTheDocument();
  });
});
