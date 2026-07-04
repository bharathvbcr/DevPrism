import { useEffect, useRef, useState } from "react";
import { SparklesIcon, Loader2Icon } from "lucide-react";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import {
  canUseAiAssist,
  fetchContextSuggestions,
  type ContextSuggestion,
} from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { recordPersonalizationEvent } from "@/lib/personalization";
import { cn } from "@/lib/utils";

/** AI-generated contextual action chips shown above the editor status bar. */
export function EditorAiSuggestions({ content }: { content: string }) {
  const aiContextSuggestions = useSettingsStore((s) => s.aiContextSuggestions);
  const { kind: spaceKind } = useSpaceFeatures();
  const activeFileName = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.name;
  });
  const seedComposerInput = useClaudeChatStore((s) => s.seedComposerInput);
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);

  const [suggestions, setSuggestions] = useState<ContextSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!aiContextSuggestions || !canUseAiAssist()) {
      setSuggestions([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const excerpt = content.trim();
      if (excerpt.length < 80) {
        setSuggestions([]);
        return;
      }

      const id = ++requestIdRef.current;
      setLoading(true);
      setErrored(false);
      void fetchContextSuggestions({
        spaceKind,
        excerpt,
        fileName: activeFileName,
      })
        .then((next) => {
          if (id === requestIdRef.current) setSuggestions(next);
        })
        .catch(() => {
          if (id === requestIdRef.current) {
            setSuggestions([]);
            setErrored(true);
          }
        })
        .finally(() => {
          if (id === requestIdRef.current) setLoading(false);
        });
    }, 3000);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content, spaceKind, activeFileName, aiContextSuggestions]);

  if (!aiContextSuggestions || !canUseAiAssist()) return null;
  const showErrorHint = errored && !loading && suggestions.length === 0;
  if (!loading && suggestions.length === 0 && !showErrorHint) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-border border-t bg-muted/20 px-2 py-1">
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
        {loading ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <SparklesIcon className="size-3" />
        )}
        AI
      </span>
      {showErrorHint && (
        <span className="text-[11px] text-muted-foreground">
          Suggestions unavailable
        </span>
      )}
      {suggestions.map((s) => (
        <button
          key={`${s.label}-${s.prompt.slice(0, 24)}`}
          type="button"
          title={`${s.prompt}\n\nRight-click to edit before sending`}
          onClick={() => {
            recordPersonalizationEvent("suggestion_clicked", {
              label: s.label,
            });
            void sendPrompt(s.prompt);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            seedComposerInput(s.prompt);
          }}
          className={cn(
            "rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] transition-colors",
            "text-muted-foreground hover:border-primary/40 hover:text-foreground",
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
