import { describe, expect, it } from "vitest";
import {
  assertCodeModeOnly,
  getResumeTemplate,
  listResumeTemplates,
  canonicalTemplateId,
  isLegacyLatexTemplateId,
  renderResume,
  renderTypstTemplate,
  templateEngine,
  typstBodyLines,
  TYPST_ATS_SINGLE_TEMPLATE,
  TYPST_ATS_TWO_COLUMN_TEMPLATE,
  type ResumeContent,
} from "@/lib/resume-templates";
import { validateTypstString } from "@/lib/resume-synthesis/typst-escape";

function sampleContent(overrides: Partial<ResumeContent> = {}): ResumeContent {
  return {
    header: {
      fullName: "Ada Lovelace",
      cityRegion: "London, UK",
      email: "ada@example.com",
      phone: "+44 20 7946 0958",
      linkedinUrl: "https://linkedin.com/in/ada_lovelace",
      linkedinLabel: "LinkedIn",
      githubUrl: "https://github.com/org/my_repo",
      githubLabel: "GitHub",
    },
    summary: "Engineer who cut costs by **40%** & shipped #1 product.",
    skills: [{ label: "Languages", items: "Rust, TypeScript, C++" }],
    experience: [
      {
        id: "exp_1",
        title: "Senior Engineer",
        org: "Acme Corp",
        location: "Remote",
        dateRange: "Jan 2022 -- Present",
        url: "https://acme.example",
        urlLabel: "acme",
        bullets: [
          "Cut p99 latency by **40%** across 100% of the fleet.",
          "Owned the $2M migration & the C# rewrite.",
        ],
        canonicalBullets: ["Cut p99 latency.", "Owned the migration."],
        extra: "Promoted twice",
      },
    ],
    education: [
      {
        id: "edu_1",
        title: "BSc Mathematics",
        org: "University",
        dateRange: "2016 -- 2020",
        bullets: [],
      },
    ],
    ...overrides,
  };
}

/** Every quoted literal in the document must be individually well-formed. */
function everyLiteralValidates(source: string): void {
  const literals = source.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  expect(literals.length).toBeGreaterThan(0);
  for (const lit of literals) {
    expect(validateTypstString(lit), `literal ${lit}`).toEqual({ ok: true });
  }
}

describe("typst template registry", () => {
  it("registers both Typst templates with engine typst", () => {
    expect(templateEngine(TYPST_ATS_SINGLE_TEMPLATE)).toBe("typst");
    expect(templateEngine(TYPST_ATS_TWO_COLUMN_TEMPLATE)).toBe("typst");
    expect(getResumeTemplate("typst-ats-single-column")).toBeDefined();
    expect(getResumeTemplate("typst-ats-two-column")).toBeDefined();
  });

  it("maps removed LaTeX template ids onto their Typst replacements", () => {
    // Stored runs and un-migrated personas can still name these; they must
    // resolve rather than fail with "Unknown resume template".
    expect(isLegacyLatexTemplateId("ats-single-column")).toBe(true);
    expect(canonicalTemplateId("ats-single-column")).toBe(
      "typst-ats-single-column",
    );
    expect(canonicalTemplateId("ats-two-column")).toBe("typst-ats-two-column");
    expect(getResumeTemplate("ats-single-column")?.id).toBe(
      "typst-ats-single-column",
    );
    expect(getResumeTemplate("ats-two-column")?.id).toBe(
      "typst-ats-two-column",
    );
  });

  it("leaves unknown ids unmapped", () => {
    expect(isLegacyLatexTemplateId("something-else")).toBe(false);
    expect(canonicalTemplateId("something-else")).toBe("something-else");
    expect(getResumeTemplate("something-else")).toBeUndefined();
  });

  it("registers only Typst templates", () => {
    expect(
      listResumeTemplates().every((t) => templateEngine(t) === "typst"),
    ).toBe(true);
  });

  it("every registered template declares a usable engine", () => {
    for (const t of listResumeTemplates()) {
      expect(["latex", "typst"]).toContain(templateEngine(t));
    }
  });

  it("renderResume produces Typst, never LaTeX", () => {
    const typst = renderResume(TYPST_ATS_SINGLE_TEMPLATE, sampleContent());
    expect(typst.source).toContain('#set page(paper: "us-letter"');
    expect(typst.source).not.toContain("\\documentclass");
  });

  it("renderResume rejects a template with no renderer", () => {
    expect(() =>
      renderResume(
        { ...TYPST_ATS_SINGLE_TEMPLATE, render: undefined },
        sampleContent(),
      ),
    ).toThrow(/no renderer/);
  });
});

