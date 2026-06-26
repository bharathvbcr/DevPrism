import { useEffect, useRef, useState } from "react";
import { WandSparklesIcon, Loader2Icon } from "lucide-react";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import { ensureCoverLetterFile } from "@/lib/cover-letter";
import {
  canUseAiAssist,
  fetchContextSuggestions,
  type ContextSuggestion,
} from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { recordPersonalizationEvent } from "@/lib/personalization";
import { cn } from "@/lib/utils";

/** Space quick actions + dynamic AI suggestions above the chat composer. */
export function ChatSpaceSuggestions({
  visible,
  className,
}: {
  visible: boolean;
  className?: string;
}) {
  const { config } = useSpaceFeatures();
  const seedComposerInput = useClaudeChatStore((s) => s.seedComposerInput);
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const aiContextSuggestions = useSettingsStore((s) => s.aiContextSuggestions);
  const activeContent = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.content ?? "";
  });
  const activeFileName = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.name;
  });
  const { kind: spaceKind } = useSpaceFeatures();

  const [dynamic, setDynamic] = useState<ContextSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  const staticActions = config.quickActions.map((a) => ({
    id: a.id,
    label: a.label,
    title: a.title,
    prompt: a.prompt,
    handler: a.handler,
  }));

  useEffect(() => {
    if (!visible || !aiContextSuggestions || !canUseAiAssist()) {
      setDynamic([]);
      return;
    }
    const excerpt = activeContent.trim();
    if (excerpt.length < 80) {
      setDynamic([]);
      return;
    }

    const id = ++requestIdRef.current;
    setLoading(true);
    void fetchContextSuggestions({
      spaceKind,
      excerpt,
      fileName: activeFileName,
    })
      .then((next) => {
        if (id === requestIdRef.current) setDynamic(next);
      })
      .catch(() => {
        if (id === requestIdRef.current) setDynamic([]);
      })
      .finally(() => {
        if (id === requestIdRef.current) setLoading(false);
      });
  }, [visible, aiContextSuggestions, activeContent, spaceKind, activeFileName]);

  if (!visible) return null;
  if (staticActions.length === 0 && dynamic.length === 0 && !loading)
    return null;

  const runPrompt = (prompt: string, label?: string) => {
    if (label) {
      recordPersonalizationEvent("suggestion_clicked", { label });
    }
    if (prompt.trim()) void sendPrompt(prompt);
  };

  // Drop AI suggestions whose label collides with a static quick action (or a
  // duplicate of another suggestion) so the same pill never shows twice.
  const staticLabels = new Set(
    staticActions.map((a) => a.label.trim().toLowerCase()),
  );
  const seenDynamic = new Set<string>();
  const uniqueDynamic = dynamic.filter((s) => {
    const key = s.label.trim().toLowerCase();
    if (!key || staticLabels.has(key) || seenDynamic.has(key)) return false;
    seenDynamic.add(key);
    return true;
  });

  return (
    <div
      className={cn("mx-1 mb-1 flex items-center gap-1.5 px-1.5", className)}
    >
      <span className="flex shrink-0 items-center gap-1 px-0.5 font-medium text-[10px] text-muted-foreground/80 uppercase tracking-wider">
        {loading ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <WandSparklesIcon className="size-3" />
        )}
        {config.label}
      </span>
      <div className="scrollbar-none flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto">
        {staticActions.map((action) => (
          <button
            key={action.id}
            type="button"
            title={action.title}
            onClick={() => {
              if (action.handler === "create-cover-letter") {
                void ensureCoverLetterFile();
                return;
              }
              if (action.prompt.trim()) seedComposerInput(action.prompt);
            }}
            className={cn(
              "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[11px] shadow-sm transition-colors",
              "text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <WandSparklesIcon className="size-3 opacity-70" />
            {action.label}
          </button>
        ))}
        {uniqueDynamic.map((s) => (
          <button
            key={`dyn-${s.label}`}
            type="button"
            title={s.prompt}
            onClick={() => runPrompt(s.prompt, s.label)}
            onContextMenu={(e) => {
              e.preventDefault();
              seedComposerInput(s.prompt);
            }}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full border border-primary/25 bg-primary/8 px-2.5 py-1 text-[11px] shadow-sm transition-colors",
              "text-muted-foreground hover:border-primary/40 hover:bg-primary/12 hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
