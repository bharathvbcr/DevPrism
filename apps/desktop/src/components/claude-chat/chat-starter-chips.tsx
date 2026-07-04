import { SparklesIcon } from "lucide-react";

export function ChatStarterChips({
  prompts,
  onSelect,
}: {
  prompts: string[];
  onSelect: (prompt: string) => void;
}) {
  if (prompts.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap justify-center gap-2 pt-1">
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          className="group rounded-full border border-border/60 bg-background px-3 py-1.5 text-foreground text-xs shadow-sm transition-all hover:border-primary/30 hover:bg-muted hover:shadow"
          onClick={() => onSelect(prompt)}
        >
          <span className="inline-flex items-center gap-1.5">
            <SparklesIcon className="size-3 text-primary/70 transition-colors group-hover:text-primary" />
            {prompt}
          </span>
        </button>
      ))}
    </div>
  );
}
