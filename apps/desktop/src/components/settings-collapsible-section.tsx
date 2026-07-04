import { type ReactNode } from "react";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function SettingsCollapsibleSection({
  id,
  icon: Icon,
  title,
  description,
  badge,
  enabledCount,
  totalCount,
  open,
  onToggle,
  disabled,
  panelContentClassName,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  enabledCount?: number;
  totalCount?: number;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Optional inner wrapper classes (e.g. divide-y for toggle lists). */
  panelContentClassName?: string;
  children: ReactNode;
}) {
  const badgeLabel =
    enabledCount != null && totalCount != null
      ? `${enabledCount}/${totalCount}`
      : badge;

  return (
    <div className="border-border/60 border-b last:border-b-0">
      <button
        type="button"
        id={`settings-section-${id}`}
        aria-expanded={open}
        aria-controls={`settings-section-${id}-panel`}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/30">
          <Icon className="size-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{title}</span>
            {badgeLabel && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground tabular-nums">
                {badgeLabel}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            {description}
          </p>
        </div>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          id={`settings-section-${id}-panel`}
          role="region"
          aria-labelledby={`settings-section-${id}`}
          className="border-border/40 border-t bg-muted/5 pb-1"
        >
          {panelContentClassName ? (
            <div className={panelContentClassName}>{children}</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
