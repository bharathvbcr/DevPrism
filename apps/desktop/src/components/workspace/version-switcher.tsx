import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  LayersIcon,
  ChevronDownIcon,
  PlusIcon,
  Loader2Icon,
  PencilIcon,
  Trash2Icon,
  FileTextIcon,
  CheckIcon,
  WandSparklesIcon,
  LayoutListIcon,
  GitCompareIcon,
} from "lucide-react";
import { useDocumentStore } from "@/stores/document-store";
import { useVariantsStore } from "@/stores/variants-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { VariantInfo } from "@/lib/tauri/variants";
import { aiSuggestVersionName, canUseAiAssist } from "@/lib/ai-assist";
import { TAILOR_PROMPT, suggestVersionName } from "@/lib/variant-status";
import {
  spaceFeatureConfig,
  statusMetaForSpace,
  type SpaceFeatureConfig,
} from "@/lib/space-features";
import { VersionOverview } from "@/components/workspace/version-overview";
import { VersionCompare } from "@/components/workspace/version-compare";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { InlineBanner } from "@/components/ui/inline-banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SCROLLABLE_DIALOG_CONTENT = "flex max-h-[85vh] flex-col sm:max-w-lg";
const SCROLLABLE_DIALOG_BODY = "min-h-0 flex-1 overflow-y-auto";
const SCROLLABLE_DIALOG_FOOTER =
  "shrink-0 border-border border-t pt-4 sm:justify-end";

function countTargetWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function TargetDescriptionTextarea({
  id,
  value,
  onChange,
  placeholder,
  rows = 8,
  autoFocus,
  onSubmit,
  maxHeightClass = "max-h-[min(28rem,calc(85vh-14rem))]",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
  autoFocus?: boolean;
  onSubmit?: () => void;
  maxHeightClass?: string;
}) {
  const wordCount = countTargetWords(value);

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        id={id}
        autoFocus={autoFocus}
        rows={rows}
        className={cn(
          "field-sizing-fixed min-h-24 resize-y overflow-y-auto",
          maxHeightClass,
        )}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {wordCount > 0 && (
        <p className="text-muted-foreground text-xs tabular-nums">
          {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
        </p>
      )}
    </div>
  );
}

function StatusDot({
  status,
  config,
}: {
  status: string;
  config: SpaceFeatureConfig;
}) {
  const meta = statusMetaForSpace(config, status);
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: meta.color }}
      role="img"
      aria-label={meta.label}
    />
  );
}

