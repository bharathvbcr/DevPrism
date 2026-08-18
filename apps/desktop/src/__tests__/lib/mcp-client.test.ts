import { describe, expect, it } from "vitest";
import {
  CareerResumeBridge,
  InputRequiredResult,
  MCP_HEADERS,
  MCP_PROTOCOL_VERSION,
  StatelessMcpClient,
} from "../../lib/mcp";

describe("StatelessMcpClient (MCP 2.0 Spec)", () => {
  it("attaches inline _meta and standard HTTP headers on every request", async () => {
    let capturedRequest: any = null;
    let capturedHeaders: Record<string, string> | undefined;

    const client = new StatelessMcpClient({
      customTransport: async (req, headers) => {
        capturedRequest = req;
        capturedHeaders = headers;
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: [] },
        };
      },
    });

    await client.listTools();

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.jsonrpc).toBe("2.0");
    expect(capturedRequest?.method).toBe("tools/list");
    expect(capturedRequest?.params?._meta).toBeDefined();
    expect(
      capturedRequest?.params?._meta?.[
        "io.modelcontextprotocol/protocolVersion"
      ],
    ).toBe(MCP_PROTOCOL_VERSION);
    expect(capturedRequest?.params?._meta?.clientInfo?.name).toBe(
      "@devprism/desktop",
    );

    // Verify standard HTTP headers (SEP-2243)
    expect(capturedHeaders?.[MCP_HEADERS.PROTOCOL_VERSION]).toBe(
      MCP_PROTOCOL_VERSION,
    );
    expect(capturedHeaders?.[MCP_HEADERS.METHOD]).toBe("tools/list");
  });

  it("passes mcp-name header on tools/call", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const client = new StatelessMcpClient({
      customTransport: async (req, headers) => {
        capturedHeaders = headers;
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { profile: { title: "Software Engineer" } },
        };
      },
    });

    await client.callTool("resume_analyze_jd", { jd_text: "Senior Rust role" });

    expect(capturedHeaders?.[MCP_HEADERS.METHOD]).toBe("tools/call");
    expect(capturedHeaders?.[MCP_HEADERS.NAME]).toBe("resume_analyze_jd");
  });

  it("handles MRTR elicitation request and stateless round-trip", async () => {
    let callCount = 0;
    let secondRequestPayload: any = null;

    const client = new StatelessMcpClient({
      customTransport: async (req) => {
        callCount++;
        if (callCount === 1) {
          // Return inputRequired elicitation (SEP-2322).
          //
          // This mirrors what `mcp::protocol::InputRequiredResult` actually
          // serializes: `inputRequests` is an object keyed by input id, each
          // entry carrying `type`/`message`/`schema`. The mock previously
          // hand-wrote `requiredInputs: [{id, type: "confirm", label}]`, a shape
          // the server has never emitted — so this test passed against a fiction
          // and the UI types drifted unchecked.
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              resultType: "inputRequired",
              inputRequests: {
                confirm: {
                  type: "confirmation",
                  message: "Are you sure you want to delete block 'b1'?",
                  schema: {
                    type: "boolean",
                    description: "True to permanently delete, false to cancel",
                  },
                },
              },
              requestState: "base64_encoded_state_data",
            } satisfies InputRequiredResult,
          };
        }

        secondRequestPayload = req.params as Record<string, unknown>;
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { success: true, deletedBlockId: "b1" },
        };
      },
    });

    // Step 1: Initial call yields InputRequiredResult
    const initialRes = (await client.callTool("career_delete_block", {
      block_id: "b1",
    })) as InputRequiredResult;

    expect(initialRes.resultType).toBe("inputRequired");
    expect(initialRes.requestState).toBe("base64_encoded_state_data");

    // Step 2: Second call resumes statelessly with inputResponses and requestState
    const secondRes = (await client.callTool(
      "career_delete_block",
      { block_id: "b1" },
      {
        inputResponses: { confirm: true },
        requestState: initialRes.requestState,
      },
    )) as { success: boolean; deletedBlockId: string };

    expect(secondRes.success).toBe(true);
    expect(secondRes.deletedBlockId).toBe("b1");
    expect(secondRequestPayload?.arguments).toEqual({
      block_id: "b1",
      input_responses: { confirm: true },
      request_state: "base64_encoded_state_data",
    });
  });

  it("polls and resolves async Tasks (SEP-2663) with progress updates", async () => {
    let pollCount = 0;
    const progressUpdates: number[] = [];

    const client = new StatelessMcpClient({
      customTransport: async (req) => {
        if (req.method === "tasks/get") {
          pollCount++;
          if (pollCount < 3) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              result: {
                task: {
                  taskId: "task-123",
                  name: "resume_synthesize",
                  status: "working",
                  progress: 0.3 * pollCount,
                  message: `Working step ${pollCount}`,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              },
            };
          }

          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              task: {
                taskId: "task-123",
                name: "resume_synthesize",
                status: "completed",
                progress: 1.0,
                result: {
                  typstSource: "= Resume",
                  matchReport: { coveragePercentage: 92 },
                },
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            },
          };
        }

        return { jsonrpc: "2.0", id: req.id, result: {} };
      },
    });

    const result = await client.waitForTask<{
      typstSource: string;
      matchReport: { coveragePercentage: number };
    }>("task-123", {
      pollIntervalMs: 10,
      onProgress: (progress) => {
        progressUpdates.push(progress);
      },
    });

    expect(result.typstSource).toBe("= Resume");
    expect(result.matchReport.coveragePercentage).toBe(92);
    expect(progressUpdates.length).toBeGreaterThanOrEqual(3);
  });
});

