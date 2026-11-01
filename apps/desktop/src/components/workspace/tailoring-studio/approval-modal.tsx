import { useState, useEffect, useRef } from "react";
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
import type { VaniApprovalRequiredPayload } from "./types";
import {
  ShieldAlertIcon,
  CheckCircle2Icon,
  XCircleIcon,
  Loader2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ApprovalModalProps {
  approval: VaniApprovalRequiredPayload | null;
  onApprove: (
    approvalId: string,
    chosen: string,
    writeIn?: string,
    reason?: string,
  ) => Promise<void>;
  onReject: (approvalId: string, reason?: string) => Promise<void>;
}

export function ApprovalModal({
  approval,
  onApprove,
  onReject,
}: ApprovalModalProps) {
  const [selectedOption, setSelectedOption] = useState<string>("");
  const [writeIn, setWriteIn] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const submittingRef = useRef<boolean>(false);

  useEffect(() => {
    if (approval) {
      setSelectedOption(approval.defaultChoice || approval.options[0] || "");
      setWriteIn("");
      setReason("");
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [approval]);

  if (!approval) return null;

  const handleApprove = async () => {
    if (submittingRef.current || submitting) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onApprove(
        approval.approvalId,
        selectedOption,
        writeIn.trim() || undefined,
        reason.trim() || undefined,
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (submittingRef.current || submitting) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onReject(approval.approvalId, reason.trim() || undefined);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={Boolean(approval)} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-lg"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <ShieldAlertIcon className="size-5 shrink-0" />
            Human Decision Required (fd 3)
          </DialogTitle>
          <DialogDescription className="text-foreground">
            {approval.prompt}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Options Radio Cards */}
          <div className="space-y-2">
            <span className="block font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
              Proposed Options
            </span>
            <div className="space-y-2">
              {approval.options.map((opt, idx) => {
                const isSelected = selectedOption === opt;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setSelectedOption(opt)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-lg border p-3 text-left text-xs transition-colors",
                      isSelected
                        ? "border-primary bg-primary/10 font-medium text-foreground ring-1 ring-primary/30"
                        : "border-border text-muted-foreground hover:bg-muted/40",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40",
                      )}
                    >
                      {isSelected && (
                        <span className="size-1.5 rounded-full bg-white" />
                      )}
                    </div>
                    <span className="flex-1">{opt}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Optional Write-in override */}
          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              Write-in Override (Optional)
            </span>
            <Input
              value={writeIn}
              onChange={(e) => setWriteIn(e.target.value)}
              placeholder="Custom bullet phrasing or modification..."
              className="mt-1 h-8 text-xs"
            />
          </div>

          {/* Reason */}
          <div>
            <span className="block font-medium text-muted-foreground text-xs">
              Decision Reason (Optional)
            </span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Aligns better with role's primary latency objective"
              className="mt-1 h-8 text-xs"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReject}
            disabled={submitting}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <XCircleIcon className="mr-1.5 size-3.5" />
            Reject / Fallback
          </Button>

          <Button
            size="sm"
            onClick={handleApprove}
            disabled={submitting || !selectedOption}
          >
            {submitting ? (
              <>
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <CheckCircle2Icon className="mr-1.5 size-3.5" />
                Approve & Continue
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
