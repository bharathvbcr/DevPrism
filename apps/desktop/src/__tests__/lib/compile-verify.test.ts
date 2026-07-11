import { describe, expect, it, vi } from "vitest";
import {
  ATS_RESUME_TEMPLATE,
  renderTemplate,
  setSlotPlainText,
  type ResumeContent,
} from "@/lib/resume-templates";
import {
  compileWithRepairLoop,
  mapErrorLineToSlot,
  type AgentCompileResult,
} from "@/lib/resume-synthesis/compile-verify";

function sampleContent(): ResumeContent {
  return {
    header: {
      fullName: "Ada Lovelace",
      cityRegion: "London, UK",
      email: "ada@example.com",
      phone: "+44 000",
    },
    summary: "Mathematician and first programmer.",
    skills: [{ label: "Languages", items: "Math, Notes" }],
    experience: [
      {
        id: "exp_1",
        title: "Analyst",
        org: "Analytical Engine Co",
        location: "London",
        dateRange: "1842 -- 1852",
        bullets: [
          "Designed algorithms for the Analytical Engine.",
          "Cut computation time 40% with better notation.",
        ],
      },
    ],
    education: [
      {
        id: "edu_1",
        title: "Private study",
        org: "Home",
        dateRange: "1830",
        bullets: [],
      },
    ],
  };
}

describe("renderTemplate (ats-single-column)", () => {
  it("emits a documentclass and escaped specials", () => {
    const { tex, slots } = renderTemplate(ATS_RESUME_TEMPLATE, sampleContent());
    expect(tex).toContain("\\documentclass[letterpaper,11pt]{article}");
    expect(tex).toContain("\\begin{document}");
    expect(tex).toContain("Ada Lovelace");
    expect(tex).toContain("40\\%");
    expect(tex).not.toContain("<FULL NAME>");
    expect(slots.some((s) => s.slotId.includes("bullet"))).toBe(true);
  });

  it("records line ranges covering bullet text", () => {
    const { tex, slots } = renderTemplate(ATS_RESUME_TEMPLATE, sampleContent());
    const bullet = slots.find((s) => s.slotId === "experience:exp_1:bullet:1");
    expect(bullet).toBeDefined();
    const lines = tex.split("\n");
    const line = lines[(bullet?.startLine ?? 1) - 1] ?? "";
    expect(line).toContain("40\\%");
  });
});

describe("mapErrorLineToSlot", () => {
  it("maps an error line into the covering slot", () => {
    const { slots } = renderTemplate(ATS_RESUME_TEMPLATE, sampleContent());
    const target = slots.find((s) => s.slotId === "summary");
    expect(target).toBeDefined();
    const hit = mapErrorLineToSlot(
      [{ file: "resume.tex", line: target!.startLine, message: "boom" }],
      slots,
    );
    expect(hit?.slotId).toBe("summary");
  });

  it("returns null when no line numbers", () => {
    const { slots } = renderTemplate(ATS_RESUME_TEMPLATE, sampleContent());
    expect(
      mapErrorLineToSlot([{ file: null, line: null, message: "fail" }], slots),
    ).toBeNull();
  });
});

describe("setSlotPlainText", () => {
  it("replaces a bullet", () => {
    const next = setSlotPlainText(
      sampleContent(),
      "experience:exp_1:bullet:0",
      "canonical fallback bullet",
    );
    expect(next.experience[0].bullets[0]).toBe("canonical fallback bullet");
  });
});

describe("compileWithRepairLoop", () => {
  it("returns on first successful compile", async () => {
    const compile = vi.fn(
      async (): Promise<AgentCompileResult> => ({
        success: true,
        main_file: "resume.tex",
        errors: [],
        summary: "ok",
        pdf_bytes: [37, 80, 68, 70],
      }),
    );
    const attempts: string[] = [];
    const out = await compileWithRepairLoop(
      ATS_RESUME_TEMPLATE,
      sampleContent(),
      {
        compile,
        onAttempt: (detail) => attempts.push(detail),
      },
    );
    expect(out.result.success).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(out.repairs).toEqual([]);
    expect(out.pdfBytes).toBeTruthy();
    expect(out.pdfBytes![0]).toBe(37);
    expect(attempts.some((a) => /Compiling/i.test(a))).toBe(true);
  });

  it("repairs a mapped culprit slot then succeeds", async () => {
    const content = sampleContent();
    content.experience[0].canonicalBullets = [...content.experience[0].bullets];
    // Poison the current bullet; canonical stays good for fallback.
    content.experience[0].bullets[1] = "POISONED_BULLET_FOR_REPAIR_TEST";

    let calls = 0;
    const compile = vi.fn(async (tex: string): Promise<AgentCompileResult> => {
      calls += 1;
      if (calls === 1) {
        expect(tex).toContain("POISONED\\_BULLET\\_FOR\\_REPAIR\\_TEST");
        const { slots } = renderTemplate(ATS_RESUME_TEMPLATE, content);
        const bullet = slots.find(
          (s) => s.slotId === "experience:exp_1:bullet:1",
        )!;
        return {
          success: false,
          main_file: "resume.tex",
          errors: [
            {
              file: "resume.tex",
              line: bullet.startLine,
              message: "! Undefined control sequence.",
            },
          ],
          summary: "fail",
        };
      }
      expect(tex).not.toContain("POISONED\\_BULLET\\_FOR\\_REPAIR\\_TEST");
      expect(tex).toContain("Cut computation time 40\\%");
      return {
        success: true,
        main_file: "resume.tex",
        errors: [],
        summary: "ok",
      };
    });

    const out = await compileWithRepairLoop(ATS_RESUME_TEMPLATE, content, {
      compile,
      maxRetries: 2,
    });
    expect(out.result.success).toBe(true);
    expect(out.repairs).toContain("experience:exp_1:bullet:1");
    expect(compile.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns soft-fail draft after exhausting retries", async () => {
    const compile = vi.fn(
      async (): Promise<AgentCompileResult> => ({
        success: false,
        main_file: "resume.tex",
        errors: [{ file: null, line: null, message: "nope" }],
        summary: "always fail",
      }),
    );
    // Bisect will also call compile; keep failing — still return reviewable tex.
    const out = await compileWithRepairLoop(
      ATS_RESUME_TEMPLATE,
      sampleContent(),
      {
        compile,
        maxRetries: 1,
      },
    );
    expect(out.result.success).toBe(false);
    expect(out.tex).toContain("documentclass");
    expect(out.repairs.length).toBeGreaterThan(0);
  });
});
