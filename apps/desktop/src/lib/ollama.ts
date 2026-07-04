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
  /** Max context window from /api/show model_info; null/undefined when unknown. */
  contextLength?: number | null;
}

export interface OllamaRunningModel {
  name: string;
  sizeBytes?: number | null;
  sizeVramBytes?: number | null;
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
  | "stalled"
  | "empty"
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
  const selected = credentials.find(
    (c) => c.id === selectedProviderCredentialId,
  );
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

export async function getRunningOllamaModels(
  baseUrl?: string | null,
): Promise<OllamaRunningModel[]> {
  return invoke<OllamaRunningModel[]>("ollama_ps", {
    baseUrl: baseUrl?.trim() || null,
  });
}

export async function deleteOllamaModel(
  model: string,
  baseUrl?: string | null,
): Promise<void> {
  await invoke("delete_ollama_model", {
    baseUrl: baseUrl?.trim() || null,
    model: model.trim(),
  });
}

export async function copyOllamaModel(
  source: string,
  destination: string,
  baseUrl?: string | null,
): Promise<void> {
  await invoke("copy_ollama_model", {
    baseUrl: baseUrl?.trim() || null,
    source: source.trim(),
    destination: destination.trim(),
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

/** Machine-readable code prefix emitted by the Rust backend, e.g.
 * "[E_NO_TOOLS] The model ...". Codes are stable; the prose may change. */
const ERROR_CODE_RE = /^\[(E_[A-Z_]+)\]\s*/;

const ERROR_CODE_TO_KIND: Record<string, OllamaErrorKind> = {
  E_OLLAMA_UNREACHABLE: "unreachable",
  E_NO_MODEL: "no_model",
  E_NO_TOOLS: "no_tools",
  E_NO_VISION: "no_vision",
  E_ALREADY_RUNNING: "already_running",
  E_OLLAMA_STALLED: "stalled",
  E_OLLAMA_EMPTY: "empty",
};

/** Turn native-agent / Ollama errors into actionable categories for the UI.
 * Prefers the structured `[E_*]` code prefix; falls back to string matching
 * for errors that predate the codes (persisted histories, older backends). */
export function classifyOllamaError(message: string): ClassifiedOllamaError {
  let text = message.trim();

  const codeMatch = text.match(ERROR_CODE_RE);
  if (codeMatch) {
    // Always strip the code from the human-readable message.
    text = text.slice(codeMatch[0].length).trim();
    const kind = ERROR_CODE_TO_KIND[codeMatch[1]];
    if (kind) {
      return {
        kind,
        message: text,
        model:
          kind === "no_tools" ? text.match(/model '([^']+)'/i)?.[1] : undefined,
      };
    }
    // Unknown code (newer backend): fall through to sniffing the stripped text.
  }

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
    (lower.includes("could not reach ollama at") && lower.includes("pull"))
  ) {
    return { kind: "no_model", message: text };
  }

  const toolsMatch = text.match(/model '([^']+)' does not support tool/i);
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

export const RECOMMENDED_EMBED_MODEL = {
  id: "nomic-embed-text",
  label: "nomic-embed-text",
  description: "Local embeddings for semantic PDF/editor search",
  pull: "ollama pull nomic-embed-text",
} as const;

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