export function VersionSwitcher({
  config = spaceFeatureConfig(null),
  trailing,
}: {
  config?: SpaceFeatureConfig;
  /** Extra controls (e.g. the space's quick-actions menu) shown at the row end. */
  trailing?: ReactNode;
}) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const ownerRoot = useVariantsStore((s) => s.ownerRoot);
  const activeVariantId = useVariantsStore((s) => s.activeVariantId);
  const variants = useVariantsStore((s) => s.variants);
  const switching = useVariantsStore((s) => s.switching);
  const sync = useVariantsStore((s) => s.sync);
  const create = useVariantsStore((s) => s.create);
  const switchTo = useVariantsStore((s) => s.switchTo);
  const setStatus = useVariantsStore((s) => s.setStatus);
  const rename = useVariantsStore((s) => s.rename);
  const setJd = useVariantsStore((s) => s.setJd);
  const remove = useVariantsStore((s) => s.remove);
  const seedComposerInput = useClaudeChatStore((s) => s.seedComposerInput);

  // Keep the variant list in sync with whatever project is open.
  useEffect(() => {
    void sync(projectRoot);
  }, [projectRoot, sync]);

  const active = useMemo(
    () => variants.find((v) => v.id === activeVariantId) ?? null,
    [variants, activeVariantId],
  );

  // Open a version (if needed) and seed the chat with the tailoring prompt.
  const tailorWithAi = (variantId: string) => {
    const prompt = config.tailorPrompt || TAILOR_PROMPT;
    if (variantId === activeVariantId) {
      seedComposerInput(prompt);
    } else {
      void switchTo(variantId).then(() => seedComposerInput(prompt));
    }
  };

  // Dialog state.
  const [tailorOpen, setTailorOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<VariantInfo | null>(null);
  const [jdTarget, setJdTarget] = useState<VariantInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VariantInfo | null>(null);
  const [compareTarget, setCompareTarget] = useState<VariantInfo | null>(null);

  if (!projectRoot || !ownerRoot) return null;

  const labels = config.variantLabels;
  const statuses = config.statuses;
  const currentLabel = active ? active.name : labels.masterLabel;

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-sidebar-border border-b px-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={switching}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
              "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              switching && "opacity-60",
            )}
            title={labels.switchTitle}
            aria-label={labels.switchTitle}
          >
            {switching ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {active && <StatusDot status={active.status} config={config} />}
            <span className="truncate font-medium">{currentLabel}</span>
            {variants.length > 0 && (
              <span className="shrink-0 text-muted-foreground">
                · {variants.length}
              </span>
            )}
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-muted-foreground text-xs">
            {labels.panelTitle}
          </DropdownMenuLabel>

          <DropdownMenuItem onSelect={() => void switchTo(null)}>
            <FileTextIcon className="size-4" />
            <span className="flex-1">{labels.masterLabel}</span>
            {activeVariantId === null && <CheckIcon className="size-4" />}
          </DropdownMenuItem>

          {variants.length > 0 && <DropdownMenuSeparator />}

          {variants.map((v) => (
            <DropdownMenuSub key={v.id}>
              <DropdownMenuSubTrigger>
                <StatusDot status={v.status} config={config} />
                <span className="flex-1 truncate">{v.name}</span>
                {v.id === activeVariantId && (
                  <CheckIcon className="size-3.5 text-muted-foreground" />
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                <DropdownMenuItem
                  onSelect={() => void switchTo(v.id)}
                  disabled={v.id === activeVariantId}
                >
                  <LayersIcon className="size-4" />
                  Open this version
                </DropdownMenuItem>
                {v.jd.trim() && (
                  <DropdownMenuItem onSelect={() => tailorWithAi(v.id)}>
                    <WandSparklesIcon className="size-4" />
                    {labels.tailorWithAi}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setCompareTarget(v)}>
                  <GitCompareIcon className="size-4" />
                  Compare with {labels.masterLabel}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-muted-foreground text-xs">
                  Status
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={v.status}
                  onValueChange={(value) => void setStatus(v.id, value)}
                >
                  {statuses.map((s) => (
                    <DropdownMenuRadioItem key={s.value} value={s.value}>
                      <span
                        className="mr-1 size-2 rounded-full"
                        style={{ backgroundColor: s.color }}
                        aria-hidden
                      />
                      {s.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setJdTarget(v)}>
                  <FileTextIcon className="size-4" />
                  {labels.targetMenuItem}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRenameTarget(v)}>
                  <PencilIcon className="size-4" />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleteTarget(v)}
                >
                  <Trash2Icon className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}

          {variants.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setOverviewOpen(true)}>
                <LayoutListIcon className="size-4" />
                All versions…
              </DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setTailorOpen(true)}>
            <PlusIcon className="size-4" />
            {labels.createAction}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {active?.jd.trim() && (
        <button
          type="button"
          disabled={switching}
          onClick={() => tailorWithAi(active.id)}
          title={labels.tailorButtonTitle}
          aria-label={labels.tailorButtonTitle}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
            "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            switching && "opacity-60",
          )}
        >
          <WandSparklesIcon className="size-3.5" />
        </button>
      )}

      {trailing}

      <VersionOverview
        open={overviewOpen}
        onOpenChange={setOverviewOpen}
        onTailorNew={() => setTailorOpen(true)}
        config={config}
      />

      <TailorDialog
        open={tailorOpen}
        onOpenChange={setTailorOpen}
        onCreate={create}
        config={config}
      />
      <RenameDialog
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRename={rename}
      />
      <JdDialog
        target={jdTarget}
        onClose={() => setJdTarget(null)}
        onSave={setJd}
        config={config}
      />
      <DeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={remove}
      />
      <VersionCompare
        target={compareTarget}
        onClose={() => setCompareTarget(null)}
        masterLabel={labels.masterLabel}
      />
    </div>
  );
}

function TailorDialog({
  open,
  onOpenChange,
  onCreate,
  config,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, jd: string, status: string) => Promise<void>;
  config: SpaceFeatureConfig;
}) {
  const aiNaming = useSettingsStore((s) => s.aiNaming);
  const [name, setName] = useState("");
  const [jd, setJd] = useState("");
  const [status, setStatus] = useState("draft");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  // Once the user edits the name, stop auto-filling it from the target text.
  const [nameTouched, setNameTouched] = useState(false);
  // Pending AI name suggestion (refines the synchronous heuristic default).
  const [aiNameLoading, setAiNameLoading] = useState(false);
  const aiDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiRequestIdRef = useRef(0);
  // Live mirror of nameTouched so an in-flight AI fetch sees the current value.
  const nameTouchedRef = useRef(false);
  nameTouchedRef.current = nameTouched;

  // Reset fields whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setName("");
      setJd("");
      setStatus("draft");
      setBusy(false);
      setDialogError(null);
      setNameTouched(false);
      setAiNameLoading(false);
    }
  }, [open]);

  // Refine the heuristic name with an AI suggestion: debounce on the target
  // text, and only apply the result while the user hasn't typed a name. Fails
  // silently — the synchronous suggestVersionName default stays put on error.
  useEffect(() => {
    if (!open || nameTouched || !aiNaming || !canUseAiAssist()) {
      setAiNameLoading(false);
      return;
    }

    const target = jd.trim();
    if (target.length < 80) {
      setAiNameLoading(false);
      return;
    }

    if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current);
    aiDebounceRef.current = setTimeout(() => {
      const id = ++aiRequestIdRef.current;
      setAiNameLoading(true);
      void aiSuggestVersionName(target)
        .then((suggested) => {
          if (id !== aiRequestIdRef.current) return;
          // Re-check the touched flag: the user may have typed while we waited.
          const trimmed = suggested.trim();
          if (trimmed && !nameTouchedRef.current) setName(trimmed);
        })
        .catch(() => {
          // Passive/background AI: keep the heuristic name, stay quiet.
        })
        .finally(() => {
          if (id === aiRequestIdRef.current) setAiNameLoading(false);
        });
    }, 1200);

    return () => {
      if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current);
    };
  }, [open, jd, nameTouched, aiNaming]);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setDialogError(null);
    try {
      await onCreate(name.trim(), jd, status);
      toast.success(`Tailored version "${name.trim()}" created`);
      onOpenChange(false);
    } catch (err) {
      setDialogError(String(err));
      setBusy(false);
    }
  };

  const labels = config.variantLabels;
  const statuses = config.statuses;
  const canSubmit = Boolean(name.trim()) && !busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className={SCROLLABLE_DIALOG_CONTENT}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{labels.createDialogTitle}</DialogTitle>
          <DialogDescription>
            {labels.createDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <div className={SCROLLABLE_DIALOG_BODY}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label
                  className="flex items-center gap-1.5 font-medium text-sm"
                  htmlFor="variant-name"
                >
                  Version name
                  {aiNameLoading && (
                    <Loader2Icon
                      className="size-3 animate-spin text-muted-foreground"
                      aria-label="Suggesting a name…"
                    />
                  )}
                </label>
                <Input
                  id="variant-name"
                  placeholder={labels.versionNamePlaceholder}
                  value={name}
                  onChange={(e) => {
                    setNameTouched(true);
                    setName(e.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="font-medium text-sm" htmlFor="variant-jd">
                  {labels.targetLabel}{" "}
                  <span className="font-normal text-muted-foreground">
                    {labels.targetHint}
                  </span>
                </label>
                <TargetDescriptionTextarea
                  id="variant-jd"
                  autoFocus
                  rows={8}
                  maxHeightClass="max-h-[min(28rem,calc(85vh-18rem))]"
                  placeholder={labels.targetPlaceholder}
                  value={jd}
                  onChange={(next) => {
                    setJd(next);
                    // Auto-suggest a name from the target until the user types one.
                    if (!nameTouched) setName(suggestVersionName(next));
                  }}
                  onSubmit={() => {
                    if (canSubmit) void submit();
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="font-medium text-sm" id="variant-status-label">
                  Status
                </span>
                <div
                  className="flex flex-wrap gap-1.5"
                  role="radiogroup"
                  aria-labelledby="variant-status-label"
                >
                  {statuses.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      role="radio"
                      aria-checked={status === s.value}
                      onClick={() => setStatus(s.value)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                        status === s.value
                          ? "border-ring bg-accent"
                          : "border-border hover:bg-accent/50",
                      )}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: s.color }}
                        aria-hidden
                      />
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {dialogError && (
            <InlineBanner
              kind="error"
              title="Could not create version"
              message={dialogError}
              onDismiss={() => setDialogError(null)}
            />
          )}
          <DialogFooter className={SCROLLABLE_DIALOG_FOOTER}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              Create & open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  target,
  onClose,
  onRename,
}: {
  target: VariantInfo | null;
  onClose: () => void;
  onRename: (variantId: string, name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setName(target.name);
      setBusy(false);
      setDialogError(null);
    }
  }, [target]);

  const submit = async () => {
    if (!target || !name.trim() || busy) return;
    setBusy(true);
    setDialogError(null);
    try {
      await onRename(target.id, name.trim());
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
          <DialogTitle>Rename version</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {dialogError && (
          <InlineBanner
            kind="error"
            title="Could not rename"
            message={dialogError}
            onDismiss={() => setDialogError(null)}
          />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JdDialog({
  target,
  onClose,
  onSave,
  config,
}: {
  target: VariantInfo | null;
  onClose: () => void;
  onSave: (variantId: string, jd: string) => Promise<void>;
  config: SpaceFeatureConfig;
}) {
  const [jd, setJd] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setJd(target.jd);
      setBusy(false);
      setDialogError(null);
    }
  }, [target]);

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setDialogError(null);
    try {
      await onSave(target.id, jd);
      onClose();
    } catch (err) {
      setDialogError(String(err));
      setBusy(false);
    }
  };

  const labels = config.variantLabels;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (busy && !open) return;
        if (!open) onClose();
      }}
    >
      <DialogContent className={SCROLLABLE_DIALOG_CONTENT}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{labels.targetDialogTitle}</DialogTitle>
          <DialogDescription>
            {labels.targetDialogDescription.replace(
              "{name}",
              target?.name ?? "",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void submit();
          }}
        >
          <div className={SCROLLABLE_DIALOG_BODY}>
            <TargetDescriptionTextarea
              autoFocus
              rows={12}
              placeholder={labels.targetPlaceholder}
              value={jd}
              onChange={setJd}
              onSubmit={() => {
                if (!busy) void submit();
              }}
            />
          </div>
          {dialogError && (
            <InlineBanner
              kind="error"
              title="Could not save"
              message={dialogError}
              onDismiss={() => setDialogError(null)}
            />
          )}
          <DialogFooter className={SCROLLABLE_DIALOG_FOOTER}>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