describe("renderTypstTemplate", () => {
  it("emits a compilable-looking document with content present", () => {
    const { source } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent(),
    );
    expect(source).toContain("#let rich(parts)");
    expect(source).toContain("Ada Lovelace");
    expect(source).toContain("Senior Engineer");
    expect(source).toContain('sect("Experience")');
    everyLiteralValidates(source);
  });

  it("puts every content line in code mode", () => {
    const { source } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent(),
    );
    // The invariant guard must accept its own output.
    expect(() => assertCodeModeOnly(typstBodyLines(source))).not.toThrow();
  });

  it("does not escape LaTeX specials — they are literal text in Typst", () => {
    const { source } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent(),
    );
    expect(source).not.toContain("\\%");
    expect(source).not.toContain("\\&");
    expect(source).toContain("100% of the fleet");
    expect(source).toContain("$2M migration & the C# rewrite");
  });

  it("converts markdown bold into rich() segments", () => {
    const { source } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent(),
    );
    expect(source).toContain('(true, "40%")');
  });

  it("records slot line ranges that point at the emitted line", () => {
    const { source, slots } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent(),
    );
    const lines = source.split("\n");
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.startLine).toBeGreaterThan(0);
      expect(slot.endLine).toBeLessThanOrEqual(lines.length);
    }
    // Guards the preamble line-offset arithmetic: a slot's recorded line must
    // be the line its own text was written to.
    for (const slot of slots) {
      const line = lines[slot.startLine - 1] ?? "";
      const needle = slot.current.slice(0, 12);
      if (needle.trim().length > 3 && !slot.slotId.endsWith(":entry")) {
        expect(line, `slot ${slot.slotId} -> "${line}"`).toContain(
          needle.slice(0, 8),
        );
      }
    }
    const bullet = slots.find((s) => s.slotId === "experience:exp_1:bullet:0");
    expect(bullet).toBeDefined();
    expect(lines[bullet!.startLine - 1]).toContain("40%");
  });

  it("keeps injection payloads inside literals", () => {
    const hostile = sampleContent({
      summary: '#read("/etc/passwd")',
      experience: [
        {
          id: "exp_1",
          title: '#eval("1+1")',
          org: '" + read("/x") + "',
          dateRange: "*/ #x /*",
          bullets: ['#import "@preview/evil:1.0.0": *', '// #read("/x")'],
        },
      ],
    });
    const { source } = renderTypstTemplate(TYPST_ATS_SINGLE_TEMPLATE, hostile);
    everyLiteralValidates(source);
    expect(() => assertCodeModeOnly(typstBodyLines(source))).not.toThrow();
    // The payload text survives, but only ever inside a quoted literal.
    expect(source).toContain('\\"/etc/passwd\\"');
  });

  it("renders the two-column layout as code-mode arrays", () => {
    const { source } = renderTypstTemplate(
      TYPST_ATS_TWO_COLUMN_TEMPLATE,
      sampleContent(),
    );
    expect(source).toContain("two-col({");
    expect(() => assertCodeModeOnly(typstBodyLines(source))).not.toThrow();
    everyLiteralValidates(source);
  });

  it("survives empty and minimal content", () => {
    const empty: ResumeContent = {
      header: { fullName: "", cityRegion: "", email: "", phone: "" },
      experience: [],
    };
    const { source, slots } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      empty,
    );
    expect(() => assertCodeModeOnly(typstBodyLines(source))).not.toThrow();
    expect(source).toContain("doc-header(");
    expect(slots.length).toBeGreaterThan(0);
  });

  it("renders location, org link and the GPA/extra line", () => {
    // Regression: draftsToContent never mapped these, so RenderedBlock
    // supported them and both templates rendered them, yet no synthesized
    // resume could ever show a GPA, a location, or a linked org.
    const { source, slots } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent({
        education: [
          {
            id: "edu_1",
            title: "BSc Mathematics",
            org: "University",
            location: "Cambridge, UK",
            dateRange: "2016 -- 2020",
            url: "https://uni.example",
            bullets: [],
            extra: "GPA 3.9/4.0 · Dean's List",
          },
        ],
      }),
    );
    expect(source).toContain('"Cambridge, UK"');
    expect(source).toContain('"https://uni.example"');
    expect(source).toContain("GPA 3.9/4.0");
    expect(slots.some((s) => s.slotId === "education:edu_1:extra")).toBe(true);
  });

  it("keeps the extra line optional", () => {
    const { source, slots } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent({
        education: [
          {
            id: "edu_1",
            title: "BSc",
            org: "University",
            dateRange: "2016 -- 2020",
            bullets: [],
          },
        ],
      }),
    );
    expect(slots.some((s) => s.slotId === "education:edu_1:extra")).toBe(false);
    // An absent location still renders a well-formed entry call.
    expect(source).toContain('entry("BSc"');
  });

  it("blanks hostile URL schemes in links", () => {
    const { source } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent({
        header: {
          fullName: "X",
          cityRegion: "",
          email: "",
          phone: "",
          portfolioUrl: "javascript:alert(1)",
          portfolioLabel: "site",
        },
      }),
    );
    expect(source).not.toContain("javascript:");
  });

  it("honours section order", () => {
    const { source } = renderTypstTemplate(
      TYPST_ATS_SINGLE_TEMPLATE,
      sampleContent(),
      ["education", "experience"],
    );
    expect(source.indexOf('sect("Education")')).toBeLessThan(
      source.indexOf('sect("Experience")'),
    );
  });
});

describe("assertCodeModeOnly", () => {
  it("throws when a statement escapes the document code block", () => {
    // A leading `#` inside `#{ … }` is the exact defect the cross-language
    // fixture test caught in the two-column layout.
    expect(() => assertCodeModeOnly(['#sect("Experience")'])).toThrow(
      /markup-mode line/,
    );
  });

  it("accepts code-block statements", () => {
    expect(() =>
      assertCodeModeOnly([
        'sect("Experience")',
        "bullets((",
        '  rich(((false, "x"),)),',
        "))",
        "two-col({",
        "}, {",
        "})",
        "",
      ]),
    ).not.toThrow();
  });
});
