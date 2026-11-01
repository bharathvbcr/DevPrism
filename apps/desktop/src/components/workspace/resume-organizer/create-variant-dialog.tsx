import { useState } from "react";
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
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import type { SeniorityLevel } from "@/lib/tauri/variants";
import { toast } from "sonner";
import { Loader2Icon, PlusIcon } from "lucide-react";

interface CreateVariantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (variantId: string) => void;
}

export function CreateVariantDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateVariantDialogProps) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [seniority, setSeniority] = useState<SeniorityLevel>("senior");
  const [status, setStatus] = useState("draft");
  const [jd, setJd] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setName("");
    setCompany("");
    setRole("");
    setSeniority("senior");
    setStatus("draft");
    setJd("");
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Variant name is required");
      return;
    }

    setSubmitting(true);
    try {
      const created = await useResumeVariantsStore
        .getState()
        .create(trimmedName, jd.trim() || undefined, status, {
          company: company.trim() || undefined,
          role: role.trim() || undefined,
          seniority,
        });
      toast.success(`Created variant: ${created.name}`);
      resetForm();
      onOpenChange(false);
      onCreated?.(created.id);
    } catch (err) {
      toast.error(`Failed to create variant: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusIcon className="size-5 text-primary" />
            Create Variant from Master
          </DialogTitle>
          <DialogDescription>
            Snapshots your canonical master resume into a new branch in{" "}
            <code className="font-mono text-xs">.prism/variants/</code>.
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
              placeholder="e.g. Datadog - Staff SRE"
              className="mt-1 h-8 text-xs"
              autoFocus
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
                placeholder="e.g. Datadog"
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
              <Select
                value={seniority}
                onValueChange={(val) => setSeniority(val as SeniorityLevel)}
              >
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
                Initial Status
              </span>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="mt-1 h-8 text-xs">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="applied">Applied</SelectItem>
                  <SelectItem value="interview">Interview</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              Target Job Description (Optional)
            </span>
            <Textarea
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              placeholder="Paste target job description..."
              rows={4}
              className="mt-1 font-mono text-xs"
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
            onClick={handleCreate}
            disabled={submitting || !name.trim()}
          >
            {submitting ? (
              <>
                <Loader2Icon className="mr-2 size-3.5 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Variant"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
