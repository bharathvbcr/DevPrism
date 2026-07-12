import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineBoard } from "@/components/career/synthesize/pipeline-board";
import type { SynthesisReadiness } from "@/lib/resume-synthesis/preflight";

const dispatchOpenSettings = vi.fn();

vi.mock("@/lib/home-flow-events", () => ({
  dispatchOpenSettings: (...args: unknown[]) => dispatchOpenSettings(...args),
}));

vi.mock("@/lib/ai-assist", () => ({
  canUseAiAssist: vi.fn(() => false),
}));

function readiness(
  overrides: Partial<SynthesisReadiness> = {},
): SynthesisReadiness {
  return {
    checkedAt: Date.now(),
    text: {
      status: "unavailable",
      available: false,
      backend: null,
      model: null,
      streams: false,
      issue: "no-provider",
      message: "Configure an AI chat provider in Settings",
    },
    embeddings: {
      status: "unavailable",
      available: false,
      issue: "no-embeddings",
      message: "Embeddings unavailable",
    },
    data: {
      status: "ok",
      blockCount: 0,
      blocksMissingEmbeddings: 0,
      kbSourceCount: 0,
      kbChunksMissingEmbeddings: 0,
      message: "0 blocks",
    },
    canRunWithAi: false,
    embeddingsDown: true,
    ...overrides,
  };
}

const idleProps = {
  stage: null,
  stageId: "idle" as const,
  events: [],
  report: null,
  elapsedMs: 0,
  running: false,
  canRun: false,
  jdLength: 12,
  blockCount: 0,
  hasPersona: true,
  hasTemplate: true,
  readiness: readiness(),
};

describe("PipelineBoard", () => {
  it("renders idle stage board with distill descriptions", () => {
    render(<PipelineBoard {...idleProps} />);

    expect(screen.getByLabelText("Synthesis pipeline")).toBeInTheDocument();
    expect(screen.getByText("Synthesis pipeline")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("Analyze JD")).toBeInTheDocument();
    expect(
      screen.getByText(/Distill facts \+ evidence into tailored bullets/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Retrieve KB chunks and block facts/),
    ).toBeInTheDocument();
  });

  it("shows run-blocked explainer with fix CTAs when canRun is false", async () => {
    const user = userEvent.setup();
    const onFocusJd = vi.fn();
    const onOpenDatabase = vi.fn();
    const onImportResume = vi.fn();
    const onAddKnowledge = vi.fn();

    render(
      <PipelineBoard
        {...idleProps}
        onFocusJd={onFocusJd}
        onOpenDatabase={onOpenDatabase}
        onImportResume={onImportResume}
        onAddKnowledge={onAddKnowledge}
      />,
    );

    expect(screen.getByText("Run blocked")).toBeInTheDocument();
    expect(
      screen.getByText(/Need at least 40 characters \(12\/40\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Add experience blocks before synthesizing/),
    ).toBeInTheDocument();
    expect(screen.getByText(/degraded mode/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /focus jd/i }));
    expect(onFocusJd).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /open database/i }));
    expect(onOpenDatabase).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /import resume/i }));
    expect(onImportResume).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /open ai settings/i }));
    expect(dispatchOpenSettings).toHaveBeenCalledWith("ai");

    await user.click(screen.getByRole("button", { name: /add knowledge/i }));
    expect(onAddKnowledge).toHaveBeenCalledOnce();
  });

  it("hides blocked explainer when canRun is true", () => {
    render(
      <PipelineBoard
        {...idleProps}
        canRun
        jdLength={80}
        blockCount={2}
        readiness={readiness({
          canRunWithAi: true,
          embeddingsDown: false,
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
            message: "Ready",
          },
        })}
      />,
    );

    expect(screen.queryByText("Run blocked")).toBeNull();
    expect(screen.getByText("Synthesis pipeline")).toBeInTheDocument();
  });
});
