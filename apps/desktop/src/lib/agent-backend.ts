import { useSettingsStore } from "@/stores/settings-store";

/** Which runtime powers the chat agent. */
export type AgentBackend =
  | "native-ollama"
  | "native-api"
  | "native-groq"
  | "claude-code"
  | "cursor-cli";

export const AGENT_BACKENDS: readonly {
  id: AgentBackend;
  label: string;
  description: string;
}[] = [
  {
    id: "native-ollama",
    label: "Native Ollama",
    description:
      "Built-in agent talking directly to a local Ollama model — fully offline.",
  },
  {
    id: "native-api",
    label: "Native API",
    description:
      "Built-in agent using any OpenAI-compatible API (Groq, OpenRouter, Gemini, …).",
  },
  {
    id: "native-groq",
    label: "Native Groq",
    description:
      "Alias for Native API pre-selected to Groq — fast cloud inference.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic Claude Code CLI with stream-json output.",
  },
  {
    id: "cursor-cli",
    label: "Cursor CLI",
    description: "Cursor agent CLI via ACP (stream-json fallback).",
  },
];

export const CURSOR_CLI_PROVIDER_ID = "__cursor-cli__";
export const GROQ_PROVIDER_BASE = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";

export function isAgentBackend(value: unknown): value is AgentBackend {
  return (
    value === "native-ollama" ||
    value === "native-api" ||
    value === "native-groq" ||
    value === "claude-code" ||
    value === "cursor-cli"
  );
}

/** Migrate legacy boolean to the backend enum. */
export function migrateNativeAgentEnabled(
  nativeAgentEnabled: unknown,
): AgentBackend {
  return nativeAgentEnabled === true ? "native-ollama" : "claude-code";
}

export function isNativeBackend(backend: AgentBackend): boolean {
  return (
    backend === "native-ollama" ||
    backend === "native-api" ||
    backend === "native-groq"
  );
}

export function isNativeOllamaBackend(backend: AgentBackend): boolean {
  return backend === "native-ollama";
}

/** True for the generic native OpenAI-compat backend (not the Groq alias). */
export function isNativeApiBackend(backend: AgentBackend): boolean {
  return backend === "native-api";
}

/** True for native-groq (kept as a Groq-preselect alias of native-api). */
export function isNativeGroqBackend(backend: AgentBackend): boolean {
  return backend === "native-groq";
}

/** True when the native agent talks to an OpenAI-compatible cloud/API endpoint. */
export function isNativeOpenAiCompatBackend(backend: AgentBackend): boolean {
  return backend === "native-api" || backend === "native-groq";
}

export function isClaudeCodeBackend(backend: AgentBackend): boolean {
  return backend === "claude-code";
}

export function isCursorCliBackend(backend: AgentBackend): boolean {
  return backend === "cursor-cli";
}

/** Whether the backend uses the in-process native agent (Ollama / API / Groq). */
export function backendUsesNativeRuntime(backend: AgentBackend): boolean {
  return isNativeBackend(backend);
}

/** Whether session history UI should be shown for the backend. */
export function backendShowsSessionHistory(backend: AgentBackend): boolean {
  return isClaudeCodeBackend(backend) || isCursorCliBackend(backend);
}

/** @deprecated Use `agentBackend` — true when any native backend is active. */
export function nativeAgentEnabledFromBackend(backend: AgentBackend): boolean {
  return isNativeBackend(backend);
}

export function getAgentBackend(): AgentBackend {
  return useSettingsStore.getState().agentBackend;
}

export function useAgentBackend(): AgentBackend {
  return useSettingsStore((s) => s.agentBackend);
}

export function isGroqBaseUrl(baseUrl?: string | null): boolean {
  return /api\.groq\.com/i.test(baseUrl ?? "");
}

export function isOpenRouterBaseUrl(baseUrl?: string | null): boolean {
  return /openrouter\.ai/i.test(baseUrl ?? "");
}

export function isGeminiBaseUrl(baseUrl?: string | null): boolean {
  return /aiplatform\.googleapis\.com|generativelanguage\.googleapis\.com|googleapis\.com.*openai/i.test(
    baseUrl ?? "",
  );
}

/** Local Ollama-style endpoints (not cloud OpenAI-compat). */
export function isOllamaBaseUrl(baseUrl?: string | null): boolean {
  return /:11434|localhost|127\.0\.0\.1/i.test(baseUrl ?? "");
}
