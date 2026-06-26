import { type FC } from "react";
import { classifyOllamaError } from "@/lib/ollama";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { Button } from "@/components/ui/button";

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
    return <span>{error}</span>;
  }

  const classified = classifyOllamaError(error);

  return (
    <div className="space-y-2">
      <p>{classified.message}</p>
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
        {classified.kind === "unreachable" && onRetry && (
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
}
