import { type FC } from "react";
import { classifyOllamaError } from "@/lib/ollama";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

interface OllamaErrorHelpProps {
  error: string;
  onRetry?: () => void;
}

export const OllamaErrorHelp: FC<OllamaErrorHelpProps> = ({
  error,
  onRetry,
}) => {
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const requestModelPicker = useClaudeChatStore((s) => s.requestModelPicker);
  const clearError = useClaudeChatStore((s) => s._setError);
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);

  if (!nativeAgentEnabled) {
    return (
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1">{error}</p>
        <div className="flex shrink-0 gap-2">
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="size-8 p-0 text-destructive/70 hover:text-destructive"
            aria-label="Dismiss error"
            onClick={() => clearError(activeTabId, null)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  const classified = classifyOllamaError(error);

  return (
    <div className="space-y-2">
      <p>{classified.message}</p>
      {classified.kind === "unreachable" && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Make sure the Ollama app is running, then retry. If it stopped
          mid-chat, your conversation is still here — pick a model and send
          again.
        </p>
      )}
      {(classified.kind === "stalled" || classified.kind === "empty") && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          The model likely ran out of memory or its runner wedged. Try a smaller
          model or a lower context size (Settings → Native agent), or run{" "}
          <code>ollama ps</code> to check what's loaded, then retry.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(classified.kind === "no_tools" || classified.kind === "no_model") && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => requestModelPicker()}
          >
            Change model
          </Button>
        )}
        {(classified.kind === "unreachable" ||
          classified.kind === "stalled" ||
          classified.kind === "empty") &&
          onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => clearError(activeTabId, null)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
};
