import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { Sparkles, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  CHAT_DRAWER_OPEN_EVENT,
  CHAT_DRAWER_TOGGLE_EVENT,
  chatDrawerShortcutLabel,
} from "@/lib/chat-drawer-events";
import { aiComplete, canUseAiAssist } from "@/lib/ai-assist";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("command-palette");

/** A single executable command-palette action. */
interface PaletteAction {
  id: string;
  label: string;
  /** Extra terms (beyond the label) used for lexical matching. */
  keywords: string[];
  /** Short hint shown on the right of the row. */
  hint?: string;
  run: (ctx: { query: string }) => void;
}

/** Read-only framing prepended to free-form project questions. */
const READ_ONLY_FRAMING =
  "Answer using only Read, Grep, Glob, and LS — do NOT modify any files. Question: ";

const ASK_ACTION_ID = "ask";

/** Build the action registry from live store setters. Memoized per-open. */
function buildActions(): PaletteAction[] {
  const settings = () => useSettingsStore.getState();
  const chat = () => useClaudeChatStore.getState();

  const toggleHint = (on: boolean) => (on ? "On" : "Off");

  const actions: PaletteAction[] = [
    {
      id: "toggle-auto-compile",
      label: "Toggle auto-compile",
      keywords: ["build", "recompile", "automatic", "rebuild", "compile"],
      hint: toggleHint(settings().autoCompile),
      run: () => settings().setAutoCompile(!settings().autoCompile),
    },
    {
      id: "toggle-vim-mode",
      label: "Toggle Vim mode",
      keywords: ["editor", "keybindings", "modal", "vi"],
      hint: toggleHint(settings().vimMode),
      run: () => settings().setVimMode(!settings().vimMode),
    },
    {
      id: "toggle-pdf-dark-mode",
      label: "Toggle PDF dark mode",
      keywords: ["preview", "invert", "theme", "night", "pdf"],
      hint: toggleHint(settings().pdfDarkMode),
      run: () => settings().setPdfDarkMode(!settings().pdfDarkMode),
    },
    {
      id: "toggle-spell-check",
      label: "Toggle spell check",
      keywords: ["spelling", "proofread", "grammar", "prose"],
      hint: toggleHint(settings().spellCheck),
      run: () => settings().setSpellCheck(!settings().spellCheck),
    },
    {
      id: "toggle-ai-assist",
      label: "Toggle AI assist",
      keywords: ["enable", "disable", "assistant", "suggestions", "master"],
      hint: toggleHint(settings().aiAssistEnabled),
      run: () => settings().setAiAssistEnabled(!settings().aiAssistEnabled),
    },
    {
      id: "toggle-chat",
      label: "Toggle chat",
      keywords: ["assistant", "claude", "ai", "drawer", "panel", "conversation"],
      hint: chatDrawerShortcutLabel("J"),
      run: () => {
        window.dispatchEvent(new CustomEvent(CHAT_DRAWER_TOGGLE_EVENT));
      },
    },
    {
      id: "open-chat",
      label: "Open chat and focus input",
      keywords: ["assistant", "claude", "ai", "ask", "compose", "message"],
      hint: chatDrawerShortcutLabel("J", { shift: true }),
      run: () => {
        window.dispatchEvent(
          new CustomEvent(CHAT_DRAWER_OPEN_EVENT, {
            detail: { focusComposer: true },
          }),
        );
      },
    },
    {
      id: "new-chat",
      label: "New chat",
      keywords: ["session", "conversation", "claude", "assistant", "reset"],
      run: () => chat().newSession(),
    },
    {
      id: ASK_ACTION_ID,
      label: "Ask about this project…",
      keywords: ["question", "explain", "how", "what", "where", "search"],
      hint: "Read-only",
      run: ({ query }) => {
        const q = query.trim();
        if (!q) {
          // No question typed — just open a fresh chat for the user to type.
          chat().newSession();
          return;
        }
        void chat()
          .sendPrompt(READ_ONLY_FRAMING + q)
          .catch((err) => {
            log.warn("Failed to send read-only project question", {
              error: String(err),
            });
          });
      },
    },
  ];

  return actions;
}

