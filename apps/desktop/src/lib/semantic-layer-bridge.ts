import { invoke } from "@tauri-apps/api/core";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { resolveSemanticConfig } from "@/lib/semantic-layer/config";
import {
  clearSemanticCache,
  storeSemanticCache,
  type SemanticPipelineInput,
} from "@/lib/semantic-layer/pipeline";
import { aiEmbed } from "@/lib/ai-assist";
import { resolveOllamaCredential, getOllamaBaseUrl } from "@/lib/ollama";
import { isTauri } from "@/lib/runtime/is-tauri";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";

let lastSemanticLayerEnabled: boolean | undefined;

/** Push semantic-layer settings to the Rust runtime (proxy + shared cache). */
export function syncSemanticLayerConfig(): void {
  if (!isTauri()) return;

  const config = resolveSemanticConfig();
  if (lastSemanticLayerEnabled === true && !config.enabled) {
    clearSemanticCache();
  }
  lastSemanticLayerEnabled = config.enabled;
  const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
  const selectedId = useClaudeChatStore.getState().selectedProviderCredentialId;
  const ollama = resolveOllamaCredential(creds, selectedId);

  void invoke("sync_semantic_layer_config", {
    config: {
      enabled: config.enabled,
      cacheEnabled: config.cacheEnabled,
      routerEnabled: config.routerEnabled,
      compressorEnabled: config.compressorEnabled,
      lightModel: config.lightModel,
      mediumModel: config.mediumModel,
      heavyModel: config.heavyModel,
      ollamaBaseUrl: ollama?.base_url ?? "http://localhost:11434",
    },
  }).catch(() => {
    // Best-effort sync — proxy falls back to passthrough when config is stale.
  });
}

let autoEnableAttempted = false;

/** Auto-enable the semantic layer once when local embeddings are available. */
export async function maybeAutoEnableSemanticLayer(): Promise<void> {
  if (!isTauri() || autoEnableAttempted) return;
  autoEnableAttempted = true;

  if (useSettingsStore.getState().semanticLayerEnabled) return;

  try {
    const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
    const selectedId =
      useClaudeChatStore.getState().selectedProviderCredentialId;
    const ollama = resolveOllamaCredential(creds, selectedId);
    const baseUrl = getOllamaBaseUrl(ollama);
    const status = await invoke<{ embeddingModels?: number }>("ollama_status", {
      baseUrl,
    });
    if ((status.embeddingModels ?? 0) > 0) {
      useSettingsStore.getState().setSemanticLayerEnabled(true);
      syncSemanticLayerConfig();
    }
  } catch {
    // Fail-open — user can enable manually in settings.
  }
}

/** Subscribe to settings changes and keep Rust in sync. Call once at app mount. */
export function watchSemanticLayerConfigSync(): () => void {
  if (!isTauri()) return () => {};

  syncSemanticLayerConfig();
  void maybeAutoEnableSemanticLayer();

  // Only re-sync when inputs that feed the config actually change — the chat
  // store in particular updates on every streaming token, and an unguarded
  // subscription would spam `sync_semantic_layer_config` invokes per token.
  const unsubs = [
    useSettingsStore.subscribe((state, prev) => {
      if (
        state.semanticLayerEnabled !== prev.semanticLayerEnabled ||
        state.semanticCacheEnabled !== prev.semanticCacheEnabled ||
        state.semanticRouterEnabled !== prev.semanticRouterEnabled ||
        state.semanticCompressorEnabled !== prev.semanticCompressorEnabled ||
        state.semanticLightModel !== prev.semanticLightModel ||
        state.semanticMediumModel !== prev.semanticMediumModel ||
        state.semanticHeavyModel !== prev.semanticHeavyModel
      ) {
        syncSemanticLayerConfig();
      }
    }),
    useClaudeSetupStore.subscribe((state, prev) => {
      if (state.openAiCredentials !== prev.openAiCredentials) {
        syncSemanticLayerConfig();
      }
    }),
    useClaudeChatStore.subscribe((state, prev) => {
      if (
        state.selectedProviderCredentialId !== prev.selectedProviderCredentialId
      ) {
        syncSemanticLayerConfig();
      }
    }),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
  };
}

const pendingSemanticTurns = new Map<
  string,
  Pick<SemanticPipelineInput, "prompt" | "system">
>();

/** Remember the semantic cache key inputs for a tab turn (for post-turn store). */
export function trackSemanticTurn(
  tabId: string,
  input: Pick<SemanticPipelineInput, "prompt" | "system">,
): void {
  pendingSemanticTurns.set(tabId, {
    prompt: input.prompt,
    system: input.system,
  });
}

export function clearSemanticTurn(tabId: string): void {
  pendingSemanticTurns.delete(tabId);
}

function extractLastAssistantText(
  messages: ClaudeStreamMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== "assistant") continue;
    const content = msg.message?.content ?? [];
    const parts = content
      .filter((block) => block.type === "text" && block.text?.trim())
      .map((block) => block.text!.trim());
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

/** Store a completed chat turn in the semantic cache when tracked. Fail-open. */
export async function completeSemanticTurn(
  tabId: string,
  messages: ClaudeStreamMessage[],
  success: boolean,
): Promise<void> {
  const pending = pendingSemanticTurns.get(tabId);
  pendingSemanticTurns.delete(tabId);
  if (!pending || !success) return;

  const response = extractLastAssistantText(messages);
  if (!response) return;

  await storeSemanticCache(pending, response, aiEmbed);
}
