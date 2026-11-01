import { describe, it, expect, beforeEach, vi } from "vitest";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSpacesStore } from "@/stores/spaces-store";
import type { VariantInfo } from "@/lib/tauri/variants";

// Mock Tauri invoke calls
const mockVariants: Map<string, VariantInfo> = new Map();
const _slugCounter = 1;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    switch (cmd) {
      case "variant_list":
      case "list_variants": {
        return Array.from(mockVariants.values()).sort(
          (a, b) => b.createdAt - a.createdAt,
        );
      }
      case "variant_get": {
        const v = mockVariants.get(args.variantId);
        if (!v) throw new Error("That version no longer exists.");
        return v;
      }
      case "variant_create":
      case "create_variant": {
        const name = (args.name ?? "").trim();
        if (!name) throw new Error("Version name cannot be empty.");

        const score = args.atsScore;
        if (score !== null && score !== undefined) {
          if (score < 0 || score > 100) {
            throw new Error("ATS score must be between 0 and 100.");
          }
        }

        // Slugify logic matching Rust backend
        let slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        if (!slug) slug = "version";

        let finalSlug = slug;
        if (mockVariants.has(finalSlug)) {
          let n = 2;
          while (mockVariants.has(`${slug}-${n}`)) {
            n++;
          }
          finalSlug = `${slug}-${n}`;
        }

        const now = Date.now();
        const info: VariantInfo = {
          id: finalSlug,
          name,
          status: args.status || "draft",
          jd: args.jd || "",
          createdAt: now,
          updatedAt: now,
          path: `${args.projectRoot}/.prism/variants/${finalSlug}`,
          company: args.company || undefined,
          role: args.role || undefined,
          seniority: args.seniority || undefined,
          persona: args.persona || undefined,
          atsScore: score !== null && score !== undefined ? score : undefined,
          baseResumeSourcePath: args.baseResumeSourcePath || undefined,
        };
        mockVariants.set(finalSlug, info);
        return info;
      }
      case "variant_update":
      case "update_variant": {
        const v = mockVariants.get(args.variantId);
        if (!v) throw new Error("That version no longer exists.");

        const score = args.atsScore;
        if (score !== null && score !== undefined) {
          if (score < 0 || score > 100) {
            throw new Error("ATS score must be between 0 and 100.");
          }
        }

        const updated: VariantInfo = {
          ...v,
          name:
            args.name !== null && args.name !== undefined ? args.name : v.name,
          status:
            args.status !== null && args.status !== undefined
              ? args.status
              : v.status,
          jd: args.jd !== null && args.jd !== undefined ? args.jd : v.jd,
          company:
            args.company !== null && args.company !== undefined
              ? args.company
              : v.company,
          role:
            args.role !== null && args.role !== undefined ? args.role : v.role,
          seniority:
            args.seniority !== null && args.seniority !== undefined
              ? args.seniority
              : v.seniority,
          persona:
            args.persona !== null && args.persona !== undefined
              ? args.persona
              : v.persona,
          atsScore: score !== null && score !== undefined ? score : v.atsScore,
          updatedAt: Date.now(),
        };
        mockVariants.set(args.variantId, updated);
        return updated;
      }
      case "variant_bind_jd": {
        const v = mockVariants.get(args.variantId);
        if (!v) throw new Error("That version no longer exists.");
        const updated: VariantInfo = {
          ...v,
          jd: args.jdText,
          company: args.company || v.company,
          role: args.role || v.role,
          updatedAt: Date.now(),
        };
        mockVariants.set(args.variantId, updated);
        return updated;
      }
      case "variant_delete":
      case "delete_variant": {
        mockVariants.delete(args.variantId);
        return;
      }
      case "diff_variant": {
        return [];
      }
      default:
        throw new Error(`Unhandled mock command: ${cmd}`);
    }
  }),
}));

