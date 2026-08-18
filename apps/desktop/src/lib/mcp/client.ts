/**
 * Stateless MCP 2.0 Client implementation for DevPrism.
 *
 * Implements:
 * - 2026-07-28 Stateless JSON-RPC 2.0 core with inline `_meta`.
 * - SEP-2243 standard HTTP headers (`mcp-protocol-version`, `mcp-method`, `mcp-name`).
 * - SEP-2322 Multi Round-Trip Requests (MRTR) for stateless elicitation.
 * - SEP-2663 Tasks Extension polling and lifecycle management.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  ClientInfo,
  InputRequiredResult,
  JsonRpcRequest,
  JsonRpcResponse,
  MCP_HEADERS,
  MCP_PROTOCOL_VERSION,
  PromptDefinition,
  ResourceDefinition,
  TaskRecord,
  ToolDefinition,
} from "./types";

/**
 * Default ceiling on a single JSON-RPC call.
 *
 * Neither transport was bounded from this side: `fetch` carried no
 * `AbortSignal` and Tauri's `invoke` has no cancellation at all, so any call
 * that bottoms out in a model request simply hung for as long as the Rust side
 * allowed — up to its own 600s budget — with no way for a caller to give up.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Default ceiling on polling an async task, matching the server's 600s task TTL.
 */
const TASK_POLL_TIMEOUT_MS = 600_000;

