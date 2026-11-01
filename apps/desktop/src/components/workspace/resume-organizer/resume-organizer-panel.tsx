import { useState, useEffect, useMemo } from "react";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import { useDocumentStore } from "@/stores/document-store";
import type { VariantInfo } from "@/lib/tauri/variants";
import { MasterVariantCard } from "./master-variant-card";
import { VariantCard } from "./variant-card";
import { BindJdDialog } from "./bind-jd-dialog";
import { CreateVariantDialog } from "./create-variant-dialog";
import { EditVariantDialog } from "./edit-variant-dialog";
import { VersionCompare } from "@/components/workspace/version-compare";
import { TailoringStudioModal } from "@/components/workspace/tailoring-studio/tailoring-studio-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BriefcaseIcon,
  PlusIcon,
  SparklesIcon,
  SearchIcon,
  RefreshCwIcon,
  Loader2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function ResumeOrganizerPanel() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const variants = useResumeVariantsStore((s) => s.variants);
  const loading = useResumeVariantsStore((s) => s.loading);
  const sync = useResumeVariantsStore((s) => s.sync);
  const refresh = useResumeVariantsStore((s) => s.refresh);

  // Filters & Search
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Modals state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [bindJdTarget, setBindJdTarget] = useState<VariantInfo | null>(null);
  const [editTarget, setEditTarget] = useState<VariantInfo | null>(null);
  const [compareTarget, setCompareTarget] = useState<VariantInfo | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [tailorTarget, setTailorTarget] = useState<VariantInfo | null>(null);

  // Sync on project change or mount
  useEffect(() => {
    sync(projectRoot);
  }, [projectRoot, sync]);

  // Filtered variants
  const filteredVariants = useMemo(() => {
    return variants.filter((v) => {
      // Status filter
      if (
        statusFilter !== "all" &&
        v.status.toLowerCase() !== statusFilter.toLowerCase()
      ) {
        return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = v.name.toLowerCase().includes(q);
        const matchesId = v.id.toLowerCase().includes(q);
        const matchesCompany = (v.company || "").toLowerCase().includes(q);
        const matchesRole = (v.role || "").toLowerCase().includes(q);
        return matchesName || matchesId || matchesCompany || matchesRole;
      }
      return true;
    });
  }, [variants, statusFilter, searchQuery]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      {/* Top Header */}
      <div className="flex shrink-0 flex-col gap-2 border-sidebar-border border-b p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BriefcaseIcon className="size-4 text-primary" />
            <h2 className="font-semibold text-xs tracking-tight">
              Resume Variants
            </h2>
            <span className="rounded-full bg-muted px-1.5 py-0.2 font-mono text-[10px] text-muted-foreground">
              {variants.length}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => refresh()}
              title="Refresh variants"
            >
              <RefreshCwIcon
                className={cn("size-3.5", loading && "animate-spin")}
              />
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => setCreateDialogOpen(true)}
            >
              <PlusIcon className="size-3" />
              New Variant
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 border-primary/30 px-2 text-[11px] text-primary hover:bg-primary/10"
              onClick={() => {
                setTailorTarget(null);
                setStudioOpen(true);
              }}
            >
              <SparklesIcon className="size-3" />
              Tailor New
            </Button>
          </div>
        </div>

        {/* Search & Status Filter */}
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search variants..."
              className="h-7 pl-7 text-[11px]"
            />
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-7 w-28 text-[11px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
              <SelectItem value="interview">Interview</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Main Content Scrollable Area */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* Pinned Master Resume Card */}
        <div className="space-y-1">
          <div className="font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
            Master Source
          </div>
          <MasterVariantCard
            onTailorClick={() => {
              setTailorTarget(null);
              setStudioOpen(true);
            }}
          />
        </div>

        {/* Tailored Variants Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
            <span>Tailored Variants</span>
            {filteredVariants.length !== variants.length && (
              <span>
                {filteredVariants.length} of {variants.length}
              </span>
            )}
          </div>

          {loading && variants.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
              <Loader2Icon className="mr-2 size-4 animate-spin text-primary" />
              Loading variants...
            </div>
          ) : variants.length === 0 ? (
            /* Empty state matching E2E test T2-F04-01 verbatim requirement */
            <div className="rounded-lg border border-border border-dashed p-6 text-center">
              <BriefcaseIcon className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-2 font-medium text-foreground text-xs">
                No resume variants created yet. Create one from master.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Snapshot your canonical resume to customize for specific job
                postings.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setCreateDialogOpen(true)}
                >
                  <PlusIcon className="mr-1 size-3" />
                  Create Variant
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setTailorTarget(null);
                    setStudioOpen(true);
                  }}
                >
                  <SparklesIcon className="mr-1 size-3" />
                  Tailor with Manvi
                </Button>
              </div>
            </div>
          ) : filteredVariants.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-xs">
              No variants match the current filters.
            </p>
          ) : (
            <div className="space-y-2">
              {filteredVariants.map((v) => (
                <VariantCard
                  key={v.id}
                  variant={v}
                  onBindJd={(target) => setBindJdTarget(target)}
                  onEdit={(target) => setEditTarget(target)}
                  onTailor={(target) => {
                    setTailorTarget(target);
                    setStudioOpen(true);
                  }}
                  onCompare={(target) => setCompareTarget(target)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <CreateVariantDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {bindJdTarget && (
        <BindJdDialog
          variant={bindJdTarget}
          open={Boolean(bindJdTarget)}
          onOpenChange={(open) => !open && setBindJdTarget(null)}
        />
      )}

      {editTarget && (
        <EditVariantDialog
          variant={editTarget}
          open={Boolean(editTarget)}
          onOpenChange={(open) => !open && setEditTarget(null)}
        />
      )}

      {compareTarget && (
        <VersionCompare
          target={compareTarget}
          masterLabel="Master Resume"
          onClose={() => setCompareTarget(null)}
        />
      )}

      <TailoringStudioModal
        open={studioOpen}
        onOpenChange={setStudioOpen}
        targetVariant={tailorTarget}
      />
    </div>
  );
}
