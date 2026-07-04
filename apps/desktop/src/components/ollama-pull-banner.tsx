import { OllamaPullStatus } from "@/components/ollama-pull-status";
import { useOllamaPullStore } from "@/stores/ollama-pull-store";

/** App-wide pull progress when install starts outside setup hints. */
export function OllamaPullBanner() {
  const pulling = useOllamaPullStore((s) => s.pulling);
  const progress = useOllamaPullStore((s) => s.progress);
  const baseUrl = useOllamaPullStore((s) => s.baseUrl);
  const pull = useOllamaPullStore((s) => s.pull);
  const reset = useOllamaPullStore((s) => s.reset);

  if (!pulling && !progress?.error) return null;

  return (
    <div className="fixed inset-x-0 top-[var(--titlebar-height)] z-[9998] border-border/60 border-b bg-muted/20 px-4 py-2 shadow-sm">
      <OllamaPullStatus
        pulling={pulling}
        progress={progress}
        onRetry={
          progress?.error && baseUrl
            ? () => {
                reset();
                void pull(progress.model, baseUrl);
              }
            : undefined
        }
      />
    </div>
  );
}
