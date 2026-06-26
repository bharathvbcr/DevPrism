import { invoke } from "@tauri-apps/api/core";
import type { OpenAiCompatibleCredentialInfo } from "@/stores/claude-setup-store";
import { useSettingsStore } from "@/stores/settings-store";

export interface OllamaModelInfo {
  name: string;
  chatCapable: boolean;
  sizeBytes?: number | null;
}

export interface OllamaStatus {
  connected: boolean;
  baseUrl: string;
  version?: string | null;
  totalModels: number;
  chatModels: number;
  embeddingModels: number;
}

export interface OllamaModelCapabilities {
  tools?: boolean | null;
  vision?: boolean | null;
}

export interface OllamaPullProgress {
  model: string;
  status: string;
  percent?: number | null;
  completed?: number | null;
  total?: number | null;
  done: boolean;
  error?: string | null;
}

export type OllamaErrorKind =
  | "unreachable"
  | "no_model"
  | "no_tools"
  | "no_vision"
  | "already_running"
  | "generic";

export interface ClassifiedOllamaError {
  kind: OllamaErrorKind;
  message: string;
  model?: string;
}

export function isOllamaEndpoint(baseUrl?: string | null): boolean {
  return /:11434|localhost|127\.0\.0\.1/.test(baseUrl ?? "");
}

/** Pick the Ollama credential used by the native agent and AI assist. */
export function resolveOllamaCredential(
  credentials: OpenAiCompatibleCredentialInfo[],
  selectedProviderCredentialId: string | null,
): OpenAiCompatibleCredentialInfo | null {
  const selected = credentials.find((c) => c.id === selectedProviderCredentialId);
  return (
    (selected && isOllamaEndpoint(selected.base_url) ? selected : undefined) ??
    credentials.find((c) => isOllamaEndpoint(c.base_url)) ??
    null
  );
}

/** Resolved model name for native Ollama chat (settings override → cred picker → cred default). */
export function resolveNativeOllamaModel(options: {
  nativeOllamaModel: string | null;
  ollamaCredential: OpenAiCompatibleCredentialInfo | null;
  providerModels: Record<string, string>;
}): string | null {
  const fromSettings = options.nativeOllamaModel?.trim();
  if (fromSettings) return fromSettings;
  const cred = options.ollamaCredential;
  if (!cred) return null;
  return options.providerModels[cred.id]?.trim() || cred.model?.trim() || null;
}

export function getOllamaBaseUrl(
  credential: OpenAiCompatibleCredentialInfo | null,
): string {
  return credential?.base_url?.trim() || "http://localhost:11434";
}

export async function listOllamaModels(
  baseUrl?: string | null,
): Promise<OllamaModelInfo[]> {
  return invoke<OllamaModelInfo[]>("list_ollama_models", {
    baseUrl: baseUrl?.trim() || null,
  });
}

export async function getOllamaStatus(
  baseUrl?: string | null,
): Promise<OllamaStatus> {
  return invoke<OllamaStatus>("ollama_status", {
    baseUrl: baseUrl?.trim() || null,
  });
}

export async function getOllamaModelCapabilities(
  model: string,
  baseUrl?: string | null,
): Promise<OllamaModelCapabilities> {
  return invoke<OllamaModelCapabilities>("ollama_model_capabilities", {
    baseUrl: baseUrl?.trim() || null,
    model,
  });
}

export async function pullOllamaModel(
  model: string,
  baseUrl?: string | null,
): Promise<void> {
  await invoke("pull_ollama_model", {
    baseUrl: baseUrl?.trim() || null,
    model: model.trim(),
  });
}

/** Turn native-agent / Ollama errors into actionable categories for the UI. */
export function classifyOllamaError(message: string): ClassifiedOllamaError {
  const text = message.trim();
  const lower = text.toLowerCase();

  if (
    lower.includes("could not reach ollama") ||
    lower.includes("not reachable") ||
    lower.includes("connection refused") ||
    lower.includes("failed to connect")
  ) {
    return { kind: "unreachable", message: text };
  }

  if (
    lower.includes("no ollama model") ||
    lower.includes("install a chat model") ||
    lower.includes("could not reach ollama at") && lower.includes("pull")
  ) {
    return { kind: "no_model", message: text };
  }

  const toolsMatch = text.match(
    /model '([^']+)' does not support tool/i,
  );
  if (toolsMatch || lower.includes("does not support tool")) {
    return {
      kind: "no_tools",
      message: text,
      model: toolsMatch?.[1],
    };
  }

  if (lower.includes("no vision support") || lower.includes("vision-capable")) {
    return { kind: "no_vision", message: text };
  }

  if (lower.includes("already running in this tab")) {
    return { kind: "already_running", message: text };
  }

  return { kind: "generic", message: text };
}

/** Heuristic capability hints when `/api/show` is unavailable or slow. */
export function ollamaModelHeuristics(model: string) {
  const name = model.toLowerCase();
  const tools =
    /llama3\.[12]|llama3\.1|qwen2\.5|qwen3|mistral-nemo|command-r|deepseek-r1|phi[34]|granite|nemotron|gemma2|gemma3|mixtral|firefunction/.test(
      name,
    );
  const vision =
    /llava|bakllava|moondream|llama3\.2-vision|minicpm-v|qwen2-vl|qwen2\.5-vl|gemma3.*vision|llama3\.2-vision/.test(
      name,
    );
  return { tools, vision };
}

export type ResolvedOllamaCapabilities = {
  tools: boolean;
  vision: boolean;
  source: "api" | "heuristic";
};

/** Merge `/api/show` capabilities with name heuristics. */
export function resolveOllamaCapabilities(
  model: string,
  api?: OllamaModelCapabilities | null,
): ResolvedOllamaCapabilities {
  const heuristics = ollamaModelHeuristics(model);
  const hasApiTools = api?.tools != null;
  const hasApiVision = api?.vision != null;
  return {
    tools: hasApiTools ? Boolean(api?.tools) : heuristics.tools,
    vision: hasApiVision ? Boolean(api?.vision) : heuristics.vision,
    source: hasApiTools || hasApiVision ? "api" : "heuristic",
  };
}

export const RECOMMENDED_OLLAMA_MODELS = [
  {
    id: "llama3.2",
    label: "Llama 3.2",
    description: "Balanced general chat with tool support",
    pull: "ollama pull llama3.2",
  },
  {
    id: "qwen2.5",
    label: "Qwen 2.5",
    description: "Strong coding and tool use",
    pull: "ollama pull qwen2.5",
  },
  {
    id: "mistral-nemo",
    label: "Mistral Nemo",
    description: "Fast edits with reliable tools",
    pull: "ollama pull mistral-nemo",
  },
] as const;

export function formatOllamaModelSize(bytes?: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

/** Read native sampling settings for display or invoke payloads. */
export function getNativeSamplingSettings() {
  const ns = useSettingsStore.getState();
  return {
    numCtx: ns.nativeNumCtx ?? null,
    temperature: ns.nativeTemperature ?? null,
  };
}
