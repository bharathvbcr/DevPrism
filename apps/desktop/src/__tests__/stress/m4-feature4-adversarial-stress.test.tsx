import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { ResumeOrganizerPanel } from "@/components/workspace/resume-organizer/resume-organizer-panel";
import { BindJdDialog } from "@/components/workspace/resume-organizer/bind-jd-dialog";
import { CreateVariantDialog } from "@/components/workspace/resume-organizer/create-variant-dialog";
import { EditVariantDialog } from "@/components/workspace/resume-organizer/edit-variant-dialog";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import { useDocumentStore } from "@/stores/document-store";
import { useEditorTabsStore } from "@/stores/editor-tabs-store";
import type { VariantInfo } from "@/lib/tauri/variants";
import * as careerApi from "@/lib/career";

let mockTauriVariants: VariantInfo[] = [];
let mockInvokeReject: Error | null = null;

// Mock Tauri invoke and event listeners
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (mockInvokeReject) {
      throw mockInvokeReject;
    }
    if (cmd === "variant_list" || cmd === "list_variants") {
      return mockTauriVariants;
    }
    if (cmd === "variant_get") {
      const found = mockTauriVariants.find((v) => v.id === args.variantId);
      if (!found) throw new Error("Variant not found");
      return found;
    }
    if (cmd === "variant_bind_jd") {
      const idx = mockTauriVariants.findIndex((v) => v.id === args.variantId);
      if (idx === -1) throw new Error("Variant not found");
      const updated = {
        ...mockTauriVariants[idx],
        jd: args.jdText,
        company: args.company || mockTauriVariants[idx].company,
        role: args.role || mockTauriVariants[idx].role,
        updatedAt: Date.now(),
      };
      mockTauriVariants[idx] = updated;
      return updated;
    }
    if (cmd === "variant_update") {
      const idx = mockTauriVariants.findIndex((v) => v.id === args.variantId);
      if (idx === -1) throw new Error("Variant not found");
      const updated = {
        ...mockTauriVariants[idx],
        name: args.name ?? mockTauriVariants[idx].name,
        company: args.company ?? mockTauriVariants[idx].company,
        role: args.role ?? mockTauriVariants[idx].role,
        seniority: args.seniority ?? mockTauriVariants[idx].seniority,
        status: args.status ?? mockTauriVariants[idx].status,
        atsScore:
          args.atsScore !== null
            ? args.atsScore
            : mockTauriVariants[idx].atsScore,
        updatedAt: Date.now(),
      };
      mockTauriVariants[idx] = updated;
      return updated;
    }
    if (cmd === "variant_create") {
      const newVar: VariantInfo = {
        id: args.name.toLowerCase().replace(/\s+/g, "-"),
        name: args.name,
        status: args.status || "draft",
        jd: args.jd || "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        path: `${args.projectRoot}/.prism/variants/${args.name}`,
        company: args.company,
        role: args.role,
        seniority: args.seniority,
        atsScore: args.atsScore,
      };
      mockTauriVariants.push(newVar);
      return newVar;
    }
    if (cmd === "variant_delete") {
      mockTauriVariants = mockTauriVariants.filter(
        (v) => v.id !== args.variantId,
      );
      return null;
    }
    if (cmd === "career_list_runs") return [];
    if (cmd === "career_list_personas") return [];
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// Generator for N variants
function generateVariants(count: number): VariantInfo[] {
  const statuses = [
    "draft",
    "applied",
    "interview",
    "archived",
    "offer",
    "rejected",
  ];
  const companies = [
    "Google",
    "Stripe",
    "Datadog",
    "Meta",
    "Amazon",
    "Apple",
    "Netflix",
    "Microsoft",
  ];
  const roles = [
    "Staff SRE",
    "Backend Lead",
    "Infra Eng",
    "Platform Architect",
    "Principal SWE",
  ];
  const seniorities: ("ic" | "senior" | "lead" | "manager" | "director")[] = [
    "ic",
    "senior",
    "lead",
    "manager",
    "director",
  ];

  return Array.from({ length: count }, (_, i) => {
    const company = companies[i % companies.length];
    const role = roles[i % roles.length];
    const status = statuses[i % statuses.length];
    const seniority = seniorities[i % seniorities.length];
    return {
      id: `variant-${i + 1}-${company.toLowerCase()}`,
      name: `${company} ${role} #${i + 1}`,
      status,
      jd: `Target job description for ${company} ${role} requirements #${i + 1}.`,
      createdAt: Date.now() - (count - i) * 3600000,
      updatedAt: Date.now() - i * 60000,
      path: `/projects/resume/.prism/variants/variant-${i + 1}`,
      company,
      role,
      seniority,
      atsScore:
        i % 5 === 0 ? undefined : Math.min(100, Math.max(0, 50 + (i % 51))),
    };
  });
}

