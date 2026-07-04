import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUpIcon } from "lucide-react";
import {
  ResumeBulletControls,
  type ResumeBulletControlsProps,
} from "./resume-bullet-controls";
import { cn } from "@/lib/utils";

export interface ToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  hint?: string; // e.g. "Double-click also works"
}

interface SelectionToolbarProps {
  position: { top: number; left: number };
  contextLabel: string;
  actions: ToolbarAction[];
  onSendPrompt: (prompt: string) => void;
  onAction: (actionId: string) => void;
  onDismiss: () => void;
  resumeBulletAdjust?: ResumeBulletControlsProps;
}

export function SelectionToolbar({
  position,
  contextLabel,
  actions,
  onSendPrompt,
  onAction,
  onDismiss,
  resumeBulletAdjust,
}: SelectionToolbarProps) {
  const [input, setInput] = useState("");
  const toolbarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    onSendPrompt(trimmed);
  }, [input, onSendPrompt]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    },
    [handleSend, onDismiss],
  );

  // Dismiss on click outside or Escape
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (
        toolbarRef.current &&
        !toolbarRef.current.contains(e.target as Node)
      ) {
        onDismiss();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    // Delay attaching to avoid dismissing on the same click that created the selection
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleMouseDown);
      document.addEventListener("keydown", handleKeyDown);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss]);

  // Focus the prompt field on open so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      ref={toolbarRef}
      role="dialog"
      aria-label="Edit selection with AI"
      className={cn(
        "absolute z-30 max-h-[min(24rem,60vh)] overflow-y-auto rounded-lg border border-border bg-background shadow-xl",
        resumeBulletAdjust ? "w-96" : "w-72",
      )}
      style={{
        top: position.top,
        left: position.left,
      }}
    >
      {/* Prompt input */}
      <div className="flex items-center gap-1 border-border border-b px-2 py-1.5">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            resumeBulletAdjust
              ? "Or describe how to reshape these bullets…"
              : "Edit selection with AI…"
          }
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          aria-label="Send prompt"
          onClick={handleSend}
          disabled={!input.trim()}
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30"
        >
          <ArrowUpIcon className="size-3.5" />
        </button>
      </div>

      {/* Action buttons */}
      {resumeBulletAdjust && <ResumeBulletControls {...resumeBulletAdjust} />}

      {actions.length > 0 && (
        <div className="flex flex-col py-1">
          {actions.map((action) => (
            <button
              key={action.id}
              onClick={() => onAction(action.id)}
              className="flex items-center gap-2.5 px-3 py-1.5 text-left text-foreground text-sm outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="size-4 text-muted-foreground">
                {action.icon}
              </span>
              {action.label}
              {action.hint && (
                <span className="ml-auto text-muted-foreground text-xs">
                  {action.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Context label */}
      <div className="border-border border-t px-3 py-1.5">
        <span className="font-mono text-muted-foreground text-xs">
          {contextLabel}
        </span>
      </div>
    </div>
  );
}
