import { PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";

interface WorkspacePanelResizeHandleProps {
  /** Called on double-click to reset the adjacent panels to their default sizes. */
  onReset?: () => void;
  /** Accessible name describing what this divider resizes (e.g. "Resize sidebar"). */
  "aria-label"?: string;
  className?: string;
}

/**
 * Discoverable resize divider: wider hit target, grip on hover, double-click reset.
 */
export function WorkspacePanelResizeHandle({
  onReset,
  "aria-label": ariaLabel,
  className,
}: WorkspacePanelResizeHandleProps) {
  const handleDoubleClick: React.MouseEventHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onReset?.();
  };

  const handleKeyDown: React.KeyboardEventHandler<
    keyof HTMLElementTagNameMap
  > = (e) => {
    // Keyboard equivalent of double-click reset (arrow-key resize is handled
    // natively by react-resizable-panels).
    if (onReset && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      onReset();
    }
  };

  return (
    <PanelResizeHandle
      className={cn(
        "group relative z-10 flex w-2 shrink-0 items-center justify-center",
        "cursor-col-resize touch-none select-none",
        className,
      )}
      aria-label={ariaLabel}
      title={
        onReset ? "Drag to resize · Double-click to reset" : "Drag to resize"
      }
      onKeyDown={onReset ? handleKeyDown : undefined}
    >
      <div
        className="absolute inset-0"
        onDoubleClick={handleDoubleClick}
        aria-hidden
      />
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border",
          "transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-active:bg-primary/70",
          "group-data-[resize-handle-state=drag]:bg-primary",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "relative flex flex-col gap-0.5 rounded-full border border-border/60 bg-background/90 px-0.5 py-1.5 shadow-sm",
          "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          "group-data-[resize-handle-state=drag]:border-primary/40 group-data-[resize-handle-state=drag]:opacity-100",
        )}
      >
        <span className="size-0.5 rounded-full bg-muted-foreground/50" />
        <span className="size-0.5 rounded-full bg-muted-foreground/50" />
        <span className="size-0.5 rounded-full bg-muted-foreground/50" />
      </div>
    </PanelResizeHandle>
  );
}
