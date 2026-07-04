import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { getOllamaBaseUrl, resolveOllamaCredential } from "@/lib/ollama";
import { useOllamaStatus } from "@/hooks/use-ollama-status";

/** Whether local embedding models are available for semantic search. */
export function useEmbeddingReady(pollMs = 45_000) {
  const aiSemanticSearch = useSettingsStore((s) => s.aiSemanticSearch);
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);

  const baseUrl = useMemo(
    () => getOllamaBaseUrl(resolveOllamaCredential(openAiCredentials, null)),
    [openAiCredentials],
  );

  const enabled = aiSemanticSearch && nativeAgentEnabled;
  const { status, loading, refresh } = useOllamaStatus(
    baseUrl,
    enabled,
    pollMs,
  );

  return {
    enabled,
    baseUrl,
    connected: Boolean(status?.connected),
    ready: (status?.embeddingModels ?? 0) > 0,
    embeddingModels: status?.embeddingModels ?? 0,
    loading: enabled && loading && !status,
    refresh,
  };
}
