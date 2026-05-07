import { cn } from "@/lib/utils";

type DevPrismLogoProps = {
  className?: string;
  imageClassName?: string;
  withWordmark?: boolean;
  wordmarkClassName?: string;
};

export function DevPrismLogo({
  className,
  imageClassName,
  withWordmark = false,
  wordmarkClassName,
}: DevPrismLogoProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <img
        src="/icon-192.png"
        alt="DevPrism"
        className={cn("size-7 shrink-0", imageClassName)}
        draggable={false}
      />
      {withWordmark && (
        <span
          className={cn("truncate font-semibold text-sm", wordmarkClassName)}
        >
          DevPrism
        </span>
      )}
    </div>
  );
}
