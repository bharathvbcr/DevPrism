import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { ApprovalModal } from "@/components/workspace/tailoring-studio/approval-modal";
import { TailoringDiffReview } from "@/components/workspace/tailoring-studio/tailoring-diff-review";
import { TailoringStudioModal } from "@/components/workspace/tailoring-studio/tailoring-studio-modal";
import { lineDiff, diffStats } from "@/lib/line-diff";
import { toDisplayDiffRows } from "@/lib/diff-display";
import { useDocumentStore } from "@/stores/document-store";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import type {
  VaniApprovalRequiredPayload,
  VaniTailorResult,
} from "@/components/workspace/tailoring-studio/types";

// Tauri event listener mock tracking registered callbacks
const activeListeners: Record<
  string,
  Array<(event: { payload: any }) => void>
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, callback: (event: { payload: any }) => void) => {
      if (!activeListeners[event]) activeListeners[event] = [];
      activeListeners[event].push(callback);
      return () => {
        activeListeners[event] = (activeListeners[event] || []).filter(
          (cb) => cb !== callback,
        );
      };
    },
  ),
}));

function emitEvent(event: string, payload: any) {
  const cbs = activeListeners[event] || [];
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

describe("Milestone 4 Feature 16 Adversarial Stress Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(activeListeners)) {
      delete activeListeners[key];
    }

    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "career_list_personas") return [];
      if (cmd === "manvi_tailor_resume") {
        const res: VaniTailorResult = {
          runId: "run-stress-001",
          status: "completed",
          rewrittenContent:
            "= Stress Tailored Resume\n- Optimized throughput by 500%",
          atsScore: 92,
          metricsPreserved: true,
          phasesCompleted: 4,
        };
        return res;
      }
      if (cmd === "manvi_approve_action") return { success: true };
      if (cmd === "manvi_cancel_run") return { success: true };
      if (cmd === "variant_create" || cmd === "create_variant") {
        return {
          id: "stress-variant-001",
          name: args.name,
          status: "applied",
          jd: args.jd,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          path: "/projects/resume/.prism/variants/stress-variant-001",
          company: args.company,
          role: args.role,
          atsScore: args.atsScore,
        };
      }
      return null;
    });

    useDocumentStore.setState({
      projectRoot: "/projects/stress-resume",
      files: [
        {
          id: "main.typ",
          name: "main.typ",
          relativePath: "main.typ",
          absolutePath: "/projects/stress-resume/main.typ",
          content: "= Master Resume\n- Initial experience bullet",
          type: "typst",
          isDirty: false,
        },
      ],
      activeFileId: "main.typ",
    });

    useResumeVariantsStore.setState({
      ownerRoot: "/projects/stress-resume",
      activeVariantId: null,
      variants: [],
      selectedVariant: null,
      loading: false,
      switching: false,
    });
  });

  // =========================================================================
  // 1. Stress Test Tailoring Run Lifecycle & Unmounting / Event Listener Cleanup
  // =========================================================================
  describe("Lifecycle & Cancellation Stress", () => {
    it("handles rapid cancellation before runId is received from progress", async () => {
      // simulate long running invoke
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "career_list_personas") return [];
        if (cmd === "manvi_tailor_resume") {
          return new Promise(() => {}); // never resolves
        }
        if (cmd === "manvi_cancel_run") return { success: true };
        return null;
      });

      render(<TailoringStudioModal open={true} onOpenChange={vi.fn()} />);

      await waitFor(() => {
        expect(activeListeners["vani://tailor-progress"]).toBeDefined();
      });

      const jd = screen.getByPlaceholderText(/Paste the full job posting/i);
      fireEvent.change(jd, {
        target: { value: "Staff Infrastructure Engineer" },
      });

      const launchBtn = screen.getByText("Launch Tailoring Run");
      fireEvent.click(launchBtn);

      // Verify UI enters running state immediately
      await waitFor(() => {
        expect(screen.getByText("Cancel Run")).toBeInTheDocument();
      });

      // Rapidly click Cancel Run without receiving any vani://tailor-progress (runId is still null)
      const cancelBtn = screen.getByText("Cancel Run");
      fireEvent.click(cancelBtn);

      await waitFor(() => {
        expect(
          screen.getByText(/Tailoring run was cancelled/i),
        ).toBeInTheDocument();
      });

      // Note: manvi_cancel_run is only called if runId is available
      expect(invokeMock).toHaveBeenCalledWith(
        "manvi_tailor_resume",
        expect.anything(),
      );
    });

    it("handles rapid double-cancellation when runId is known", async () => {
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "career_list_personas") return [];
        if (cmd === "manvi_tailor_resume") return new Promise(() => {});
        if (cmd === "manvi_cancel_run") return { success: true };
        return null;
      });

      render(<TailoringStudioModal open={true} onOpenChange={vi.fn()} />);

      await waitFor(() => {
        expect(activeListeners["vani://tailor-progress"]).toBeDefined();
      });

      const jd = screen.getByPlaceholderText(/Paste the full job posting/i);
      fireEvent.change(jd, { target: { value: "Site Reliability Engineer" } });
      fireEvent.click(screen.getByText("Launch Tailoring Run"));

      // Send progress with runId
      act(() => {
        emitEvent("vani://tailor-progress", {
          phase: 1,
          percent: 0.25,
          step: "Parsing JD...",
          runId: "run-cancellation-test",
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Cancel Run")).toBeInTheDocument();
      });

      const cancelBtn = screen.getByText("Cancel Run");
      // Double click
      fireEvent.click(cancelBtn);
      fireEvent.click(cancelBtn);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("manvi_cancel_run", {
          runId: "run-cancellation-test",
        });
      });
    });

    it("cleanly unmounts event listeners when open transitions to false", async () => {
      const { rerender } = render(
        <TailoringStudioModal open={true} onOpenChange={vi.fn()} />,
      );

      // Wait for listeners to attach
      await waitFor(() => {
        expect(activeListeners["vani://tailor-progress"]?.length).toBe(1);
        expect(activeListeners["vani://approval-required"]?.length).toBe(1);
        expect(activeListeners["vani://tailor-cancelled"]?.length).toBe(1);
      });

      // Transition open from true to false
      rerender(<TailoringStudioModal open={false} onOpenChange={vi.fn()} />);

      // Verify all listeners are detached
      await waitFor(() => {
        expect(activeListeners["vani://tailor-progress"]?.length || 0).toBe(0);
        expect(activeListeners["vani://approval-required"]?.length || 0).toBe(
          0,
        );
        expect(activeListeners["vani://tailor-cancelled"]?.length || 0).toBe(0);
      });
    });

    it("cleanly unmounts event listeners on component unmount during active progress", async () => {
      const { unmount } = render(
        <TailoringStudioModal open={true} onOpenChange={vi.fn()} />,
      );

      await waitFor(() => {
        expect(activeListeners["vani://tailor-progress"]?.length).toBe(1);
      });

      // Emit progress while active
      act(() => {
        emitEvent("vani://tailor-progress", {
          phase: 2,
          percent: 0.5,
          step: "Knapsack optimizing...",
          runId: "run-unmount-progress",
        });
      });

      // Unmount component
      unmount();

      // Listeners should be cleaned up
      expect(activeListeners["vani://tailor-progress"]?.length || 0).toBe(0);
      expect(activeListeners["vani://approval-required"]?.length || 0).toBe(0);
      expect(activeListeners["vani://tailor-cancelled"]?.length || 0).toBe(0);
    });

    it("cleanly unmounts during active approval dialog without unhandled rejection", async () => {
      const { unmount } = render(
        <TailoringStudioModal open={true} onOpenChange={vi.fn()} />,
      );

      await waitFor(() => {
        expect(activeListeners["vani://approval-required"]?.length).toBe(1);
      });

      // Emit approval required
      act(() => {
        emitEvent("vani://approval-required", {
          runId: "run-unmount-approval",
          approvalId: "appr-unmount-1",
          prompt: "Select bullet priority:",
          options: ["Option A", "Option B"],
          defaultChoice: "Option A",
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText("Human Decision Required (fd 3)"),
        ).toBeInTheDocument();
      });

      // Unmount while modal is showing
      unmount();

      // Should not throw or retain listeners
      expect(activeListeners["vani://tailor-progress"]?.length || 0).toBe(0);
      expect(activeListeners["vani://approval-required"]?.length || 0).toBe(0);
    });

    it("survives rapid open-close cycling without leaking zombie listeners", async () => {
      const { rerender } = render(
        <TailoringStudioModal open={false} onOpenChange={vi.fn()} />,
      );

      // Rapidly toggle open 10 times
      for (let i = 0; i < 10; i++) {
        rerender(<TailoringStudioModal open={true} onOpenChange={vi.fn()} />);
        await waitFor(() => {
          expect(activeListeners["vani://tailor-progress"]?.length).toBe(1);
        });
        rerender(<TailoringStudioModal open={false} onOpenChange={vi.fn()} />);
        await waitFor(() => {
          expect(activeListeners["vani://tailor-progress"]?.length || 0).toBe(
            0,
          );
        });
      }

      expect(activeListeners["vani://tailor-progress"]?.length || 0).toBe(0);
      expect(activeListeners["vani://approval-required"]?.length || 0).toBe(0);
      expect(activeListeners["vani://tailor-cancelled"]?.length || 0).toBe(0);
    });
  });

  // =========================================================================
  // 2. Stress Test Approval Decision Flow
  // =========================================================================
  describe("Approval Decision Flow Stress", () => {
    const baseApproval: VaniApprovalRequiredPayload = {
      runId: "run-approval-stress",
      approvalId: "appr-stress-42",
      prompt: "Confirm synthesis candidate for performance metric:",
      options: [
        "Reduced p99 database query latency from 120ms to 4ms via Redis caching",
        "Engineered zero-downtime database sharding for 50TB Cassandra cluster",
      ],
      defaultChoice:
        "Reduced p99 database query latency from 120ms to 4ms via Redis caching",
    };

    it("handles empty / whitespace-only writeIn and reason by normalizing to undefined", async () => {
      const onApprove = vi.fn(async () => {});
      const onReject = vi.fn(async () => {});

      render(
        <ApprovalModal
          approval={baseApproval}
          onApprove={onApprove}
          onReject={onReject}
        />,
      );

      const writeInInput = screen.getByPlaceholderText(
        "Custom bullet phrasing or modification...",
      );
      const reasonInput = screen.getByPlaceholderText(
        "e.g. Aligns better with role's primary latency objective",
      );

      // Enter only spaces and tabs
      fireEvent.change(writeInInput, { target: { value: "   \t  \n  " } });
      fireEvent.change(reasonInput, { target: { value: "     " } });

      fireEvent.click(screen.getByText("Approve & Continue"));

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalledWith(
          "appr-stress-42",
          baseApproval.defaultChoice,
          undefined,
          undefined,
        );
      });
    });

    it("handles huge strings (50,000 characters) in writeIn and reason without UI freeze", async () => {
      const onApprove = vi.fn(async () => {});
      const onReject = vi.fn(async () => {});

      render(
        <ApprovalModal
          approval={baseApproval}
          onApprove={onApprove}
          onReject={onReject}
        />,
      );

      const hugeWriteIn = "Architected high-throughput message bus. ".repeat(
        1200,
      ); // ~51,600 chars
      const hugeReason = "Performance requirement justification. ".repeat(600); // ~23,400 chars

      const writeInInput = screen.getByPlaceholderText(
        "Custom bullet phrasing or modification...",
      );
      const reasonInput = screen.getByPlaceholderText(
        "e.g. Aligns better with role's primary latency objective",
      );

      fireEvent.change(writeInInput, { target: { value: hugeWriteIn } });
      fireEvent.change(reasonInput, { target: { value: hugeReason } });

      const startTime = performance.now();
      fireEvent.click(screen.getByText("Approve & Continue"));

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalledWith(
          "appr-stress-42",
          baseApproval.defaultChoice,
          hugeWriteIn.trim(),
          hugeReason.trim(),
        );
      });
      const duration = performance.now() - startTime;
      expect(duration).toBeLessThan(1000); // Instant submission
    });

    it("handles complex Unicode, emoji, RTL, CJK, and mathematical symbols", async () => {
      const onApprove = vi.fn(async () => {});
      const onReject = vi.fn(async () => {});

      render(
        <ApprovalModal
          approval={baseApproval}
          onApprove={onApprove}
          onReject={onReject}
        />,
      );

      const unicodeWriteIn =
        "🚀 Scaled backend for 👨‍👩‍👧‍👦 families across 日本語 and العربية: ∑(x_i) ≥ 99.999% SLA ✓ ñ, ü, ø, ß";
      const unicodeReason = "السبب: تحسين الأداء 🌟 and zero-width \u200D test";

      const writeInInput = screen.getByPlaceholderText(
        "Custom bullet phrasing or modification...",
      );
      const reasonInput = screen.getByPlaceholderText(
        "e.g. Aligns better with role's primary latency objective",
      );

      fireEvent.change(writeInInput, { target: { value: unicodeWriteIn } });
      fireEvent.change(reasonInput, { target: { value: unicodeReason } });

      fireEvent.click(screen.getByText("Approve & Continue"));

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalledWith(
          "appr-stress-42",
          baseApproval.defaultChoice,
          unicodeWriteIn,
          unicodeReason,
        );
      });
    });

    it("handles adversarial injection payloads and quotes safely", async () => {
      const onApprove = vi.fn(async () => {});
      const onReject = vi.fn(async () => {});

      render(
        <ApprovalModal
          approval={baseApproval}
          onApprove={onApprove}
          onReject={onReject}
        />,
      );

      const adversarialPayload =
        '{"action": "drop_all", "payload": "<script>alert(\'XSS\')</script>", "sql": "\'; DROP TABLE variants; --", "path": "../../../etc/passwd"}';

      const writeInInput = screen.getByPlaceholderText(
        "Custom bullet phrasing or modification...",
      );
      fireEvent.change(writeInInput, { target: { value: adversarialPayload } });

      fireEvent.click(screen.getByText("Approve & Continue"));

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalledWith(
          "appr-stress-42",
          baseApproval.defaultChoice,
          adversarialPayload,
          undefined,
        );
      });
    });

    it("disables buttons while submitting and rejects rapid double-submission", async () => {
      let resolveApproval: () => void = () => {};
      const onApprove = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveApproval = resolve;
          }),
      );

      render(
        <ApprovalModal
          approval={baseApproval}
          onApprove={onApprove}
          onReject={vi.fn(async () => {})}
        />,
      );

      const approveBtn = screen.getByText("Approve & Continue");
      fireEvent.click(approveBtn);

      // Button should now be disabled and show loading indicator
      expect(screen.getByText("Submitting...")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Submitting/i }),
      ).toBeDisabled();

      // Attempt second click while in flight
      fireEvent.click(screen.getByRole("button", { name: /Submitting/i }));

      // onApprove should only have been called once
      expect(onApprove).toHaveBeenCalledTimes(1);

      // Resolve in-flight request
      await act(async () => {
        resolveApproval();
      });
    });
  });

  // =========================================================================
  // 3. Stress Test Diff Review Algorithm (toDisplayDiffRows and lineDiff)
  // =========================================================================
  describe("Diff Review Algorithm Stress", () => {
    it("correctly diffs identical documents (all context, zero adds/dels)", () => {
      const doc = Array.from(
        { length: 500 },
        (_, i) => `Line ${i}: Canonical master bullet`,
      ).join("\n");

      const diff = lineDiff(doc, doc);
      expect(diff.length).toBe(500);
      expect(diff.every((l) => l.type === "context")).toBe(true);

      const stats = diffStats(diff);
      expect(stats.added).toBe(0);
      expect(stats.removed).toBe(0);

      const rows = toDisplayDiffRows(diff);
      expect(rows.length).toBe(500);
      expect(rows.every((r) => r.kind === "context")).toBe(true);
    });

    it("correctly diffs completely disjoint documents without overlap", () => {
      const docA = Array.from({ length: 100 }, (_, i) => `Alpha ${i}`).join(
        "\n",
      );
      const docB = Array.from({ length: 100 }, (_, i) => `Beta ${i}`).join(
        "\n",
      );

      const diff = lineDiff(docA, docB);
      const stats = diffStats(diff);

      expect(stats.removed).toBe(100);
      expect(stats.added).toBe(100);

      const rows = toDisplayDiffRows(diff);
      // Because there are 100 consecutive dels and 100 consecutive adds, none should be a lone pair
      const delRows = rows.filter((r) => r.kind === "del");
      const addRows = rows.filter((r) => r.kind === "add");
      const wordRows = rows.filter((r) => r.kind === "word");

      expect(delRows.length).toBe(100);
      expect(addRows.length).toBe(100);
      expect(wordRows.length).toBe(0);
    });

    it("handles empty and single-sided document inputs cleanly", () => {
      // Both empty
      const emptyDiff = lineDiff("", "");
      expect(emptyDiff).toEqual([]);
      expect(toDisplayDiffRows(emptyDiff)).toEqual([]);
      expect(diffStats(emptyDiff)).toEqual({ added: 0, removed: 0 });

      // Old empty, New populated
      const addDiff = lineDiff("", "Line 1\nLine 2\nLine 3");
      expect(addDiff.length).toBe(3);
      expect(addDiff.every((l) => l.type === "add")).toBe(true);
      expect(diffStats(addDiff)).toEqual({ added: 3, removed: 0 });

      // Old populated, New empty
      const delDiff = lineDiff("Line 1\nLine 2", "");
      expect(delDiff.length).toBe(2);
      expect(delDiff.every((l) => l.type === "del")).toBe(true);
      expect(diffStats(delDiff)).toEqual({ added: 0, removed: 2 });
    });

    it("pairs isolated lone del+add changes into word diffs without misaligning surrounding context", () => {
      const oldDoc = [
        "Header",
        "Bullet 1: Built backend in Python",
        "Bullet 2: Managed MySQL",
        "Footer",
      ].join("\n");

      const newDoc = [
        "Header",
        "Bullet 1: Built backend in Rust",
        "Bullet 2: Managed MySQL",
        "Footer",
      ].join("\n");

      const diff = lineDiff(oldDoc, newDoc);
      const rows = toDisplayDiffRows(diff);

      expect(rows).toEqual([
        { kind: "context", text: "Header" },
        {
          kind: "word",
          oldText: "Bullet 1: Built backend in Python",
          newText: "Bullet 1: Built backend in Rust",
        },
        { kind: "context", text: "Bullet 2: Managed MySQL" },
        { kind: "context", text: "Footer" },
      ]);
    });

    it("survives huge multi-thousand line documents exceeding LCS_LINE_CAP (3000 lines) without freezing", () => {
      // 3,500 lines on each side -> exceeds LCS_LINE_CAP of 3000
      const largeOld = Array.from(
        { length: 3500 },
        (_, i) => `Old Line ${i}`,
      ).join("\n");
      const largeNew = Array.from(
        { length: 3500 },
        (_, i) => `New Line ${i}`,
      ).join("\n");

      const t0 = performance.now();
      const diff = lineDiff(largeOld, largeNew);
      const tDiff = performance.now() - t0;

      // Because it exceeds 3000, whole-block fallback must trigger and execute in under 100ms
      expect(tDiff).toBeLessThan(100);
      expect(diff.length).toBe(7000);

      const t1 = performance.now();
      const rows = toDisplayDiffRows(diff);
      const tRows = performance.now() - t1;

      expect(tRows).toBeLessThan(100);
      expect(rows.length).toBe(7000);

      const stats = diffStats(diff);
      expect(stats.removed).toBe(3500);
      expect(stats.added).toBe(3500);
    });

    it("renders TailoringDiffReview with 10,000 lines without crashing", () => {
      const hugeOld = Array.from(
        { length: 5000 },
        (_, i) => `Old bullet ${i}`,
      ).join("\n");
      const hugeNew = Array.from(
        { length: 5000 },
        (_, i) => `New bullet ${i}`,
      ).join("\n");

      const { container } = render(
        <TailoringDiffReview
          masterContent={hugeOld}
          tailoredContent={hugeNew}
          atsScore={88}
          metricsPreserved={true}
          phasesCompleted={4}
          onAccept={vi.fn(async () => {})}
          onDiscard={vi.fn()}
        />,
      );

      expect(screen.getByText("88% ATS Match")).toBeInTheDocument();
      expect(
        screen.getByText("Metrics Preserved (checkSafe Passed)"),
      ).toBeInTheDocument();
      expect(container.querySelector("table")).toBeInTheDocument();
    });
  });
});
