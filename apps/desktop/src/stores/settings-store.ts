import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  type AgentBackend,
  isAgentBackend,
  migrateNativeAgentEnabled,
} from "@/lib/agent-backend";
import type { HeaderFields } from "@/lib/resume-templates";

type CompilerBackend = "tectonic" | "texlive";

/** Which timestamp the homepage project cards show. */
export type HomepageDateField = "created" | "modified";

export const EMPTY_RESUME_HEADER: HeaderFields = {
  fullName: "",
  cityRegion: "",
  email: "",
  phone: "",
  linkedinUrl: "",
  githubUrl: "",
  portfolioUrl: "",
};

function normalizeResumeHeader(value: unknown): HeaderFields {
  const o =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  return {
    fullName: str("fullName"),
    cityRegion: str("cityRegion"),
    email: str("email"),
    phone: str("phone"),
    linkedinUrl: str("linkedinUrl") || undefined,
    linkedinLabel: str("linkedinLabel") || undefined,
    githubUrl: str("githubUrl") || undefined,
    githubLabel: str("githubLabel") || undefined,
    portfolioUrl: str("portfolioUrl") || undefined,
    portfolioLabel: str("portfolioLabel") || undefined,
  };
}

interface SettingsState {
  compilerBackend: CompilerBackend;
  setCompilerBackend: (backend: CompilerBackend) => void;
  /** Automatically recompile (debounced) after the document is edited. */
  autoCompile: boolean;
  setAutoCompile: (enabled: boolean) => void;
  /** Invert PDF rendering for a dark-friendly page (dark background, light ink). */
  pdfDarkMode: boolean;
  setPdfDarkMode: (enabled: boolean) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
  /** Native (OS/Chromium) spell checking of prose in the editor. */
  spellCheck: boolean;
  setSpellCheck: (enabled: boolean) => void;
  /** Which agent runtime powers chat (Ollama, Groq API, Claude Code, Cursor CLI). */
  agentBackend: AgentBackend;
  setAgentBackend: (backend: AgentBackend) => void;
  /**
   * @deprecated Use `agentBackend`. True when a native backend (Ollama or Groq) is active.
   */
  nativeAgentEnabled: boolean;
  /** @deprecated Use `setAgentBackend`. */
  setNativeAgentEnabled: (enabled: boolean) => void;
  /** Groq model for native-groq backend (null = default llama-3.3-70b-versatile). */
  nativeGroqModel: string | null;
  setNativeGroqModel: (model: string | null) => void;
  /** Prefer Cursor ACP over stream-json fallback when both are available. */
  cursorAcpPreferred: boolean;
  setCursorAcpPreferred: (enabled: boolean) => void;
  /** Master toggle for lightweight AI assist (grammar, predictive text, suggestions). */
  aiAssistEnabled: boolean;
  setAiAssistEnabled: (enabled: boolean) => void;
  /** AI grammar hints on the current line while editing. */
  aiGrammarHints: boolean;
  setAiGrammarHints: (enabled: boolean) => void;
  /** Ghost-text predictive completions while typing (Tab to accept). */
  aiPredictiveText: boolean;
  setAiPredictiveText: (enabled: boolean) => void;
  /** Contextual AI action chips above the editor status bar. */
  aiContextSuggestions: boolean;
  setAiContextSuggestions: (enabled: boolean) => void;
  /** Direct AI fixes for LaTeX lint problems. */
  aiLintFix: boolean;
  setAiLintFix: (enabled: boolean) => void;
  /** AI assist on compile error screens (explain + fix). */
  aiCompileAssist: boolean;
  setAiCompileAssist: (enabled: boolean) => void;
  /** AI completion for bibliography entries. */
  aiBibAssist: boolean;
  setAiBibAssist: (enabled: boolean) => void;
  /** Suggested follow-up prompts after assistant replies. */
  aiChatFollowUps: boolean;
  setAiChatFollowUps: (enabled: boolean) => void;
  /** Predictive next-step action chips for the active document. */
  aiPredictiveActions: boolean;
  setAiPredictiveActions: (enabled: boolean) => void;
  /** Ghost-text predictive completion in the chat composer. */
  aiChatGhostText: boolean;
  setAiChatGhostText: (enabled: boolean) => void;
  /** "Improve my prompt" rewrite button in the chat composer. */
  aiPromptImprove: boolean;
  setAiPromptImprove: (enabled: boolean) => void;
  /** Auto-generate chat tab/session titles with local AI. */
  aiAutoTitles: boolean;
  setAiAutoTitles: (enabled: boolean) => void;
  /** One-click AI summaries (editor selection, long chat replies). */
  aiSummarize: boolean;
  setAiSummarize: (enabled: boolean) => void;
  /** AI-suggested names for projects and tailored versions. */
  aiNaming: boolean;
  setAiNaming: (enabled: boolean) => void;
  /** AI template recommendations from a typed goal. */
  aiTemplateRecommend: boolean;
  setAiTemplateRecommend: (enabled: boolean) => void;
  /** AI summary blurbs on project cards. */
  aiProjectBlurb: boolean;
  setAiProjectBlurb: (enabled: boolean) => void;
  /** AI comment reply / "address this" drafting and diff summaries in review surfaces. */
  aiCommentAssist: boolean;
  setAiCommentAssist: (enabled: boolean) => void;
  /** Local-embedding semantic search fallbacks (PDF find, etc.). */
  aiSemanticSearch: boolean;
  setAiSemanticSearch: (enabled: boolean) => void;
  /** AI command/skill descriptions and semantic slash-command ranking. */
  aiCommandAssist: boolean;
  setAiCommandAssist: (enabled: boolean) => void;
  /** "Insert with AI" snippet placeholder filling. */
  aiSnippetFill: boolean;
  setAiSnippetFill: (enabled: boolean) => void;
  /** AI image captions / alt-text via a local vision model. */
  aiVisionCaption: boolean;
  setAiVisionCaption: (enabled: boolean) => void;
  /** AI command palette (Cmd/Ctrl+K) with natural-language action routing. */
  aiCommandPalette: boolean;
  setAiCommandPalette: (enabled: boolean) => void;
  /** Semantic layer: cache, router, and RAG compressor on AI assist calls. */
  semanticLayerEnabled: boolean;
  setSemanticLayerEnabled: (enabled: boolean) => void;
  semanticCacheEnabled: boolean;
  setSemanticCacheEnabled: (enabled: boolean) => void;
  semanticRouterEnabled: boolean;
  setSemanticRouterEnabled: (enabled: boolean) => void;
  semanticCompressorEnabled: boolean;
  setSemanticCompressorEnabled: (enabled: boolean) => void;
  /** Optional Ollama models per complexity tier (null = use default chat model). */
  semanticLightModel: string | null;
  setSemanticLightModel: (model: string | null) => void;
  semanticMediumModel: string | null;
  setSemanticMediumModel: (model: string | null) => void;
  semanticHeavyModel: string | null;
  setSemanticHeavyModel: (model: string | null) => void;
  /** Ollama context window (num_ctx) for the native agent. */
  nativeNumCtx: number;
  setNativeNumCtx: (n: number) => void;
  /** Ollama sampling temperature for the native agent. */
  nativeTemperature: number;
  setNativeTemperature: (t: number) => void;
  /**
   * How long Ollama keeps the native-agent model resident between turns
   * (e.g. "10m", "1h", "30s", "0" to unload immediately, "-1" to keep forever).
   */
  nativeKeepAlive: string;
  setNativeKeepAlive: (v: string) => void;
  /** Chat model used by the native Ollama agent (null = auto-pick first installed). */
  nativeOllamaModel: string | null;
  setNativeOllamaModel: (model: string | null) => void;
  /** Whether homepage project cards show the created or last-edited date. */
  homepageDateField: HomepageDateField;
  setHomepageDateField: (field: HomepageDateField) => void;
  /** Per-project choice of which \\documentclass root to compile/preview. */
  compileRootByProject: Record<string, string>;
  setCompileRootForProject: (
    projectRoot: string,
    rootId: string | null,
  ) => void;
  /**
   * Contact header for resume synthesis (name / email / phone / links).
   * Persisted here (not career DB) so synthesis UI does not race career_db edits.
   */
  resumeHeader: HeaderFields;
  setResumeHeader: (header: HeaderFields | Partial<HeaderFields>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
      autoCompile: false,
      setAutoCompile: (enabled) => set({ autoCompile: enabled }),
      pdfDarkMode: false,
      setPdfDarkMode: (enabled) => set({ pdfDarkMode: enabled }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
      spellCheck: false,
      setSpellCheck: (enabled) => set({ spellCheck: enabled }),
      agentBackend: "native-ollama" as AgentBackend,
      setAgentBackend: (backend) =>
        set({
          agentBackend: backend,
          nativeAgentEnabled:
            backend === "native-ollama" ||
            backend === "native-api" ||
            backend === "native-groq",
        }),
      nativeAgentEnabled: true,
      setNativeAgentEnabled: (enabled) =>
        set({
          nativeAgentEnabled: enabled,
          agentBackend: enabled ? "native-ollama" : "claude-code",
        }),
      nativeGroqModel: null,
      setNativeGroqModel: (model) =>
        set({
          nativeGroqModel: model?.trim() ? model.trim() : null,
        }),
      cursorAcpPreferred: true,
      setCursorAcpPreferred: (enabled) => set({ cursorAcpPreferred: enabled }),
      aiAssistEnabled: true,
      setAiAssistEnabled: (enabled) => set({ aiAssistEnabled: enabled }),
      aiGrammarHints: true,
      setAiGrammarHints: (enabled) => set({ aiGrammarHints: enabled }),
      aiPredictiveText: true,
      setAiPredictiveText: (enabled) => set({ aiPredictiveText: enabled }),
      aiContextSuggestions: true,
      setAiContextSuggestions: (enabled) =>
        set({ aiContextSuggestions: enabled }),
      aiLintFix: true,
      setAiLintFix: (enabled) => set({ aiLintFix: enabled }),
      aiCompileAssist: true,
      setAiCompileAssist: (enabled) => set({ aiCompileAssist: enabled }),
      aiBibAssist: true,
      setAiBibAssist: (enabled) => set({ aiBibAssist: enabled }),
      aiChatFollowUps: true,
      setAiChatFollowUps: (enabled) => set({ aiChatFollowUps: enabled }),
      aiPredictiveActions: true,
      setAiPredictiveActions: (enabled) =>
        set({ aiPredictiveActions: enabled }),
      aiChatGhostText: true,
      setAiChatGhostText: (enabled) => set({ aiChatGhostText: enabled }),
      aiPromptImprove: true,
      setAiPromptImprove: (enabled) => set({ aiPromptImprove: enabled }),
      aiAutoTitles: true,
      setAiAutoTitles: (enabled) => set({ aiAutoTitles: enabled }),
      aiSummarize: true,
      setAiSummarize: (enabled) => set({ aiSummarize: enabled }),
      aiNaming: true,
      setAiNaming: (enabled) => set({ aiNaming: enabled }),
      aiTemplateRecommend: true,
      setAiTemplateRecommend: (enabled) =>
        set({ aiTemplateRecommend: enabled }),
      aiProjectBlurb: true,
      setAiProjectBlurb: (enabled) => set({ aiProjectBlurb: enabled }),
      aiCommentAssist: true,
      setAiCommentAssist: (enabled) => set({ aiCommentAssist: enabled }),
      aiSemanticSearch: true,
      setAiSemanticSearch: (enabled) => set({ aiSemanticSearch: enabled }),
      aiCommandAssist: true,
      setAiCommandAssist: (enabled) => set({ aiCommandAssist: enabled }),
      aiSnippetFill: true,
      setAiSnippetFill: (enabled) => set({ aiSnippetFill: enabled }),
      aiVisionCaption: true,
      setAiVisionCaption: (enabled) => set({ aiVisionCaption: enabled }),
      aiCommandPalette: true,
      setAiCommandPalette: (enabled) => set({ aiCommandPalette: enabled }),
      semanticLayerEnabled: false,
      setSemanticLayerEnabled: (enabled) =>
        set({ semanticLayerEnabled: enabled }),
      semanticCacheEnabled: true,
      setSemanticCacheEnabled: (enabled) =>
        set({ semanticCacheEnabled: enabled }),
      semanticRouterEnabled: true,
      setSemanticRouterEnabled: (enabled) =>
        set({ semanticRouterEnabled: enabled }),
      semanticCompressorEnabled: true,
      setSemanticCompressorEnabled: (enabled) =>
        set({ semanticCompressorEnabled: enabled }),
      semanticLightModel: null,
      setSemanticLightModel: (model) =>
        set({
          semanticLightModel: model?.trim() ? model.trim() : null,
        }),
      semanticMediumModel: null,
      setSemanticMediumModel: (model) =>
        set({
          semanticMediumModel: model?.trim() ? model.trim() : null,
        }),
      semanticHeavyModel: null,
      setSemanticHeavyModel: (model) =>
        set({
          semanticHeavyModel: model?.trim() ? model.trim() : null,
        }),
      nativeNumCtx: 8192,
      setNativeNumCtx: (n) =>
        set({
          nativeNumCtx: Math.min(131072, Math.max(512, Math.round(n) || 8192)),
        }),
      nativeTemperature: 0.4,
      setNativeTemperature: (t) =>
        set({
          // Guard NaN (e.g. the input cleared mid-edit) so it can't persist or be
          // sent to the backend as a temperature.
          nativeTemperature: Math.min(
            2,
            Math.max(0, Number.isFinite(t) ? t : 0.4),
          ),
        }),
      nativeKeepAlive: "10m",
      setNativeKeepAlive: (v) =>
        set({
          // Accept an Ollama duration ("10m", "1.5h", "30s", "500ms"), a bare
          // second count, "0" (unload now), or "-1" (keep forever). Anything
          // else falls back to the default so a bad value can't be persisted.
          nativeKeepAlive: /^(-1|\d+(\.\d+)?(ms|s|m|h)?)$/.test(v.trim())
            ? v.trim()
            : "10m",
        }),
      nativeOllamaModel: null,
      setNativeOllamaModel: (model) =>
        set({
          nativeOllamaModel: model?.trim() ? model.trim() : null,
        }),
      homepageDateField: "modified",
      setHomepageDateField: (field) => set({ homepageDateField: field }),
      compileRootByProject: {},
      setCompileRootForProject: (projectRoot, rootId) =>
        set((state) => {
          const compileRootByProject = { ...state.compileRootByProject };
          if (rootId) {
            compileRootByProject[projectRoot] = rootId;
          } else {
            delete compileRootByProject[projectRoot];
          }
          return { compileRootByProject };
        }),
      resumeHeader: { ...EMPTY_RESUME_HEADER },
      setResumeHeader: (header) =>
        set((state) => ({
          resumeHeader: normalizeResumeHeader({
            ...state.resumeHeader,
            ...header,
          }),
        })),
    }),
    {
      name: "claude-prism-settings",
      version: 3,
      migrate: (persisted, version) => {
        const s = { ...(persisted as Record<string, unknown>) };
        // v2: replace nativeAgentEnabled boolean with agentBackend enum.
        if (version < 2) {
          if (!isAgentBackend(s.agentBackend)) {
            s.agentBackend = migrateNativeAgentEnabled(s.nativeAgentEnabled);
          }
          s.nativeAgentEnabled =
            s.agentBackend === "native-ollama" ||
            s.agentBackend === "native-api" ||
            s.agentBackend === "native-groq";
        }
        if ("nativeNumCtx" in s) {
          s.nativeNumCtx = Math.min(
            131072,
            Math.max(512, Math.round(Number(s.nativeNumCtx)) || 8192),
          );
        }
        if ("nativeTemperature" in s) {
          const t = Number(s.nativeTemperature);
          s.nativeTemperature = Math.min(
            2,
            Math.max(0, Number.isFinite(t) ? t : 0.4),
          );
        }
        if ("nativeKeepAlive" in s) {
          const v =
            typeof s.nativeKeepAlive === "string"
              ? s.nativeKeepAlive.trim()
              : "";
          s.nativeKeepAlive = /^(-1|\d+(\.\d+)?(ms|s|m|h)?)$/.test(v)
            ? v
            : "10m";
        }
        // v3: resume contact header for synthesis.
        if (version < 3 || !("resumeHeader" in s)) {
          s.resumeHeader = normalizeResumeHeader(s.resumeHeader);
        } else {
          s.resumeHeader = normalizeResumeHeader(s.resumeHeader);
        }
        return s as unknown as SettingsState;
      },
    },
  ),
);
