import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { PhaseProgressRail } from "@/components/workspace/tailoring-studio/phase-progress-rail";
import { ApprovalModal } from "@/components/workspace/tailoring-studio/approval-modal";
import { TailoringDiffReview } from "@/components/workspace/tailoring-studio/tailoring-diff-review";
import { TailoringStudioModal } from "@/components/workspace/tailoring-studio/tailoring-studio-modal";
import { useDocumentStore } from "@/stores/document-store";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import type {
  VaniApprovalRequiredPayload,
  VaniTailorResult,
} from "@/components/workspace/tailoring-studio/types";

// Tauri event listener mock
const listeners: Record<string, Array<(event: { payload: any }) => void>> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, callback: (event: { payload: any }) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      return () => {
        listeners[event] = (listeners[event] || []).filter(
          (cb) => cb !== callback,
        );
      };
    },
  ),
}));

function emitEvent(event: string, payload: any) {
  const cbs = listeners[event] || [];
  for (const cb of cbs) {
    cb({ payload });
  }
}

// Tauri invoke mock
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("Tailoring Studio Components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(listeners)) {
      delete listeners[key];
    }

    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "career_list_personas") return [];
      if (cmd === "manvi_tailor_resume") {
        const res: VaniTailorResult = {
          runId: "run-test-123",
          status: "completed",
          rewrittenContent:
            "= Tailored Resume\n- Architected distributed payment rails with sub-5ms p99 latency",
          atsScore: 94,
          metricsPreserved: true,
          phasesCompleted: 4,
        };
        return res;
      }
      if (cmd === "manvi_approve_action") return { success: true };
      if (cmd === "manvi_cancel_run") return { success: true };
      if (cmd === "variant_create" || cmd === "create_variant") {
        return {
          id: "stripe-lead",
          name: args.name,
          status: "applied",
          jd: args.jd,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          path: "/projects/resume/.prism/variants/stripe-lead",
          company: args.company,
          role: args.role,
          atsScore: args.atsScore,
        };
      }
      if (cmd === "scan_project_folder") {
        return {
          files: [
            {
              relativePath: "main.typ",
              absolutePath: `${(args as any)?.rootPath || "/projects/resume"}/main.typ`,
              type: "typst",
              fileSize: 100,
            },
          ],
          folders: [],
        };
      }
      if (cmd === "allow_project_directory") {
        return true;
      }
      return null;
    });

    useDocumentStore.setState({
      projectRoot: "/projects/resume",
      files: [
        {
          id: "main.typ",
          name: "main.typ",
          relativePath: "main.typ",
          absolutePath: "/projects/resume/main.typ",
          content: "= Master Resume\n- Built software systems for payments",
          type: "typst",
          isDirty: false,
        },
      ],
      activeFileId: "main.typ",
    });

    useResumeVariantsStore.setState({
      ownerRoot: "/projects/resume",
      activeVariantId: null,
      variants: [],
      selectedVariant: null,
      loading: false,
      switching: false,
    });
  });

  describe("PhaseProgressRail", () => {
    it("renders progress percentage, elapsed time, and phase descriptions", () => {
      const onCancel = vi.fn();
      render(
        <PhaseProgressRail
          currentPhase={2}
          progressPercent={0.45}
          stepDescription="Analyzing gap analysis between master and JD..."
          elapsedSeconds={125}
          status="running"
          onCancel={onCancel}
        />,
      );

      expect(
        screen.getByText("Tailoring Pipeline Execution"),
      ).toBeInTheDocument();
      expect(screen.getByText("45%")).toBeInTheDocument();
      expect(screen.getByText("02:05")).toBeInTheDocument();
      expect(
        screen.getByText("Analyzing gap analysis between master and JD..."),
      ).toBeInTheDocument();

      // Check the 4 phases
      expect(screen.getByText("Phase 1: JD Extraction")).toBeInTheDocument();
      expect(
        screen.getByText("Phase 2: Knapsack Optimization"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Phase 3: Metric-Preserving Synthesis"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Phase 4: Critic Audit & Verification"),
      ).toBeInTheDocument();
    });

    it("normalizes both whole number (e.g. 75) and fractional (0.75) progress percentages safely", () => {
      const { rerender } = render(
        <PhaseProgressRail
          currentPhase={2}
          progressPercent={75}
          elapsedSeconds={10}
          status="running"
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("75%")).toBeInTheDocument();

      rerender(
        <PhaseProgressRail
          currentPhase={3}
          progressPercent={0.75}
          elapsedSeconds={20}
          status="running"
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("75%")).toBeInTheDocument();

      rerender(
        <PhaseProgressRail
          currentPhase={1}
          progressPercent={Number.NaN}
          elapsedSeconds={0}
          status="running"
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("0%")).toBeInTheDocument();
    });

    it("triggers onCancel when Cancel Run button is clicked while running", () => {
      const onCancel = vi.fn();
      render(
        <PhaseProgressRail
          currentPhase={3}
          progressPercent={0.7}
          elapsedSeconds={42}
          status="running"
          onCancel={onCancel}
        />,
      );

      const cancelBtn = screen.getByText("Cancel Run");
      fireEvent.click(cancelBtn);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("shows cancelling spinner when cancelling is true", () => {
      render(
        <PhaseProgressRail
          currentPhase={3}
          progressPercent={0.7}
          elapsedSeconds={42}
          status="running"
          onCancel={vi.fn()}
          cancelling={true}
        />,
      );

      expect(screen.getByText("Cancelling...")).toBeInTheDocument();
    });
  });

  describe("ApprovalModal", () => {
    const mockApproval: VaniApprovalRequiredPayload = {
      runId: "run-test-123",
      approvalId: "approval-xyz-987",
      prompt:
        "Select bullet priority to align with Stripe's low-latency requirement:",
      options: [
        "Architected distributed payment rails with sub-5ms p99 latency",
        "Scaled transaction throughput by 400% during Black Friday peaks",
      ],
      defaultChoice:
        "Architected distributed payment rails with sub-5ms p99 latency",
    };

    it("renders prompt, options, and handles approval with selection", async () => {
      const onApprove = vi.fn(async () => {});
      const onReject = vi.fn(async () => {});

      render(
        <ApprovalModal
          approval={mockApproval}
          onApprove={onApprove}
          onReject={onReject}
        />,
      );

      expect(
        screen.getByText("Human Decision Required (fd 3)"),
      ).toBeInTheDocument();
      expect(screen.getByText(mockApproval.prompt)).toBeInTheDocument();
      expect(screen.getByText(mockApproval.options[0])).toBeInTheDocument();
      expect(screen.getByText(mockApproval.options[1])).toBeInTheDocument();

      // Click second option
      fireEvent.click(screen.getByText(mockApproval.options[1]));

      // Type write-in and reason
      const writeInInput = screen.getByPlaceholderText(
        "Custom bullet phrasing or modification...",
      );
      fireEvent.change(writeInInput, {
        target: {
          value: "Scaled transaction throughput by 400% with zero data loss",
        },
      });

      const reasonInput = screen.getByPlaceholderText(
        "e.g. Aligns better with role's primary latency objective",
      );
      fireEvent.change(reasonInput, {
        target: { value: "Emphasizes reliability alongside scale" },
      });

      const approveBtn = screen.getByText("Approve & Continue");
      fireEvent.click(approveBtn);

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalledWith(
          "approval-xyz-987",
          "Scaled transaction throughput by 400% during Black Friday peaks",
          "Scaled transaction throughput by 400% with zero data loss",
          "Emphasizes reliability alongside scale",
        );
      });
    });

    it("handles reject action", async () => {
      const onApprove = vi.fn(async () => {});
      const onReject = vi.fn(async () => {});

      render(
        <ApprovalModal
          approval={mockApproval}
          onApprove={onApprove}
          onReject={onReject}
        />,
      );

      const rejectBtn = screen.getByText("Reject / Fallback");
      fireEvent.click(rejectBtn);

      await waitFor(() => {
        expect(onReject).toHaveBeenCalledWith("approval-xyz-987", undefined);
      });
    });
  });

  describe("TailoringDiffReview", () => {
    it("renders ATS score gauge, metric preservation summary, and diff stats", () => {
      const onAccept = vi.fn(async () => {});
      const onDiscard = vi.fn();

      render(
        <TailoringDiffReview
          masterContent="= Master Resume\n- Built software systems for payments"
          tailoredContent="= Tailored Resume\n- Architected distributed payment rails with sub-5ms p99 latency"
          atsScore={94}
          metricsPreserved={true}
          phasesCompleted={4}
          onAccept={onAccept}
          onDiscard={onDiscard}
        />,
      );

      expect(screen.getByText("94% ATS Match")).toBeInTheDocument();
      expect(
        screen.getByText("Metrics Preserved (checkSafe Passed)"),
      ).toBeInTheDocument();
      expect(screen.getByText("(4 phases)")).toBeInTheDocument();

      // View mode toggling
      const sideBySideBtn = screen.getByText("Side-by-Side");
      fireEvent.click(sideBySideBtn);
      expect(screen.getByText("Canonical Master Document")).toBeInTheDocument();
      expect(
        screen.getByText("Tailored Variant Output (94% ATS)"),
      ).toBeInTheDocument();

      const acceptBtn = screen.getByText("Accept & Open in Editor");
      fireEvent.click(acceptBtn);
      expect(onAccept).toHaveBeenCalledTimes(1);

      const discardBtn = screen.getByText("Discard / Edit Prompt");
      fireEvent.click(discardBtn);
      expect(onDiscard).toHaveBeenCalledTimes(1);
    });

    it("displays warning when metricsPreserved is false", () => {
      render(
        <TailoringDiffReview
          masterContent="= Master Resume"
          tailoredContent="= Tailored Resume"
          atsScore={65}
          metricsPreserved={false}
          phasesCompleted={3}
          onAccept={vi.fn(async () => {})}
          onDiscard={vi.fn()}
        />,
      );

      expect(screen.getByText("Metric Invariant Warning")).toBeInTheDocument();
    });
  });

  describe("TailoringStudioModal Orchestration", () => {
    it("runs preflight form submission and executes tailoring pipeline", async () => {
      const onOpenChange = vi.fn();
      render(<TailoringStudioModal open={true} onOpenChange={onOpenChange} />);

      expect(
        screen.getByText("Vani Interactive Tailoring Studio"),
      ).toBeInTheDocument();

      // Wait for event listeners to be registered
      await waitFor(() => {
        expect(listeners["vani://tailor-progress"]).toBeDefined();
      });

      // Fill in preflight inputs
      const jdTextarea = screen.getByPlaceholderText(
        "Paste the full job posting responsibilities, qualifications, and requirements...",
      );
      fireEvent.change(jdTextarea, {
        target: {
          value:
            "Looking for Staff Distributed Systems Engineer in Go with Kubernetes.",
        },
      });

      const companyInput = screen.getByPlaceholderText("e.g. Datadog, Stripe");
      fireEvent.change(companyInput, { target: { value: "Stripe" } });

      const roleInput = screen.getByPlaceholderText(
        "e.g. Staff Infrastructure Engineer",
      );
      fireEvent.change(roleInput, {
        target: { value: "Staff Backend Engineer" },
      });

      // Click Launch Tailoring Run
      const runBtn = screen.getByText("Launch Tailoring Run");
      fireEvent.click(runBtn);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "manvi_tailor_resume",
          expect.objectContaining({
            request: expect.objectContaining({
              masterPath: "/projects/resume/main.typ",
              jobDescription:
                "Looking for Staff Distributed Systems Engineer in Go with Kubernetes.",
              targetPageBudget: 1,
              strictMetrics: true,
            }),
          }),
        );
      });

      // After pipeline finishes, diff review is displayed
      await waitFor(() => {
        expect(screen.getByText("94% ATS Match")).toBeInTheDocument();
        expect(
          screen.getByText("Metrics Preserved (checkSafe Passed)"),
        ).toBeInTheDocument();
      });

      // Accept & Open in Editor
      const acceptBtn = screen.getByText("Accept & Open in Editor");
      fireEvent.click(acceptBtn);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "variant_create",
          expect.objectContaining({
            company: "Stripe",
            role: "Staff Backend Engineer",
            atsScore: 94,
          }),
        );
        const docState = useDocumentStore.getState();
        expect(docState.files[0].content).toBe(
          "= Tailored Resume\n- Architected distributed payment rails with sub-5ms p99 latency",
        );
      });
    });

    it("surfaces ApprovalModal on vani://approval-required event and submits decision via manvi_approve_action", async () => {
      render(<TailoringStudioModal open={true} onOpenChange={vi.fn()} />);

      // Wait for listeners to be registered
      await waitFor(() => {
        expect(listeners["vani://approval-required"]).toBeDefined();
      });

      // Emit vani://approval-required event
      act(() => {
        emitEvent("vani://approval-required", {
          runId: "run-interactive-456",
          approvalId: "approval-decision-777",
          prompt: "Confirm phrasing for high-scale metric:",
          options: [
            "Processed 10B events daily with 99.999% uptime",
            "Handled 100k QPS across 4 global cloud regions",
          ],
          defaultChoice: "Processed 10B events daily with 99.999% uptime",
        });
      });

      // Modal should appear
      await waitFor(() => {
        expect(
          screen.getByText("Human Decision Required (fd 3)"),
        ).toBeInTheDocument();
        expect(
          screen.getByText("Confirm phrasing for high-scale metric:"),
        ).toBeInTheDocument();
      });

      // Approve & Continue
      const approveBtn = screen.getByText("Approve & Continue");
      fireEvent.click(approveBtn);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("manvi_approve_action", {
          approvalId: "approval-decision-777",
          allow: true,
          chosen: "Processed 10B events daily with 99.999% uptime",
          writeIn: null,
          reason: null,
        });
      });
    });

    it("cancels running pipeline via manvi_cancel_run", async () => {
      // Setup a long-running call that doesn't immediately resolve
      invokeMock.mockImplementation(async (cmd: string, _args: any) => {
        if (cmd === "career_list_personas") return [];
        if (cmd === "manvi_tailor_resume") {
          return new Promise(() => {});
        }
        if (cmd === "manvi_cancel_run") return { success: true };
        return null;
      });

      render(<TailoringStudioModal open={true} onOpenChange={vi.fn()} />);

      await waitFor(() => {
        expect(listeners["vani://tailor-progress"]).toBeDefined();
      });

      const jdTextarea = screen.getByPlaceholderText(
        "Paste the full job posting responsibilities, qualifications, and requirements...",
      );
      fireEvent.change(jdTextarea, {
        target: { value: "Full Stack Engineer needed." },
      });

      const runBtn = screen.getByText("Launch Tailoring Run");
      fireEvent.click(runBtn);

      // Emit progress to set runId
      act(() => {
        emitEvent("vani://tailor-progress", {
          phase: 2,
          percent: 0.3,
          step: "Analyzing keywords...",
          runId: "run-to-cancel-999",
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Cancel Run")).toBeInTheDocument();
      });

      // Click Cancel Run
      const cancelBtn = screen.getByText("Cancel Run");
      fireEvent.click(cancelBtn);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("manvi_cancel_run", {
          runId: "run-to-cancel-999",
        });
      });
    });

    it("updates active document content with rewrittenContent and persists to disk when accepting tailored variant", async () => {
      const onOpenChange = vi.fn();
      const tailoredContent =
        "= Tailored Variant Resume\n- Architected high-throughput payment processing engine with sub-5ms p99 latency";

      useDocumentStore.setState({
        projectRoot: "/projects/resume",
        files: [
          {
            id: "main.typ",
            name: "main.typ",
            relativePath: "main.typ",
            absolutePath: "/projects/resume/main.typ",
            content: "= Master Resume Document\n- Standard un-tailored bullet",
            type: "typst",
            isDirty: false,
          },
        ],
        activeFileId: "main.typ",
      });

      invokeMock.mockImplementation(async (cmd: string, args: any) => {
        if (cmd === "career_list_personas") return [];
        if (cmd === "manvi_tailor_resume") {
          return {
            runId: "run-accept-persist-001",
            status: "completed",
            rewrittenContent: tailoredContent,
            atsScore: 96,
            metricsPreserved: true,
            phasesCompleted: 4,
          };
        }
        if (cmd === "variant_create") {
          return {
            id: "tailored-accepted-variant",
            name: args.name,
            status: "applied",
            jd: args.jd,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            path: "/projects/resume/.prism/variants/tailored-accepted-variant",
            company: args.company,
            role: args.role,
            atsScore: args.atsScore,
          };
        }
        if (cmd === "scan_project_folder") {
          return {
            files: [
              {
                relativePath: "main.typ",
                absolutePath: `${(args as any)?.rootPath || "/projects/resume"}/main.typ`,
                type: "typst",
                fileSize: 100,
              },
            ],
            folders: [],
          };
        }
        if (cmd === "allow_project_directory") return true;
        if (cmd === "variant_list") return [];
        return null;
      });

      render(<TailoringStudioModal open={true} onOpenChange={onOpenChange} />);

      const jdTextarea = screen.getByPlaceholderText(
        "Paste the full job posting responsibilities, qualifications, and requirements...",
      );
      fireEvent.change(jdTextarea, {
        target: {
          value:
            "Looking for Cloud Native Architect with Kubernetes experience.",
        },
      });

      const launchBtn = screen.getByText("Launch Tailoring Run");
      fireEvent.click(launchBtn);

      await waitFor(() => {
        expect(screen.getByText("96% ATS Match")).toBeInTheDocument();
        expect(screen.getByText("Accept & Open in Editor")).toBeInTheDocument();
      });

      const acceptBtn = screen.getByText("Accept & Open in Editor");
      fireEvent.click(acceptBtn);

      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });

      const docState = useDocumentStore.getState();
      const activeFile =
        docState.files.find((f) => f.id === docState.activeFileId) ||
        docState.files[0];
      expect(activeFile).toBeDefined();
      expect(activeFile.content).toBe(tailoredContent);
      expect(writeTextFile).toHaveBeenCalledWith(
        expect.stringContaining("main.typ"),
        tailoredContent,
      );
    });

    it("prevents status revival when cancelled before runId arrives and dispatches deferred cancellation", async () => {
      let resolveTailorPromise: (res: any) => void = () => {};

      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "career_list_personas") return [];
        if (cmd === "manvi_tailor_resume") {
          return new Promise((resolve) => {
            resolveTailorPromise = resolve;
          });
        }
        if (cmd === "manvi_cancel_run") return { success: true };
        return null;
      });

      render(<TailoringStudioModal open={true} onOpenChange={vi.fn()} />);

      await waitFor(() => {
        expect(listeners["vani://tailor-progress"]).toBeDefined();
      });

      const jd = screen.getByPlaceholderText(
        "Paste the full job posting responsibilities, qualifications, and requirements...",
      );
      fireEvent.change(jd, {
        target: { value: "Full Stack Engineer needed." },
      });
      fireEvent.click(screen.getByText("Launch Tailoring Run"));

      // 1. Cancel immediately while runId is still null
      await waitFor(() => {
        expect(screen.getByText("Cancel Run")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("Cancel Run"));

      // Assert UI enters cancelled state immediately
      await waitFor(() => {
        expect(
          screen.getByText(/Tailoring run was cancelled/i),
        ).toBeInTheDocument();
      });

      // manvi_cancel_run should NOT have been called yet since runId was unknown
      expect(invokeMock).not.toHaveBeenCalledWith(
        "manvi_cancel_run",
        expect.anything(),
      );

      // 2. Simulate backend emitting progress with runId
      act(() => {
        emitEvent("vani://tailor-progress", {
          phase: 1,
          percent: 0.2,
          step: "Analyzing keywords...",
          runId: "run-deferred-123",
        });
      });

      // Deferred cancellation should immediately dispatch manvi_cancel_run!
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("manvi_cancel_run", {
          runId: "run-deferred-123",
        });
      });

      // 3. Simulate manvi_tailor_resume promise resolving with "completed"
      act(() => {
        resolveTailorPromise({
          runId: "run-deferred-123",
          status: "completed",
          rewrittenContent: "= Tailored Resume\n- Architected scale",
          atsScore: 95,
          metricsPreserved: true,
          phasesCompleted: 4,
        });
      });

      // Assert status was NOT revived to "completed" - Diff Review should NOT be rendered
      expect(screen.queryByText("95% ATS Match")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Accept & Open in Editor"),
      ).not.toBeInTheDocument();
      // Cancelled state remains active
      expect(
        screen.getByText(/Tailoring run was cancelled/i),
      ).toBeInTheDocument();
    });

    it("ignores promise rejection when cancelled during execution", async () => {
      let rejectTailorPromise: (err: any) => void = () => {};

      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "career_list_personas") return [];
        if (cmd === "manvi_tailor_resume") {
          return new Promise((_, reject) => {
            rejectTailorPromise = reject;
          });
        }
        if (cmd === "manvi_cancel_run") return { success: true };
        return null;
      });

      render(<TailoringStudioModal open={true} onOpenChange={vi.fn()} />);

      await waitFor(() => {
        expect(listeners["vani://tailor-progress"]).toBeDefined();
      });

      const jd = screen.getByPlaceholderText(
        "Paste the full job posting responsibilities, qualifications, and requirements...",
      );
      fireEvent.change(jd, {
        target: { value: "Site Reliability Engineer" },
      });
      fireEvent.click(screen.getByText("Launch Tailoring Run"));

      // Set runId via progress
      act(() => {
        emitEvent("vani://tailor-progress", {
          phase: 1,
          percent: 0.25,
          step: "Parsing JD...",
          runId: "run-reject-test",
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Cancel Run")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("Cancel Run"));

      // Reject the promise (simulating killed process / closed stdio)
      act(() => {
        rejectTailorPromise(
          new Error("Process terminated with signal SIGKILL"),
        );
      });

      // Error banner should NOT be rendered; cancelled banner should remain
      expect(
        screen.queryByText(
          /An error occurred while executing the tailoring pipeline/i,
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/Tailoring run was cancelled/i),
      ).toBeInTheDocument();
    });
  });
});
