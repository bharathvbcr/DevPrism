import { invoke, Channel } from "@tauri-apps/api/core";
import {
  useClaudeChatStore,
  CLAUDE_CODE_PROVIDER_ID,
} from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import type { SpaceKind } from "@/lib/space-features";
import { personalizationAssistHint } from "@/lib/personalization";
import {
  resolveNativeOllamaModel,
  resolveOllamaCredential,
} from "@/lib/ollama";

export interface AiProviderConfig {
  providerCredentialId: string | null;
  model: string | null;
  baseUrl: string | null;
  numCtx: number | null;
  temperature: number | null;
}

/** Resolve the model/provider used for lightweight local AI assist calls. */
export function resolveAiProvider(): AiProviderConfig {
  const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
  const selectedId = useClaudeChatStore.getState().selectedProviderCredentialId;
  const providerModels = useClaudeChatStore.getState().selectedProviderModels;
  const ns = useSettingsStore.getState();

  if (selectedId && selectedId !== CLAUDE_CODE_PROVIDER_ID) {
    const cred = creds.find((c) => c.id === selectedId);
    if (cred) {
      return {
        providerCredentialId: cred.id,
        model: providerModels[cred.id] || cred.model || null,
        baseUrl: cred.base_url || null,
        numCtx: ns.nativeNumCtx ?? null,
        temperature: ns.nativeTemperature ?? null,
      };
    }
  }

  const ollama = resolveOllamaCredential(creds, selectedId);
  return {
    providerCredentialId: ollama?.id ?? null,
    model: resolveNativeOllamaModel({
      nativeOllamaModel: ns.nativeOllamaModel,
      ollamaCredential: ollama,
      providerModels,
    }),
    baseUrl: ollama?.base_url || null,
    numCtx: ns.nativeNumCtx ?? null,
    temperature: ns.nativeTemperature ?? null,
  };
}

/** Whether direct one-shot AI (Ollama or OpenAI-compatible) is available. */
export function canUseAiAssist(): boolean {
  if (!useSettingsStore.getState().aiAssistEnabled) return false;

  const providerId = useClaudeChatStore.getState().selectedProviderCredentialId;
  if (providerId && providerId !== CLAUDE_CODE_PROVIDER_ID) {
    const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
    return creds.some((c) => c.id === providerId);
  }
  return (
    useSettingsStore.getState().nativeAgentEnabled ||
    !!resolveOllamaCredential(
      useClaudeSetupStore.getState().openAiCredentials ?? [],
      providerId,
    )
  );
}

// Bound the number of concurrent one-shot AI calls. Many passive features
// (grammar, predictive text/actions, context suggestions, project blurbs,
// command descriptions, comment verdicts, semantic ranking) fire automatically;
// a single local Ollama serializes generation, so an uncoordinated burst would
// queue dozens of requests and starve latency-sensitive calls. This gate caps
// the fan-out app-wide so callers don't each need their own limiter.
const AI_MAX_CONCURRENCY = 3;
let aiActiveCount = 0;
const aiWaiters: Array<() => void> = [];

function acquireAiSlot(): Promise<void> {
  if (aiActiveCount < AI_MAX_CONCURRENCY) {
    aiActiveCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => aiWaiters.push(resolve));
}

function releaseAiSlot(): void {
  const next = aiWaiters.shift();
  if (next) {
    next(); // hand the slot directly to the next waiter (count stays the same)
  } else {
    aiActiveCount = Math.max(0, aiActiveCount - 1);
  }
}

/** One-shot completion via the native agent backend (Ollama or OpenAI-compatible). */
export async function aiComplete(options: {
  prompt: string;
  system?: string;
  temperature?: number;
  /** Pass "json" to ask the local model for a strict JSON object. */
  format?: "json";
}): Promise<string> {
  const provider = resolveAiProvider();
  await acquireAiSlot();
  try {
    return await invoke<string>("ai_complete", {
      prompt: options.prompt,
      system: options.system ?? null,
      model: provider.model,
      baseUrl: provider.baseUrl,
      providerCredentialId: provider.providerCredentialId,
      numCtx: provider.numCtx,
      temperature: options.temperature ?? provider.temperature,
      format: options.format ?? null,
    });
  } finally {
    releaseAiSlot();
  }
}

