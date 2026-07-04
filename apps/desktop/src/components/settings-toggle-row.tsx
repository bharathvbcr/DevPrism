import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";

export function SettingsToggleRow({
  checked,
  disabled,
  onChange,
  title,
  description,
  className,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/20",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="cursor-pointer font-medium text-sm">
          {title}
        </label>
        <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={title}
        className="mt-0.5"
      />
    </div>
  );
}