describe("CareerResumeBridge", () => {
  it("executes high-level resume gap analysis and JD profiling", async () => {
    const client = new StatelessMcpClient({
      customTransport: async (req) => {
        if (
          (req.params as Record<string, unknown>)?.name === "resume_analyze_jd"
        ) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              profile: {
                roleTitle: "Staff AI Engineer",
                seniority: "lead",
                mustHaveSkills: ["rust", "python"],
                niceToHaveSkills: ["typst"],
                domains: ["AI"],
                atsKeywords: ["rust", "python", "AI"],
                toneSignals: ["scale"],
                responsibilitiesText: "Build AI systems.",
                qualificationsText: "Rust and Python.",
              },
              source: "deterministic",
              notices: [],
              extractionEmpty: false,
            },
          };
        }

        if (
          (req.params as Record<string, unknown>)?.name ===
          "resume_gap_analysis"
        ) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              personaId: "ai",
              source: "deterministic",
              coveragePercentage: 90,
              mustHave: {
                total: 2,
                covered: [
                  { skill: "rust", evidenceBlockIds: ["block-1"] },
                  { skill: "python", evidenceBlockIds: ["block-2"] },
                ],
                missing: [],
              },
              niceToHave: {
                total: 1,
                covered: [{ skill: "typst", evidenceBlockIds: ["block-1"] }],
                missing: [],
              },
              uncoveredAfterSelection: [],
              blocksInKnowledgebase: 2,
              warnings: [],
            },
          };
        }

        return { jsonrpc: "2.0", id: req.id, result: {} };
      },
    });

    const bridge = new CareerResumeBridge(client);

    const jdAnalysis = await bridge.analyzeJobDescription(
      "Looking for Staff AI Engineer with Rust & Python",
    );
    // Canonical JDProfile shape, shared with the in-app pipeline.
    expect(jdAnalysis.profile.roleTitle).toBe("Staff AI Engineer");
    expect(jdAnalysis.profile.mustHaveSkills).toContain("rust");
    expect(jdAnalysis.profile.seniority).toBe("lead");
    // The response says how the profile was derived.
    expect(jdAnalysis.source).toBe("deterministic");

    const gapReport = await bridge.runGapAnalysis(
      "Looking for Staff AI Engineer with Rust & Python",
      "ai",
    );
    expect(gapReport.coveragePercentage).toBe(90);
    expect(gapReport.mustHave.missing).toHaveLength(0);
    // Every coverage claim names the block that evidences it.
    expect(gapReport.mustHave.covered[0]?.evidenceBlockIds).toEqual([
      "block-1",
    ]);
  });

  it("passes the language provider through to the server", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client = new StatelessMcpClient({
      customTransport: async (req) => {
        seen.push((req.params as Record<string, unknown>) ?? {});
        return { jsonrpc: "2.0", id: req.id, result: {} };
      },
    });
    const bridge = new CareerResumeBridge(client);
    await bridge.analyzeJobDescription("JD", {
      mode: "ollama",
      model: "qwen3.8:27b-mlx",
      numCtx: 16384,
    });
    const args = seen[0]?.arguments as Record<string, unknown>;
    expect(args.language).toEqual({
      mode: "ollama",
      model: "qwen3.8:27b-mlx",
      numCtx: 16384,
    });
  });

  it("surfaces a rejected rewrite instead of silently accepting it", async () => {
    const client = new StatelessMcpClient({
      customTransport: async (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          results: [
            {
              bulletId: "b1",
              blockId: "block-1",
              accepted: false,
              reason: "fabricated-metric",
              droppedMetrics: ["999"],
              text: "Improved throughput across the fleet",
              canonical: "Improved throughput across the fleet",
            },
          ],
          submitted: 1,
          accepted: 0,
          rejected: 1,
          unknownBullets: 0,
          perBulletChars: 140,
        },
      }),
    });
    const bridge = new CareerResumeBridge(client);
    const out = await bridge.verifyRewrite([
      { bullet_id: "b1", text: "Improved throughput by 999%" },
    ]);
    expect(out.accepted).toBe(0);
    expect(out.results[0]?.reason).toBe("fabricated-metric");
    // A rejection returns the user's verified text, not the model's.
    expect(out.results[0]?.text).toBe(out.results[0]?.canonical);
  });
});
