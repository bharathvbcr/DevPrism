import { useEffect, useRef, useState } from "react";
import {
  WandSparklesIcon,
  ChevronDownIcon,
  FilePlusIcon,
  SparklesIcon,
  Loader2Icon,
} from "lucide-react";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import { useSettingsStore } from "@/stores/settings-store";
import {
  canUseAiAssist,
  fetchPredictiveActions,
  type ContextSuggestion,
} from "@/lib/ai-assist";
import type { SpaceQuickAction } from "@/lib/space-features";
import { ensureCoverLetterFile } from "@/lib/cover-letter";
import { cn } from "@/lib/utils";
import { recordPersonalizationEvent } from "@/lib/personalization";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Compact trailing control for a space's AI quick actions. Every action lives
 * in one labelled dropdown — keeping the space header a single tidy row rather
 * than a cramped strip of inline buttons that always spilled into a "More" menu.
 *
 * The static actions come from the space definition; an additive "Suggested
 * next" section is populated from the active document via a debounced,
 * cancellation-safe AI call (gated on the aiPredictiveActions toggle).
 */
export function SpaceQuickActions({
  actions,
}: {
  actions: SpaceQuickAction[];
}) {
  const seedComposerInput = useClaudeChatStore((s) => s.seedComposerInput);
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);

  const aiPredictiveActions = useSettingsStore((s) => s.aiPredictiveActions);
  const { kind: spaceKind } = useSpaceFeatures();
  const activeFileName = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.name;
  });
  const activeFileContent = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.content ?? "";
  });

  const [open, setOpen] = useState(false);
  const [suggested, setSuggested] = useState<ContextSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  // Fetch predictive next-step actions on a debounce after the active document
  // changes (or when the dropdown is opened). Passive/background — fail silently.
  useEffect(() => {
    if (!open || !aiPredictiveActions || !canUseAiAssist()) {
      setSuggested([]);
      setLoading(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const excerpt = activeFileContent.trim();
      if (excerpt.length < 60) {
        setSuggested([]);
        return;
      }

      const id = ++requestIdRef.current;
      setLoading(true);
      void fetchPredictiveActions({
        spaceKind,
        excerpt,
        fileName: activeFileName,
      })
        .then((next) => {
          if (id === requestIdRef.current) setSuggested(next);
        })
        .catch(() => {
          if (id === requestIdRef.current) setSuggested([]);
        })
        .finally(() => {
          if (id === requestIdRef.current) setLoading(false);
        });
    }, 2500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, aiPredictiveActions, spaceKind, activeFileName, activeFileContent]);

  if (actions.length === 0) return null;

  const run = (action: SpaceQuickAction) => {
    if (action.handler === "create-cover-letter") {
      void ensureCoverLetterFile();
      return;
    }
    seedComposerInput(action.prompt);
  };

  const iconFor = (action: SpaceQuickAction) =>
    action.handler === "create-cover-letter" ? (
      <FilePlusIcon className="size-4" />
    ) : (
      <WandSparklesIcon className="size-4" />
    );

  const showSuggested =
    aiPredictiveActions &&
    canUseAiAssist() &&
    (loading || suggested.length > 0);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Quick actions"
          aria-label="Quick actions"
          className={cn(
            "flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-xs transition-colors",
            "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <SparklesIcon className="size-3.5" />
          <ChevronDownIcon className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          Quick actions
        </DropdownMenuLabel>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onSelect={() => run(action)}
            className="items-start gap-2"
          >
            <span className="mt-0.5 shrink-0 text-muted-foreground">
              {iconFor(action)}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium leading-none">{action.label}</span>
              <span className="text-muted-foreground text-xs leading-snug">
                {action.title}
              </span>
            </span>
          </DropdownMenuItem>
        ))}

        {showSuggested && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1 text-muted-foreground text-xs">
              {loading ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <SparklesIcon className="size-3" />
              )}
              Suggested next
            </DropdownMenuLabel>
            {suggested.map((s) => (
              <DropdownMenuItem
                key={`${s.label}-${s.prompt.slice(0, 24)}`}
                title={s.prompt}
                onSelect={() => {
                  recordPersonalizationEvent("suggestion_clicked", {
                    label: s.label,
                  });
                  void sendPrompt(s.prompt);
                }}
                className="items-start gap-2"
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground">
                  <SparklesIcon className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium leading-none">{s.label}</span>
                  <span className="text-muted-foreground text-xs leading-snug">
                    {s.prompt}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
