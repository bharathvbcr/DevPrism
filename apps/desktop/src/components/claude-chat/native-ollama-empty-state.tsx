import { type FC } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { OllamaSetupHints } from "@/components/ollama-setup-hints";
import {
  getOllamaBaseUrl,
  resolveNativeOllamaModel,
  resolveOllamaCredential,
} from "@/lib/ollama";
import { useOllamaStatus } from "@/hooks/use-ollama-status";
import { cn } from "@/lib/utils";

const STARTER_PROMPTS = [
  "Summarize the open document",
  "Fix grammar in the current selection",
  "List files in this project",
] as const;

export const NativeOllamaEmptyState: FC = () => {
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const nativeOllamaModel = useSettingsStore((s) => s.nativeOllamaModel);
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);
  const selectedProviderModels = useClaudeChatStore((s) => s.selectedProviderModels);
  const saveDraft = useClaudeChatStore((s) => s.saveDraft);
  const ollamaCredential = resolveOllamaCredential(openAiCredentials, null);
  const ollamaBaseUrl = getOllamaBaseUrl(ollamaCredential);
  const effectiveModel = resolveNativeOllamaModel({
    nativeOllamaModel,
    ollamaCredential,
    providerModels: selectedProviderModels,
  });
  const { status, loading, error, refresh } = useOllamaStatus(
    ollamaBaseUrl,
    true,
  );

  const connected = Boolean(status?.connected) && !error;
  const chatModels = status?.chatModels ?? 0;
  const ready = connected && chatModels > 0;

  const applyStarterPrompt = (prompt: string) => {
    saveDraft(activeTabId, { input: prompt, pinnedContexts: [] });
  };

  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-full border border-border/60 bg-muted/40">
        <SparklesIcon className="size-5 text-primary" />
      </div>
      <div className="space-y-1">
        <p className="font-medium text-foreground text-sm">
          Chat with your local Ollama model
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Edit LaTeX, explore project files, and attach context — fully offline
          when Ollama is running.
        </p>
      </div>

      <div className="w-full rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-left text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            {ollamaBaseUrl}
            {status?.version ? ` · v${status.version}` : ""}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[10px]",
              loading
                ? "text-muted-foreground"
                : connected
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-destructive",
            )}
          >
            {loading ? (
              <>
                <Loader2Icon className="size-3 animate-spin" />
                Checking…
              </>
            ) : connected ? (
              <>
                <span className="size-1.5 rounded-full bg-current" />
                {chatModels} chat model{chatModels === 1 ? "" : "s"}
              </>
            ) : (
              "Unreachable"
            )}
          </span>
        </div>
        {effectiveModel && (
          <p className="mt-1 text-muted-foreground text-[10px]">
            Model: <span className="font-medium text-foreground">{effectiveModel}</span>
          </p>
        )}
        {!loading && !connected && (
          <button
            type="button"
            className="mt-2 text-foreground text-[10px] underline underline-offset-2 hover:text-primary"
            onClick={() => void refresh()}
          >
            Retry connection
          </button>
        )}
      </div>

      {!ready && (
        <OllamaSetupHints
          connected={connected}
          chatModels={chatModels}
          baseUrl={ollamaBaseUrl}
          onModelsChanged={() => void refresh()}
          className="w-full"
        />
      )}

      {ready && (
        <div className="flex w-full flex-wrap justify-center gap-2">
          {STARTER_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="rounded-full border border-border/60 bg-background px-3 py-1.5 text-foreground text-xs transition-colors hover:bg-muted"
              onClick={() => applyStarterPrompt(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};