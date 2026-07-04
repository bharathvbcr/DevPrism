import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  // When `value` is null/undefined we don't know the progress: render an
  // animated indeterminate loop instead of a stuck empty bar. The keyframe is
  // scoped inline; the global prefers-reduced-motion rule in globals.css
  // (universal selector, !important) neutralizes it for reduced-motion users.
  const indeterminate = value == null;
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      aria-valuetext={indeterminate ? "Loading" : undefined}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className,
      )}
      {...props}
    >
      {indeterminate ? (
        <>
          <style>{`@keyframes progress-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
          <div
            data-slot="progress-indicator"
            className="h-full w-1/3 rounded-full bg-primary"
            style={{
              animation: "progress-indeterminate 1.15s ease-in-out infinite",
            }}
          />
        </>
      ) : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full w-full flex-1 rounded-full bg-primary transition-transform duration-500 ease-out"
          style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
        />
      )}
    </ProgressPrimitive.Root>
  );
}

export { Progress };
