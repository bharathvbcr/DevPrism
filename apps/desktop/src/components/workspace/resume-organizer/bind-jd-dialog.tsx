import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listRuns, type SynthesisRun } from "@/lib/career";
import {
  parseStoredMatchReport,
  atsScoreFromReport,
} from "@/lib/resume-synthesis";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import type { VariantInfo, SeniorityLevel } from "@/lib/tauri/variants";
import { toast } from "sonner";
import {
  Loader2Icon,
  BriefcaseIcon,
  DatabaseIcon,
  FileTextIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface BindJdDialogProps {
  variant: VariantInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BindJdDialog({
  variant,
  open,
  onOpenChange,
}: BindJdDialogProps) {
  const [tab, setTab] = useState<"paste" | "runs">("paste");
  const [company, setCompany] = useState(variant?.company || "");
  const [role, setRole] = useState(variant?.role || "");
  const [seniority, setSeniority] = useState<string>(
    variant?.seniority || "senior",
  );
  const [jdText, setJdText] = useState(variant?.jd || "");
  const [submitting, setSubmitting] = useState(false);

  // Runs from career.db
  const [runs, setRuns] = useState<SynthesisRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (variant) {
      setCompany(variant.company || "");
      setRole(variant.role || "");
      setSeniority(variant.seniority || "senior");
      setJdText(variant.jd || "");
    }
  }, [variant]);

  useEffect(() => {
    if (open) {
      setLoadingRuns(true);
      listRuns()
        .then((items) => setRuns(items || []))
        .catch(() => setRuns([]))
        .finally(() => setLoadingRuns(false));
    }
  }, [open]);

  const handleSelectRun = (run: SynthesisRun) => {
    setSelectedRunId(run.id);
    const stored = parseStoredMatchReport(run.reportJson);
    if (stored?.profile) {
      if (stored.profile.roleTitle) setRole(stored.profile.roleTitle);
      if (stored.profile.seniority)
        setSeniority(String(stored.profile.seniority));
    }
    const reportAny = run.reportJson as any;
    if (typeof reportAny?.company === "string" && reportAny.company) {
      setCompany(reportAny.company);
    } else if (
      typeof reportAny?.targetCompany === "string" &&
      reportAny.targetCompany
    ) {
      setCompany(reportAny.targetCompany);
    }
    if (typeof reportAny?.jdText === "string" && reportAny.jdText) {
      setJdText(reportAny.jdText);
    } else if (
      typeof reportAny?.jobDescription === "string" &&
      reportAny.jobDescription
    ) {
      setJdText(reportAny.jobDescription);
    } else if (stored?.profile?.roleTitle) {
      setJdText(
        `Target Role: ${stored.profile.roleTitle}\nSeniority: ${stored.profile.seniority || ""}`,
      );
    }
  };

  const wordCount = useMemo(() => {
    const trimmed = jdText.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [jdText]);

  const handleSubmit = async () => {
    if (!variant) return;
    setSubmitting(true);
    try {
      await useResumeVariantsStore
        .getState()
        .bindJd(
          variant.id,
          jdText,
          company.trim() || undefined,
          role.trim() || undefined,
        );
      // Also update seniority if changed
      if (seniority && seniority !== variant.seniority) {
        await useResumeVariantsStore
          .getState()
          .update(variant.id, { seniority: seniority as SeniorityLevel });
      }
      toast.success(`Job Description bound to ${variant.name}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Failed to bind JD: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BriefcaseIcon className="size-5 text-primary" />
            Bind Job Description — {variant?.name}
          </DialogTitle>
          <DialogDescription>
            Attach or update the target job description for this resume variant
            to calibrate ATS matching and tailoring.
          </DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-2 border-b pb-2 text-xs">
          <button
            type="button"
            onClick={() => setTab("paste")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors",
              tab === "paste"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            <FileTextIcon className="size-3.5" />
            Paste / Edit JD
          </button>
          <button
            type="button"
            onClick={() => setTab("runs")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors",
              tab === "runs"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            <DatabaseIcon className="size-3.5" />
            From Career DB Runs ({runs.length})
          </button>
        </div>

        {tab === "runs" ? (
          <div className="max-h-60 space-y-2 overflow-y-auto">
            {loadingRuns ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Loading Career DB synthesis runs...
              </div>
            ) : runs.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground text-xs">
                No synthesis runs found in Career DB. Switch to the paste tab to
                enter a new JD.
              </p>
            ) : (
              runs.map((r) => {
                const stored = parseStoredMatchReport(r.reportJson);
                const ats = atsScoreFromReport(stored);
                const roleTitle = stored?.profile?.roleTitle || "Untitled Role";
                const reportAny = r.reportJson as any;
                const targetComp =
                  reportAny?.company ||
                  reportAny?.targetCompany ||
                  "Career Run";
                const isSelected = selectedRunId === r.id;

                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => handleSelectRun(r)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg border p-2.5 text-left text-xs transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <div>
                      <p className="font-semibold">{roleTitle}</p>
                      <p className="text-muted-foreground">
                        {targetComp} ·{" "}
                        {new Date(r.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    {ats !== null && (
                      <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400">
                        {ats}% ATS
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        ) : null}

        {/* Metadata Inputs */}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              Target Company
            </span>
            <Input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Stripe, Datadog"
              className="mt-1 h-8 text-xs"
            />
          </div>
          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              Target Role
            </span>
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Staff Infrastructure Engineer"
              className="mt-1 h-8 text-xs"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              Seniority Level
            </span>
            <Select value={seniority} onValueChange={setSeniority}>
              <SelectTrigger className="mt-1 h-8 text-xs">
                <SelectValue placeholder="Select seniority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ic">IC (Individual Contributor)</SelectItem>
                <SelectItem value="senior">Senior</SelectItem>
                <SelectItem value="lead">Staff / Lead</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="director">Director / Executive</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end justify-end pb-1 text-muted-foreground text-xs">
            <span>{wordCount} words</span>
          </div>
        </div>

        {/* Raw JD Textarea */}
        <div>
          <span className="block font-medium text-muted-foreground text-xs">
            Job Description Text
          </span>
          <Textarea
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
            placeholder="Paste target job description requirements, responsibilities, and qualifications..."
            rows={6}
            className="mt-1 font-mono text-xs"
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2Icon className="mr-2 size-3.5 animate-spin" />
                Binding...
              </>
            ) : (
              "Bind Job Description"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
