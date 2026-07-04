import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOllamaModelCapabilities,
  type OllamaModelCapabilities,
} from "@/lib/ollama";

const capabilityCache = new Map<string, OllamaModelCapabilities>();

function cacheKey(baseUrl: string, model: string) {
  return `${baseUrl}::${model}`;
}

export function useOllamaModelCapabilities(
  model: string | null | undefined,
  baseUrl: string,
  enabled: boolean,
) {
  const [capabilities, setCapabilities] =
    useState<OllamaModelCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const trimmed = model?.trim();
    if (!enabled || !trimmed) {
      setCapabilities(null);
      setLoading(false);
      return;
    }

    const key = cacheKey(baseUrl, trimmed);
    const cached = capabilityCache.get(key);
    if (cached) {
      setCapabilities(cached);
      return;
    }

    const id = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await getOllamaModelCapabilities(trimmed, baseUrl);
      capabilityCache.set(key, next);
      if (id !== requestIdRef.current) return;
      setCapabilities(next);
    } catch {
      if (id !== requestIdRef.current) return;
      setCapabilities(null);
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, [baseUrl, enabled, model]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { capabilities, loading, refresh };
}

/** Synchronous read of cached capabilities (for sendPrompt chat-only flag). */
export function peekCachedOllamaModelCapabilities(
  baseUrl: string,
  model: string | null | undefined,
): OllamaModelCapabilities | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  return capabilityCache.get(cacheKey(baseUrl, trimmed)) ?? null;
}

export function useOllamaModelsCapabilities(
  models: string[],
  baseUrl: string,
  enabled: boolean,
) {
  const [capabilitiesByModel, setCapabilitiesByModel] = useState<
    Record<string, OllamaModelCapabilities>
  >({});
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || models.length === 0) {
      setCapabilitiesByModel({});
      setLoading(false);
      return;
    }

    const id = ++requestIdRef.current;
    setLoading(true);

    void (async () => {
      const entries = await Promise.all(
        models.map(async (model) => {
          const key = cacheKey(baseUrl, model);
          const cached = capabilityCache.get(key);
          if (cached) return [model, cached] as const;
          try {
            const caps = await getOllamaModelCapabilities(model, baseUrl);
            capabilityCache.set(key, caps);
            return [model, caps] as const;
          } catch {
            return [model, { tools: null, vision: null }] as const;
          }
        }),
      );
      if (id !== requestIdRef.current) return;
      setCapabilitiesByModel(Object.fromEntries(entries));
      setLoading(false);
    })();

    return () => {
      requestIdRef.current += 1;
    };
  }, [baseUrl, enabled, models.join("\0")]);

  return { capabilitiesByModel, loading };
}
