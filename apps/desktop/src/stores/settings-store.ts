import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";

/** Which timestamp the homepage project cards show. */
export type HomepageDateField = "created" | "modified";

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
  /**
   * Use DevPrism's built-in native agent (talks directly to a local Ollama
   * model — no Claude Code CLI required) instead of the CLI-based backend.
   */
  nativeAgentEnabled: boolean;
  setNativeAgentEnabled: (enabled: boolean) => void;
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
  /** Ollama context window (num_ctx) for the native agent. */
  nativeNumCtx: number;
  setNativeNumCtx: (n: number) => void;
  /** Ollama sampling temperature for the native agent. */
  nativeTemperature: number;
  setNativeTemperature: (t: number) => void;
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
      nativeAgentEnabled: true,
      setNativeAgentEnabled: (enabled) => set({ nativeAgentEnabled: enabled }),
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
    }),
    {
      name: "claude-prism-settings",
    },
  ),
);
