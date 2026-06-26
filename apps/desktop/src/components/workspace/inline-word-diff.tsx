import { wordDiff } from "@/lib/word-diff";
import { cn } from "@/lib/utils";

/** Inline word-level diff for UI (strikethrough deletions, green additions). */
export function InlineWordDiff({
  oldLine,
  newLine,
  className,
}: {
  oldLine: string;
  newLine: string;
  className?: string;
}) {
  const parts = wordDiff(oldLine, newLine);
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {parts.map((part, idx) => (
        <span
          key={idx}
          className={cn(
            part.type === "del" &&
              "bg-red-500/15 text-red-900 line-through dark:text-red-200",
            part.type === "add" &&
              "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
          )}
        >
          {part.text || " "}
        </span>
      ))}
    </span>
  );
}