describe("Feature 15: useResumeVariantsStore Empirical Stress Suite", () => {
  const masterRoot = "/home/user/Documents/DevPrism/MyResume";

  beforeEach(() => {
    mockVariants.clear();
    useDocumentStore.setState({
      saveAllFiles: vi.fn(async () => {}),
      openProject: vi.fn(async () => {}),
    });
    useSpacesStore.setState({
      spaceForProject: vi.fn(() => null),
      assignProject: vi.fn(),
    });
    useResumeVariantsStore.setState({
      ownerRoot: null,
      activeVariantId: null,
      variants: [],
      selectedVariant: null,
      loading: false,
      switching: false,
    });
  });

  // =========================================================================
  // 1. ATS Score Boundaries & Validation
  // =========================================================================
  describe("ATS Score Boundary Values", () => {
    it("accepts boundary values 0 and 100", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      const vMin = await store.create("Score Min", "JD", "draft", {
        atsScore: 0,
      });
      expect(vMin.atsScore).toBe(0);

      const vMax = await store.create("Score Max", "JD", "draft", {
        atsScore: 100,
      });
      expect(vMax.atsScore).toBe(100);
    });

    it("rejects invalid negative scores (-1, -100)", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      await expect(
        store.create("Invalid Negative", "JD", "draft", { atsScore: -1 }),
      ).rejects.toThrow("ATS score must be between 0 and 100.");

      await expect(
        store.create("Invalid -100", "JD", "draft", { atsScore: -100 }),
      ).rejects.toThrow("ATS score must be between 0 and 100.");
    });

    it("rejects invalid overflow scores (101, 255, 9999)", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      await expect(
        store.create("Invalid 101", "JD", "draft", { atsScore: 101 }),
      ).rejects.toThrow("ATS score must be between 0 and 100.");

      await expect(
        store.create("Invalid 9999", "JD", "draft", { atsScore: 9999 }),
      ).rejects.toThrow("ATS score must be between 0 and 100.");
    });

    it("rejects invalid score on update patch", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      const v = await store.create("Valid Variant", "JD", "draft", {
        atsScore: 85,
      });
      expect(v.atsScore).toBe(85);

      await expect(store.update(v.id, { atsScore: 120 })).rejects.toThrow(
        "ATS score must be between 0 and 100.",
      );

      await expect(store.update(v.id, { atsScore: -5 })).rejects.toThrow(
        "ATS score must be between 0 and 100.",
      );
    });
  });

  // =========================================================================
  // 2. Duplicate Slugs & Collision Resolution
  // =========================================================================
  describe("Duplicate Slugs & Name Collisions", () => {
    it("resolves duplicate names with incremental slug suffix", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      const v1 = await store.create("Backend Lead", "JD 1", "draft");
      const v2 = await store.create("Backend Lead", "JD 2", "draft");
      const v3 = await store.create("Backend Lead", "JD 3", "draft");

      expect(v1.id).toBe("backend-lead");
      expect(v2.id).toBe("backend-lead-2");
      expect(v3.id).toBe("backend-lead-3");

      const all = useResumeVariantsStore.getState().variants;
      expect(all).toHaveLength(3);
      expect(all.map((v) => v.id)).toEqual([
        "backend-lead-3",
        "backend-lead-2",
        "backend-lead",
      ]);
    });

    it("handles adversarial characters and non-alphanumeric names", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      // Only punctuation -> fallback to 'version'
      const vPunct = await store.create("!!!", "", "draft");
      expect(vPunct.id).toBe("version");

      // Special characters, emojis, and slashes
      const vSpecial = await store.create(
        'Staff SRE / Core Team "Special" 🚀',
        "",
        "draft",
      );
      expect(vSpecial.id).toBe("staff-sre-core-team-special");

      // Empty name throws
      await expect(store.create("   ", "", "draft")).rejects.toThrow(
        "Version name cannot be empty.",
      );
    });
  });

  // =========================================================================
  // 3. Partial Updates & Field Preservation
  // =========================================================================
  describe("Metadata Partial Updates & Field Preservation", () => {
    it("preserves untouched extended fields during partial updates", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      const initial = await store.create(
        "Initial Variant",
        "Initial JD",
        "draft",
        {
          company: "Stripe",
          role: "Staff Infrastructure Engineer",
          seniority: "lead",
          persona: "infra-platform",
          atsScore: 92,
          baseResumeSourcePath: "resume.typ",
        },
      );

      // Update only status
      const patched = await store.update(initial.id, { status: "interview" });
      expect(patched.status).toBe("interview");
      expect(patched.company).toBe("Stripe");
      expect(patched.role).toBe("Staff Infrastructure Engineer");
      expect(patched.seniority).toBe("lead");
      expect(patched.persona).toBe("infra-platform");
      expect(patched.atsScore).toBe(92);
      expect(patched.jd).toBe("Initial JD");

      // Bind JD updates JD, company, role
      const bound = await store.bindJd(
        initial.id,
        "New Target JD Text",
        "Stripe Core",
        "Principal Engineer",
      );
      expect(bound.jd).toBe("New Target JD Text");
      expect(bound.company).toBe("Stripe Core");
      expect(bound.role).toBe("Principal Engineer");
      expect(bound.persona).toBe("infra-platform");
      expect(bound.atsScore).toBe(92);
    });
  });

  // =========================================================================
  // 4. Project Switch & Idempotent Deletion
  // =========================================================================
  describe("Project Switch & Lifecycle", () => {
    it("switches to master when active variant is deleted", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      const v = await store.create("To Delete", "JD", "draft");
      expect(useResumeVariantsStore.getState().activeVariantId).toBe(v.id);

      await store.remove(v.id);
      expect(useResumeVariantsStore.getState().variants).toHaveLength(0);
      expect(useResumeVariantsStore.getState().activeVariantId).toBeNull();
    });

    it("double delete handles gracefully without throwing", async () => {
      await useResumeVariantsStore.getState().sync(masterRoot);
      const store = useResumeVariantsStore.getState();

      const v = await store.create("Test Delete", "JD", "draft");
      await store.remove(v.id);
      await expect(store.remove(v.id)).resolves.not.toThrow();
    });

    it("derives owner correctly when synced from variant project path", async () => {
      const variantPath = `${masterRoot}/.prism/variants/my-variant`;
      await useResumeVariantsStore.getState().sync(variantPath);

      const state = useResumeVariantsStore.getState();
      expect(state.ownerRoot).toBe(masterRoot);
      expect(state.activeVariantId).toBe("my-variant");
    });
  });
});
