import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton layout shown while a project is initializing in the workspace. */
export function WorkspaceLoadingSkeleton() {
  return (
    <div
      className="flex h-full"
      role="status"
      aria-busy="true"
      aria-label="Loading project"
    >
      {/* Sidebar */}
      <div
        className="flex shrink-0 flex-col gap-3 border-border/60 border-r p-3"
        style={{ width: "15%", minWidth: "10%" }}
      >
        <div
          style={{
            height:
              "calc(var(--titlebar-height) + var(--workspace-topbar-height))",
          }}
          aria-hidden
        />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <div className="mt-2 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-5 w-full"
              style={{ opacity: 1 - i * 0.1 }}
            />
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div
          style={{
            height:
              "calc(var(--titlebar-height) + var(--workspace-topbar-height))",
          }}
          aria-hidden
        />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="ml-auto h-8 w-20" />
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-4"
              style={{
                width: `${55 + ((i * 17) % 40)}%`,
                opacity: 1 - i * 0.05,
              }}
            />
          ))}
        </div>
      </div>

      {/* Preview */}
      <div className="flex w-[42%] shrink-0 flex-col gap-3 border-border/60 border-l p-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="min-h-0 flex-1 rounded-lg" />
      </div>
    </div>
  );
}
