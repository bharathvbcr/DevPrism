import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestionIcon, Loader2Icon } from "lucide-react";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import {
  canUseAiAssist,
  fetchChatFollowUps,
  type ContextSuggestion,
} from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { recordPersonalizationEvent } from "@/lib/personalization";
import { cn } from "@/lib/utils";

/**
 * Suggested follow-up prompts shown above the composer after the assistant
 * replies. Reads the active tab's most recent assistant message and asks the
 * model (via {@link fetchChatFollowUps}) for 2-3 short next-step prompts.
 * Gated on the `aiChatFollowUps` setting and provider availability; always
 * degrades silently to rendering nothing if the AI call is disabled or fails.
 */
export function ChatFollowUpSuggestions({
  visible,
  className,
}: {
  visible: boolean;
  className?: string;
}) {
  const seedComposerInput = useClaudeChatStore((s) => s.seedComposerInput);
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const aiChatFollowUps = useSettingsStore((s) => s.aiChatFollowUps);
  const { kind: spaceKind } = useSpaceFeatures();

  // Concatenated text of the active tab's most recent assistant reply. Returning
  // a primitive keeps the selector stable (identical content → no re-render).
  const assistantExcerpt = useClaudeChatStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab) return "";
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if (m.type !== "assistant") continue;
      return (m.message?.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    return "";
  });

  const [suggestions, setSuggestions] = useState<ContextSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [railOverflowing, setRailOverflowing] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  // Skip re-fetching when the underlying reply hasn't changed.
  const lastKeyRef = useRef<string>("");

  useEffect(() => {
    if (!visible || !aiChatFollowUps || !canUseAiAssist()) {
      setSuggestions([]);
      lastKeyRef.current = "";
      return;
    }
    const excerpt = assistantExcerpt.trim();
    if (excerpt.length < 40) {
      setSuggestions([]);
      lastKeyRef.current = "";
      return;
    }
    // The backend only looks at the trailing 1800 chars; key on the same slice
    // so cosmetically-identical replies don't trigger a redundant model call.
    const key = excerpt.slice(-1800);
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    const id = ++requestIdRef.current;
    setLoading(true);
    void fetchChatFollowUps({ assistantExcerpt: excerpt, spaceKind })
      .then((next) => {
        if (id === requestIdRef.current) setSuggestions(next);
      })
      .catch(() => {
        if (id === requestIdRef.current) setSuggestions([]);
      })
      .finally(() => {
        if (id === requestIdRef.current) setLoading(false);
      });
  }, [visible, aiChatFollowUps, assistantExcerpt, spaceKind]);

  // Only fade the right edge when the rail actually overflows, so the last pill
  // isn't faintly clipped when everything fits.
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    setRailOverflowing(el.scrollWidth > el.clientWidth);
  }, [suggestions, loading]);

  if (!visible) return null;
  if (suggestions.length === 0 && !loading) return null;

  const runPrompt = (prompt: string, label?: string) => {
    if (label) {
      recordPersonalizationEvent("suggestion_clicked", { label });
    }
    if (prompt.trim()) void sendPrompt(prompt);
  };

  return (
    <div
      className={cn("mx-1 mb-1 flex items-center gap-1.5 px-1.5", className)}
    >
      <span className="flex shrink-0 items-center gap-1 px-0.5 font-medium text-[10px] text-muted-foreground/80 uppercase tracking-wider">
        {loading ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <MessageCircleQuestionIcon className="size-3" />
        )}
        Follow-ups
      </span>
      <div
        ref={railRef}
        className="scrollbar-none flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto"
        style={
          railOverflowing
            ? {
                maskImage: "linear-gradient(to right, black 85%, transparent)",
                WebkitMaskImage:
                  "linear-gradient(to right, black 85%, transparent)",
              }
            : undefined
        }
      >
        {suggestions.map((s) => (
          <button
            key={`followup-${s.label}`}
            type="button"
            title={`${s.prompt} — Right-click to edit before sending`}
            aria-label={s.prompt}
            onClick={() => runPrompt(s.prompt, s.label)}
            onContextMenu={(e) => {
              e.preventDefault();
              seedComposerInput(s.prompt);
            }}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full border border-primary/25 bg-primary/8 px-2.5 py-1 text-[11px] shadow-sm transition-colors",
              "text-muted-foreground hover:border-primary/40 hover:bg-primary/12 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
