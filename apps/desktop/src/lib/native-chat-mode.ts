import { peekCachedOllamaModelCapabilities } from "@/hooks/use-ollama-model-capabilities";
import {
  getOllamaBaseUrl,
  resolveNativeOllamaModel,
  resolveOllamaCapabilities,
  resolveOllamaCredential,
} from "@/lib/ollama";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * Whether the native agent should run in chat-only mode (no tools).
 * Uses cached /api/show when available; otherwise name heuristics.
 * Returns `null` only when the model name is unknown.
 */
export function resolveNativeChatOnlyFlag(): boolean | null {
  if (!useSettingsStore.getState().nativeAgentEnabled) return null;

  const chat = useClaudeChatStore.getState();
  const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
  const cred = resolveOllamaCredential(
    creds,
    chat.selectedProviderCredentialId,
  );
  const baseUrl = getOllamaBaseUrl(cred);
  const ns = useSettingsStore.getState();
  const model = resolveNativeOllamaModel({
    nativeOllamaModel: ns.nativeOllamaModel,
    ollamaCredential: cred,
    providerModels: chat.selectedProviderModels,
  });
  if (!model) return null;

  const cached = peekCachedOllamaModelCapabilities(baseUrl, model);
  const resolved = resolveOllamaCapabilities(model, cached);
  return !resolved.tools;
}
