/**
 * Model Context Protocol (MCP 2.0) Stateless TypeScript Definitions (2026-07-28).
 *
 * Fully compliant with:
 * - SEP-2575: Stateless Core Protocol (no initialize handshake, inline _meta)
 * - SEP-2243: HTTP Standardization (Mcp-Protocol-Version, Mcp-Method, Mcp-Name)
 * - SEP-2549: Intelligent Caching (ttlMs, cacheScope)
 * - SEP-2322: Multi Round-Trip Requests (MRTR) for stateless elicitation
 * - SEP-2663: Tasks Extension (tasks/get, tasks/cancel, tasks/list)
 */

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export const MCP_HEADERS = {
  PROTOCOL_VERSION: "mcp-protocol-version",
  METHOD: "mcp-method",
  NAME: "mcp-name",
} as const;

export const MCP_ERROR_CODES = {
  HEADER_MISMATCH: -32020,
  TASK_FAILED: -32001,
  ELICITATION_FAILED: -32002,
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface ClientInfo {
  name: string;
  version: string;
  titles?: string[];
}

export interface ClientCapabilities {
  roots?: {
    listChanged?: boolean;
  };
  sampling?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface RequestMeta {
  "io.modelcontextprotocol/protocolVersion"?: string;
  clientInfo?: ClientInfo;
  capabilities?: ClientCapabilities;
  [key: string]: unknown;
}

export interface ResponseMeta {
  ttlMs?: number;
  cacheScope?: "public" | "user" | "session" | string;
  protocolVersion?: string;
  [key: string]: unknown;
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: TParams & {
    _meta?: RequestMeta;
  };
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: TResult;
  error?: JsonRpcError;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: ResponseMeta;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  _meta?: ResponseMeta;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
  _meta?: ResponseMeta;
}

// --- MRTR Multi Round-Trip Requests (SEP-2322) ---

export interface InputRequest {
  id: string;
  type: "text" | "select" | "confirm" | "form";
  label: string;
  description?: string;
  options?: string[];
  defaultValue?: string | boolean;
}

export interface InputRequiredResult {
  resultType: "inputRequired";
  action: string;
  message: string;
  requiredInputs: InputRequest[];
  requestState: string; // Base64 encoded state for stateless resume
}

// --- Tasks Extension (SEP-2663) ---

export type TaskStatus = "working" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
  taskId: string;
  name: string;
  status: TaskStatus;
  progress: number;
  message?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
