import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOllamaStatus,
  type OllamaStatus,
} from "@/lib/ollama";

export function useOllamaStatus(
  baseUrl: string,
  enabled: boolean,
  pollMs = 30_000,
) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await getOllamaStatus(baseUrl);
      if (id !== requestIdRef.current) return;
      setStatus(next);
      setError(next.connected ? null : `Ollama is not reachable at ${next.baseUrl}`);
    } catch (err: unknown) {
      if (id !== requestIdRef.current) return;
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  return { status, loading, error, refresh };
}
