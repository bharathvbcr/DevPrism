import type { ReactNode } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkspaceBannerKind } from "@/stores/workspace-banner-store";

const KIND_STYLES: Record<
  WorkspaceBannerKind,
  { container: string; icon: typeof AlertCircleIcon }
> = {
  error: {
    container: "border-destructive/40 bg-destructive/10 text-destructive",
    icon: AlertCircleIcon,
  },
  warning: {
    container: "border-warning/40 bg-warning/10 text-warning-foreground",
    icon: AlertTriangleIcon,
  },
  info: {
    container: "border-border/60 bg-muted/40 text-foreground",
    icon: InfoIcon,
  },
};

export function InlineBanner({
  kind,
  title,
  message,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  onDismiss,
  className,
  children,
}: {
  kind: WorkspaceBannerKind;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  onDismiss?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const styles = KIND_STYLES[kind];
  const Icon = styles.icon;

  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 border-b px-3 py-2 text-xs",
        styles.container,
        className,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 opacity-80" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[13px] leading-snug">{title}</p>
        {message ? (
          <p className="mt-0.5 text-[11px] leading-relaxed opacity-90">
            {message}
          </p>
        ) : null}
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {secondaryActionLabel && onSecondaryAction && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="bg-background/60 text-xs hover:bg-background"
            onClick={onSecondaryAction}
          >
            {secondaryActionLabel}
          </Button>
        )}
        {actionLabel && onAction && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="bg-background/60 text-xs hover:bg-background"
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        )}
        {onDismiss && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="opacity-70 hover:opacity-100"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