/** Lexical match: does the action's label/keywords contain the query terms? */
function matchesQuery(action: PaletteAction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${action.label} ${action.keywords.join(" ")}`.toLowerCase();
  // All whitespace-separated terms must appear somewhere.
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [routing, setRouting] = useState(false);
  // AI-routed action SUGGESTION (never auto-run): the user confirms it.
  const [routedAction, setRoutedAction] = useState<PaletteAction | null>(null);

  const aiCommandPalette = useSettingsStore((s) => s.aiCommandPalette);

  // Rebuild actions each time the palette opens so toggle hints reflect state.
  const actions = useMemo(
    () => buildActions(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const routeRequestRef = useRef(0);
  const routeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setRouting(false);
    setRoutedAction(null);
    routeRequestRef.current += 1; // invalidate any in-flight routing
    if (routeTimerRef.current) {
      clearTimeout(routeTimerRef.current);
      routeTimerRef.current = null;
    }
  }, []);

  const runAction = useCallback(
    (action: PaletteAction, ctx: { query: string }) => {
      try {
        action.run(ctx);
      } catch (err) {
        log.warn("Command palette action threw", {
          id: action.id,
          error: String(err),
        });
      }
      close();
    },
    [close],
  );

  // Global Ctrl/Cmd+K toggles the palette (workspace/editor context only —
  // this component is mounted inside the workspace, not the project picker).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Reset transient state whenever we close.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRouting(false);
      setRoutedAction(null);
    }
  }, [open]);

  const lexicalMatches = useMemo(
    () => actions.filter((a) => matchesQuery(a, query)),
    [actions, query],
  );

  const askAction = useMemo(
    () => actions.find((a) => a.id === ASK_ACTION_ID),
    [actions],
  );

  // NL routing: when the typed query (>=3 chars) matches no action lexically
  // and AI is available, ask the local model which action id fits best.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();

    // Clear any pending debounce/route on every keystroke.
    if (routeTimerRef.current) {
      clearTimeout(routeTimerRef.current);
      routeTimerRef.current = null;
    }
    setRouting(false);
    // Stale suggestion no longer applies to the new query.
    setRoutedAction(null);

    const hasLexical = actions.some((a) => matchesQuery(a, q));
    if (
      q.length < 3 ||
      hasLexical ||
      !aiCommandPalette ||
      !canUseAiAssist()
    ) {
      return;
    }

    const requestId = ++routeRequestRef.current;
    setRouting(true);

    routeTimerRef.current = setTimeout(() => {
      const routable = actions.filter((a) => a.id !== ASK_ACTION_ID);
      const idList = routable
        .map((a) => `- ${a.id}: ${a.label}`)
        .join("\n");
      const system =
        `You route a user's request to one app action. Available actions:\n${idList}\n` +
        `Pick the single best matching action id for the user's request, or "${ASK_ACTION_ID}" if none fit. ` +
        `Return JSON {"id": string}.`;

      aiComplete({ system, prompt: q, format: "json", temperature: 0.1 })
        .then((raw) => {
          if (requestId !== routeRequestRef.current) return; // superseded
          setRouting(false);
          const id = parseRoutedId(raw);
          const matched =
            id && id !== ASK_ACTION_ID
              ? actions.find((a) => a.id === id)
              : undefined;
          // Do NOT auto-run: surface the routed action as a confirmable
          // suggestion row. A misclassification must never mutate settings
          // without the user explicitly selecting it. The "Ask about this
          // project" fallback row already covers the no-match case.
          setRoutedAction(matched ?? null);
        })
        .catch((err) => {
          if (requestId !== routeRequestRef.current) return;
          // Fail silently to lexical results.
          setRouting(false);
          log.warn("NL routing failed", { error: String(err) });
        });
    }, 450);

    return () => {
      if (routeTimerRef.current) {
        clearTimeout(routeTimerRef.current);
        routeTimerRef.current = null;
      }
    };
  }, [open, query, actions, aiCommandPalette]);

  if (!open) return null;

  const trimmed = query.trim();
  // Only surface the AI suggestion when lexical search found nothing (the
  // same gating the router itself uses) so a stale row can't linger.
  const suggestion =
    lexicalMatches.length === 0 ? routedAction : null;
  const showAskFallback =
    askAction && trimmed.length > 0 && lexicalMatches.length === 0;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center pt-[15vh]"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close command palette"
        className="absolute inset-0 cursor-default bg-black/35 backdrop-blur-sm dark:bg-black/45"
        onClick={close}
      />
      <Command
        label="Command palette"
        shouldFilter={false}
        loop
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-lg border bg-background shadow-lg outline-none"
      >
        <div className="flex items-center gap-2 border-border border-b px-3">
          <Sparkles className="size-4 shrink-0 text-muted-foreground" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command or ask about this project…"
            className="flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          {routing && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>

        <Command.List className="max-h-[min(60vh,320px)] overflow-y-auto p-1">
          <Command.Empty className="py-6 text-center text-muted-foreground text-sm">
            {routing ? "Routing your request…" : "No matching commands."}
          </Command.Empty>

          {suggestion && (
            <Command.Item
              key="ai-suggestion"
              value="__ai_suggestion__"
              onSelect={() => runAction(suggestion, { query })}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-sm",
                "border border-primary/30 bg-primary/5 text-foreground outline-none",
                "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                <span className="truncate">{suggestion.label}</span>
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {suggestion.hint ?? "AI suggestion"}
              </span>
            </Command.Item>
          )}

          {lexicalMatches.map((action) => (
            <Command.Item
              key={action.id}
              value={action.id}
              keywords={action.keywords}
              onSelect={() => runAction(action, { query })}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-sm",
                "text-foreground outline-none",
                "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
              )}
            >
              <span className="truncate">{action.label}</span>
              {action.hint && (
                <span className="shrink-0 text-muted-foreground text-xs">
                  {action.hint}
                </span>
              )}
            </Command.Item>
          ))}

          {showAskFallback && askAction && (
            <Command.Item
              key="ask-fallback"
              value="__ask_fallback__"
              onSelect={() => runAction(askAction, { query })}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-sm",
                "text-foreground outline-none",
                "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
              )}
            >
              <span className="truncate">
                Ask about this project: “{trimmed}”
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                Read-only
              </span>
            </Command.Item>
          )}
        </Command.List>
      </Command>
    </div>
  );
}

/** Tolerant parse of the routed `{ "id": string }` JSON (handles fences). */
function parseRoutedId(raw: string): string | null {
  const tryParse = (text: string): string | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "id" in parsed &&
        typeof (parsed as { id: unknown }).id === "string"
      ) {
        return (parsed as { id: string }).id.trim();
      }
    } catch {
      /* fall through */
    }
    return null;
  };

  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }

  const objStart = trimmed.indexOf("{");
  const objEnd = trimmed.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    return tryParse(trimmed.slice(objStart, objEnd + 1));
  }
  return null;
}
