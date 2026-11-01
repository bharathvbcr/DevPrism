import { useState } from "react";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import type { VariantInfo } from "@/lib/tauri/variants";
import { cn } from "@/lib/utils";
import {
  BuildingIcon,
  UserIcon,
  CheckCircle2Icon,
  MoreVerticalIcon,
  SparklesIcon,
  Link2Icon,
  PencilIcon,
  Trash2Icon,
  GitCompareIcon,
  FileTextIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

interface VariantCardProps {
  variant: VariantInfo;
  onBindJd: (variant: VariantInfo) => void;
  onEdit: (variant: VariantInfo) => void;
  onTailor: (variant: VariantInfo) => void;
  onCompare: (variant: VariantInfo) => void;
}

export function VariantCard({
  variant,
  onBindJd,
  onEdit,
  onTailor,
  onCompare,
}: VariantCardProps) {
  const activeVariantId = useResumeVariantsStore((s) => s.activeVariantId);
  const switchTo = useResumeVariantsStore((s) => s.switchTo);
  const remove = useResumeVariantsStore((s) => s.remove);
  const [deleting, setDeleting] = useState(false);

  const isActive = activeVariantId === variant.id;

  const getStatusBadgeClass = (status: string) => {
    switch (status.toLowerCase()) {
      case "applied":
        return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
      case "interview":
      case "interviewing":
        return "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20";
      case "offer":
        return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
      case "rejected":
        return "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20";
      case "archived":
        return "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20";
      default:
        return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
    }
  };

  const getAtsBadgeClass = (score: number) => {
    if (score >= 80) {
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
    }
    if (score >= 60) {
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30";
    }
    return "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30";
  };

  const formattedDate = new Date(
    variant.updatedAt || variant.createdAt,
  ).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  const jdWordCount = variant.jd?.trim()
    ? variant.jd.trim().split(/\s+/).length
    : 0;

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await remove(variant.id);
      toast.success(`Deleted variant: ${variant.name}`);
    } catch (err) {
      toast.error(`Failed to delete: ${String(err)}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      onClick={() => {
        if (!isActive) {
          switchTo(variant.id);
        }
      }}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-all",
        isActive
          ? "border-primary bg-primary/5 shadow-xs"
          : "border-border bg-card hover:border-primary/50 hover:bg-muted/40",
      )}
    >
      {/* Header: Name, slug, status & menu */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-xs leading-none tracking-tight">
              {variant.name}
            </span>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wider",
                getStatusBadgeClass(variant.status),
              )}
            >
              {variant.status}
            </span>
            {variant.seniority && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase">
                {variant.seniority}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {variant.id}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isActive ? (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary">
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
                switchTo(variant.id);
              }}
            >
              Switch
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVerticalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onBindJd(variant);
                }}
              >
                <Link2Icon className="mr-2 size-3.5 text-primary" />
                Bind Job Description
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onTailor(variant);
                }}
              >
                <SparklesIcon className="mr-2 size-3.5 text-primary" />
                Tailor in Studio
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onCompare(variant);
                }}
              >
                <GitCompareIcon className="mr-2 size-3.5" />
                Compare with Master
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(variant);
                }}
              >
                <PencilIcon className="mr-2 size-3.5" />
                Edit Metadata
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                className="text-destructive focus:text-destructive"
              >
                <Trash2Icon className="mr-2 size-3.5" />
                Delete Variant
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Target Info: Company and Role */}
      {(variant.company || variant.role) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
          {variant.company && (
            <div className="flex items-center gap-1">
              <BuildingIcon className="size-3 text-muted-foreground/70" />
              <span className="truncate">{variant.company}</span>
            </div>
          )}
          {variant.role && (
            <div className="flex items-center gap-1">
              <UserIcon className="size-3 text-muted-foreground/70" />
              <span className="truncate">{variant.role}</span>
            </div>
          )}
        </div>
      )}

      {/* Footer: ATS Score, JD status, and Date */}
      <div className="flex items-center justify-between border-border/50 border-t pt-2 text-xs">
        <div className="flex items-center gap-2">
          {variant.atsScore !== undefined && variant.atsScore !== null ? (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-semibold text-[10px]",
                getAtsBadgeClass(variant.atsScore),
              )}
            >
              {variant.atsScore}% ATS
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/70">
              Unscored
            </span>
          )}

          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <FileTextIcon className="size-2.5" />
            {jdWordCount > 0 ? `${jdWordCount}w JD` : "No JD"}
          </span>
        </div>

        <span className="text-[10px] text-muted-foreground">
          {formattedDate}
        </span>
      </div>
    </div>
  );
}
