import { Skeleton } from "@/components/ui/skeleton";

export function HistoryPanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 px-2 py-1">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-md border border-border/40 px-2 py-2">
          <Skeleton className="mb-1.5 h-3 w-2/5" />
          <Skeleton className="h-2.5 w-4/5" />
        </div>
      ))}
    </div>
  );
}
