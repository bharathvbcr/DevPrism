import { type FC, useState } from "react";
import {
  CopyIcon,
  DownloadIcon,
  Loader2Icon,
  TerminalIcon,
} from "lucide-react";
import { toast } from "sonner";
import { RECOMMENDED_EMBED_MODEL } from "@/lib/ollama";
import { useOllamaModelPull } from "@/hooks/use-ollama-model-pull";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { OllamaPullStatus } from "@/components/ollama-pull-status";
import { cn } from "@/lib/utils";

/** Prompt to install an Ollama embedding model for semantic search. */
export const OllamaEmbedSetupHints: FC<{
  baseUrl?: string;
  connected: boolean;
  className?: string;
  compact?: boolean;
  onModelPulled?: () => void;
}> = ({
  baseUrl = "http://localhost:11434",
  connected,
  className,
  compact = false,
  onModelPulled,
}) => {
  const { pull, pulling, progress, reset } = useOllamaModelPull(
    baseUrl,
    onModelPulled,
  );
  const model = RECOMMENDED_EMBED_MODEL;
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyCommand = async (command: string) => {
    setCopyError(null);
    const err = await copyToClipboard(command);
    if (err) setCopyError(err);
    else toast.success("Copied to clipboard");
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-amber-500/30 bg-amber-500/5 text-left",
        compact ? "p-2.5" : "p-3",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground text-xs">
            Install an embedding model
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
            Semantic search needs{" "}
            <code className="rounded bg-muted px-1 font-mono text-[10px]">
              {model.id}
            </code>
            . Pull it in-app or copy the terminal command.
          </p>
        </div>
      </div>

      {copyError && (
        <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          {copyError}
        </p>
      )}

      <OllamaPullStatus
        pulling={pulling}
        progress={progress}
        onRetry={
          progress?.error
            ? () => {
                reset();
                void pull(model.id);
              }
            : undefined
        }
      />

      <div className="mt-2 flex items-center gap-1 rounded-md border border-border/50 bg-background/80 p-1">
        <button
          type="button"
          disabled={!connected || pulling}
          aria-label={`Copy pull command for ${model.label}`}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
            connected && !pulling ? "hover:bg-muted/60" : "opacity-60",
          )}
          onClick={() => void copyCommand(model.pull)}
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground text-xs">
              {model.label}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {model.description}
            </div>
          </div>
          <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
        {connected && (
          <button
            type="button"
            disabled={pulling}
            title={`Pull ${model.id}`}
            aria-label={`Pull ${model.label}`}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-50"
            onClick={() => void pull(model.id)}
          >
            {pulling ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
};