/** Reject after `ms`, so an uncancellable transport still releases its caller. */
function rejectAfter(
  ms: number,
  label: string,
): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP request '${label}' timed out after ${ms}ms`)),
      ms,
    );
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export interface McpClientOptions {
  clientInfo?: ClientInfo;
  transport?: "tauri" | "http";
  httpUrl?: string;
  customTransport?: (
    request: JsonRpcRequest,
    headers?: Record<string, string>,
  ) => Promise<JsonRpcResponse>;
}

export class StatelessMcpClient {
  private clientInfo: ClientInfo;
  private transport: "tauri" | "http" | "custom";
  private httpUrl: string;
  private customTransport?: (
    request: JsonRpcRequest,
    headers?: Record<string, string>,
  ) => Promise<JsonRpcResponse>;
  private reqCounter = 1;

  constructor(options?: McpClientOptions) {
    this.clientInfo = options?.clientInfo || {
      name: "@devprism/desktop",
      version: "1.4.0",
    };
    this.transport = options?.customTransport
      ? "custom"
      : options?.transport || "tauri";
    this.httpUrl = options?.httpUrl || "http://127.0.0.1:39200/mcp";
    this.customTransport = options?.customTransport;
  }

  /**
   * Execute a raw JSON-RPC 2.0 request statelessly.
   */
  async execute<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    toolOrPromptName?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TResult> {
    const id = `req-${Date.now()}-${this.reqCounter++}`;

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...((params as Record<string, unknown>) || {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          clientInfo: this.clientInfo,
        },
      },
    };

    // Standard HTTP headers (SEP-2243)
    const headers: Record<string, string> = {
      [MCP_HEADERS.PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
      [MCP_HEADERS.METHOD]: method,
    };
    if (toolOrPromptName) {
      headers[MCP_HEADERS.NAME] = toolOrPromptName;
    }

    let response: JsonRpcResponse<TResult>;

    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const deadline = rejectAfter(timeoutMs, toolOrPromptName ?? method);

    try {
      if (this.customTransport) {
        response = (await Promise.race([
          this.customTransport(request, headers),
          deadline.promise,
        ])) as JsonRpcResponse<TResult>;
      } else if (this.transport === "http") {
        // The fetch path can be aborted for real, so the request is dropped
        // rather than merely abandoned.
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options?.signal?.addEventListener("abort", onAbort);
        const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

        let httpRes: Response;
        try {
          httpRes = await fetch(this.httpUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headers,
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(abortTimer);
          options?.signal?.removeEventListener("abort", onAbort);
        }

        if (!httpRes.ok) {
          throw new Error(
            `MCP HTTP transport failed with HTTP status ${httpRes.status}`,
          );
        }

        response = await httpRes.json();
      } else {
        // Tauri IPC. `invoke` cannot be cancelled, so the race only releases
        // the caller — the command keeps running to completion on the Rust side.
        try {
          response = (await Promise.race([
            invoke<JsonRpcResponse<TResult>>("mcp_execute_request", {
              request,
              headers,
            }),
            deadline.promise,
          ])) as JsonRpcResponse<TResult>;
        } catch (err: unknown) {
          if (err instanceof Error && err.message.startsWith("MCP request ")) {
            throw err;
          }
          throw new Error(
            `Tauri MCP execution error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      deadline.cancel();
    }

    if (response.error) {
      const err = new Error(
        `MCP Error [${response.error.code}]: ${response.error.message}`,
      );
      (err as unknown as { code: number; data?: unknown }).code =
        response.error.code;
      (err as unknown as { code: number; data?: unknown }).data =
        response.error.data;
      throw err;
    }

    return response.result as TResult;
  }

  // --- Tools API ---

  async listTools(): Promise<ToolDefinition[]> {
    const res = await this.execute<{ tools: ToolDefinition[] }>("tools/list");
    return res.tools;
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    options?: {
      inputResponses?: Record<string, unknown>;
      requestState?: string;
    },
  ): Promise<T | InputRequiredResult> {
    const payload: Record<string, unknown> = {
      name,
      arguments: {
        ...args,
        ...(options?.inputResponses
          ? { input_responses: options.inputResponses }
          : {}),
        ...(options?.requestState
          ? { request_state: options.requestState }
          : {}),
      },
    };

    return this.execute<T | InputRequiredResult>("tools/call", payload, name);
  }

  // --- Resources API ---

  async listResources(): Promise<ResourceDefinition[]> {
    const res = await this.execute<{ resources: ResourceDefinition[] }>(
      "resources/list",
    );
    return res.resources;
  }

  async readResource<T = unknown>(uri: string): Promise<T> {
    return this.execute<T>("resources/read", { uri });
  }

  // --- Prompts API ---

  async listPrompts(): Promise<PromptDefinition[]> {
    const res = await this.execute<{ prompts: PromptDefinition[] }>(
      "prompts/list",
    );
    return res.prompts;
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
  ): Promise<{
    description?: string;
    messages: Array<{ role: string; content: { type: string; text: string } }>;
  }> {
    return this.execute("prompts/get", { name, arguments: args }, name);
  }

  // --- Tasks API (SEP-2663) ---

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const res = await this.execute<{ task: TaskRecord }>("tasks/get", {
      taskId,
    });
    return res.task || null;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const res = await this.execute<{ taskId: string; cancelled: boolean }>(
      "tasks/cancel",
      { taskId },
    );
    return res.cancelled;
  }

  async listTasks(): Promise<TaskRecord[]> {
    const res = await this.execute<{ tasks: TaskRecord[] }>("tasks/list");
    return res.tasks;
  }

  /**
   * Poll a running async task until completion or failure.
   */
  async waitForTask<T = unknown>(
    taskId: string,
    options?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      onProgress?: (progress: number, message?: string) => void;
    },
  ): Promise<T> {
    const interval = options?.pollIntervalMs || 250;
    // Match the server's own budget. `resume_synthesize` creates its task with a
    // 600s TTL and, in `ollama` mode, runs JD analysis plus a per-block rewrite
    // loop plus a Typst compile — routinely past the old 120s default, which
    // abandoned work that was still progressing normally.
    const timeout = options?.timeoutMs ?? TASK_POLL_TIMEOUT_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const task = await this.getTask(taskId);
      if (!task) {
        throw new Error(`Task '${taskId}' not found during polling`);
      }

      if (options?.onProgress) {
        options.onProgress(task.progress, task.message);
      }

      if (task.status === "completed") {
        return task.result as T;
      }

      if (task.status === "failed") {
        throw new Error(
          `Task '${taskId}' failed: ${task.error || "Unknown error"}`,
        );
      }

      if (task.status === "cancelled") {
        throw new Error(`Task '${taskId}' was cancelled`);
      }

      await new Promise((r) => setTimeout(r, interval));
    }

    // Giving up on the poll must also stop the work. Without this the model kept
    // generating and the Typst compile kept running against a result nobody
    // would read, and a retry stacked a second full pipeline on top of the first.
    try {
      await this.cancelTask(taskId);
    } catch {
      // Best effort: the task may already be gone. The timeout below is the
      // error the caller needs either way.
    }
    throw new Error(`Task '${taskId}' timed out after ${timeout}ms`);
  }
}

export const defaultMcpClient = new StatelessMcpClient();
