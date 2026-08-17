import { describe, expect, it, vi } from "vitest";
import {
  CareerResumeBridge,
  InputRequiredResult,
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_HEADERS,
  MCP_PROTOCOL_VERSION,
  StatelessMcpClient,
} from "../../lib/mcp";

describe("StatelessMcpClient (MCP 2.0 Spec)", () => {
  it("attaches inline _meta and standard HTTP headers on every request", async () => {
    let capturedRequest: JsonRpcRequest | null = null;
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
      capturedRequest?.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
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
    let secondRequestPayload: Record<string, unknown> | null = null;

    const client = new StatelessMcpClient({
      customTransport: async (req) => {
        callCount++;
        if (callCount === 1) {
          // Return inputRequired elicitation (SEP-2322)
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              resultType: "inputRequired",
              action: "confirm_deletion",
              message: "Are you sure you want to delete block 'b1'?",
              requiredInputs: [
                {
                  id: "confirm",
                  type: "confirm",
                  label: "Confirm permanent deletion",
                },
              ],
              requestState: "base64_encoded_state_data",
            } as InputRequiredResult,
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
        if ((req.params as Record<string, unknown>)?.name === "resume_analyze_jd") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              profile: {
                title: "Staff AI Engineer",
                company: "Google",
                requiredSkills: ["rust", "python"],
                preferredSkills: ["typst"],
                seniority: "Staff",
                domain: "AI",
                cultureKeywords: ["scale"],
              },
            },
          };
        }

        if ((req.params as Record<string, unknown>)?.name === "resume_gap_analysis") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              coveragePercentage: 90,
              personaId: "ai",
              requiredSkillsTotal: 2,
              requiredSkillsCovered: ["rust", "python"],
              requiredSkillsMissing: [],
              preferredSkillsCovered: ["typst"],
              preferredSkillsMissing: [],
              warnings: [],
              recommendedFocus: "Emphasize leadership",
            },
          };
        }

        return { jsonrpc: "2.0", id: req.id, result: {} };
      },
    });

    const bridge = new CareerResumeBridge(client);

    const jdAnalysis = await bridge.analyzeJobDescription("Looking for Staff AI Engineer with Rust & Python");
    expect(jdAnalysis.profile.title).toBe("Staff AI Engineer");
    expect(jdAnalysis.profile.requiredSkills).toContain("rust");

    const gapReport = await bridge.runGapAnalysis("Looking for Staff AI Engineer with Rust & Python", "ai");
    expect(gapReport.coveragePercentage).toBe(90);
    expect(gapReport.requiredSkillsMissing).toHaveLength(0);
  });
});
