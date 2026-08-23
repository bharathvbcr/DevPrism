import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MatchReport,
  RunEvent,
  SynthesisResult,
} from "@/lib/resume-synthesis";
import type { SynthesisReadiness } from "@/lib/resume-synthesis/preflight";

const synthesizeResume = vi.fn();
const checkSynthesisReadiness = vi.fn();

vi.mock("@/lib/resume-synthesis", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/resume-synthesis")>();
  return {
    ...actual,
    synthesizeResume: (...args: unknown[]) => synthesizeResume(...args),
  };
});

vi.mock("@/lib/resume-synthesis/preflight", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/resume-synthesis/preflight")>();
  return {
    ...actual,
    checkSynthesisReadiness: (...args: unknown[]) =>
      checkSynthesisReadiness(...args),
  };
});

import { useSynthesisStore } from "@/stores/synthesis-store";

const greenReadiness: SynthesisReadiness = {
  checkedAt: Date.now(),
  text: {
    status: "ok",
    available: true,
    backend: "ollama",
    model: "llama3.2",
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
    kbSourceCount: 1,
    kbChunksMissingEmbeddings: 0,
    message: "Ready",
  },
  canRunWithAi: true,
  embeddingsDown: false,
};

function minimalReport(): MatchReport {
  return {
    profile: {
      roleTitle: "ML Engineer",
      seniority: "senior",
      mustHaveSkills: ["Python"],
      niceToHaveSkills: [],
      domains: [],
      atsKeywords: ["Python"],
      toneSignals: [],
      responsibilitiesText: "",
      qualificationsText: "",
    },
    scored: [],
    selectedBlockIds: [],
    notices: [],
    semanticMatchingDisabled: false,
    critique: null,
    repairs: [],
    stageTimingsMs: {},
    aiRewrittenCount: 1,
    canonicalFallbackCount: 0,
    bulletFallbackReasons: [],
    blockEvidence: [],
  };
}

