import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import { useDocumentStore } from "@/stores/document-store";
import { cn } from "@/lib/utils";
import { SparklesIcon, CheckCircle2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MasterVariantCardProps {
  onTailorClick?: () => void;
}

export function MasterVariantCard({ onTailorClick }: MasterVariantCardProps) {
  const activeVariantId = useResumeVariantsStore((s) => s.activeVariantId);
  const switchTo = useResumeVariantsStore((s) => s.switchTo);
  const files = useDocumentStore((s) => s.files);

  const isActive = activeVariantId === null;
  const isTypst = files.some((f) => f.name.endsWith(".typ"));
  const isTex = files.some((f) => f.name.endsWith(".tex"));
  const formatLabel = isTypst ? "Typst 0.15" : isTex ? "LaTeX" : "Document";

  return (
    <div
      onClick={() => {
        if (!isActive) {
          switchTo(null);
        }
      }}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-all",
        isActive
          ? "border-primary bg-primary/5 shadow-xs"
          : "border-border bg-card hover:border-primary/50 hover:bg-muted/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-xs leading-none tracking-tight">
              Master Resume
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              Canonical
            </span>
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
              {formatLabel}
            </span>
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            Source of truth for all tailored versions
          </p>
        </div>

        {isActive ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary">
            <CheckCircle2Icon className="size-3" />
            Active
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              switchTo(null);
            }}
          >
            Switch
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between border-border/50 border-t pt-2 text-xs">
        <span className="text-[11px] text-muted-foreground">
          {files.length} project file{files.length === 1 ? "" : "s"}
        </span>
        {onTailorClick && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={(e) => {
              e.stopPropagation();
              onTailorClick();
            }}
          >
            <SparklesIcon className="size-3 text-primary" />
            Tailor New
          </Button>
        )}
      </div>
    </div>
  );
}
