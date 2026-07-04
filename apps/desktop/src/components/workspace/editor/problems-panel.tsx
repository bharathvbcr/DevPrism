import { useRef, useState } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
  Loader2Icon,
  MessageSquareIcon,
  MousePointerClickIcon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react";
import { toast } from "sonner";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { canUseAiAssist } from "@/lib/ai-assist";
import { useChatLabels } from "@/lib/chat-labels";
import { useSettingsStore } from "@/stores/settings-store";

export interface DiagnosticItem {
  from: number;
  to: number;
  severity: string;
  message: string;
  line: number;
}

interface ProblemsPopoverProps {
  diagnostics: DiagnosticItem[];
  fileName: string;
  onNavigate: (from: number) => void;
  onFixWithChat: (message: string, line: number) => void;
  onFixWithAi?: (message: string, line: number) => void;
  onFixAllWithChat?: () => void;
  onFixAllWithAi?: () => void;
  aiFixAvailable?: boolean;
  /**
   * Multi-line "Fix with AI" for a diagnostic that spans more than a single
   * line. The parent owns the active-file content/offsets, so it builds the
   * InlineEditSelection across the diagnostic's range and runs the proposed-
   * changes flow (runInlineEdit). Returns once the change is queued/failed.
   */
  onFixSpanWithAi?: (diagnostic: DiagnosticItem) => Promise<void> | void;
}

/**
 * A diagnostic covers more than one line when its character range is non-empty
 * (the source reports a real span, not just a caret/line). We prefer the
 * multi-line span fix in that case since the single-line lint fix can't repair
 * cross-line errors (e.g. unbalanced braces / environments).
 */
function spansMultipleLines(d: DiagnosticItem): boolean {
  return d.to > d.from;
}

function SeverityIcon({ severity }: { severity: string }) {
  switch (severity) {
    case "error":
      return (
        <AlertCircleIcon
          role="img"
          aria-label="Error"
          className="size-3.5 shrink-0 text-red-400"
        />
      );
    case "warning":
      return (
        <AlertTriangleIcon
          role="img"
          aria-label="Warning"
          className="size-3.5 shrink-0 text-yellow-400"
        />
      );
    default:
      return (
        <InfoIcon
          role="img"
          aria-label="Info"
          className="size-3.5 shrink-0 text-blue-400"
        />
      );
  }
}

// Compact diagnostics surface that lives in the editor toolbar. Renders a small
// error/warning count badge; clicking it opens the full Problems list as a
// popover instead of occupying a fixed strip at the bottom of the editor.
export function ProblemsPopover({
  diagnostics,
  fileName,
  onNavigate,
  onFixWithChat,
  onFixWithAi,
  onFixAllWithChat,
  onFixAllWithAi,
  aiFixAvailable = false,
  onFixSpanWithAi,
}: ProblemsPopoverProps) {
  const [open, setOpen] = useState(false);
  const aiLintFix = useSettingsStore((s) => s.aiLintFix);
  const chatLabels = useChatLabels();
  // Index of the diagnostic row whose multi-line fix is currently running, plus
  // a monotonic request id so a stale in-flight fix can't flip the spinner back.
  const [spanPendingIndex, setSpanPendingIndex] = useState<number | null>(null);
  const spanRequestIdRef = useRef(0);

  const spanFixEnabled = !!onFixSpanWithAi && aiLintFix && canUseAiAssist();

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;

  const runSpanFix = async (d: DiagnosticItem, index: number) => {
    if (!onFixSpanWithAi) return;
    const id = ++spanRequestIdRef.current;
    setSpanPendingIndex(index);
    try {
      await onFixSpanWithAi(d);
    } catch (err) {
      showWorkspaceError(
        "AI fix failed",
        err instanceof Error ? err.message : "Could not apply the fix.",
        { dedupeKey: "problems-ai-fix" },
      );
    } finally {
      // Only clear if no newer span fix superseded this one.
      if (id === spanRequestIdRef.current) setSpanPendingIndex(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Problems"
          aria-label={`Problems: ${errorCount} errors, ${warningCount} warnings`}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-muted"
        >
          <span className="flex items-center gap-1">
            <AlertCircleIcon
              className={
                errorCount > 0
                  ? "size-3.5 text-red-400"
                  : "size-3.5 text-muted-foreground"
              }
            />
            <span className="text-muted-foreground tabular-nums">
              {errorCount}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <AlertTriangleIcon
              className={
                warningCount > 0
                  ? "size-3.5 text-yellow-400"
                  : "size-3.5 text-muted-foreground"
              }
            />
            <span className="text-muted-foreground tabular-nums">
              {warningCount}
            </span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        {/* Header */}
        <div className="flex items-center justify-between border-border border-b px-3 py-1.5">
          <span className="font-medium text-foreground text-xs">Problems</span>
          {diagnostics.length > 0 && (onFixAllWithAi || onFixAllWithChat) && (
            <button
              onClick={() => {
                if (aiFixAvailable && onFixAllWithAi) onFixAllWithAi();
                else onFixAllWithChat?.();
                setOpen(false);
              }}
              className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs shadow-sm transition-colors hover:bg-primary/90"
              title={
                aiFixAvailable
                  ? "Fix all problems with AI"
                  : `Fix all problems with ${chatLabels.fixWithChat.toLowerCase().replace(/^fix with /, "")}`
              }
            >
              {aiFixAvailable ? (
                <SparklesIcon className="size-3" />
              ) : (
                <MousePointerClickIcon className="size-3" />
              )}
              <span>
                {aiFixAvailable ? "Fix all with AI" : chatLabels.fixAllWithChat}
              </span>
            </button>
          )}
        </div>

        {/* Diagnostic list */}
        <div className="max-h-72 overflow-y-auto">
          {diagnostics.length === 0 ? (
            <div className="px-3 py-4 text-center text-muted-foreground text-xs">
              No problems detected.
            </div>
          ) : (
            diagnostics.map((d, i) => (
              <div
                key={`${d.from}-${d.message}-${i}`}
                role="button"
                tabIndex={0}
                className="group flex cursor-pointer items-center gap-2 px-3 py-1 text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                onClick={() => {
                  onNavigate(d.from);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onNavigate(d.from);
                    setOpen(false);
                  }
                }}
              >
                <SeverityIcon severity={d.severity} />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {d.message}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {fileName}:{d.line}
                </span>
                {spanFixEnabled && spansMultipleLines(d) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void runSpanFix(d, i);
                    }}
                    disabled={spanPendingIndex !== null}
                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 group-hover:opacity-100 group-hover:disabled:opacity-50"
                    title="Fix multi-line error with AI"
                  >
                    {spanPendingIndex === i ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <WandSparklesIcon className="size-3.5" />
                    )}
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (aiFixAvailable && onFixWithAi)
                      onFixWithAi(d.message, d.line);
                    else onFixWithChat(d.message, d.line);
                    setOpen(false);
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
                  title={
                    aiFixAvailable ? "Fix with AI" : chatLabels.fixWithChat
                  }
                >
                  {aiFixAvailable ? (
                    <SparklesIcon className="size-3.5" />
                  ) : (
                    <MessageSquareIcon className="size-3.5" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
