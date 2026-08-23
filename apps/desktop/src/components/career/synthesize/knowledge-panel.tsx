import { BookOpenIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCareerStore } from "@/stores/career-store";
import { useSynthesisStore } from "@/stores/synthesis-store";

/**
 * First-class knowledge-base surface on the Synthesize tab.
 * Shows source/chunk coverage and opens the add-knowledge dialog.
 */
export function KnowledgePanel({
  onAddKnowledge,
  className,
}: {
  onAddKnowledge: () => void;
  className?: string;
}) {
  const readiness = useSynthesisStore((s) => s.readiness);
  const readinessLoading = useSynthesisStore((s) => s.readinessLoading);
  const setActiveTab = useCareerStore((s) => s.setActiveTab);

  // Avoid a false "0 sources" while the first readiness probe is in flight.
  const probing = readiness == null;
  const kbSourceCount = readiness?.data.kbSourceCount ?? null;
  const kbMissing = readiness?.data.kbChunksMissingEmbeddings ?? null;
  const unknown = !probing && kbSourceCount == null;
  const empty = !probing && kbSourceCount === 0;

  const summary =
    kbSourceCount == null
      ? null
      : `${kbSourceCount} source${kbSourceCount === 1 ? "" : "s"}${
          kbMissing == null
            ? ""
            : kbMissing > 0
              ? ` · ${kbMissing} chunk${kbMissing === 1 ? "" : "s"} pending embed`
              : " · chunks embedded"
        }`;

  return (
    <section
      className={cn(
        "rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5",
        className,
      )}
      aria-label="Knowledge base"
      aria-busy={probing || readinessLoading}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-medium text-xs">Knowledge base</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => setActiveTab("knowledge")}
        >
          <BookOpenIcon className="size-3" />
          Open Knowledge tab
        </Button>
      </div>

      {probing ? (
        <div
          className="space-y-2"
          role="status"
          aria-label="Loading knowledge coverage"
        >
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            Checking knowledge coverage…
          </div>
          <Skeleton className="h-8 w-full" />
        </div>
      ) : unknown ? (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Couldn't load knowledge coverage from the Career database — source
            count unavailable.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={() => setActiveTab("knowledge")}
          >
            <BookOpenIcon className="size-3" />
            Open Knowledge tab
          </Button>
        </div>
      ) : empty ? (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Add notes, papers, or project write-ups so rewrites can ground
            bullets in real evidence instead of inventing details.
          </p>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            onClick={onAddKnowledge}
          >
            <PlusIcon className="size-3.5" />
            Add knowledge
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            {summary}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={onAddKnowledge}
          >
            <PlusIcon className="size-3" />
            Add knowledge
          </Button>
        </div>
      )}
    </section>
  );
}
