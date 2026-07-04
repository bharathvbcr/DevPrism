import { type FC, useState } from "react";
import {
  DownloadIcon,
  Loader2Icon,
  CopyIcon,
  TerminalIcon,
} from "lucide-react";
import { toast } from "sonner";
import { RECOMMENDED_OLLAMA_MODELS } from "@/lib/ollama";
import { useOllamaModelPull } from "@/hooks/use-ollama-model-pull";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { OllamaPullStatus } from "@/components/ollama-pull-status";
import { cn } from "@/lib/utils";

interface OllamaSetupHintsProps {
  connected: boolean;
  chatModels: number;
  baseUrl?: string;
  onModelsChanged?: () => void;
  className?: string;
  compact?: boolean;
}

export const OllamaSetupHints: FC<OllamaSetupHintsProps> = ({
  connected,
  chatModels,
  baseUrl = "http://localhost:11434",
  onModelsChanged,
  className,
  compact = false,
}) => {
  const { pull, pulling, progress, reset } = useOllamaModelPull(
    baseUrl,
    onModelsChanged,
  );
  const [copyError, setCopyError] = useState<string | null>(null);

  if (connected && chatModels > 0) return null;

  const copyPullCommand = async (command: string) => {
    setCopyError(null);
    const err = await copyToClipboard(command);
    if (err) setCopyError(err);
    else toast.success("Copied to clipboard");
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-muted/30 text-left",
        compact ? "p-2.5" : "p-3",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground text-xs">
            {!connected ? "Start Ollama locally" : "Install a chat model"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
            {!connected ? (
              <>
                Install{" "}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-2 hover:text-primary"
                >
                  Ollama
                </a>{" "}
                and keep it running on port 11434.
              </>
            ) : (
              <>
                Ollama is running but no chat models are installed yet. Pull one
                here or copy the terminal command.
              </>
            )}
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
                void pull(progress.model);
              }
            : undefined
        }
      />

      <div className={cn("space-y-1.5", compact ? "mt-2" : "mt-3")}>
        {RECOMMENDED_OLLAMA_MODELS.map((model) => {
          const isPulling = pulling && progress?.model === model.id;
          // Primary action installs when we can reach Ollama; otherwise it
          // copies the terminal command so the user can run it themselves.
          const primaryDisabled = connected && pulling;
          return (
            <div
              key={model.id}
              className="flex items-center gap-1 rounded-md border border-border/50 bg-background/80 p-1"
            >
              <button
                type="button"
                disabled={primaryDisabled}
                aria-label={
                  connected
                    ? `Install ${model.label}`
                    : `Copy install command for ${model.label}`
                }
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
                  primaryDisabled ? "opacity-60" : "hover:bg-muted/60",
                )}
                onClick={() =>
                  connected
                    ? void pull(model.id)
                    : void copyPullCommand(model.pull)
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground text-xs">
                    {model.label}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {model.description}
                  </div>
                </div>
                {connected ? (
                  isPulling ? (
                    <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <DownloadIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </button>
              {connected && (
                <button
                  type="button"
                  disabled={pulling}
                  title="Copy install command"
                  aria-label={`Copy install command for ${model.label}`}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                  onClick={() => void copyPullCommand(model.pull)}
                >
                  <CopyIcon className="size-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