/**
 * Streaming one-shot completion. Forwards text fragments to `onChunk` as they
 * arrive (local Ollama streams token-by-token; the credential path delivers one
 * chunk). Resolves with the full accumulated text.
 */
export async function aiCompleteStream(
  options: { prompt: string; system?: string; temperature?: number },
  onChunk: (fragment: string) => void,
): Promise<string> {
  const provider = resolveAiProvider();
  const channel = new Channel<string>();
  channel.onmessage = (fragment) => onChunk(fragment);
  return invoke<string>("ai_complete_stream", {
    prompt: options.prompt,
    system: options.system ?? null,
    model: provider.model,
    baseUrl: provider.baseUrl,
    providerCredentialId: provider.providerCredentialId,
    numCtx: provider.numCtx,
    temperature: options.temperature ?? provider.temperature,
    onChunk: channel,
  });
}

/** Embed texts with a local Ollama embedding model. One vector per input.
 * Embeddings are Ollama-only, so this always targets the local Ollama endpoint —
 * never the active provider's base URL, which may be a cloud host with no
 * `/api/embed`. */
export async function aiEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
  const selectedId = useClaudeChatStore.getState().selectedProviderCredentialId;
  const ollama = resolveOllamaCredential(creds, selectedId);
  const baseUrl = ollama?.base_url ?? "http://localhost:11434";
  await acquireAiSlot();
  try {
    return await invoke<number[][]>("ai_embed", {
      texts,
      // Embedding uses a dedicated embed model, not the chat model; let the
      // backend pick an installed embedding model when none is configured.
      model: null,
      baseUrl,
    });
  } finally {
    releaseAiSlot();
  }
}

/** Cosine similarity between two equal-length vectors (0 when degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank candidates by local-embedding similarity to a query. Embeds the query
 * and all candidate texts in one batch, returns indices sorted most-similar
 * first with their scores. Returns [] on any failure (caller falls back).
 */
export async function semanticRank(
  query: string,
  candidates: string[],
): Promise<{ index: number; score: number }[]> {
  if (!query.trim() || candidates.length === 0) return [];
  const vectors = await aiEmbed([query, ...candidates]);
  if (vectors.length !== candidates.length + 1) return [];
  const [queryVec, ...candVecs] = vectors;
  return candVecs
    .map((vec, index) => ({ index, score: cosineSimilarity(queryVec, vec) }))
    .sort((a, b) => b.score - a.score);
}

const PREDICTIVE_SYSTEM =
  "You continue LaTeX or plain document prose naturally. Return ONLY the next few words " +
  "(at most one short sentence) that should follow — no quotes, no explanation, no markdown.";

const GRAMMAR_SYSTEM =
  "You are a grammar checker for LaTeX documents. Given a passage, return a JSON array of issues. " +
  'Each issue: {"message": string, "fix": string}. "fix" is the corrected phrase for that span only. ' +
  "Ignore LaTeX commands unless they contain English prose errors. If no issues, return []. " +
  "Return ONLY valid JSON — no markdown fences.";

const SUGGESTIONS_SYSTEM =
  "You suggest short writing actions for a document editor. Return a JSON array of 2-4 objects: " +
  '{"label": string, "prompt": string}. Labels are 1-3 words; prompts are one sentence the user sends to an AI assistant. ' +
  "Return ONLY valid JSON — no markdown fences.";

const FOLLOW_UPS_SYSTEM =
  "You suggest short follow-up prompts after an AI assistant reply in a writing app. " +
  'Return a JSON array of 2-3 objects: {"label": string, "prompt": string}. ' +
  "Labels are 2-4 words; prompts are one actionable sentence. JSON only.";

