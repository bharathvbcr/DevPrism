import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A segmented cluster of toolbar controls. Renders related buttons as a single
 * raised "pill" so they read as one group instead of a flat, undifferentiated
 * row of icons. The default surface (`bg-background/60`) suits a muted toolbar
 * bar; pass a `bg-*` class to recolor it for a different bar (e.g.
 * `bg-muted/40` on a plain `bg-background` bar).
 */
export function ToolbarGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-lg border border-border/50 bg-background/60 p-0.5 shadow-xs",
        className,
      )}
    >
      {children}
    </div>
  );
}
