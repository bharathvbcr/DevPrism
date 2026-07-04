import { useEffect, useMemo, useState } from "react";
import {
  FileTextIcon,
  MessageSquareIcon,
  SearchIcon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { SettingsCollapsibleSection } from "@/components/settings-collapsible-section";
import { SettingsToggleRow } from "@/components/settings-toggle-row";
import { OllamaEmbedSetupHints } from "@/components/ollama-embed-setup-hints";
import { useEmbeddingReady } from "@/hooks/use-embedding-ready";

type ToggleDef = {
  key: string;
  title: string;
  description: string;
  keywords: string;
  get: () => boolean;
  set: (v: boolean) => void;
};

export function SettingsAiFeatures({
  searchQuery = "",
}: {
  searchQuery?: string;
}) {
  const aiAssistEnabled = useSettingsStore((s) => s.aiAssistEnabled);
  const setAiAssistEnabled = useSettingsStore((s) => s.setAiAssistEnabled);
  const aiGrammarHints = useSettingsStore((s) => s.aiGrammarHints);
  const setAiGrammarHints = useSettingsStore((s) => s.setAiGrammarHints);
  const aiPredictiveText = useSettingsStore((s) => s.aiPredictiveText);
  const setAiPredictiveText = useSettingsStore((s) => s.setAiPredictiveText);
  const aiContextSuggestions = useSettingsStore((s) => s.aiContextSuggestions);
  const setAiContextSuggestions = useSettingsStore(
    (s) => s.setAiContextSuggestions,
  );
  const aiLintFix = useSettingsStore((s) => s.aiLintFix);
  const setAiLintFix = useSettingsStore((s) => s.setAiLintFix);
  const aiCompileAssist = useSettingsStore((s) => s.aiCompileAssist);
  const setAiCompileAssist = useSettingsStore((s) => s.setAiCompileAssist);
  const aiBibAssist = useSettingsStore((s) => s.aiBibAssist);
  const setAiBibAssist = useSettingsStore((s) => s.setAiBibAssist);
  const aiPredictiveActions = useSettingsStore((s) => s.aiPredictiveActions);
  const setAiPredictiveActions = useSettingsStore(
    (s) => s.setAiPredictiveActions,
  );
  const aiSnippetFill = useSettingsStore((s) => s.aiSnippetFill);
  const setAiSnippetFill = useSettingsStore((s) => s.setAiSnippetFill);
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);
  const setAiSummarize = useSettingsStore((s) => s.setAiSummarize);
  const aiVisionCaption = useSettingsStore((s) => s.aiVisionCaption);
  const setAiVisionCaption = useSettingsStore((s) => s.setAiVisionCaption);
  const aiChatFollowUps = useSettingsStore((s) => s.aiChatFollowUps);
  const setAiChatFollowUps = useSettingsStore((s) => s.setAiChatFollowUps);
  const aiChatGhostText = useSettingsStore((s) => s.aiChatGhostText);
  const setAiChatGhostText = useSettingsStore((s) => s.setAiChatGhostText);
  const aiPromptImprove = useSettingsStore((s) => s.aiPromptImprove);
  const setAiPromptImprove = useSettingsStore((s) => s.setAiPromptImprove);
  const aiAutoTitles = useSettingsStore((s) => s.aiAutoTitles);
  const setAiAutoTitles = useSettingsStore((s) => s.setAiAutoTitles);
  const aiCommentAssist = useSettingsStore((s) => s.aiCommentAssist);
  const setAiCommentAssist = useSettingsStore((s) => s.setAiCommentAssist);
  const aiNaming = useSettingsStore((s) => s.aiNaming);
  const setAiNaming = useSettingsStore((s) => s.setAiNaming);
  const aiTemplateRecommend = useSettingsStore((s) => s.aiTemplateRecommend);
  const setAiTemplateRecommend = useSettingsStore(
    (s) => s.setAiTemplateRecommend,
  );
  const aiProjectBlurb = useSettingsStore((s) => s.aiProjectBlurb);
  const setAiProjectBlurb = useSettingsStore((s) => s.setAiProjectBlurb);
  const aiSemanticSearch = useSettingsStore((s) => s.aiSemanticSearch);
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const embedding = useEmbeddingReady();
  const setAiSemanticSearch = useSettingsStore((s) => s.setAiSemanticSearch);
  const aiCommandAssist = useSettingsStore((s) => s.aiCommandAssist);
  const setAiCommandAssist = useSettingsStore((s) => s.setAiCommandAssist);
  const aiCommandPalette = useSettingsStore((s) => s.aiCommandPalette);
  const setAiCommandPalette = useSettingsStore((s) => s.setAiCommandPalette);

  const sections = useMemo(
    () => [
      {
        id: "editor",
        icon: FileTextIcon,
        title: "Editor & writing",
        description: "Ghost text, grammar, suggestions, and LaTeX fixes",
        toggles: [
          {
            key: "predictive",
            title: "Predictive text (ghost text)",
            description:
              "Show inline gray ghost text as you type. Press Tab to accept or Esc to dismiss.",
            keywords: "predictive ghost text tab completion typing",
            get: () => aiPredictiveText,
            set: setAiPredictiveText,
          },
          {
            key: "grammar",
            title: "AI grammar & style checks",
            description:
              "Scan the paragraph around your cursor after you pause typing.",
            keywords: "grammar style spelling hints",
            get: () => aiGrammarHints,
            set: setAiGrammarHints,
          },
          {
            key: "context",
            title: "Contextual prompt suggestions",
            description:
              "Quick action chips above the status bar based on your document.",
            keywords: "context suggestions chips status bar",
            get: () => aiContextSuggestions,
            set: setAiContextSuggestions,
          },
          {
            key: "predictive-actions",
            title: "Predictive next-step actions",
            description: "One-click chips for the most likely next edits.",
            keywords: "predictive actions next step chips",
            get: () => aiPredictiveActions,
            set: setAiPredictiveActions,
          },
          {
            key: "lint",
            title: "Direct lint fixes",
            description: "Fix LaTeX lint problems in one click via local AI.",
            keywords: "lint fix latex problems",
            get: () => aiLintFix,
            set: setAiLintFix,
          },
          {
            key: "snippet",
            title: "Insert snippets with AI",
            description:
              "Fill LaTeX snippet placeholders from surrounding context.",
            keywords: "snippet fill skeleton insert",
            get: () => aiSnippetFill,
            set: setAiSnippetFill,
          },
          {
            key: "summarize",
            title: "One-click summaries",
            description: "Summarize selected text from the editor toolbar.",
            keywords: "summarize selection condense",
            get: () => aiSummarize,
            set: setAiSummarize,
          },
        ] satisfies ToggleDef[],
      },
      {
        id: "compile",
        icon: SparklesIcon,
        title: "Compilation & bibliography",
        description: "Compile errors, BibTeX, and figure captions",
        toggles: [
          {
            key: "compile",
            title: "Compile error assist",
            description:
              "Explain compilation failures and route fixes from the PDF preview.",
            keywords: "compile error explain fix pdf preview",
            get: () => aiCompileAssist,
            set: setAiCompileAssist,
          },
          {
            key: "bib",
            title: "Bibliography completion",
            description:
              "Generate or complete BibTeX entries from a DOI, URL, or hint.",
            keywords: "bibliography bibtex citation doi",
            get: () => aiBibAssist,
            set: setAiBibAssist,
          },
          {
            key: "vision",
            title: "Image captions (vision)",
            description:
              "Generate figure captions from a captured region (e.g. llava).",
            keywords: "vision caption image figure llava alt text",
            get: () => aiVisionCaption,
            set: setAiVisionCaption,
          },
        ] satisfies ToggleDef[],
      },
      {
        id: "chat",
        icon: MessageSquareIcon,
        title: "Chat assistant",
        description: "Follow-ups, ghost text, titles, and prompt polish",
        toggles: [
          {
            key: "followups",
            title: "Chat follow-up suggestions",
            description: "Suggested next prompts after assistant replies.",
            keywords: "chat follow up suggestions prompts",
            get: () => aiChatFollowUps,
            set: setAiChatFollowUps,
          },
          {
            key: "chat-ghost",
            title: "Chat ghost-text completion",
            description: "Inline completions while typing in the chat box.",
            keywords: "chat ghost text completion tab",
            get: () => aiChatGhostText,
            set: setAiChatGhostText,
          },
          {
            key: "prompt",
            title: "Improve my prompt",
            description: "Rewrite your chat prompt before sending.",
            keywords: "improve prompt rewrite clarify",
            get: () => aiPromptImprove,
            set: setAiPromptImprove,
          },
          {
            key: "titles",
            title: "AI chat titles",
            description: "Name chat tabs automatically from the conversation.",
            keywords: "chat titles auto name tabs",
            get: () => aiAutoTitles,
            set: setAiAutoTitles,
          },
          {
            key: "comments",
            title: "Review & comment assist",
            description:
              "Draft replies to comments and summarize version diffs.",
            keywords: "comment review feedback version reply",
            get: () => aiCommentAssist,
            set: setAiCommentAssist,
          },
        ] satisfies ToggleDef[],
      },
      {
        id: "project",
        icon: WandSparklesIcon,
        title: "Project & templates",
        description: "Naming, summaries, and template recommendations",
        toggles: [
          {
            key: "naming",
            title: "AI naming suggestions",
            description: "Propose names for new projects and versions.",
            keywords: "naming project version suggest",
            get: () => aiNaming,
            set: setAiNaming,
          },
          {
            key: "templates",
            title: "AI template recommendations",
            description: "Rank templates by what you describe in the gallery.",
            keywords: "template recommend gallery rank",
            get: () => aiTemplateRecommend,
            set: setAiTemplateRecommend,
          },
          {
            key: "blurb",
            title: "Project card summaries",
            description: "One-line AI summary on each project card at home.",
            keywords: "project card blurb summary home",
            get: () => aiProjectBlurb,
            set: setAiProjectBlurb,
          },
        ] satisfies ToggleDef[],
      },
      {
        id: "search",
        icon: SearchIcon,
        title: "Search & commands",
        description: "Semantic search and AI command palette",
        toggles: [
          {
            key: "semantic",
            title: "Semantic search",
            description:
              "Local embeddings for related passages (needs nomic-embed-text).",
            keywords: "semantic search embeddings pdf find",
            get: () => aiSemanticSearch,
            set: setAiSemanticSearch,
          },
          {
            key: "commands",
            title: "Command & skill assist",
            description: "Summarize slash commands and rank by what you type.",
            keywords: "slash command skill assist picker",
            get: () => aiCommandAssist,
            set: setAiCommandAssist,
          },
          {
            key: "palette",
            title: "AI command palette",
            description: "Ctrl/Cmd+K to run actions or describe what you want.",
            keywords: "command palette ctrl k actions",
            get: () => aiCommandPalette,
            set: setAiCommandPalette,
          },
        ] satisfies ToggleDef[],
      },
    ],
    [
      aiAutoTitles,
      aiBibAssist,
      aiChatFollowUps,
      aiChatGhostText,
      aiCommandAssist,
      aiCommandPalette,
      aiCommentAssist,
      aiCompileAssist,
      aiContextSuggestions,
      aiGrammarHints,
      aiLintFix,
      aiNaming,
      aiPredictiveActions,
      aiPredictiveText,
      aiProjectBlurb,
      aiPromptImprove,
      aiSemanticSearch,
      aiSnippetFill,
      aiSummarize,
      aiTemplateRecommend,
      aiVisionCaption,
      setAiAutoTitles,
      setAiBibAssist,
      setAiChatFollowUps,
      setAiChatGhostText,
      setAiCommandAssist,
      setAiCommandPalette,
      setAiCommentAssist,
      setAiCompileAssist,
      setAiContextSuggestions,
      setAiGrammarHints,
      setAiLintFix,
      setAiNaming,
      setAiPredictiveActions,
      setAiPredictiveText,
      setAiProjectBlurb,
      setAiPromptImprove,
      setAiSemanticSearch,
      setAiSnippetFill,
      setAiSummarize,
      setAiTemplateRecommend,
      setAiVisionCaption,
    ],
  );

  const q = searchQuery.trim().toLowerCase();

  const filteredSections = useMemo(() => {
    if (!q) return sections;
    return sections
      .map((section) => ({
        ...section,
        toggles: section.toggles.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q) ||
            t.keywords.includes(q) ||
            section.title.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.toggles.length > 0);
  }, [q, sections]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    editor: true,
    compile: false,
    chat: false,
    project: false,
    search: false,
  });

  useEffect(() => {
    if (!q) return;
    setOpenSections((prev) => {
      const next = { ...prev };
      for (const section of filteredSections) {
        next[section.id] = true;
      }
      return next;
    });
  }, [q, filteredSections]);

  const visibleToggleCount = filteredSections.flatMap((s) => s.toggles).length;

  return (
    <div>
      <SettingsToggleRow
        checked={aiAssistEnabled}
        onChange={setAiAssistEnabled}
        title="Enable AI assistant features"
        description="Master toggle for all lightweight AI assist features below."
        className="border-border/60 border-b"
      />

      {!aiAssistEnabled && (
        <p className="border-border/60 border-b bg-muted/10 px-4 py-2 text-muted-foreground text-xs">
          Turn on ‘Enable AI assistant features’ to configure these.
        </p>
      )}

      {visibleToggleCount === 0 ? (
        <p className="p-4 text-muted-foreground text-sm">
          No AI features match your search.
        </p>
      ) : (
        filteredSections.map((section) => {
          const enabledCount = section.toggles.filter((t) => t.get()).length;
          return (
            <SettingsCollapsibleSection
              key={section.id}
              id={section.id}
              icon={section.icon}
              title={section.title}
              description={section.description}
              enabledCount={enabledCount}
              totalCount={section.toggles.length}
              open={Boolean(openSections[section.id])}
              disabled={!aiAssistEnabled}
              onToggle={() =>
                setOpenSections((prev) => ({
                  ...prev,
                  [section.id]: !prev[section.id],
                }))
              }
              panelContentClassName="divide-y divide-border/40"
            >
              {section.toggles.map((toggle) => (
                <SettingsToggleRow
                  key={toggle.key}
                  checked={toggle.get()}
                  disabled={!aiAssistEnabled}
                  onChange={toggle.set}
                  title={toggle.title}
                  description={toggle.description}
                />
              ))}
              {section.id === "search" &&
                aiAssistEnabled &&
                aiSemanticSearch &&
                nativeAgentEnabled &&
                embedding.connected &&
                !embedding.ready && (
                  <div className="px-4 py-3">
                    <OllamaEmbedSetupHints
                      compact
                      connected={embedding.connected}
                      baseUrl={embedding.baseUrl}
                      onModelPulled={() => void embedding.refresh()}
                    />
                  </div>
                )}
            </SettingsCollapsibleSection>
          );
        })
      )}
    </div>
  );
}
