import {
  type AgentBackend,
  AGENT_BACKENDS,
  isOllamaBaseUrl,
} from "@/lib/agent-backend";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCursorSetupStore } from "@/stores/cursor-setup-store";
import { useGroqSetupStore } from "@/stores/groq-setup-store";

export type BackendAvailabilityStatus = "ready" | "needs-setup" | "checking";

export type BackendAvailabilityMap = Record<
  AgentBackend,
  BackendAvailabilityStatus
>;

export interface BackendAvailabilityInput {
  claudeStatus: string;
  claudeProviderConfigured: boolean;
  cursorStatus: string;
  ollamaConnected: boolean | null;
  ollamaChatModels: number;
  ollamaLoading?: boolean;
  groqApiKeyConfigured: boolean;
  openAiCredentials: ReadonlyArray<{ base_url?: string | null }>;
}

function hasNonLocalCredential(
  credentials: ReadonlyArray<{ base_url?: string | null }>,
): boolean {
  return credentials.some(
    (credential) => !isOllamaBaseUrl(credential.base_url),
  );
}

/** Pure derivation of per-backend readiness from setup/store snapshots. */
export function deriveBackendAvailability(
  input: BackendAvailabilityInput,
): BackendAvailabilityMap {
  const claude: BackendAvailabilityStatus =
    input.claudeStatus === "checking"
      ? "checking"
      : input.claudeStatus === "ready" || input.claudeProviderConfigured
        ? "ready"
        : "needs-setup";

  const cursor: BackendAvailabilityStatus =
    input.cursorStatus === "checking"
      ? "checking"
      : input.cursorStatus === "ready"
        ? "ready"
        : "needs-setup";

  const ollama: BackendAvailabilityStatus =
    input.ollamaLoading && input.ollamaConnected === null
      ? "checking"
      : input.ollamaConnected === true && input.ollamaChatModels > 0
        ? "ready"
        : "needs-setup";

  const groq: BackendAvailabilityStatus = input.groqApiKeyConfigured
    ? "ready"
    : "needs-setup";

  const api: BackendAvailabilityStatus = hasNonLocalCredential(
    input.openAiCredentials,
  )
    ? "ready"
    : "needs-setup";

  return {
    "claude-code": claude,
    "cursor-cli": cursor,
    "native-ollama": ollama,
    "native-groq": groq,
    "native-api": api,
  };
}

export interface UseBackendAvailabilityOptions {
  ollamaConnected?: boolean | null;
  ollamaChatModels?: number;
  ollamaLoading?: boolean;
}

/** Live availability for each agent backend from setup stores + Ollama status. */
export function useBackendAvailability(
  options: UseBackendAvailabilityOptions = {},
): BackendAvailabilityMap {
  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const claudeProviderConfigured = useClaudeSetupStore(
    (s) => s.claudeProviderConfigured,
  );
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const cursorStatus = useCursorSetupStore((s) => s.status);
  const groqApiKeyConfigured = useGroqSetupStore((s) => s.apiKeyConfigured);

  return deriveBackendAvailability({
    claudeStatus,
    claudeProviderConfigured,
    cursorStatus,
    ollamaConnected: options.ollamaConnected ?? null,
    ollamaChatModels: options.ollamaChatModels ?? 0,
    ollamaLoading: options.ollamaLoading,
    groqApiKeyConfigured,
    openAiCredentials,
  });
}

export function backendAvailabilityLabel(
  status: BackendAvailabilityStatus,
): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "checking":
      return "Checking…";
    case "needs-setup":
      return "Set up";
  }
}

/** Stable ordered list matching AGENT_BACKENDS. */
export const BACKEND_AVAILABILITY_ORDER = AGENT_BACKENDS.map((b) => b.id);