const BIB_COMPLETE_SYSTEM =
  "You complete BibTeX metadata from a citation hint (DOI, URL, title, authors, or partial entry). " +
  'Return JSON: {"type": string, "key": string, "title": string, "author": string, "year": string, ' +
  '"journal"?: string, "booktitle"?: string, "publisher"?: string, "doi"?: string, "url"?: string}. JSON only.';

const LINT_FIX_SYSTEM =
  "You fix a single line of LaTeX to resolve a lint/syntax error. " +
  "Return ONLY the corrected line — no explanation, no markdown fences.";

const COMPILE_EXPLAIN_SYSTEM =
  "You explain LaTeX compilation errors clearly and suggest the most likely fix in 2-4 sentences. " +
  "Be specific about which line or command to change. Plain text only.";

const SECTION_SUMMARY_SYSTEM =
  "You summarize a document section in 1-2 concise sentences for an outline panel. Plain text only.";

const TIGHTEN_SYSTEM =
  "You shorten document prose to meet a word or character limit while preserving meaning and LaTeX commands. " +
  "Return ONLY the shortened text — no explanation.";

/** Extract prose context around the cursor for predictive completion. */
export function extractProseContext(
  doc: string,
  cursor: number,
  maxChars = 600,
): { prefix: string; inProse: boolean } {
  const pos = Math.min(Math.max(0, cursor), doc.length);
  const before = doc.slice(Math.max(0, pos - maxChars), pos);

  // Skip if cursor is inside a LaTeX command name or math mode.
  const tail = before.slice(-80);
  if (/\\[a-zA-Z@]*$/.test(tail)) return { prefix: "", inProse: false };
  if ((tail.match(/\$/g) ?? []).length % 2 === 1)
    return { prefix: "", inProse: false };

  const stripped = before
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?(\{[^}]*\})*/g, " ")
    .replace(/[{}$&~^_#]/g, " ")
    .trim();

  if (stripped.length < 12) return { prefix: "", inProse: false };
  return { prefix: stripped.slice(-400), inProse: true };
}

/** Current sentence/paragraph for grammar checking. */
export function extractGrammarSpan(
  doc: string,
  cursor: number,
): { text: string; from: number; to: number } | null {
  const pos = Math.min(Math.max(0, cursor), doc.length);
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = doc.indexOf("\n", pos);
  const line = doc.slice(lineStart, lineEnd === -1 ? doc.length : lineEnd);
  if (!line.trim() || line.trim().startsWith("%")) return null;
  if (
    /^\\(begin|end|section|subsection|item|label|cite|ref)/.test(line.trim())
  ) {
    return null;
  }
  return {
    text: line,
    from: lineStart,
    to: lineEnd === -1 ? doc.length : lineEnd,
  };
}

export interface GrammarIssue {
  message: string;
  fix: string;
}

export async function checkGrammar(text: string): Promise<GrammarIssue[]> {
  if (!text.trim() || text.trim().length < 8) return [];
  const raw = await aiComplete({
    system: GRAMMAR_SYSTEM,
    prompt: text,
    temperature: 0.1,
    format: "json",
  });
  return parseJsonArray<GrammarIssue>(raw).filter(
    (i) => i.message?.trim() && i.fix?.trim(),
  );
}

export interface ContextSuggestion {
  label: string;
  prompt: string;
}

export async function fetchContextSuggestions(options: {
  spaceKind: SpaceKind;
  excerpt: string;
  fileName?: string;
}): Promise<ContextSuggestion[]> {
  const excerpt = options.excerpt.trim().slice(0, 1200);
  if (excerpt.length < 40) return [];

  const raw = await aiComplete({
    system: SUGGESTIONS_SYSTEM,
    prompt:
      personalizationAssistHint() +
      `Document type: ${options.spaceKind}\n` +
      `File: ${options.fileName ?? "document"}\n\n` +
      `Excerpt:\n${excerpt}`,
    temperature: 0.5,
    format: "json",
  });
  return parseJsonArray<ContextSuggestion>(raw)
    .filter((s) => s.label?.trim() && s.prompt?.trim())
    .slice(0, 4);
}

export async function fetchChatFollowUps(options: {
  assistantExcerpt: string;
  spaceKind: SpaceKind;
}): Promise<ContextSuggestion[]> {
  const excerpt = options.assistantExcerpt.trim().slice(-1800);
  if (excerpt.length < 40) return [];

  const raw = await aiComplete({
    system: FOLLOW_UPS_SYSTEM,
    prompt:
      personalizationAssistHint() +
      `Document type: ${options.spaceKind}\n\nLast assistant reply:\n${excerpt}`,
    temperature: 0.45,
    format: "json",
  });
  return parseJsonArray<ContextSuggestion>(raw)
    .filter((s) => s.label?.trim() && s.prompt?.trim())
    .slice(0, 3);
}

export async function fixLintLine(
  text: string,
  message: string,
): Promise<string> {
  if (!text.trim()) throw new Error("Empty line to fix.");
  return aiComplete({
    system: LINT_FIX_SYSTEM,
    prompt: `Lint error: ${message}\n\nLine:\n${text}`,
    temperature: 0.1,
  });
}

export async function explainCompileErrors(errors: string[]): Promise<string> {
  if (errors.length === 0) return "";
  return aiComplete({
    system: COMPILE_EXPLAIN_SYSTEM,
    prompt: errors.map((e) => `- ${e}`).join("\n"),
    temperature: 0.2,
  });
}

/** Streaming variant of explainCompileErrors — fragments arrive via onChunk. */
export async function explainCompileErrorsStream(
  errors: string[],
  onChunk: (fragment: string) => void,
): Promise<string> {
  if (errors.length === 0) return "";
  return aiCompleteStream(
    {
      system: COMPILE_EXPLAIN_SYSTEM,
      prompt: errors.map((e) => `- ${e}`).join("\n"),
      temperature: 0.2,
    },
    onChunk,
  );
}

/** Parse `l.42` style line numbers from LaTeX log errors. */
export function parseCompileErrorLine(error: string): number | null {
  const m = error.match(/\bl\.(\d+)\b/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface BibFieldSuggestion {
  type?: string;
  key?: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  doi?: string;
  url?: string;
}

export async function completeBibEntryFields(
  hint: string,
): Promise<BibFieldSuggestion> {
  const raw = await aiComplete({
    system: BIB_COMPLETE_SYSTEM,
    prompt: hint.trim(),
    temperature: 0.2,
    format: "json",
  });
  return parseJsonObject<BibFieldSuggestion>(raw);
}

export async function summarizeSection(text: string): Promise<string> {
  const excerpt = text.trim().slice(0, 2500);
  if (excerpt.length < 20) return "";
  return aiComplete({
    system: SECTION_SUMMARY_SYSTEM,
    prompt: excerpt,
    temperature: 0.3,
  });
}

export async function tightenToLimit(
  text: string,
  options: { wordLimit?: number; charLimit?: number },
): Promise<string> {
  const limit =
    options.wordLimit != null
      ? `${options.wordLimit} words`
      : options.charLimit != null
        ? `${options.charLimit} characters`
        : "shorter";
  return aiComplete({
    system: TIGHTEN_SYSTEM,
    prompt: `Target: ${limit}\n\nText:\n${text.slice(0, 4000)}`,
    temperature: 0.25,
  });
}

export function lineOffsets(
  content: string,
  line: number,
): { from: number; to: number; text: string } | null {
  const lines = content.split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return null;
  let from = 0;
  for (let i = 0; i < idx; i++) from += lines[i].length + 1;
  const text = lines[idx];
  return { from, to: from + text.length, text };
}

export async function fetchPredictiveContinuation(
  prefix: string,
): Promise<string> {
  const continuation = await aiComplete({
    system: PREDICTIVE_SYSTEM,
    prompt: `Continue after:\n\n${prefix}`,
    temperature: 0.35,
  });
  return continuation.replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function draftCommentSuggestion(options: {
  mode: "comment" | "suggestion";
  quotedText: string;
}): Promise<{ comment: string; replacement?: string }> {
  const system =
    options.mode === "suggestion"
      ? "You suggest a concise editorial comment and an improved replacement for the quoted passage. " +
        'Return JSON: {"comment": string, "replacement": string}. Preserve LaTeX. JSON only.'
      : "You draft a brief editorial comment about the quoted passage. " +
        'Return JSON: {"comment": string}. JSON only.';

  const raw = await aiComplete({
    system,
    prompt: `Quoted passage:\n\n${options.quotedText}`,
    temperature: 0.4,
    format: "json",
  });

  const parsed = parseJsonObject<{ comment?: string; replacement?: string }>(
    raw,
  );
  const comment = parsed.comment?.trim() ?? "";
  if (!comment) throw new Error("AI returned an empty comment.");
  if (options.mode === "suggestion" && parsed.replacement?.trim()) {
    return { comment, replacement: parsed.replacement.trim() };
  }
  return { comment };
}

const PREDICTIVE_ACTIONS_SYSTEM =
  "You predict the user's most likely NEXT ACTIONS while writing a document. " +
  'Return a JSON array of 2-4 objects: {"label": string, "prompt": string}. ' +
  "Labels are imperative, 1-3 words (e.g. \"Add abstract\", \"Tighten intro\", \"Cite source\"). " +
  "Prompts are one actionable sentence to send to an AI writing assistant. " +
  "Base them on what is missing or unfinished in the excerpt. Return ONLY valid JSON — no markdown fences.";

const IMPROVE_PROMPT_SYSTEM =
  "You rewrite a user's draft instruction to an AI writing assistant so it is clearer, " +
  "more specific, and more likely to get a good result. Keep the user's intent and any " +
  "referenced files. Return ONLY the improved instruction — no preamble, no quotes, no markdown.";

const PROJECT_NAME_SYSTEM =
  "You name a document project from a short description of its purpose. " +
  "Return ONLY a concise, human-readable title of 2-5 words — no quotes, no trailing punctuation, no explanation.";

const VERSION_NAME_SYSTEM =
  "You name a tailored version of a document from a target description (a job posting, call for papers, " +
  'grant prompt, or program brief). Return ONLY a short label of the form "Org — Role/Venue" or just the ' +
  "role/venue when no organization is stated. At most 60 characters. No quotes, no explanation.";

const TEMPLATE_RECOMMEND_SYSTEM =
  "You recommend document templates that best fit a user's goal. You are given the goal and a JSON list of " +
  'templates ({"id", "name", "description"}). Return a JSON array of the best-matching template ids, most ' +
  "relevant first, at most 5. Return ONLY a JSON array of id strings — no markdown fences.";

const LIMIT_PARSE_SYSTEM =
  "You extract an explicit length limit from requirements text (a prompt, brief, or job description). " +
  'Return JSON: {"wordLimit"?: number, "charLimit"?: number}. Include a field ONLY if the text states that ' +
  'limit (including spelled-out numbers like "five hundred words" or ranges — use the upper bound). ' +
  "If no length limit is stated, return {}. Return ONLY valid JSON — no markdown fences.";

/** Predict the user's likely next writing actions for the active document. */
export async function fetchPredictiveActions(options: {
  spaceKind: SpaceKind;
  excerpt: string;
  fileName?: string;
}): Promise<ContextSuggestion[]> {
  const excerpt = options.excerpt.trim().slice(0, 1600);
  if (excerpt.length < 60) return [];

  const raw = await aiComplete({
    system: PREDICTIVE_ACTIONS_SYSTEM,
    prompt:
      personalizationAssistHint() +
      `Document type: ${options.spaceKind}\n` +
      `File: ${options.fileName ?? "document"}\n\n` +
      `Current document:\n${excerpt}`,
    temperature: 0.5,
    format: "json",
  });
  return parseJsonArray<ContextSuggestion>(raw)
    .filter((s) => s.label?.trim() && s.prompt?.trim())
    .slice(0, 4);
}

/** Rewrite a terse chat prompt into a clearer, more specific instruction. */
export async function improvePrompt(text: string): Promise<string> {
  const draft = text.trim();
  if (draft.length < 3) return draft;
  const improved = await aiComplete({
    system: IMPROVE_PROMPT_SYSTEM,
    prompt: draft,
    temperature: 0.4,
  });
  const out = improved.trim();
  return out || draft;
}

/** Suggest a concise project name from a free-text purpose/description. */
export async function suggestProjectName(purpose: string): Promise<string> {
  const text = purpose.trim().slice(0, 1200);
  if (text.length < 8) return "";
  const name = await aiComplete({
    system: PROJECT_NAME_SYSTEM,
    prompt: text,
    temperature: 0.4,
  });
  return name
    .replace(/^["'\s]+|["'\s.]+$/g, "")
    .slice(0, 60)
    .trim();
}

/** Suggest a tailored-version name from a pasted target description. */
export async function aiSuggestVersionName(target: string): Promise<string> {
  const text = target.trim().slice(0, 2000);
  if (text.length < 20) return "";
  const name = await aiComplete({
    system: VERSION_NAME_SYSTEM,
    prompt: text,
    temperature: 0.3,
  });
  return name
    .replace(/^["'\s]+|["'\s.]+$/g, "")
    .slice(0, 70)
    .trim();
}

/** Rank template ids by relevance to a user's goal. */
export async function recommendTemplates(
  goal: string,
  templates: { id: string; name: string; description?: string }[],
): Promise<string[]> {
  const text = goal.trim();
  if (text.length < 8 || templates.length === 0) return [];
  const known = new Set(templates.map((t) => t.id));
  const raw = await aiComplete({
    system: TEMPLATE_RECOMMEND_SYSTEM,
    prompt:
      `Goal: ${text}\n\nTemplates:\n` +
      JSON.stringify(
        templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: (t.description ?? "").slice(0, 160),
        })),
      ),
    temperature: 0.2,
    format: "json",
  });
  return parseJsonArray<string>(raw)
    .filter((id) => typeof id === "string" && known.has(id))
    .slice(0, 5);
}

/** Rank templates by local-embedding similarity to a goal; ids most-relevant
 * first. Returns [] on any failure so callers can fall back to recommendTemplates. */
export async function semanticRankTemplates(
  goal: string,
  templates: { id: string; name: string; description?: string }[],
): Promise<string[]> {
  if (goal.trim().length < 4 || templates.length === 0) return [];
  const docs = templates.map(
    (t) => `${t.name}. ${(t.description ?? "").slice(0, 200)}`,
  );
  const ranked = await semanticRank(goal, docs);
  return ranked
    .filter((r) => r.score > 0.2)
    .map((r) => templates[r.index].id)
    .slice(0, 6);
}

/** AI fallback for length-limit detection when the regex parser finds nothing. */
export async function aiParseLimits(
  text: string,
): Promise<{ wordLimit?: number; charLimit?: number }> {
  const excerpt = text.trim().slice(0, 3000);
  if (excerpt.length < 20) return {};
  const raw = await aiComplete({
    system: LIMIT_PARSE_SYSTEM,
    prompt: excerpt,
    temperature: 0.1,
    format: "json",
  });
  const parsed = parseJsonObject<{ wordLimit?: number; charLimit?: number }>(
    raw,
  );
  const clamp = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n > 0
      ? Math.round(n)
      : undefined;
  return { wordLimit: clamp(parsed.wordLimit), charLimit: clamp(parsed.charLimit) };
}

const DIFF_SUMMARY_SYSTEM =
  "You summarize what changed between two versions of a document, given a line/unified diff. " +
  "In 1-3 sentences describe the substantive edits (what was added, cut, reworded, or restructured) — " +
  "not line counts or file names. Plain text only, no preamble.";

const COMMENT_REPLY_SYSTEM =
  "You draft a brief, constructive reply to an editorial comment on a document passage. " +
  "1-2 sentences, plain text, no preamble or quotes.";

const CITATION_SYSTEM =
  "You pick the most relevant bibliography entries to cite at a point in a document. Given the surrounding " +
  'text and a JSON list of entries ({key,title,author,year}), return a JSON array of the best citation keys, ' +
  "most relevant first, at most 4. Return ONLY a JSON array of key strings — no markdown fences.";

const SEARCH_EXPAND_SYSTEM =
  "You expand a search query into alternative wordings to find related passages when the exact phrase is " +
  "absent. Return a JSON array of 3-6 short alternative search strings (synonyms, rephrasings). " +
  "Return ONLY a JSON array of strings — no markdown fences.";

/** Narrate what changed in a diff (review aid for version compare). */
export async function summarizeDiff(diff: string): Promise<string> {
  const excerpt = diff.trim().slice(0, 6000);
  if (excerpt.length < 20) return "";
  return aiComplete({
    system: DIFF_SUMMARY_SYSTEM,
    prompt: excerpt,
    temperature: 0.2,
  });
}

/** Draft a short reply to an editorial comment (optionally about a passage). */
export async function draftCommentReply(options: {
  commentText: string;
  quotedText?: string;
}): Promise<string> {
  const comment = options.commentText.trim();
  if (!comment) return "";
  const quoted = options.quotedText?.trim();
  const prompt = quoted
    ? `Passage:\n${quoted.slice(0, 800)}\n\nComment:\n${comment}`
    : `Comment:\n${comment}`;
  return aiComplete({
    system: COMMENT_REPLY_SYSTEM,
    prompt,
    temperature: 0.4,
  });
}

/** Rank bibliography keys by relevance to the surrounding text. */
export async function suggestCitations(
  context: string,
  entries: { key: string; title?: string; author?: string; year?: string }[],
): Promise<string[]> {
  const ctx = context.trim();
  if (ctx.length < 8 || entries.length === 0) return [];
  const known = new Set(entries.map((e) => e.key));
  const raw = await aiComplete({
    system: CITATION_SYSTEM,
    prompt:
      `Context:\n${ctx.slice(0, 1200)}\n\nEntries:\n` +
      JSON.stringify(
        entries.map((e) => ({
          key: e.key,
          title: (e.title ?? "").slice(0, 120),
          author: (e.author ?? "").slice(0, 80),
          year: e.year ?? "",
        })),
      ),
    temperature: 0.2,
    format: "json",
  });
  return parseJsonArray<string>(raw)
    .filter((k) => typeof k === "string" && known.has(k))
    .slice(0, 4);
}

/** Alternative wordings for a search query (literal-search fallback). */
export async function expandSearchTerms(query: string): Promise<string[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const raw = await aiComplete({
    system: SEARCH_EXPAND_SYSTEM,
    prompt: q,
    temperature: 0.4,
    format: "json",
  });
  return parseJsonArray<string>(raw)
    .filter((s) => typeof s === "string" && s.trim())
    .slice(0, 6);
}

function parseJsonArray<T>(raw: string): T[] {
  const parsed = tryParseJson(raw);
  if (Array.isArray(parsed)) return parsed as T[];
  // Ollama JSON mode biases toward a top-level object, so a model may wrap the
  // array (e.g. {"issues":[...]}). Recover the first array-valued property.
  if (parsed && typeof parsed === "object") {
    const nested = Object.values(parsed as Record<string, unknown>).find(
      Array.isArray,
    );
    if (nested) return nested as T[];
  }
  return [];
}

function parseJsonObject<T extends object>(raw: string): T {
  const parsed = tryParseJson(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as T)
    : ({} as T);
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        return null;
      }
    }
    const start = trimmed.indexOf("[");
    const objStart = trimmed.indexOf("{");
    const idx =
      start >= 0 && (objStart < 0 || start < objStart) ? start : objStart;
    if (idx >= 0) {
      try {
        return JSON.parse(trimmed.slice(idx));
      } catch {
        return null;
      }
    }
    return null;
  }
}
