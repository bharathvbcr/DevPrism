import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SynthesisReadiness } from "@/lib/resume-synthesis/preflight";
import { useSynthesisStore } from "@/stores/synthesis-store";
import { KnowledgePanel } from "@/components/career/synthesize/knowledge-panel";

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

function readiness(
  data: Partial<SynthesisReadiness["data"]>,
): SynthesisReadiness {
  return {
    checkedAt: Date.now(),
    text: {
      status: "ok",
      available: true,
      backend: "ollama",
      model: "m",
      streams: true,
      issue: null,
      message: "Ready",
    },
    embeddings: {
      status: "ok",
      available: true,
      issue: null,
      message: "Ready",
    },
    data: {
      status: "ok",
      blockCount: 2,
      blocksMissingEmbeddings: 0,
      kbSourceCount: 0,
      kbChunksMissingEmbeddings: 0,
      message: "",
      ...data,
    },
    canRunWithAi: true,
    embeddingsDown: false,
  };
}

describe("KnowledgePanel", () => {
  beforeEach(() => {
    useSynthesisStore.setState({
      readiness: null,
      readinessLoading: false,
    });
  });

  it("shows a skeleton while the first probe is in flight", () => {
    render(<KnowledgePanel onAddKnowledge={() => {}} />);

    expect(screen.getByText(/Checking knowledge coverage/)).toBeInTheDocument();
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
  });

  it("reports unknown coverage instead of claiming an empty KB", () => {
    useSynthesisStore.setState({
      readiness: readiness({ kbSourceCount: null, status: "warn" }),
    });
    render(<KnowledgePanel onAddKnowledge={() => {}} />);

    expect(
      screen.getByText(/Couldn't load knowledge coverage/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Add knowledge/i)).toBeNull();
    expect(screen.queryByText(/0 sources/i)).toBeNull();
  });

  it("keeps the ingest prompt for a confirmed empty KB", () => {
    useSynthesisStore.setState({
      readiness: readiness({ kbSourceCount: 0 }),
    });
    render(<KnowledgePanel onAddKnowledge={() => {}} />);

    expect(
      screen.getByRole("button", { name: /add knowledge/i }),
    ).toBeEnabled();
  });

  it("summarizes verified coverage including pending embeds", () => {
    useSynthesisStore.setState({
      readiness: readiness({ kbSourceCount: 1, kbChunksMissingEmbeddings: 4 }),
    });
    render(<KnowledgePanel onAddKnowledge={() => {}} />);

    expect(
      screen.getByText(/1 source · 4 chunks pending embed/),
    ).toBeInTheDocument();
  });
});
