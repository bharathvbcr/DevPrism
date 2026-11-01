import { useState, useEffect } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import type { VariantInfo, SeniorityLevel } from "@/lib/tauri/variants";
import { toast } from "sonner";
import { Loader2Icon, PencilIcon } from "lucide-react";

interface EditVariantDialogProps {
  variant: VariantInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditVariantDialog({
  variant,
  open,
  onOpenChange,
}: EditVariantDialogProps) {
  const [name, setName] = useState(variant?.name || "");
  const [company, setCompany] = useState(variant?.company || "");
  const [role, setRole] = useState(variant?.role || "");
  const [seniority, setSeniority] = useState<string>(
    variant?.seniority || "senior",
  );
  const [status, setStatus] = useState(variant?.status || "draft");
  const [atsScore, setAtsScore] = useState<string>(
    variant?.atsScore !== undefined && variant?.atsScore !== null
      ? String(variant.atsScore)
      : "",
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (variant) {
      setName(variant.name || "");
      setCompany(variant.company || "");
      setRole(variant.role || "");
      setSeniority(variant.seniority || "senior");
      setStatus(variant.status || "draft");
      setAtsScore(
        variant.atsScore !== undefined && variant.atsScore !== null
          ? String(variant.atsScore)
          : "",
      );
    }
  }, [variant]);

  const handleUpdate = async () => {
    if (!variant) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Variant name cannot be empty");
      return;
    }

    setSubmitting(true);
    try {
      const parsedAts =
        atsScore.trim() !== "" ? Number.parseInt(atsScore, 10) : undefined;
      const validAts =
        parsedAts !== undefined && !Number.isNaN(parsedAts)
          ? Math.max(0, Math.min(100, parsedAts))
          : undefined;

      await useResumeVariantsStore.getState().update(variant.id, {
        name: trimmedName,
        company: company.trim() || undefined,
        role: role.trim() || undefined,
        seniority: seniority as SeniorityLevel,
        status,
        atsScore: validAts,
      });

      toast.success(`Updated variant: ${trimmedName}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Failed to update variant: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon className="size-4 text-primary" />
            Edit Variant Metadata
          </DialogTitle>
          <DialogDescription>
            Update metadata and tracking status for{" "}
            <code className="font-mono text-xs">{variant?.id}</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              Variant Name *
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 h-8 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="block font-medium text-muted-foreground text-xs">
                Target Company
              </span>
              <Input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Google"
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
                placeholder="e.g. Staff SRE"
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
                  <SelectItem value="ic">IC</SelectItem>
                  <SelectItem value="senior">Senior</SelectItem>
                  <SelectItem value="lead">Staff / Lead</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="director">Director</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <span className="block font-medium text-muted-foreground text-xs">
                Status
              </span>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="mt-1 h-8 text-xs">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="applied">Applied</SelectItem>
                  <SelectItem value="interview">Interview</SelectItem>
                  <SelectItem value="offer">Offer</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              ATS Match Score (0–100)
            </span>
            <Input
              type="number"
              min="0"
              max="100"
              value={atsScore}
              onChange={(e) => setAtsScore(e.target.value)}
              placeholder="e.g. 92"
              className="mt-1 h-8 text-xs"
            />
          </div>
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
          <Button
            size="sm"
            onClick={handleUpdate}
            disabled={submitting || !name.trim()}
          >
            {submitting ? (
              <>
                <Loader2Icon className="mr-2 size-3.5 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
