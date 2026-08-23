/**
 * AI readiness preflight for Career → Synthesize.
 * Checks chat provider, embedding probe, and career/KB data coverage.
 */

import {
  aiComplete,
  aiEmbed,
  canUseAiAssist,
  resolveAiProvider,
  type AiAssistBackend,
  type AiProviderConfig,
} from "@/lib/ai-assist";
import {
  countBlocksMissingEmbeddings,
  countKbChunksMissingEmbeddings,
  listBlocks,
  listKbSources,
} from "@/lib/career";
import {
  classifyOllamaError,
  getOllamaBaseUrl,
  getOllamaStatus,
  resolveOllamaCredential,
} from "@/lib/ollama";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCursorSetupStore } from "@/stores/cursor-setup-store";
import { useSettingsStore } from "@/stores/settings-store";

export type ReadinessLevel = "ok" | "warn" | "error";

export type TextGenerationIssue =
  | "assist-disabled"
  | "no-provider"
  | "unreachable"
  | "no-model"
  | null;

export type EmbeddingIssue = "unreachable" | "no-model" | "error" | null;

export interface TextGenerationReadiness {
  status: ReadinessLevel;
  available: boolean;
  backend: AiAssistBackend | null;
  model: string | null;
  /** True for Ollama and openai-compat (SSE). CLI backends stay one-shot. */
  streams: boolean;
  issue: TextGenerationIssue;
  message: string;
}

export interface EmbeddingReadiness {
  status: ReadinessLevel;
  available: boolean;
  issue: EmbeddingIssue;
  message: string;
}

export interface DataReadiness {
  status: ReadinessLevel;
  /**
   * `null` means the lookup itself failed (unknown) — never conflated with a
   * confirmed zero, so UI can't claim absence for a check that couldn't run.
   */
  blockCount: number | null;
  blocksMissingEmbeddings: number | null;
  kbSourceCount: number | null;
  kbChunksMissingEmbeddings: number | null;
  message: string;
}

export interface SynthesisReadiness {
  checkedAt: number;
  text: TextGenerationReadiness;
  embeddings: EmbeddingReadiness;
  data: DataReadiness;
  /** Chat provider is usable — synthesis can start. */
  canRunWithAi: boolean;
  /** Embeddings unavailable — evidence / hybrid scoring degrade. */
  embeddingsDown: boolean;
}

const EMBED_PROBE_TTL_MS = 30_000;
const TEXT_PROBE_TTL_MS = 30_000;

let embedProbeCache: {
  at: number;
  result: EmbeddingReadiness;
} | null = null;

let textProbeCache: {
  at: number;
  key: string;
  result: TextGenerationReadiness;
} | null = null;

/** Clear cached probes (tests / after user installs a model). */
export function clearEmbedProbeCache(): void {
  embedProbeCache = null;
  textProbeCache = null;
}

function backendStreams(backend: AiAssistBackend): boolean {
  // Ollama streams natively; openai-compat streams via Rust SSE (Workstream A).
  return backend === "ollama" || backend === "openai-compat";
}

function backendLabel(backend: AiAssistBackend): string {
  switch (backend) {
    case "openai-compat":
      return "OpenAI-compatible";
    case "claude-code":
      return "Claude Code";
    case "cursor-cli":
      return "Cursor CLI";
    default:
      return "Ollama";
  }
}

function okTextMessage(provider: AiProviderConfig, streams: boolean): string {
  const label = backendLabel(provider.backend);
  const modelSuffix = provider.model ? ` · ${provider.model}` : "";
  return streams
    ? `${label}${modelSuffix} (live streaming)`
    : `${label}${modelSuffix} (no live token stream)`;
}

