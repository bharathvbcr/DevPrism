import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  pullOllamaModel,
  type OllamaPullProgress,
} from "@/lib/ollama";

export function useOllamaModelPull(
  baseUrl: string,
  onComplete?: () => void,
) {
  const [progress, setProgress] = useState<OllamaPullProgress | null>(null);
  const [pulling, setPulling] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
      setProgress(event.payload);
      if (event.payload.done) {
        setPulling(false);
        if (!event.payload.error) {
          toast.success(`Installed ${event.payload.model}`);
          onCompleteRef.current?.();
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const pull = useCallback(
    async (model: string) => {
      if (pulling) return;
      setPulling(true);
      setProgress({
        model,
        status: "Starting…",
        done: false,
      });
      try {
        await pullOllamaModel(model, baseUrl);
      } catch (err: unknown) {
        setPulling(false);
        const message = err instanceof Error ? err.message : String(err);
        setProgress({
          model,
          status: "Failed",
          done: true,
          error: message,
        });
        toast.error(message);
      }
    },
    [baseUrl, pulling],
  );

  const reset = useCallback(() => {
    setProgress(null);
  }, []);

  return { pull, pulling, progress, reset };
}
