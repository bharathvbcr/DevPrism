import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useDocumentStore } from "@/stores/document-store";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import { listPersonas, type Persona } from "@/lib/career";
import type { VariantInfo, SeniorityLevel } from "@/lib/tauri/variants";
import { PhaseProgressRail } from "./phase-progress-rail";
import { ApprovalModal } from "./approval-modal";
import { TailoringDiffReview } from "./tailoring-diff-review";
import type {
  VaniTailorRequest,
  VaniTailorResult,
  VaniTailorProgressPayload,
  VaniApprovalRequiredPayload,
  VaniTailorCancelledPayload,
} from "./types";
import { toast } from "sonner";
import {
  SparklesIcon,
  PlayIcon,
  FileTextIcon,
  ShieldCheckIcon,
} from "lucide-react";

interface TailoringStudioModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetVariant?: VariantInfo | null;
}

export function TailoringStudioModal({
  open,
  onOpenChange,
  targetVariant,
}: TailoringStudioModalProps) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const files = useDocumentStore((s) => s.files);

  // Preflight form state
  const [variantName, setVariantName] = useState(targetVariant?.name || "");
  const [targetCompany, setTargetCompany] = useState(
    targetVariant?.company || "",
  );
  const [targetRole, setRole] = useState(targetVariant?.role || "");
  const [seniority, setSeniority] = useState<SeniorityLevel>(
    (targetVariant?.seniority as SeniorityLevel) || "senior",
  );
  const [pageBudget, setPageBudget] = useState<number>(1);
  const [strictMetrics, setStrictMetrics] = useState<boolean>(true);
  const [jobDescription, setJobDescription] = useState(targetVariant?.jd || "");
  const [personaId, setPersonaId] = useState<string>("ai");
  const [personas, setPersonas] = useState<Persona[]>([]);

  // Execution state
  const [status, setStatus] = useState<
    "idle" | "running" | "completed" | "cancelled" | "error"
  >("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [currentPhase, setCurrentPhase] = useState<number>(1);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [stepDescription, setStepDescription] = useState<string>("");
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [pendingApproval, setPendingApproval] =
    useState<VaniApprovalRequiredPayload | null>(null);
  const [result, setResult] = useState<VaniTailorResult | null>(null);
  const [accepting, setAccepting] = useState<boolean>(false);
  const [cancelling, setCancelling] = useState<boolean>(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef<boolean>(false);
  const hasCancelledBackendRef = useRef<boolean>(false);
  const runIdRef = useRef<string | null>(null);

  // Sync inputs when targetVariant changes
  useEffect(() => {
    if (targetVariant) {
      setVariantName(targetVariant.name || "");
      setTargetCompany(targetVariant.company || "");
      setRole(targetVariant.role || "");
      setSeniority((targetVariant.seniority as SeniorityLevel) || "senior");
      setJobDescription(targetVariant.jd || "");
      if (targetVariant.persona) setPersonaId(targetVariant.persona);
    } else {
      setVariantName("");
      setTargetCompany("");
      setRole("");
      setSeniority("senior");
      setJobDescription("");
    }
  }, [targetVariant]);

  // Load personas from career DB
  useEffect(() => {
    if (open) {
      listPersonas()
        .then((items) => {
          if (items && items.length > 0) {
            setPersonas(items);
            if (!personaId) setPersonaId(items[0].id);
          }
        })
        .catch(() => {});
    }
  }, [open, personaId]);

  // Timer lifecycle during running
  useEffect(() => {
    if (status === "running") {
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  // Cancel backend run on unmount if running to prevent process leaks
  useEffect(() => {
    return () => {
      if (
        status === "running" &&
        runIdRef.current &&
        !hasCancelledBackendRef.current
      ) {
        hasCancelledBackendRef.current = true;
        invoke("manvi_cancel_run", { runId: runIdRef.current }).catch(() => {});
      }
    };
  }, [status]);

  // Window event listeners: progress, approval, cancellation with leak-free disposal
  useEffect(() => {
    if (!open) return;

    let active = true;
    const cleanups: UnlistenFn[] = [];

    listen<VaniTailorProgressPayload>("vani://tailor-progress", (event) => {
      const payload = event.payload;
      if (payload) {
        const incomingRunId =
          payload.runId || (payload as unknown as { run_id?: string }).run_id;
        if (incomingRunId) {
          runIdRef.current = incomingRunId;
          setRunId(incomingRunId);

          // If cancellation was requested before runId arrived, immediately dispatch deferred backend cancel
          if (cancelledRef.current && !hasCancelledBackendRef.current) {
            hasCancelledBackendRef.current = true;
            invoke("manvi_cancel_run", { runId: incomingRunId }).catch(
              () => {},
            );
          }
        }

        // If run has been cancelled, suppress subsequent progress/phase updates in UI
        if (cancelledRef.current) {
          return;
        }

        if (payload.phase) setCurrentPhase(payload.phase);
        if (typeof payload.percent === "number")
          setProgressPercent(payload.percent);
        if (payload.step) setStepDescription(payload.step);
      }
    }).then((un) => {
      if (active) {
        cleanups.push(un);
      } else {
        un();
      }
    });

    listen<VaniApprovalRequiredPayload>("vani://approval-required", (event) => {
      if (event.payload) {
        const incomingRunId =
          event.payload.runId ||
          (event.payload as unknown as { run_id?: string }).run_id;
        if (incomingRunId) {
          runIdRef.current = incomingRunId;
          setRunId(incomingRunId);

          if (cancelledRef.current && !hasCancelledBackendRef.current) {
            hasCancelledBackendRef.current = true;
            invoke("manvi_cancel_run", { runId: incomingRunId }).catch(
              () => {},
            );
          }
        }

        // Suppress approval modal if run has been cancelled
        if (cancelledRef.current) {
          return;
        }

        setPendingApproval(event.payload);
      }
    }).then((un) => {
      if (active) {
        cleanups.push(un);
      } else {
        un();
      }
    });

    listen<VaniTailorCancelledPayload>("vani://tailor-cancelled", (_event) => {
      cancelledRef.current = true;
      setStatus("cancelled");
      setPendingApproval(null);
    }).then((un) => {
      if (active) {
        cleanups.push(un);
      } else {
        un();
      }
    });

    return () => {
      active = false;
      for (const un of cleanups) {
        un();
      }
      cleanups.length = 0;
    };
  }, [open]);

  // Resolve Master Document file path
  const masterFile = useMemo(() => {
    const mainTyp = files.find(
      (f) => f.name === "main.typ" || f.name === "resume.typ",
    );
    if (mainTyp) return mainTyp;
    const mainTex = files.find(
      (f) => f.name === "main.tex" || f.name === "document.tex",
    );
    if (mainTex) return mainTex;
    return files[0] ?? null;
  }, [files]);

  const masterPath = useMemo(() => {
    if (!projectRoot) return "";
    const rel = masterFile ? masterFile.relativePath : "main.typ";
    return `${projectRoot}/${rel}`;
  }, [projectRoot, masterFile]);

  const masterContent = useMemo(() => {
    return (
      masterFile?.content ||
      "= Master Resume Document\n- Experienced Software Engineer"
    );
  }, [masterFile]);

  // Start tailoring run
  const handleStart = async () => {
    const trimmedJd = jobDescription.trim();
    if (!trimmedJd) {
      toast.error("Job description cannot be empty.");
      return;
    }

    cancelledRef.current = false;
    hasCancelledBackendRef.current = false;
    runIdRef.current = null;
    setRunId(null);
    setStatus("running");
    setCurrentPhase(1);
    setProgressPercent(0.1);
    setStepDescription("Initializing tailoring pipeline...");
    setResult(null);
    setPendingApproval(null);

    const request: VaniTailorRequest = {
      masterPath,
      jobDescription: trimmedJd,
      targetPageBudget: pageBudget,
      strictMetrics,
      personaId: personaId || null,
    };

    try {
      const res = await invoke<VaniTailorResult>("manvi_tailor_resume", {
        request,
      });

      // Guard: If cancellation was requested during execution, discard result and keep status cancelled
      if (cancelledRef.current) {
        return;
      }

      if (res.status === "cancelled") {
        setStatus("cancelled");
      } else {
        setResult(res);
        setStatus("completed");
        setCurrentPhase(4);
        setProgressPercent(1.0);
      }
    } catch (err) {
      // Guard: If cancelled, subprocess abort error is expected; do not overwrite cancelled status
      if (cancelledRef.current) {
        return;
      }
      setStatus("error");
      toast.error(`Tailoring failed: ${String(err)}`);
    }
  };

  // Submit approval decision back to fd 3
  const handleApprove = async (
    approvalId: string,
    chosen: string,
    writeIn?: string,
    reason?: string,
  ) => {
    try {
      await invoke("manvi_approve_action", {
        approvalId,
        allow: true,
        chosen: chosen || null,
        writeIn: writeIn || null,
        reason: reason || null,
      });
      setPendingApproval(null);
      toast.success("Approval decision applied to synthesis stream.");
    } catch (err) {
      toast.error(`Failed to submit approval: ${String(err)}`);
    }
  };

  // Reject approval decision
  const handleReject = async (approvalId: string, reason?: string) => {
    try {
      await invoke("manvi_approve_action", {
        approvalId,
        allow: false,
        reason: reason || "User rejected bullet priority option",
      });
      setPendingApproval(null);
      toast.info("Action rejected; fallback path active.");
    } catch (err) {
      toast.error(`Failed to reject approval: ${String(err)}`);
    }
  };

  // Cancel in-flight run
  const handleCancelRun = async () => {
    const activeRunId = runIdRef.current || runId;
    if (!activeRunId && status !== "running") return;

    cancelledRef.current = true;
    setCancelling(true);
    setStatus("cancelled");
    setPendingApproval(null);

    try {
      if (activeRunId && !hasCancelledBackendRef.current) {
        hasCancelledBackendRef.current = true;
        await invoke("manvi_cancel_run", { runId: activeRunId });
      }
      toast.info("Tailoring run was cancelled. No files were modified.");
    } catch {
      // Status is already set to cancelled; child process will be killed by escalation
    } finally {
      setCancelling(false);
    }
  };

  // Accept and Open in Editor
  const handleAccept = async () => {
    if (!result) return;
    setAccepting(true);
    try {
      const finalName =
        variantName.trim() ||
        (targetCompany ? `${targetCompany} Tailored` : "Tailored Variant");

      let targetId = targetVariant?.id;

      if (targetVariant) {
        // Update existing variant
        await useResumeVariantsStore.getState().update(targetVariant.id, {
          name: finalName,
          company: targetCompany.trim() || undefined,
          role: targetRole.trim() || undefined,
          seniority,
          atsScore: result.atsScore,
          jd: jobDescription.trim(),
        });
      } else {
        // Create new variant from master
        const created = await useResumeVariantsStore
          .getState()
          .create(finalName, jobDescription.trim(), "applied", {
            company: targetCompany.trim() || undefined,
            role: targetRole.trim() || undefined,
            seniority,
            atsScore: result.atsScore,
          });
        targetId = created.id;
      }

      if (targetId) {
        await useResumeVariantsStore.getState().switchTo(targetId);

        // Apply rewritten tailored content to the active variant document and persist to disk
        const contentToPersist =
          result.rewrittenContent?.trim() || masterContent;

        const docState = useDocumentStore.getState();
        const targetFile =
          docState.files.find(
            (f) =>
              f.name === "main.typ" ||
              f.name === "resume.typ" ||
              f.name === "main.tex" ||
              f.name === "document.tex",
          ) ||
          docState.files.find((f) => f.id === docState.activeFileId) ||
          docState.files[0];

        if (targetFile && contentToPersist) {
          docState.updateFileContent(targetFile.id, contentToPersist);
          await docState.saveFile(targetFile.id);
        }
      }

      toast.success("Tailored variant accepted and opened in editor!");
      onOpenChange(false);
    } catch (err) {
      toast.error(`Failed to accept variant: ${String(err)}`);
    } finally {
      setAccepting(false);
    }
  };

  const handleReset = () => {
    cancelledRef.current = false;
    hasCancelledBackendRef.current = false;
    runIdRef.current = null;
    setStatus("idle");
    setRunId(null);
    setResult(null);
    setPendingApproval(null);
    setCurrentPhase(1);
    setProgressPercent(0);
    setStepDescription("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-4xl flex-col overflow-hidden p-6">
        <DialogHeader className="shrink-0 border-b pb-3">
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-5 text-primary" />
            Vani Interactive Tailoring Studio
          </DialogTitle>
          <DialogDescription className="sr-only">
            Interactive tailoring studio for resumes
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {status === "completed" && result ? (
            /* Diff Review and Accept View */
            <TailoringDiffReview
              masterContent={masterContent}
              tailoredContent={result.rewrittenContent || masterContent}
              atsScore={result.atsScore}
              metricsPreserved={result.metricsPreserved}
              phasesCompleted={result.phasesCompleted}
              onAccept={handleAccept}
              onDiscard={handleReset}
              accepting={accepting}
            />
          ) : status === "running" ||
            status === "cancelled" ||
            status === "error" ? (
            /* Active Progress and Pipeline Stepper View */
            <div className="space-y-4">
              <PhaseProgressRail
                currentPhase={currentPhase}
                progressPercent={progressPercent}
                stepDescription={stepDescription}
                elapsedSeconds={elapsedSeconds}
                status={status}
                onCancel={handleCancelRun}
                cancelling={cancelling}
              />

              {status === "cancelled" && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center dark:border-zinc-800 dark:bg-zinc-900/50">
                  <p className="font-medium text-foreground text-xs">
                    Tailoring run was cancelled. No files were modified.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-4"
                    onClick={handleReset}
                  >
                    Configure New Run
                  </Button>
                </div>
              )}

              {status === "error" && (
                <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-6 text-center">
                  <p className="font-medium text-destructive text-xs">
                    An error occurred while executing the tailoring pipeline.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-4"
                    onClick={handleReset}
                  >
                    Try Again
                  </Button>
                </div>
              )}
            </div>
          ) : (
            /* Preflight Configuration Form */
            <div className="space-y-4">
              <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                <div className="flex items-center gap-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                  <FileTextIcon className="size-4 text-primary" />
                  Target Position & Persona Configuration
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <span className="block font-medium text-muted-foreground text-xs">
                      Variant Name
                    </span>
                    <Input
                      value={variantName}
                      onChange={(e) => setVariantName(e.target.value)}
                      placeholder="e.g. Datadog - Staff SRE"
                      className="mt-1 h-8 text-xs"
                    />
                  </div>

                  <div>
                    <span className="block font-medium text-muted-foreground text-xs">
                      Target Company
                    </span>
                    <Input
                      value={targetCompany}
                      onChange={(e) => setTargetCompany(e.target.value)}
                      placeholder="e.g. Datadog, Stripe"
                      className="mt-1 h-8 text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <span className="block font-medium text-muted-foreground text-xs">
                      Target Role
                    </span>
                    <Input
                      value={targetRole}
                      onChange={(e) => setRole(e.target.value)}
                      placeholder="e.g. Staff Infrastructure Engineer"
                      className="mt-1 h-8 text-xs"
                    />
                  </div>

                  <div>
                    <span className="block font-medium text-muted-foreground text-xs">
                      Seniority Level
                    </span>
                    <Select
                      value={seniority}
                      onValueChange={(val) =>
                        setSeniority(val as SeniorityLevel)
                      }
                    >
                      <SelectTrigger className="mt-1 h-8 text-xs">
                        <SelectValue placeholder="Seniority" />
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
                      Persona Spin
                    </span>
                    <Select value={personaId} onValueChange={setPersonaId}>
                      <SelectTrigger className="mt-1 h-8 text-xs">
                        <SelectValue placeholder="Persona" />
                      </SelectTrigger>
                      <SelectContent>
                        {personas.length > 0 ? (
                          personas.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.label}
                            </SelectItem>
                          ))
                        ) : (
                          <>
                            <SelectItem value="ai">AI / ML Engineer</SelectItem>
                            <SelectItem value="lead">Staff / Lead</SelectItem>
                            <SelectItem value="backend">
                              Backend Systems
                            </SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 border-t pt-1 sm:grid-cols-2">
                  <div>
                    <span className="block font-medium text-muted-foreground text-xs">
                      Page Budget
                    </span>
                    <Select
                      value={String(pageBudget)}
                      onValueChange={(val) =>
                        setPageBudget(Number.parseInt(val, 10))
                      }
                    >
                      <SelectTrigger className="mt-1 h-8 text-xs">
                        <SelectValue placeholder="Page Budget" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">
                          1 Page (Knapsack ~36 lines)
                        </SelectItem>
                        <SelectItem value="2">
                          2 Pages (Knapsack ~72 lines)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-2 pt-5">
                    <input
                      type="checkbox"
                      id="strictMetrics"
                      checked={strictMetrics}
                      onChange={(e) => setStrictMetrics(e.target.checked)}
                      className="size-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <label
                      htmlFor="strictMetrics"
                      className="flex cursor-pointer items-center gap-1.5 font-medium text-foreground text-xs"
                    >
                      <ShieldCheckIcon className="size-3.5 text-primary" />
                      Strict Metric Preservation (Enforce checkSafe invariant)
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <span className="block font-medium text-muted-foreground text-xs">
                  Target Job Description *
                </span>
                <Textarea
                  value={jobDescription}
                  onChange={(e) => setJobDescription(e.target.value)}
                  placeholder="Paste the full job posting responsibilities, qualifications, and requirements..."
                  rows={8}
                  className="mt-1 font-mono text-xs"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleStart}
                  disabled={!jobDescription.trim()}
                  className="gap-1.5 bg-primary"
                >
                  <PlayIcon className="size-3.5" />
                  Launch Tailoring Run
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Human-in-the-Loop Approval Interceptor Modal */}
        <ApprovalModal
          approval={pendingApproval}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      </DialogContent>
    </Dialog>
  );
}
