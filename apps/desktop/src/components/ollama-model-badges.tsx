import { EyeIcon, WrenchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface OllamaModelBadgesProps {
  tools?: boolean;
  vision?: boolean;
  className?: string;
}

export function OllamaModelBadges({
  tools,
  vision,
  className,
}: OllamaModelBadgesProps) {
  if (!tools && !vision) return null;
  const badgeClass =
    "inline-flex h-4 items-center rounded border border-border px-0.5 text-muted-foreground";

  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
    >
      {tools && (
        <span className={badgeClass} title="Tool calling">
          <WrenchIcon className="size-2.5" />
        </span>
      )}
      {vision && (
        <span className={badgeClass} title="Vision input">
          <EyeIcon className="size-2.5" />
        </span>
      )}
    </span>
  );
}
