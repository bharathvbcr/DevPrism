import { useCallback } from "react";
import { useOllamaPullStore } from "@/stores/ollama-pull-store";

/** Shared Ollama model pull state (global progress events). */
export function useOllamaModelPull(baseUrl: string, onComplete?: () => void) {
  const progress = useOllamaPullStore((s) => s.progress);
  const pulling = useOllamaPullStore((s) => s.pulling);
  const pullModel = useOllamaPullStore((s) => s.pull);
  const reset = useOllamaPullStore((s) => s.reset);

  const pull = useCallback(
    async (model: string) => {
      await pullModel(model, baseUrl, onComplete);
    },
    [baseUrl, onComplete, pullModel],
  );

  return { pull, pulling, progress, reset };
}