describe("Milestone 4 Feature 4 Adversarial Stress Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvokeReject = null;
    mockTauriVariants = [];

    useEditorTabsStore.getState().resetTabs();

    useDocumentStore.setState({
      projectRoot: "/projects/resume",
      files: [
        {
          id: "main.typ",
          name: "main.typ",
          relativePath: "main.typ",
          absolutePath: "/projects/resume/main.typ",
          content: "= Master Resume Document\n- Experienced Platform Engineer",
          type: "typst",
          isDirty: false,
        },
      ],
      activeFileId: "main.typ",
      saveAllFiles: vi.fn(async () => {}),
      openProject: vi.fn(async (target: string) => {
        useDocumentStore.setState({
          projectRoot: target,
          files: [
            {
              id: `${target}/main.typ`,
              name: "main.typ",
              relativePath: "main.typ",
              absolutePath: `${target}/main.typ`,
              content: `= Tailored Resume for ${target}\n- Specific bullet`,
              type: "typst",
              isDirty: false,
            },
          ],
          activeFileId: `${target}/main.typ`,
        });
      }),
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

  afterEach(() => {
    useEditorTabsStore.getState().resetTabs();
  });

  // =========================================================================
  // 1. HIGH-SCALE RENDERING, EMPTY STATE, SEARCH & FILTER STRESS
  // =========================================================================
  describe("1. Variant List Rendering at Scale & Boundary Conditions", () => {
    it("renders empty state boundary condition with verbatim E2E message", async () => {
      mockTauriVariants = [];
      render(<ResumeOrganizerPanel />);

      await waitFor(() => {
        expect(
          screen.getByText(
            "No resume variants created yet. Create one from master.",
          ),
        ).toBeInTheDocument();
      });

      // Master source card is visible
      expect(screen.getByText("Master Resume")).toBeInTheDocument();
      expect(screen.getByText("Canonical")).toBeInTheDocument();
      expect(screen.getByText("Create Variant")).toBeInTheDocument();
      expect(screen.getByText("Tailor with Manvi")).toBeInTheDocument();
    });

    it("renders loading state spinner when loading is true and variants are empty", async () => {
      useResumeVariantsStore.setState({
        variants: [],
        loading: true,
      });

      render(<ResumeOrganizerPanel />);

      expect(screen.getByText("Loading variants...")).toBeInTheDocument();
      expect(
        screen.queryByText(
          "No resume variants created yet. Create one from master.",
        ),
      ).toBeNull();
    });

    it("renders 60+ variants cleanly without DOM explosion or frame drops", async () => {
      const manyVariants = generateVariants(65);
      mockTauriVariants = [...manyVariants];
      useResumeVariantsStore.setState({
        variants: manyVariants,
        selectedVariant: manyVariants[0],
      });

      render(<ResumeOrganizerPanel />);

      await waitFor(() => {
        expect(screen.getByText(manyVariants[0].name)).toBeInTheDocument();
      });

      // All 65 variants should be counted in header
      expect(screen.getByText("65")).toBeInTheDocument();

      // Check random samples across beginning, middle, and end of list
      expect(screen.getByText(manyVariants[30].name)).toBeInTheDocument();
      expect(screen.getByText(manyVariants[64].name)).toBeInTheDocument();

      // Check unscored variants handle gracefully (displaying "Unscored")
      const unscoredCount = manyVariants.filter(
        (v) => v.atsScore === undefined,
      ).length;
      const unscoredBadges = screen.getAllByText("Unscored");
      expect(unscoredBadges.length).toBe(unscoredCount);
    });

    it("filters 100 variants rapidly across search query and status dropdown", async () => {
      const hundredVariants = generateVariants(100);
      mockTauriVariants = [...hundredVariants];
      useResumeVariantsStore.setState({
        variants: hundredVariants,
        selectedVariant: hundredVariants[0],
      });

      render(<ResumeOrganizerPanel />);

      await waitFor(() => {
        expect(screen.getByText("100")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search variants...");

      // 1. Search by specific company
      fireEvent.change(searchInput, { target: { value: "Netflix" } });
      const netflixExpected = hundredVariants.filter(
        (v) => v.company === "Netflix",
      ).length;
      expect(screen.getByText(`${netflixExpected} of 100`)).toBeInTheDocument();

      // 2. Search with adversarial / regex chars (e.g. '[', '*', '(', '\')
      fireEvent.change(searchInput, {
        target: { value: "[.*+?^${}()|[path\\]" },
      });
      expect(
        screen.getByText("No variants match the current filters."),
      ).toBeInTheDocument();

      // 3. Clear search and test case-insensitivity
      fireEvent.change(searchInput, { target: { value: "STRIPE" } });
      const stripeExpected = hundredVariants.filter((v) =>
        v.company?.toLowerCase().includes("stripe"),
      ).length;
      expect(screen.getByText(`${stripeExpected} of 100`)).toBeInTheDocument();

      // 4. Test rapid typing simulation (50 sequential search events)
      for (let i = 0; i < 50; i++) {
        fireEvent.change(searchInput, {
          target: { value: `Google #${i % 10}` },
        });
      }
      // Should not throw or crash
      expect(searchInput).toBeInTheDocument();
    });

    it("handles variant with missing or extreme metadata without crashing", async () => {
      const malformedVariants: VariantInfo[] = [
        {
          id: "empty-meta",
          name: "Minimalist Variant",
          status: "unknown-status",
          jd: "",
          createdAt: 0,
          updatedAt: 0,
          path: "/path",
          company: undefined,
          role: undefined,
          seniority: undefined,
          atsScore: 0, // Score 0 boundary
        },
        {
          id: "score-100",
          name: "Perfect Variant",
          status: "applied",
          jd: "x ".repeat(1000), // Massive JD
          createdAt: Date.now(),
          path: "/path/2",
          atsScore: 100, // Score 100 boundary
        },
      ];

      mockTauriVariants = [...malformedVariants];
      useResumeVariantsStore.setState({
        variants: malformedVariants,
        selectedVariant: malformedVariants[0],
      });

      render(<ResumeOrganizerPanel />);

      await waitFor(() => {
        expect(screen.getByText("Minimalist Variant")).toBeInTheDocument();
      });

      // Score 0 should render "0% ATS", not "Unscored"
      expect(screen.getByText("0% ATS")).toBeInTheDocument();
      // Score 100 should render "100% ATS"
      expect(screen.getByText("100% ATS")).toBeInTheDocument();
      // Massive JD word count
      expect(screen.getByText("1000w JD")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 2. RAPID VARIANT SWITCHING & CONCURRENCY / RACE CONDITION STRESS
  // =========================================================================
  describe("2. Rapid Variant Switching & Editor Tabs Concurrency", () => {
    it("cleans up editor tabs and leaves zero stale handles after switching", async () => {
      const variants = generateVariants(3);
      useResumeVariantsStore.setState({
        ownerRoot: "/projects/resume",
        activeVariantId: null,
        variants,
      });

      const tabsStore = useEditorTabsStore.getState();
      // Simulate opening 4 tabs in the master document, 1 dirty
      tabsStore.openTab({
        id: "main.typ",
        path: "main.typ",
        title: "main.typ",
      });
      tabsStore.openTab({
        id: "resume.typ",
        path: "resume.typ",
        title: "resume.typ",
      });
      tabsStore.openTab({
        id: "extra.typ",
        path: "extra.typ",
        title: "extra.typ",
      });
      tabsStore.setDirty("extra.typ", true);

      expect(useEditorTabsStore.getState().tabs).toHaveLength(3);
      expect(useEditorTabsStore.getState().dirtyTabIds).toHaveLength(1);

      // Switch to variant 1
      await useResumeVariantsStore.getState().switchTo(variants[0].id);

      // Verify that tabs were cleanly reset and populated ONLY with variant 1's main file
      const updatedTabs = useEditorTabsStore.getState().tabs;
      expect(updatedTabs).toHaveLength(1);
      expect(updatedTabs[0].id).toBe(`${variants[0].path}/main.typ`);
      expect(useEditorTabsStore.getState().dirtyTabIds).toHaveLength(0);
      expect(useEditorTabsStore.getState().activeTabId).toBe(
        `${variants[0].path}/main.typ`,
      );

      // Verify document store active file
      expect(useDocumentStore.getState().activeFileId).toBe(
        `${variants[0].path}/main.typ`,
      );
    });

    it("survives rapid consecutive switchTo calls across variants and master", async () => {
      const variants = generateVariants(5);
      useResumeVariantsStore.setState({
        ownerRoot: "/projects/resume",
        activeVariantId: null,
        variants,
      });

      const store = useResumeVariantsStore.getState();

      // Rapidly call switchTo in sequential succession
      for (const v of variants) {
        await store.switchTo(v.id);
        expect(useResumeVariantsStore.getState().activeVariantId).toBe(v.id);
        const tabs = useEditorTabsStore.getState().tabs;
        expect(tabs).toHaveLength(1);
        expect(tabs[0].id).toBe(`${v.path}/main.typ`);
      }

      // Switch back to master (variantId = null)
      await store.switchTo(null);
      expect(useResumeVariantsStore.getState().activeVariantId).toBeNull();
      const masterTabs = useEditorTabsStore.getState().tabs;
      expect(masterTabs).toHaveLength(1);
      expect(masterTabs[0].id).toBe("/projects/resume/main.typ");
    });

    it("drops concurrent overlapping switchTo calls safely via switching lock", async () => {
      const variants = generateVariants(4);
      useResumeVariantsStore.setState({
        ownerRoot: "/projects/resume",
        activeVariantId: null,
        variants,
      });

      let slowOpenResolve: (() => void) | null = null;
      useDocumentStore.setState({
        openProject: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              slowOpenResolve = resolve;
            }),
        ),
      });

      const store = useResumeVariantsStore.getState();

      // Launch first switch (in-flight)
      const promise1 = store.switchTo(variants[0].id);
      expect(useResumeVariantsStore.getState().switching).toBe(true);

      // Attempt second switch while first is in-flight
      const promise2 = store.switchTo(variants[1].id);

      // Second switch should return immediately because switching is locked
      await promise2;

      // Wait until slowOpenResolve is assigned inside openProject
      while (!slowOpenResolve) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Finish first switch
      act(() => {
        slowOpenResolve!();
      });
      await promise1;

      expect(useResumeVariantsStore.getState().switching).toBe(false);
      expect(useResumeVariantsStore.getState().activeVariantId).toBe(
        variants[0].id,
      );
    });

    it("resets switching flag safely when openProject throws an error", async () => {
      const variants = generateVariants(2);
      useResumeVariantsStore.setState({
        ownerRoot: "/projects/resume",
        activeVariantId: null,
        variants,
      });

      useDocumentStore.setState({
        openProject: vi.fn(async () => {
          throw new Error("Disk read failure or path inaccessible");
        }),
      });

      const store = useResumeVariantsStore.getState();

      await expect(store.switchTo(variants[0].id)).rejects.toThrow(
        "Disk read failure or path inaccessible",
      );

      // Ensure store is not permanently deadlocked
      expect(useResumeVariantsStore.getState().switching).toBe(false);
    });

    it("handles switching to project with no main files without throwing", async () => {
      const variants = generateVariants(1);
      useResumeVariantsStore.setState({
        ownerRoot: "/projects/resume",
        activeVariantId: null,
        variants,
      });

      // Project with empty files array
      useDocumentStore.setState({
        openProject: vi.fn(async (target: string) => {
          useDocumentStore.setState({
            projectRoot: target,
            files: [],
            activeFileId: "",
          });
        }),
      });

      await expect(
        useResumeVariantsStore.getState().switchTo(variants[0].id),
      ).resolves.not.toThrow();

      // Tabs should be reset to 0 without errors
      expect(useEditorTabsStore.getState().tabs).toHaveLength(0);
      expect(useEditorTabsStore.getState().activeTabId).toBeNull();
    });
  });

  // =========================================================================
  // 3. JD BINDING AND MODAL INTERACTIONS STRESS
  // =========================================================================
  describe("3. JD Binding Modal Edge Cases & IPC Failures", () => {
    it("handles Career DB listRuns failure gracefully without breaking dialog", async () => {
      const variant = generateVariants(1)[0];
      vi.spyOn(careerApi, "listRuns").mockRejectedValueOnce(
        new Error("SQLite query failed: database disk image is malformed"),
      );

      render(
        <BindJdDialog variant={variant} open={true} onOpenChange={() => {}} />,
      );

      // Switch to Runs tab
      const runsTabBtn = screen.getByText(/From Career DB Runs/);
      fireEvent.click(runsTabBtn);

      await waitFor(() => {
        expect(
          screen.getByText(
            "No synthesis runs found in Career DB. Switch to the paste tab to enter a new JD.",
          ),
        ).toBeInTheDocument();
      });
    });

    it("handles corrupt reportJson in Career DB run without throwing", async () => {
      const variant = generateVariants(1)[0];
      const corruptRun: careerApi.SynthesisRun = {
        id: "run-corrupt",
        jdHash: "hash-corrupt",
        personaId: "persona-1",
        templateId: "tmpl-1",
        reportJson: { invalid: "data", profile: null }, // Malformed structure
        createdAt: Date.now(),
      };

      vi.spyOn(careerApi, "listRuns").mockResolvedValueOnce([corruptRun]);

      render(
        <BindJdDialog variant={variant} open={true} onOpenChange={() => {}} />,
      );

      // Switch to Runs tab
      const runsTabBtn = screen.getByText(/From Career DB Runs/);
      fireEvent.click(runsTabBtn);

      await waitFor(() => {
        expect(screen.getByText("Untitled Role")).toBeInTheDocument();
      });

      // Click on the corrupt run
      const runItem = screen.getByText("Untitled Role");
      expect(() => fireEvent.click(runItem)).not.toThrow();
    });

    it("handles IPC failure during bind JD submission and resets submitting state", async () => {
      const variant = generateVariants(1)[0];
      mockInvokeReject = new Error("IPC network timeout: backend disconnected");

      render(
        <BindJdDialog variant={variant} open={true} onOpenChange={() => {}} />,
      );

      const submitBtn = screen.getByRole("button", {
        name: "Bind Job Description",
      });
      fireEvent.click(submitBtn);

      // Submit should fail gracefully
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Bind Job Description" }),
        ).not.toBeDisabled();
      });
    });

    it("rejects variant creation with empty name in CreateVariantDialog", async () => {
      const onOpenChangeSpy = vi.fn();
      render(
        <CreateVariantDialog open={true} onOpenChange={onOpenChangeSpy} />,
      );

      const createBtn = screen.getByRole("button", { name: "Create Variant" });
      fireEvent.click(createBtn);

      // Dialog should remain open
      expect(onOpenChangeSpy).not.toHaveBeenCalled();
      expect(
        screen.getByText("Create Variant from Master"),
      ).toBeInTheDocument();
    });

    it("clamps or handles invalid ATS scores in EditVariantDialog safely", async () => {
      const variant = generateVariants(1)[0];
      variant.atsScore = 75;
      mockTauriVariants = [variant];
      useResumeVariantsStore.setState({
        ownerRoot: "/projects/resume",
        variants: [variant],
      });

      const onOpenChangeSpy = vi.fn();
      render(
        <EditVariantDialog
          variant={variant}
          open={true}
          onOpenChange={onOpenChangeSpy}
        />,
      );

      const atsInput = screen.getByPlaceholderText("e.g. 92");
      // Enter out-of-range score 250
      fireEvent.change(atsInput, { target: { value: "250" } });

      const saveBtn = screen.getByRole("button", { name: "Save Changes" });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(onOpenChangeSpy).toHaveBeenCalledWith(false);
      });

      // Check updated variant clamped to 100
      expect(mockTauriVariants[0].atsScore).toBe(100);
    });
  });
});
