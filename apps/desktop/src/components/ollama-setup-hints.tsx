import { type FC } from "react";
import { DownloadIcon, Loader2Icon, CopyIcon, TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { RECOMMENDED_OLLAMA_MODELS } from "@/lib/ollama";
import { useOllamaModelPull } from "@/hooks/use-ollama-model-pull";
import { cn } from "@/lib/utils";

interface OllamaSetupHintsProps {
  connected: boolean;
  chatModels: number;
  baseUrl?: string;
  onModelsChanged?: () => void;
  className?: string;
  compact?: boolean;
}

async function copyPullCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Could not copy command");
  }
}

export const OllamaSetupHints: FC<OllamaSetupHintsProps> = ({
  connected,
  chatModels,
  baseUrl = "http://localhost:11434",
  onModelsChanged,
  className,
  compact = false,
}) => {
  const { pull, pulling, progress } = useOllamaModelPull(
    baseUrl,
    onModelsChanged,
  );

  if (connected && chatModels > 0) return null;

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
          <p className="mt-1 text-muted-foreground text-[11px] leading-relaxed">
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

      {pulling && progress && (
        <div className="mt-2 rounded-md border border-border/50 bg-background/80 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="truncate font-medium text-foreground">
              Pulling {progress.model}
            </span>
            {progress.percent != null && (
              <span className="shrink-0 text-muted-foreground">
                {Math.round(progress.percent)}%
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground capitalize">
            {progress.status.replace(/_/g, " ")}
          </p>
          {progress.percent != null && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.min(100, progress.percent)}%` }}
              />
            </div>
          )}
        </div>
      )}

      <div className={cn("space-y-1.5", compact ? "mt-2" : "mt-3")}>
        {RECOMMENDED_OLLAMA_MODELS.map((model) => (
          <div
            key={model.id}
            className="flex items-center gap-1 rounded-md border border-border/50 bg-background/80 p-1"
          >
            <button
              type="button"
              disabled={!connected || pulling}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
                connected && !pulling
                  ? "hover:bg-muted/60"
                  : "opacity-60",
              )}
              onClick={() => void copyPullCommand(model.pull)}
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
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-50"
                onClick={() => void pull(model.id)}
              >
                {pulling && progress?.model === model.id ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3.5" />
                )}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
