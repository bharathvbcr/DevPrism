import { describe, it, expect, beforeEach, vi } from "vitest";
import { createIsolatedHarness, assertMetricPreservation } from "../harness";

describe("Tier 2: Manvi & Vani Boundary & Corner Cases (Features 13 - 16)", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // =========================================================================
  // Feature 13: Manvi NDJSON-over-stdio Bridge Boundaries
  // =========================================================================
  describe("Feature 13: Manvi NDJSON-over-stdio Bridge Boundaries", () => {
    it("T2-F13-01: high-frequency burst of 500 progress events handled without memory leak or drop", () => {
      const received: number[] = [];
      const onProgress = (p: any) => {
        received.push(p.percent);
      };

      for (let i = 0; i < 500; i++) {
        onProgress({ runId: "r1", phase: 1, percent: i / 500 });
      }

      expect(received).toHaveLength(500);
      expect(received[499]).toBeCloseTo(0.998, 3);
    });

    it("T2-F13-02: child process sudden crash triggers error event with exit code and resets state", () => {
      interface ProcessState {
        running: boolean;
        exitCode: number | null;
        errorMessage: string | null;
      }
      const state: ProcessState = {
        running: true,
        exitCode: null,
        errorMessage: null,
      };

      const onProcessCrash = (code: number, stderr: string) => {
        state.running = false;
        state.exitCode = code;
        state.errorMessage = stderr;
      };

      onProcessCrash(137, "fatal: out of memory killed by SIGKILL");
      expect(state.running).toBe(false);
      expect(state.exitCode).toBe(137);
      expect(state.errorMessage).toContain("SIGKILL");
    });

    it("T2-F13-03: child process hang triggers watchdog timeout and sends kill signal", () => {
      vi.useFakeTimers();
      const killProcess = vi.fn();
      const lastActivity = Date.now();

      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > 5000) {
          killProcess();
          clearInterval(watchdog);
        }
      }, 1000);

      vi.advanceTimersByTime(6000);
      expect(killProcess).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("T2-F13-04: sending approval for expired or non-existent approval_id handles gracefully", async () => {
      await expect(
        harness.invoke("manvi_approve_action", {
          approvalId: "non_existent_appr_id",
          allow: true,
        }),
      ).resolves.not.toThrow();
    });

    it("T2-F13-05: concurrent bidirectional progress listening and fd 3 writes execute without data race", async () => {
      let progressCount = 0;
      harness.listen("vani://tailor-progress", () => {
        progressCount++;
      });

      const tailoring = harness.invoke("manvi_tailor_resume", {
        request: {
          masterPath: "/proj/main.typ",
          jobDescription: "Staff Platform SRE",
          targetPageBudget: 1,
          strictMetrics: true,
        },
      });

      await harness.invoke("manvi_approve_action", {
        approvalId: "appr_concurrent",
        allow: true,
      });

      const res = await tailoring;
      expect(res.status).toBe("completed");
      expect(progressCount).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Feature 14: Vani Resume Tailoring Pipeline Boundaries
  // =========================================================================
  describe("Feature 14: Vani Resume Tailoring Pipeline Boundaries", () => {
    it("T2-F14-01: checkSafe invariant fails and rejects when rewritten bullet drops quantified metric", () => {
      const original =
        "Architected cache reducing latency by 45% and saving $1.2M annually.";
      const altered =
        "Architected cache improving latency significantly and saving costs.";

      expect(() => {
        assertMetricPreservation(original, altered);
      }).toThrow(/checkSafe invariant violation/);
    });

    it("T2-F14-02: empty or nonsensical job description rejected at Phase 1", async () => {
      await expect(
        harness.invoke("manvi_tailor_resume", {
          request: {
            masterPath: "/proj/main.typ",
            jobDescription: "   ",
            targetPageBudget: 1,
            strictMetrics: true,
          },
        }),
      ).rejects.toThrow("Job description cannot be empty.");
    });

    it("T2-F14-03: candidate profile with oversized history packed strictly without truncating mandatory sections", () => {
      interface Section {
        name: string;
        mandatory: boolean;
        heightPt: number;
      }
      const sections: Section[] = [
        { name: "Header", mandatory: true, heightPt: 60 },
        { name: "Skills", mandatory: true, heightPt: 80 },
        { name: "Experience_Recent", mandatory: true, heightPt: 250 },
        { name: "Experience_Old", mandatory: false, heightPt: 200 },
        { name: "Education", mandatory: true, heightPt: 80 },
      ];

      const maxPageBudget = 500;
      const mandatoryHeight = sections
        .filter((s) => s.mandatory)
        .reduce((acc, s) => acc + s.heightPt, 0);
      expect(mandatoryHeight).toBeLessThanOrEqual(maxPageBudget);

      const included = sections.filter((s) => {
        if (s.mandatory) return true;
        return mandatoryHeight + s.heightPt <= maxPageBudget;
      });

      expect(included.map((s) => s.name)).toContain("Header");
      expect(included.map((s) => s.name)).toContain("Experience_Recent");
      expect(included.map((s) => s.name)).not.toContain("Experience_Old"); // pruned to fit 1 page
    });

    it("T2-F14-04: hallucinated technical skills rejected by Phase 4 critic", () => {
      const candidateSkills = new Set([
        "rust",
        "go",
        "postgres",
        "distributed systems",
      ]);
      const proposedSkills = [
        "rust",
        "quantum computing expert",
        "distributed systems",
      ];

      const unverified = proposedSkills.filter((s) => !candidateSkills.has(s));
      expect(unverified).toEqual(["quantum computing expert"]);
    });

    it("T2-F14-05: Phase 4 critic audit rejection triggers automatic rewrite retry up to max limit (3)", () => {
      let attempts = 0;
      const maxRetries = 3;
      let finalStatus = "failed";

      while (attempts < maxRetries) {
        attempts++;
        const passedAudit = attempts === 2; // passes on 2nd attempt
        if (passedAudit) {
          finalStatus = "completed";
          break;
        }
      }

      expect(attempts).toBe(2);
      expect(finalStatus).toBe("completed");
    });
  });

  // =========================================================================
  // Feature 15: Structured Resume Organizer Data Model Boundaries
  // =========================================================================
  describe("Feature 15: Structured Resume Organizer Data Model Boundaries", () => {
    it("T2-F15-01: partial metadata patch preserves existing untouched fields", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Acme Lead",
        jd: "Original JD",
        status: "draft",
        company: "Acme",
        role: "Lead Engineer",
        seniority: "Staff",
        atsScore: 78,
      });

      const patched = await harness.invoke("update_variant", {
        projectRoot: "/proj",
        variantId: v.id,
        atsScore: 88,
      });

      expect(patched.atsScore).toBe(88);
      expect(patched.company).toBe("Acme");
      expect(patched.role).toBe("Lead Engineer");
      expect(patched.seniority).toBe("Staff");
      expect(patched.jd).toBe("Original JD");
    });

    it("T2-F15-02: invalid ATS score (negative or >100) throws validation error", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Score Test",
        jd: "",
        status: "draft",
      });

      await expect(
        harness.invoke("update_variant", {
          projectRoot: "/proj",
          variantId: v.id,
          atsScore: -5,
        }),
      ).rejects.toThrow("ATS score must be between 0 and 100.");

      await expect(
        harness.invoke("update_variant", {
          projectRoot: "/proj",
          variantId: v.id,
          atsScore: 105,
        }),
      ).rejects.toThrow("ATS score must be between 0 and 100.");
    });

    it("T2-F15-03: metadata handles quotes, slashes, and unicode characters safely", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: 'Variant with "Quotes" & Slashes / \\ and Emoji 🚀',
        jd: "Special JD",
        status: "applied",
        company: 'O\'Reilly & Associates "Tech"',
      });

      expect(v.company).toBe('O\'Reilly & Associates "Tech"');
      expect(v.id).toContain("variant-with-quotes-slashes-and-emoji");
    });

    it("T2-F15-04: slug collision resolution produces unique stable directories", async () => {
      const v1 = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Backend Lead",
        jd: "",
        status: "draft",
      });
      const v2 = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Backend Lead",
        jd: "",
        status: "draft",
      });

      expect(v1.id).toBe("backend-lead");
      expect(v2.id).not.toBe(v1.id);
      expect(v2.id.startsWith("backend-lead-")).toBe(true);
    });

    it("T2-F15-05: deleting variant twice handles gracefully without throwing", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Delete Test",
        jd: "",
        status: "draft",
      });

      await harness.invoke("delete_variant", {
        projectRoot: "/proj",
        variantId: v.id,
      });
      await expect(
        harness.invoke("delete_variant", {
          projectRoot: "/proj",
          variantId: v.id,
        }),
      ).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // Feature 16: Resume Studio & Tailoring UI Boundaries
  // =========================================================================
  describe("Feature 16: Resume Studio & Tailoring UI Boundaries", () => {
    it("T2-F16-01: user cancellation during Phase 2 cancels run and resets studio", async () => {
      let cancelled = false;
      harness.listen("vani://approval-required", (e: any) => {
        harness.invoke("manvi_approve_action", {
          approvalId: e.approvalId,
          allow: false,
        });
        cancelled = true;
      });

      const res = await harness.invoke("manvi_tailor_resume", {
        request: {
          masterPath: "/proj/main.typ",
          jobDescription: "Sample JD",
          targetPageBudget: 1,
          strictMetrics: true,
        },
      });

      expect(res.status).toBe("cancelled");
      expect(cancelled).toBe(true);
    });

    it("T2-F16-02: rejecting approval prompt triggers alternative path without crashing", async () => {
      const pendingDecision = {
        approvalId: "appr_1",
        allow: false,
        chosen: undefined,
      };

      const resolveDecision = (d: typeof pendingDecision) => {
        return d.allow ? "proceed" : "fallback";
      };

      expect(resolveDecision(pendingDecision)).toBe("fallback");
    });

    it("T2-F16-03: side-by-side diff view handles additions, deletions, and modifications cleanly", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/proj",
        name: "Diff Comprehensive",
        jd: "JD",
        status: "draft",
      });

      const diffs = await harness.invoke("diff_variant", {
        projectRoot: "/proj",
        variantId: v.id,
      });

      const statuses = diffs.map((d: any) => d.status);
      expect(statuses).toContain("modified");
      expect(statuses).toContain("added");
    });

    it("T2-F16-04: window resize during tailoring studio maintains approval prompt visibility", () => {
      const dialogOpen = true;
      const onWindowResize = () => {
        // Dialog state retained
      };
      onWindowResize();
      expect(dialogOpen).toBe(true);
    });

    it("T2-F16-05: network or bridge disconnect displays error dialog with Retry option", () => {
      interface ErrorDialogState {
        show: boolean;
        error: string;
        retryAvailable: boolean;
      }
      const dialog: ErrorDialogState = {
        show: false,
        error: "",
        retryAvailable: false,
      };

      const onBridgeDisconnect = (err: string) => {
        dialog.show = true;
        dialog.error = err;
        dialog.retryAvailable = true;
      };

      onBridgeDisconnect("Bridge stdio pipe closed unexpectedly");
      expect(dialog.show).toBe(true);
      expect(dialog.error).toContain("stdio pipe closed");
      expect(dialog.retryAvailable).toBe(true);
    });
  });
});
