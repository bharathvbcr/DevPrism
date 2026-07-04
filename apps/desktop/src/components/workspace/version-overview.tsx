import { useEffect, useMemo, useState } from "react";
import {
  FileTextIcon,
  GitCompareIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useVariantsStore } from "@/stores/variants-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import type { VariantInfo } from "@/lib/tauri/variants";
import { TAILOR_PROMPT } from "@/lib/variant-status";
import {
  spaceFeatureConfig,
  statusMetaForSpace,
  type SpaceFeatureConfig,
} from "@/lib/space-features";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/ui/inline-banner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VersionCompare } from "@/components/workspace/version-compare";

/** Format an epoch-ms timestamp as a short local date (or "—" if missing). */
function formatDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function jdSnippet(jd: string): string {
  const trimmed = jd.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed;
}

/**
 * Applications overview — a table of every tailored version (status · name ·
 * date · JD snippet) so the whole pipeline is visible at a glance. Rows switch
 * the open version; status is editable inline.
 */
export function VersionOverview({
  open,
  onOpenChange,
  onTailorNew,
  config = spaceFeatureConfig(null),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTailorNew: () => void;
  config?: SpaceFeatureConfig;
}) {
  const variants = useVariantsStore((s) => s.variants);
  const activeVariantId = useVariantsStore((s) => s.activeVariantId);
  const switchTo = useVariantsStore((s) => s.switchTo);
  const setStatus = useVariantsStore((s) => s.setStatus);
  const remove = useVariantsStore((s) => s.remove);
  const seedComposerInput = useClaudeChatStore((s) => s.seedComposerInput);

  const [confirmDelete, setConfirmDelete] = useState<VariantInfo | null>(null);
  const [compareTarget, setCompareTarget] = useState<VariantInfo | null>(null);
  // null = show all; otherwise restrict to one status.
  const [filter, setFilter] = useState<string | null>(null);

  // Count per status for the summary line and filter chips.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of variants) map.set(v.status, (map.get(v.status) ?? 0) + 1);
    return map;
  }, [variants]);

  const filtered = useMemo(
    () => (filter ? variants.filter((v) => v.status === filter) : variants),
    [variants, filter],
  );

  const open_ = (id: string) => {
    void switchTo(id);
    onOpenChange(false);
  };

  const labels = config.variantLabels;
  const statuses = config.statuses;
  const tailorPrompt = config.tailorPrompt || TAILOR_PROMPT;

  const tailorWithAi = (id: string) => {
    void switchTo(id).then(() => seedComposerInput(tailorPrompt));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{labels.overviewTitle}</DialogTitle>
          <DialogDescription>
            {variants.length === 0
              ? labels.overviewEmpty
              : `${variants.length} version${variants.length === 1 ? "" : "s"} · ` +
                statuses
                  .filter((s) => counts.get(s.value))
                  .map((s) => `${counts.get(s.value)} ${s.label.toLowerCase()}`)
                  .join(" · ")}
          </DialogDescription>
        </DialogHeader>

        {variants.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-muted-foreground text-sm">
              {labels.overviewEmptyCta}
            </p>
            <Button
              onClick={() => {
                onOpenChange(false);
                onTailorNew();
              }}
            >
              <PlusIcon className="size-4" />
              {labels.createAction.replace(/…$/, "")}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              <FilterChip
                label="All"
                count={variants.length}
                active={filter === null}
                onClick={() => setFilter(null)}
              />
              {statuses
                .filter((s) => counts.get(s.value))
                .map((s) => (
                  <FilterChip
                    key={s.value}
                    label={s.label}
                    count={counts.get(s.value) ?? 0}
                    color={s.color}
                    active={filter === s.value}
                    onClick={() =>
                      setFilter((f) => (f === s.value ? null : s.value))
                    }
                  />
                ))}
            </div>
            <div className="max-h-[60vh] overflow-auto">
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground text-sm">
                  No versions with this status.
                </p>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-border border-b text-left text-muted-foreground text-xs">
                      <th className="py-2 pr-2 font-medium">Status</th>
                      <th className="py-2 pr-2 font-medium">Version</th>
                      <th className="py-2 pr-2 font-medium">Created</th>
                      <th className="py-2 pr-2 font-medium">
                        {labels.overviewColumnTarget}
                      </th>
                      <th className="py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((v) => {
                      const isActive = v.id === activeVariantId;
                      const snippet = jdSnippet(v.jd);
                      return (
                        <tr
                          key={v.id}
                          className={cn(
                            "group border-border/60 border-b transition-colors hover:bg-accent/40",
                            isActive && "bg-accent/30",
                          )}
                        >
                          <td className="py-1.5 pr-2 align-middle">
                            <Select
                              value={v.status}
                              onValueChange={(value) =>
                                void setStatus(v.id, value)
                              }
                            >
                              <SelectTrigger className="h-7 w-[130px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {statuses.map((s) => (
                                  <SelectItem key={s.value} value={s.value}>
                                    <span className="flex items-center gap-1.5">
                                      <span
                                        className="size-2 rounded-full"
                                        style={{ backgroundColor: s.color }}
                                        aria-hidden
                                      />
                                      {s.label}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="py-1.5 pr-2 align-middle">
                            <button
                              type="button"
                              className="flex items-center gap-1.5 text-left font-medium hover:underline"
                              onClick={() => open_(v.id)}
                              title="Open this version"
                            >
                              <span
                                className="size-2 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: statusMetaForSpace(
                                    config,
                                    v.status,
                                  ).color,
                                }}
                                aria-hidden
                              />
                              <span className="truncate">{v.name}</span>
                              {isActive && (
                                <span className="rounded bg-primary/15 px-1 py-0.5 text-[10px] text-primary">
                                  open
                                </span>
                              )}
                            </button>
                          </td>
                          <td className="py-1.5 pr-2 align-middle text-muted-foreground text-xs">
                            {formatDate(v.createdAt)}
                          </td>
                          <td className="max-w-[260px] py-1.5 pr-2 align-middle text-muted-foreground text-xs">
                            {snippet || (
                              <span className="italic">no target</span>
                            )}
                          </td>
                          <td className="py-1.5 align-middle">
                            <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                              {v.jd.trim() && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7"
                                  title={labels.tailorWithAi}
                                  aria-label={labels.tailorWithAi}
                                  onClick={() => tailorWithAi(v.id)}
                                >
                                  <WandSparklesIcon className="size-3.5" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                title={`Compare with ${labels.masterLabel}`}
                                aria-label={`Compare with ${labels.masterLabel}`}
                                onClick={() => setCompareTarget(v)}
                              >
                                <GitCompareIcon className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                title="Open"
                                aria-label="Open version"
                                onClick={() => open_(v.id)}
                              >
                                <FileTextIcon className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-destructive hover:text-destructive"
                                title="Delete"
                                aria-label="Delete version"
                                onClick={() => setConfirmDelete(v)}
                              >
                                <Trash2Icon className="size-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </DialogContent>

      <DeleteDialog
        target={confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={remove}
      />

      <VersionCompare
        target={compareTarget}
        onClose={() => setCompareTarget(null)}
        masterLabel={labels.masterLabel}
      />
    </Dialog>
  );
}

function FilterChip({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active ? "border-ring bg-accent" : "border-border hover:bg-accent/50",
      )}
    >
      {color && (
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      {label}
      <span className="text-muted-foreground">{count}</span>
    </button>
  );
}

/**
 * Delete-confirmation dialog with a busy spinner, error banner, and success
 * toast. Mirrors the DeleteDialog in version-switcher.tsx so both entry points
 * to the delete action share identical copy and behavior.
 */
function DeleteDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: VariantInfo | null;
  onClose: () => void;
  onConfirm: (variantId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setBusy(false);
      setDialogError(null);
    }
  }, [target]);

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setDialogError(null);
    try {
      await onConfirm(target.id);
      toast.success(`Deleted "${target.name}"`);
      onClose();
    } catch (err) {
      setDialogError(String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this version?</DialogTitle>
          <DialogDescription>
            "{target?.name}" and its tailored files will be permanently removed.
            Your master document is not affected.
          </DialogDescription>
        </DialogHeader>
        {dialogError && (
          <InlineBanner
            kind="error"
            title="Could not delete"
            message={dialogError}
            onDismiss={() => setDialogError(null)}
          />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