async function probeNonOllamaBackend(
  provider: AiProviderConfig,
  streams: boolean,
): Promise<TextGenerationReadiness | null> {
  if (provider.backend === "claude-code") {
    const store = useClaudeSetupStore.getState();
    if (store.status !== "ready" && !store.claudeProviderConfigured) {
      try {
        await store.checkStatus();
      } catch {
        // fall through to re-read
      }
    }
    const after = useClaudeSetupStore.getState();
    if (after.status === "ready" || after.claudeProviderConfigured) {
      return null; // ok — use default success message
    }
    return {
      status: "error",
      available: false,
      backend: provider.backend,
      model: provider.model,
      streams,
      issue: "unreachable",
      message:
        "Claude Code CLI is not ready. Open AI settings to install or sign in.",
    };
  }

  if (provider.backend === "cursor-cli") {
    const store = useCursorSetupStore.getState();
    if (store.status !== "ready") {
      try {
        await store.checkStatus();
      } catch {
        // fall through
      }
    }
    const after = useCursorSetupStore.getState();
    if (after.status === "ready") {
      return null;
    }
    return {
      status: "error",
      available: false,
      backend: provider.backend,
      model: provider.model,
      streams,
      issue: "unreachable",
      message:
        "Cursor CLI is not ready. Open AI settings to install or sign in.",
    };
  }

  if (provider.backend === "openai-compat") {
    try {
      await aiComplete({
        prompt: "Reply with OK",
        system: "Reply with the single word OK.",
        temperature: 0,
        skipSemanticLayer: true,
        skipSemanticCache: true,
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        available: false,
        backend: provider.backend,
        model: provider.model,
        streams,
        issue: "unreachable",
        message: `Chat provider unreachable: ${message}`,
      };
    }
  }

  return null;
}

async function checkTextGeneration(
  force = false,
): Promise<TextGenerationReadiness> {
  const settings = useSettingsStore.getState();
  if (!settings.aiAssistEnabled) {
    return {
      status: "error",
      available: false,
      backend: null,
      model: null,
      streams: false,
      issue: "assist-disabled",
      message: "AI assist is disabled in Settings.",
    };
  }

  if (!canUseAiAssist()) {
    return {
      status: "error",
      available: false,
      backend: null,
      model: null,
      streams: false,
      issue: "no-provider",
      message: "No chat provider configured. Open AI settings to connect one.",
    };
  }

  const provider: AiProviderConfig = resolveAiProvider();
  const streams = backendStreams(provider.backend);
  const cacheKey = `${provider.backend}:${provider.providerCredentialId ?? ""}:${provider.model ?? ""}`;
  const now = Date.now();
  if (
    !force &&
    textProbeCache &&
    textProbeCache.key === cacheKey &&
    now - textProbeCache.at < TEXT_PROBE_TTL_MS
  ) {
    return textProbeCache.result;
  }

  if (provider.backend === "ollama") {
    try {
      const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
      const ollama = resolveOllamaCredential(creds, null);
      const status = await getOllamaStatus(getOllamaBaseUrl(ollama));
      if (!status.connected) {
        const result: TextGenerationReadiness = {
          status: "error",
          available: false,
          backend: provider.backend,
          model: provider.model,
          streams,
          issue: "unreachable",
          message: `Cannot reach Ollama at ${status.baseUrl}.`,
        };
        textProbeCache = { at: now, key: cacheKey, result };
        return result;
      }
      if (status.chatModels === 0 && !provider.model) {
        const result: TextGenerationReadiness = {
          status: "error",
          available: false,
          backend: provider.backend,
          model: provider.model,
          streams,
          issue: "no-model",
          message: "Ollama is running but no chat model is installed.",
        };
        textProbeCache = { at: now, key: cacheKey, result };
        return result;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const classified = classifyOllamaError(message);
      if (classified.kind === "unreachable") {
        const result: TextGenerationReadiness = {
          status: "error",
          available: false,
          backend: provider.backend,
          model: provider.model,
          streams,
          issue: "unreachable",
          message: classified.message || "Cannot reach Ollama.",
        };
        textProbeCache = { at: now, key: cacheKey, result };
        return result;
      }
      if (classified.kind === "no_model") {
        const result: TextGenerationReadiness = {
          status: "error",
          available: false,
          backend: provider.backend,
          model: provider.model,
          streams,
          issue: "no-model",
          message: classified.message || "No chat model installed.",
        };
        textProbeCache = { at: now, key: cacheKey, result };
        return result;
      }
      const result: TextGenerationReadiness = {
        status: "warn",
        available: true,
        backend: provider.backend,
        model: provider.model,
        streams,
        issue: null,
        message: `Ollama status check failed (${message}); will retry on run.`,
      };
      textProbeCache = { at: now, key: cacheKey, result };
      return result;
    }
  } else {
    const probeFail = await probeNonOllamaBackend(provider, streams);
    if (probeFail) {
      textProbeCache = { at: now, key: cacheKey, result: probeFail };
      return probeFail;
    }
  }

  const result: TextGenerationReadiness = {
    status: "ok",
    available: true,
    backend: provider.backend,
    model: provider.model,
    streams,
    issue: null,
    message: okTextMessage(provider, streams),
  };
  textProbeCache = { at: now, key: cacheKey, result };
  return result;
}

async function probeEmbeddings(force = false): Promise<EmbeddingReadiness> {
  const now = Date.now();
  if (
    !force &&
    embedProbeCache &&
    now - embedProbeCache.at < EMBED_PROBE_TTL_MS
  ) {
    return embedProbeCache.result;
  }

  try {
    await aiEmbed(["ping"]);
    const result: EmbeddingReadiness = {
      status: "ok",
      available: true,
      issue: null,
      message: "Embedding provider ready",
    };
    embedProbeCache = { at: now, result };
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classified = classifyOllamaError(message);
    let issue: EmbeddingIssue = "error";
    let status: ReadinessLevel = "warn";
    let userMessage = message;

    if (
      classified.kind === "unreachable" ||
      /E_OLLAMA_UNREACHABLE/i.test(message)
    ) {
      issue = "unreachable";
      status = "warn";
      userMessage =
        classified.message ||
        "Cannot reach Ollama for embeddings. Evidence search will be empty.";
    } else if (classified.kind === "no_model" || /E_NO_MODEL/i.test(message)) {
      issue = "no-model";
      status = "warn";
      userMessage =
        classified.message ||
        "No embedding model installed. Pull nomic-embed-text or use a cloud embed provider.";
    } else {
      userMessage = `Embeddings unavailable: ${message}`;
    }

    const result: EmbeddingReadiness = {
      status,
      available: false,
      issue,
      message: userMessage,
    };
    embedProbeCache = { at: now, result };
    return result;
  }
}

async function checkData(): Promise<DataReadiness> {
  // Independent lookups: one failing table must not zero out the others.
  const [blocksRes, blocksMissingRes, sourcesRes, kbMissingRes] =
    await Promise.allSettled([
      listBlocks(),
      countBlocksMissingEmbeddings(),
      listKbSources(),
      countKbChunksMissingEmbeddings(),
    ]);

  const blockCount =
    blocksRes.status === "fulfilled" ? blocksRes.value.length : null;
  const blocksMissing =
    blocksMissingRes.status === "fulfilled" ? blocksMissingRes.value : null;
  const sources = sourcesRes.status === "fulfilled" ? sourcesRes.value : null;
  const kbSourceCount = sources == null ? null : sources.length;
  const kbMissing =
    kbMissingRes.status === "fulfilled" ? kbMissingRes.value : null;

  if (blockCount == null) {
    return {
      status: "error",
      blockCount: null,
      blocksMissingEmbeddings: blocksMissing,
      kbSourceCount,
      kbChunksMissingEmbeddings: kbMissing,
      message:
        "Could not load experience blocks from the Career DB — data coverage unknown.",
    };
  }

  if (blockCount === 0) {
    return {
      status: "error",
      blockCount,
      blocksMissingEmbeddings: blocksMissing,
      kbSourceCount,
      kbChunksMissingEmbeddings: kbMissing,
      message:
        "No experience blocks yet — import a resume or add blocks first.",
    };
  }

  const parts: string[] = [`${blockCount} block${blockCount === 1 ? "" : "s"}`];
  if (blocksMissing == null) {
    parts.push("block embed coverage unknown");
  } else if (blocksMissing > 0) {
    parts.push(`${blocksMissing} block(s) missing embeddings`);
  }
  if (kbSourceCount == null) {
    parts.push("knowledge source lookup failed");
  } else if (kbSourceCount > 0) {
    parts.push(
      `${kbSourceCount} knowledge source${kbSourceCount === 1 ? "" : "s"}`,
    );
  } else {
    parts.push("no knowledge sources");
  }
  if (kbMissing == null) {
    parts.push("KB embed coverage unknown");
  } else if (kbMissing > 0) {
    parts.push(`${kbMissing} KB chunk(s) missing embeddings`);
  }

  const hasPending = (blocksMissing ?? 0) > 0 || (kbMissing ?? 0) > 0;
  const noKb = kbSourceCount === 0;
  const anyUnknown =
    blocksMissing == null || kbSourceCount == null || kbMissing == null;

  return {
    status: hasPending || noKb || anyUnknown ? "warn" : "ok",
    blockCount,
    blocksMissingEmbeddings: blocksMissing,
    kbSourceCount,
    kbChunksMissingEmbeddings: kbMissing,
    message: parts.join(" · "),
  };
}

/** Full synthesis readiness snapshot for the Synthesize tab. */
export async function checkSynthesisReadiness(options?: {
  /** Bypass embed / text probe caches. */
  forceEmbedProbe?: boolean;
}): Promise<SynthesisReadiness> {
  const force = options?.forceEmbedProbe === true;
  const [text, embeddings] = await Promise.all([
    checkTextGeneration(force),
    probeEmbeddings(force),
  ]);
  const data = await checkData();

  return {
    checkedAt: Date.now(),
    text,
    embeddings,
    data,
    canRunWithAi: text.available,
    embeddingsDown: !embeddings.available,
  };
}

/** Pending items that can be backfilled (blocks + KB chunks). Unknown counts contribute 0 — backfill recomputes server-side. */
export function pendingEmbedCount(readiness: SynthesisReadiness): number {
  return (
    (readiness.data.blocksMissingEmbeddings ?? 0) +
    (readiness.data.kbChunksMissingEmbeddings ?? 0)
  );
}
