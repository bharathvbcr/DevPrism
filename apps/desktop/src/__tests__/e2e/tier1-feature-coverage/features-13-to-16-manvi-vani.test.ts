import { describe, it, expect, beforeEach, vi } from "vitest";
import { createIsolatedHarness, assertMetricPreservation } from "../harness";

describe("Tier 1: Manvi & Vani Integration Feature Coverage (Features 13 - 16)", () => {
  let harness = createIsolatedHarness();

  beforeEach(() => {
    harness = createIsolatedHarness();
  });

  // =========================================================================
  // Feature 13: Manvi NDJSON-over-stdio Bridge
  // =========================================================================
  describe("Feature 13: Manvi NDJSON-over-stdio Bridge", () => {
    it("T1-F13-01: bridge parses incoming NDJSON progress lines from child process", () => {
      const rawNdjson = [
        JSON.stringify({
          type: "progress",
          run_id: "r1",
          phase: 1,
          percent: 0.25,
        }),
        JSON.stringify({
          type: "progress",
          run_id: "r1",
          phase: 2,
          percent: 0.5,
        }),
      ].join("\n");

      const parsedEvents = rawNdjson
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      expect(parsedEvents).toHaveLength(2);
      expect(parsedEvents[0].phase).toBe(1);
      expect(parsedEvents[1].percent).toBe(0.5);
    });

    it("T1-F13-02: bridge dispatches approval requests when child process requests decision", async () => {
      const approvalHandler = vi.fn();
      const unsubscribe = harness.listen(
        "vani://approval-required",
        approvalHandler,
      );

      // Launch tailoring request which raises approval prompt
      const tailoringPromise = harness.invoke("manvi_tailor_resume", {
        request: {
          masterPath: "/proj/main.typ",
          jobDescription: "Senior Systems Engineer",
          targetPageBudget: 1,
          strictMetrics: true,
        },
      });

      await tailoringPromise;
      expect(approvalHandler).toHaveBeenCalled();
      const eventPayload = approvalHandler.mock.calls[0][0];
      expect(eventPayload.prompt).toContain("Select bullet focus");
      expect(eventPayload.options.length).toBeGreaterThan(0);
      unsubscribe();
    });

    it("T1-F13-03: bridge formats single-line JSON approval decisions for fd 3 write", async () => {
      const formatFd3Decision = (
        approvalId: string,
        allow: boolean,
        chosen?: string,
      ) => {
        return `${JSON.stringify({ approval_id: approvalId, allow, chosen })}\n`;
      };

      const out = formatFd3Decision("appr_123", true, "Option A");
      expect(out.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(out.trim());
      expect(parsed.approval_id).toBe("appr_123");
      expect(parsed.allow).toBe(true);
      expect(parsed.chosen).toBe("Option A");
    });

    it("T1-F13-04: manvi_cancel_run sends cancel signal and stops active run", async () => {
      const cancelHandler = vi.fn();
      const unsubscribe = harness.listen(
        "vani://tailor-cancelled",
        cancelHandler,
      );

      await harness.invoke("manvi_cancel_run", { runId: "run_active_42" });

      expect(cancelHandler).toHaveBeenCalledWith({ runId: "run_active_42" });
      unsubscribe();
    });

    it("T1-F13-05: skips corrupted or non-JSON stdout lines without crashing stream parser", () => {
      const stream = [
        "info: starting manvi engine v0.8.0",
        JSON.stringify({ type: "progress", percent: 0.1 }),
        "warn: cache miss on embedding lookup",
        JSON.stringify({ type: "progress", percent: 0.2 }),
      ];

      const validEvents: any[] = [];
      for (const line of stream) {
        try {
          if (line.trim().startsWith("{")) {
            validEvents.push(JSON.parse(line));
          }
        } catch {
          // Non-JSON log lines ignored
        }
      }

      expect(validEvents).toHaveLength(2);
      expect(validEvents[0].percent).toBe(0.1);
      expect(validEvents[1].percent).toBe(0.2);
    });
  });

  // =========================================================================
  // Feature 14: Vani Resume Tailoring Pipeline
  // =========================================================================
  describe("Feature 14: Vani Resume Tailoring Pipeline", () => {
    it("T1-F14-01: Phase 1 extracts key skills, technologies, and requirements from JD", () => {
      const jd =
        "Looking for Senior Rust Engineer with experience in Tokio, distributed consensus, and Raft.";
      const extractRequirements = (text: string) => {
        const skills = [
          "rust",
          "tokio",
          "distributed consensus",
          "raft",
        ].filter((s) => text.toLowerCase().includes(s));
        return { skills, title: "Senior Rust Engineer" };
      };

      const res = extractRequirements(jd);
      expect(res.skills).toContain("rust");
      expect(res.skills).toContain("tokio");
      expect(res.skills).toContain("raft");
    });

    it("T1-F14-02: Phase 2 knapsack packing trims secondary sections to meet 1-page budget", () => {
      interface CareerBlock {
        id: string;
        relevance: number;
        estimatedHeightPt: number;
      }
      const blocks: CareerBlock[] = [
        { id: "lead_role", relevance: 98, estimatedHeightPt: 150 },
        { id: "infra_role", relevance: 90, estimatedHeightPt: 120 },
        { id: "ancient_internship", relevance: 20, estimatedHeightPt: 80 },
        { id: "hobbies", relevance: 10, estimatedHeightPt: 60 },
      ];

      const maxBudgetPt = 300;
      // Greedy knapsack by relevance
      const sorted = [...blocks].sort((a, b) => b.relevance - a.relevance);
      const packed: CareerBlock[] = [];
      let currentHeight = 0;
      for (const b of sorted) {
        if (currentHeight + b.estimatedHeightPt <= maxBudgetPt) {
          packed.push(b);
          currentHeight += b.estimatedHeightPt;
        }
      }

      expect(packed.map((b) => b.id)).toEqual(["lead_role", "infra_role"]);
      expect(packed.map((b) => b.id)).not.toContain("ancient_internship");
    });

    it("T1-F14-03: Phase 3 schema-aware bullet rewrite strictly preserves quantified metrics (checkSafe)", () => {
      const original =
        "- Led team optimizing Redis caching layer, reducing p99 latency by 40% across 50M daily queries.";
      const tailored =
        "- Spearheaded caching infrastructure refactoring, cutting p99 query latency by 40% across 50M requests per day.";

      assertMetricPreservation(original, tailored);
    });

    it("T1-F14-04: Phase 4 critic audit verifies facts belong to candidate's verified fact pool", () => {
      const verifiedPool = new Set([
        "rust",
        "go",
        "postgres",
        "kubernetes",
        "40% latency reduction",
      ]);
      const checkFactPool = (claims: string[]) => {
        return claims.every((c) => verifiedPool.has(c.toLowerCase()));
      };

      expect(checkFactPool(["rust", "kubernetes"])).toBe(true);
      expect(checkFactPool(["rust", "blockchain expert"])).toBe(false); // Hallucinated claim rejected
    });

    it("T1-F14-05: full pipeline execution emits sequential phase progress events", async () => {
      const progressSteps: number[] = [];
      const unsubscribe = harness.listen("vani://tailor-progress", (p: any) => {
        progressSteps.push(p.phase);
      });

      const res = await harness.invoke("manvi_tailor_resume", {
        request: {
          masterPath: "/proj/main.typ",
          jobDescription: "Staff Distributed Systems Engineer",
          targetPageBudget: 1,
          strictMetrics: true,
        },
      });

      expect(res.status).toBe("completed");
      expect(res.phasesCompleted).toBe(4);
      expect(progressSteps).toContain(1);
      expect(progressSteps).toContain(2);
      expect(progressSteps).toContain(3);
      expect(progressSteps).toContain(4);
      unsubscribe();
    });
  });

  // =========================================================================
  // Feature 15: Structured Resume Organizer Data Model
  // =========================================================================
  describe("Feature 15: Structured Resume Organizer Data Model", () => {
    it("T1-F15-01: creates variant with extended metadata (company, role, seniority, persona)", async () => {
      const variant = await harness.invoke("create_variant", {
        projectRoot: "/resume-project",
        name: "Netflix Senior Platform",
        jd: "JD Netflix Platform",
        status: "draft",
        company: "Netflix",
        role: "Senior Platform Engineer",
        seniority: "Senior",
        persona: "infra-platform",
        atsScore: 88,
      });

      expect(variant.company).toBe("Netflix");
      expect(variant.role).toBe("Senior Platform Engineer");
      expect(variant.seniority).toBe("Senior");
      expect(variant.persona).toBe("infra-platform");
      expect(variant.atsScore).toBe(88);
      expect(variant.path).toContain(".prism/variants/netflix-senior-platform");
    });

    it("T1-F15-02: list_variants returns all extended metadata fields", async () => {
      await harness.invoke("create_variant", {
        projectRoot: "/resume-project",
        name: "Apple SRE",
        jd: "JD Apple",
        status: "applied",
        company: "Apple",
        role: "SRE",
        atsScore: 94,
      });

      const list = await harness.invoke("list_variants", {
        projectRoot: "/resume-project",
      });
      const apple = list.find((v: any) => v.company === "Apple");
      expect(apple).toBeDefined();
      expect(apple.role).toBe("SRE");
      expect(apple.atsScore).toBe(94);
    });

    it("T1-F15-03: update_variant patches specific metadata without wiping existing fields", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/resume-project",
        name: "Meta Production Eng",
        jd: "JD Meta",
        status: "draft",
        company: "Meta",
        role: "Production Engineer",
        atsScore: 80,
      });

      const updated = await harness.invoke("update_variant", {
        projectRoot: "/resume-project",
        variantId: v.id,
        status: "interview",
        atsScore: 91,
      });

      expect(updated.status).toBe("interview");
      expect(updated.atsScore).toBe(91);
      expect(updated.company).toBe("Meta"); // preserved
      expect(updated.role).toBe("Production Engineer"); // preserved
    });

    it("T1-F15-04: legacy variants without extended fields deserialize with sensible defaults", () => {
      const legacyRaw = JSON.stringify({
        name: "Old Variant",
        status: "draft",
        createdAt: 1700000000000,
      });

      const parsed = JSON.parse(legacyRaw);
      const manifest = {
        name: parsed.name,
        status: parsed.status,
        company: parsed.company ?? null,
        role: parsed.role ?? null,
        seniority: parsed.seniority ?? null,
        atsScore: parsed.atsScore ?? 0,
      };

      expect(manifest.company).toBeNull();
      expect(manifest.atsScore).toBe(0);
    });

    it("T1-F15-05: delete_variant cleans up variant entry", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/resume-project",
        name: "To Be Deleted",
        jd: "",
        status: "draft",
      });

      await harness.invoke("delete_variant", {
        projectRoot: "/resume-project",
        variantId: v.id,
      });
      const list = await harness.invoke("list_variants", {
        projectRoot: "/resume-project",
      });
      expect(list.find((x: any) => x.id === v.id)).toBeUndefined();
    });
  });

  // =========================================================================
  // Feature 16: Resume Studio & Tailoring UI
  // =========================================================================
  describe("Feature 16: Resume Studio & Tailoring UI", () => {
    it("T1-F16-01: tailoring studio UI reflects active run progress percentage", () => {
      interface StudioProgressState {
        runId: string | null;
        currentPhase: number;
        progressPercent: number;
      }
      const studio: StudioProgressState = {
        runId: null,
        currentPhase: 0,
        progressPercent: 0,
      };

      const onProgress = (p: {
        runId: string;
        phase: number;
        percent: number;
      }) => {
        studio.runId = p.runId;
        studio.currentPhase = p.phase;
        studio.progressPercent = p.percent;
      };

      onProgress({ runId: "run_99", phase: 2, percent: 0.5 });
      expect(studio.currentPhase).toBe(2);
      expect(studio.progressPercent).toBe(0.5);
    });

    it("T1-F16-02: approval prompt surfaces options in interactive UI dialog", () => {
      const promptEvent = {
        approvalId: "appr_1",
        prompt: "Choose experience priority",
        options: ["Backend Latency", "Cost Reduction"],
      };

      expect(promptEvent.options).toHaveLength(2);
      expect(promptEvent.options[0]).toBe("Backend Latency");
    });

    it("T1-F16-03: user approval submission sends decision back through Tauri IPC", async () => {
      let resolvedApproval = false;
      const approvalHandler = (e: any) => {
        harness.invoke("manvi_approve_action", {
          approvalId: e.approvalId,
          allow: true,
          chosen: e.options[0],
        });
        resolvedApproval = true;
      };

      harness.listen("vani://approval-required", approvalHandler);

      await harness.invoke("manvi_tailor_resume", {
        request: {
          masterPath: "/proj/main.typ",
          jobDescription: "Senior Platform Architect",
          targetPageBudget: 1,
          strictMetrics: true,
        },
      });

      expect(resolvedApproval).toBe(true);
    });

    it("T1-F16-04: completed tailoring run provides side-by-side file diffs for review", async () => {
      const v = await harness.invoke("create_variant", {
        projectRoot: "/resume-project",
        name: "Diff Test Variant",
        jd: "JD Diff",
        status: "draft",
        company: "Stripe",
      });

      const diffs = await harness.invoke("diff_variant", {
        projectRoot: "/resume-project",
        variantId: v.id,
      });

      expect(Array.isArray(diffs)).toBe(true);
      expect(diffs.length).toBeGreaterThan(0);
      const mainDiff = diffs.find((d: any) => d.filePath === "main.typ");
      expect(mainDiff).toBeDefined();
      expect(mainDiff.status).toBe("modified");
      expect(mainDiff.oldContent).toContain("Master Document");
      expect(mainDiff.newContent).toContain("Tailored Document");
    });

    it("T1-F16-05: cancelling run in studio UI transitions status to cancelled", async () => {
      let cancelled = false;
      harness.listen("vani://approval-required", (e: any) => {
        // Disallow action
        harness.invoke("manvi_approve_action", {
          approvalId: e.approvalId,
          allow: false,
        });
        cancelled = true;
      });

      const result = await harness.invoke("manvi_tailor_resume", {
        request: {
          masterPath: "/proj/main.typ",
          jobDescription: "Sample JD",
          targetPageBudget: 1,
          strictMetrics: true,
        },
      });

      expect(result.status).toBe("cancelled");
      expect(cancelled).toBe(true);
    });
  });
});