describe("useSynthesisStore events / readiness / pendingJd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSynthesisStore.setState({
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
    });
    checkSynthesisReadiness.mockResolvedValue(greenReadiness);
  });

  it("accumulates onEvent callbacks during run and clears events on reset", async () => {
    synthesizeResume.mockImplementation(
      async (opts: {
        onEvent?: (e: RunEvent) => void;
        onProgress?: (s: {
          id: string;
          label: string;
          progress: number;
        }) => void;
      }) => {
        opts.onEvent?.({
          type: "stage-start",
          stage: "analyzing",
          at: Date.now(),
        });
        opts.onEvent?.({
          type: "embeddings-disabled",
          reason: "no embeddings",
          at: Date.now(),
        });
        opts.onEvent?.({
          type: "bullet-fallback",
          blockId: "b1",
          bulletId: "b1_1",
          reason: "metrics-lost",
          at: Date.now(),
        });
        opts.onProgress?.({
          id: "done",
          label: "Done",
          progress: 1,
        });
        const report = minimalReport();
        const result: SynthesisResult = {
          runId: "run-1",
          templateId: "ats-single-column",
          tex: "% tex",
          content: {
            header: {
              fullName: "A",
              cityRegion: "",
              email: "",
              phone: "",
            },
            experience: [],
          },
          report,
          compileOk: true,
          compileSummary: "ok",
          pdfBytes: null,
        };
        return result;
      },
    );

    const result = await useSynthesisStore.getState().run({
      jdText: "Senior ML engineer with Python experience required. ".repeat(3),
      personaId: "ai",
      templateId: "ats-single-column",
    });

    expect(result?.runId).toBe("run-1");
    const afterRun = useSynthesisStore.getState();
    expect(afterRun.events.map((e) => e.type)).toEqual([
      "stage-start",
      "embeddings-disabled",
      "bullet-fallback",
    ]);
    expect(
      afterRun.events.find((e) => e.type === "bullet-fallback"),
    ).toMatchObject({ reason: "metrics-lost" });
    expect(afterRun.running).toBe(false);
    expect(afterRun.stageId).toBe("done");

    useSynthesisStore.getState().setPendingJdText("preserve me");
    useSynthesisStore.getState().reset();
    const afterReset = useSynthesisStore.getState();
    expect(afterReset.events).toEqual([]);
    expect(afterReset.report).toBeNull();
    expect(afterReset.stageId).toBe("idle");
    // pendingJdText must coexist across reset (deep-link prefill)
    expect(afterReset.pendingJdText).toBe("preserve me");
  });

  it("refreshReadiness sets readiness snapshot", async () => {
    await useSynthesisStore
      .getState()
      .refreshReadiness({ forceEmbedProbe: true });
    expect(checkSynthesisReadiness).toHaveBeenCalledWith({
      forceEmbedProbe: true,
    });
    expect(useSynthesisStore.getState().readiness).toEqual(greenReadiness);
    expect(useSynthesisStore.getState().readinessLoading).toBe(false);
  });

  it("readiness fallback reports unknown data counts, not zeros", async () => {
    checkSynthesisReadiness.mockRejectedValue(
      new Error("career db unavailable"),
    );

    await useSynthesisStore.getState().refreshReadiness();

    const r = useSynthesisStore.getState().readiness;
    expect(r).not.toBeNull();
    expect(r?.data.blockCount).toBeNull();
    expect(r?.data.blocksMissingEmbeddings).toBeNull();
    expect(r?.data.kbSourceCount).toBeNull();
    expect(r?.data.kbChunksMissingEmbeddings).toBeNull();
    expect(r?.data.status).toBe("error");
    expect(r?.data.message).toMatch(/unknown/i);
  });

  it("consumePendingJdText returns once then clears", () => {
    useSynthesisStore.getState().setPendingJdText("  JD body  ");
    expect(useSynthesisStore.getState().pendingJdText).toBe("  JD body  ");
    expect(useSynthesisStore.getState().consumePendingJdText()).toBe(
      "  JD body  ",
    );
    expect(useSynthesisStore.getState().pendingJdText).toBeNull();
    expect(useSynthesisStore.getState().consumePendingJdText()).toBeNull();
  });

  it("openStoredReport restores events without clearing pendingJdText", () => {
    useSynthesisStore.getState().setPendingJdText("queued jd");
    const events: RunEvent[] = [
      { type: "critic-skipped", reason: "llm-error", at: 1 },
    ];
    useSynthesisStore
      .getState()
      .openStoredReport(
        "stored-1",
        "ats-single-column",
        minimalReport(),
        "%tex",
        events,
      );

    const state = useSynthesisStore.getState();
    expect(state.viewingStoredRunId).toBe("stored-1");
    expect(state.events).toEqual(events);
    expect(state.result?.tex).toBe("%tex");
    expect(state.pendingJdText).toBe("queued jd");
  });

  it("openStoredReport restores compileOk from stored meta", () => {
    useSynthesisStore
      .getState()
      .openStoredReport(
        "stored-fail",
        "ats-single-column",
        minimalReport(),
        "%tex",
        [],
        {
          compileOk: false,
          compileSummary: "Compile needs review",
        },
      );
    const state = useSynthesisStore.getState();
    expect(state.result?.compileOk).toBe(false);
    expect(state.result?.compileSummary).toBe("Compile needs review");
  });

  it("throttles onProgress writes and flushes trailing edge", async () => {
    vi.useFakeTimers();
    const progressCalls: number[] = [];
    synthesizeResume.mockImplementation(
      async (opts: {
        onProgress?: (s: {
          id: string;
          label: string;
          progress: number;
        }) => void;
      }) => {
        opts.onProgress?.({ id: "rewriting", label: "a", progress: 0.5 });
        opts.onProgress?.({ id: "rewriting", label: "b", progress: 0.55 });
        opts.onProgress?.({ id: "rewriting", label: "c", progress: 0.6 });
        await Promise.resolve();
        const report = minimalReport();
        return {
          runId: "run-throttle",
          templateId: "ats-single-column",
          tex: "% tex",
          content: {
            header: { fullName: "A", cityRegion: "", email: "", phone: "" },
            experience: [],
          },
          report,
          compileOk: true,
          compileSummary: "ok",
          pdfBytes: null,
        } satisfies SynthesisResult;
      },
    );

    const runPromise = useSynthesisStore.getState().run({
      jdText: "Senior ML engineer with Python experience required. ".repeat(3),
      personaId: "ai",
      templateId: "ats-single-column",
      // `progress` is an optional hint; the assertion only counts calls.
      onProgress: (s) => progressCalls.push(s.progress ?? 0),
    });

    // Mid-throttle: store should not yet have flushed rapid updates.
    expect(useSynthesisStore.getState().stage?.label).not.toBe("c");
    await vi.advanceTimersByTimeAsync(120);
    await runPromise;
    expect(useSynthesisStore.getState().stageId).toBe("done");
    // Terminal flush + trailing throttle may both fire; last label before done is flushed.
    expect(progressCalls.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("retains events after error and appends error event", async () => {
    synthesizeResume.mockImplementation(
      async (opts: { onEvent?: (e: RunEvent) => void }) => {
        opts.onEvent?.({
          type: "stage-start",
          stage: "analyzing",
          at: Date.now(),
        });
        throw new Error("provider boom");
      },
    );

    const result = await useSynthesisStore.getState().run({
      jdText: "Senior ML engineer with Python experience required. ".repeat(3),
      personaId: "ai",
      templateId: "ats-single-column",
    });

    expect(result).toBeNull();
    const state = useSynthesisStore.getState();
    expect(state.error).toBe("provider boom");
    expect(state.running).toBe(false);
    expect(state.events.map((e) => e.type)).toEqual(["stage-start", "error"]);
    expect(state.events.find((e) => e.type === "error")).toMatchObject({
      message: "provider boom",
    });
  });
});
