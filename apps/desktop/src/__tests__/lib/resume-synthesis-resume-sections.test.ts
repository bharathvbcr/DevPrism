/**
 * Native resume-section integration (IgniteCV port + DevPrism templates).
 *
 * Written against the live pipeline to disrupt it: these cases fail until
 * template-emitted headers, career block kinds, ATS aliases, and persona
 * sectionOrder share one taxonomy and never drop contentful sections.
 */
import { describe, expect, it } from "vitest";
import { createEmptyBlock, isBlockKind } from "@/lib/career";
import { parseExtractedBlocks } from "@/lib/career/extract-resume";
import {
  BLOCK_KINDS,
  BLOCK_KIND_TO_SECTION,
  RESUME_SECTION_IDS,
  SECTION_ALIASES,
  canonicalSectionFromHeader,
  resolveSectionOrder,
} from "@/lib/resume-sections";
import {
  TYPST_ATS_SINGLE_TEMPLATE,
  TYPST_ATS_TWO_COLUMN_TEMPLATE,
  renderResume,
  type ResumeContent,
} from "@/lib/resume-templates";
import {
  renderedContentPlainText,
  simulateAtsParsing,
  splitResumeIntoSections,
} from "@/lib/resume-synthesis/ats-simulate";
import { draftsToContent } from "@/lib/resume-synthesis/orchestrator";
import { sectionForBlock } from "@/lib/resume-synthesis/selection";
import type {
  ExperienceBlock,
  RewrittenBlockDraft,
} from "@/lib/resume-synthesis/types";

const HEADER = {
  fullName: "Ada Lovelace",
  cityRegion: "London, UK",
  email: "ada@example.com",
  phone: "+44 20 7946 0958",
};

function block(
  kind: ExperienceBlock["kind"],
  title: string,
  org: string,
): ExperienceBlock {
  return createEmptyBlock({
    kind,
    title,
    org,
    dateRange: { start: "2020-01", end: "2024-01" },
    bullets: [
      {
        id: "b1",
        canonical: `Shipped ${title} at ${org} with 40% gain`,
        variants: {},
        metrics: [{ value: "40%", kind: "improvement" }],
        evidenceRefs: [],
        locked: false,
      },
    ],
  });
}

function entry(
  id: string,
  title: string,
  org: string,
): ResumeContent["experience"][number] {
  return {
    id,
    title,
    org,
    dateRange: "2020 -- 2024",
    bullets: [`Did ${title} at ${org}`],
  };
}

describe("ATS parse vs template-emitted section titles", () => {
  it("detects Publications and Leadership from flattened synthesized content", () => {
    const content: ResumeContent = {
      header: HEADER,
      experience: [entry("e1", "Engineer", "Acme")],
      publications: [entry("p1", "Systems Paper", "Nature")],
      leadership: [entry("l1", "Chair", "Standards Committee")],
    };
    const text = renderedContentPlainText(content);
    expect(text).toMatch(/PUBLICATIONS/);
    expect(text).toMatch(/LEADERSHIP/);

    const names = splitResumeIntoSections(text).map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Publications", "Leadership"]),
    );

    const parse = simulateAtsParsing(text, "generic");
    const detected = parse.sections
      .filter((s) => s.detected)
      .map((s) => s.name);
    expect(detected).toEqual(
      expect.arrayContaining(["publications", "leadership"]),
    );
    const pub = splitResumeIntoSections(text).find(
      (s) => s.name === "Publications",
    );
    expect(pub?.text).toContain("Nature");
    expect(pub?.text).not.toContain("Standards Committee");
  });

  it("does not treat body mentions of publication/leadership as headers", () => {
    const sections = splitResumeIntoSections(
      [
        "EXPERIENCE",
        "Wrote publications on compilers; leadership of a guild of 12.",
        "PUBLICATIONS",
        "Real paper here.",
      ].join("\n"),
    );
    expect(sections.map((s) => s.name)).toEqual(["Experience", "Publications"]);
    expect(sections[0]?.text).toContain("Wrote publications");
  });
});

describe("IgniteCV section kinds are first-class career blocks", () => {
  it("accepts certification, award, and volunteer kinds", () => {
    expect(isBlockKind("certification")).toBe(true);
    expect(isBlockKind("award")).toBe(true);
    expect(isBlockKind("volunteer")).toBe(true);
  });

  it("maps those kinds onto printable resume sections (not experience)", () => {
    expect(sectionForBlock(block("certification", "AWS SAA", "Amazon"))).toBe(
      "certifications",
    );
    expect(sectionForBlock(block("award", "Best Paper", "NeurIPS"))).toBe(
      "awards",
    );
    expect(sectionForBlock(block("volunteer", "Mentor", "Code.org"))).toBe(
      "volunteer",
    );
  });

  it("extract-resume keeps certification rows instead of coercing to experience", () => {
    const blocks = parseExtractedBlocks(
      JSON.stringify({
        blocks: [
          {
            kind: "certification",
            title: "AWS Solutions Architect",
            org: "Amazon",
            dateStart: "2023-01",
            dateEnd: null,
            bullets: ["Passed professional exam"],
          },
        ],
      }),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("certification");
    expect(sectionForBlock(blocks[0]!)).toBe("certifications");
  });
});

describe("persona sectionOrder must not drop contentful sections", () => {
  it("still renders a summary when the persona order omits it", () => {
    const content: ResumeContent = {
      header: HEADER,
      summary: "I build compilers that cut compile time by 40%.",
      experience: [entry("e1", "Engineer", "Acme")],
    };
    const result = renderResume(TYPST_ATS_SINGLE_TEMPLATE, content, [
      "experience",
      "skills",
    ]);
    expect(result.source).toContain("I build compilers that cut compile time");
  });

  it("still renders leadership when a seeded AI-style order omits it", () => {
    const content: ResumeContent = {
      header: HEADER,
      experience: [entry("e1", "Engineer", "Acme")],
      leadership: [entry("l1", "Chair", "Committee")],
    };
    const result = renderResume(TYPST_ATS_SINGLE_TEMPLATE, content, [
      "experience",
      "projects",
      "skills",
      "education",
      "publications",
    ]);
    expect(result.source).toContain("Chair");
    expect(result.source).toContain("Committee");
  });

  it("two-column layout still emits certifications not in the left-column set", () => {
    const content: ResumeContent = {
      header: HEADER,
      experience: [entry("e1", "Engineer", "Acme")],
      certifications: [entry("c1", "AWS SAA", "Amazon")],
    };
    const result = renderResume(TYPST_ATS_TWO_COLUMN_TEMPLATE, content, [
      "experience",
      "certifications",
    ]);
    expect(result.source).toContain("AWS SAA");
    expect(result.source).toContain("Amazon");
  });
});

describe("draftsToContent round-trips extra section kinds", () => {
  it("places certification drafts into content.certifications, not experience", () => {
    const cert = block("certification", "AWS SAA", "Amazon");
    const drafts: RewrittenBlockDraft[] = [
      {
        block: cert,
        bullets: [
          {
            id: cert.bullets[0]!.id,
            text: cert.bullets[0]!.canonical,
            usedCanonical: true,
          },
        ],
        evidence: [],
        score: 1,
        components: {
          embedding: 0,
          skills: 1,
          persona: 0,
          recency: 0,
          seniority: 0,
        },
      },
    ];
    const content = draftsToContent(
      drafts,
      HEADER,
      {
        roleTitle: "Engineer",
        seniority: "senior",
        mustHaveSkills: [],
        niceToHaveSkills: [],
        domains: [],
        atsKeywords: [],
        toneSignals: [],
        responsibilitiesText: "",
        qualificationsText: "",
      },
      ["experience", "certifications"],
    );
    expect(content.certifications).toHaveLength(1);
    expect(content.certifications?.[0]?.title).toBe("AWS SAA");
    expect(content.experience).toHaveLength(0);
  });
});

describe("adversarial section headers", () => {
  it("recognizes decorated / numbered Publications and Certifications headers", () => {
    const text = [
      "== PUBLICATIONS ==",
      "Nature paper.",
      "3. Certifications",
      "AWS SAA",
      "Leadership:",
      "Chaired the guild.",
    ].join("\n");
    const names = splitResumeIntoSections(text).map((s) => s.name);
    expect(names).toEqual(["Publications", "Certifications", "Leadership"]);
  });

  it("clamps and stays total on huge mixed-header input", () => {
    const parts: string[] = [];
    for (let i = 0; i < 4000; i++) {
      parts.push(
        i % 7 === 0 ? "PUBLICATIONS" : `line ${i} publications mentioned`,
      );
    }
    const joined = parts.join("\n");
    const sections = splitResumeIntoSections(joined);
    expect(sections.length).toBeGreaterThan(0);
    expect(() => simulateAtsParsing(joined, "workday")).not.toThrow();
  });

  it("recognizes Languages and Volunteer headers under hostile decoration", () => {
    const names = splitResumeIntoSections(
      [
        "\u202E LANGUAGES \u202C",
        "English, Tamil",
        "== volunteer experience ==",
        "Mentored 12 students.",
      ].join("\n"),
    ).map((s) => s.name);
    expect(names).toEqual(["Languages", "Volunteer"]);
  });
});

describe("canonical taxonomy is total", () => {
  it("maps every block kind onto a printable persona section", () => {
    for (const kind of BLOCK_KINDS) {
      expect(BLOCK_KIND_TO_SECTION[kind]).toBeTruthy();
      expect(sectionForBlock(block(kind, "T", "O"))).toBe(
        BLOCK_KIND_TO_SECTION[kind],
      );
    }
  });

  it("has ATS aliases for every resume section except header", () => {
    for (const id of RESUME_SECTION_IDS) {
      if (id === "header") continue;
      expect(SECTION_ALIASES[id].length).toBeGreaterThan(0);
      expect(canonicalSectionFromHeader(id)).toBe(id);
      expect(canonicalSectionFromHeader(id.toUpperCase())).toBe(id);
    }
  });

  it("resolveSectionOrder never drops contentful sections the persona omitted", () => {
    const order = resolveSectionOrder(
      ["experience", "projects"],
      (id) => id === "summary" || id === "experience" || id === "leadership",
    );
    expect(order[0]).toBe("summary");
    expect(order).toEqual(
      expect.arrayContaining(["summary", "experience", "leadership"]),
    );
  });

  it("empty persona order still emits every contentful default section", () => {
    const order = resolveSectionOrder([], (id) => id === "awards");
    expect(order).toEqual(["awards"]);
  });
});

describe("extract-resume keeps award and volunteer kinds", () => {
  it("does not coerce award/volunteer rows to experience", () => {
    const blocks = parseExtractedBlocks(
      JSON.stringify({
        blocks: [
          {
            kind: "award",
            title: "Best Paper",
            org: "NeurIPS",
            dateStart: "2022-01",
            dateEnd: null,
            bullets: ["Awarded for systems work"],
          },
          {
            kind: "volunteer",
            title: "Mentor",
            org: "Code.org",
            dateStart: "2021-01",
            dateEnd: null,
            bullets: ["Mentored 12 students"],
          },
        ],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["award", "volunteer"]);
    expect(sectionForBlock(blocks[0]!)).toBe("awards");
    expect(sectionForBlock(blocks[1]!)).toBe("volunteer");
  });
});

describe("IgniteCV header aliases and dirty kinds still land in the right slot", () => {
  it("maps Honors & Awards / Licenses and Certifications as exact headers", () => {
    expect(canonicalSectionFromHeader("Honors & Awards")).toBe("awards");
    expect(canonicalSectionFromHeader("Awards and Honors")).toBe("awards");
    expect(canonicalSectionFromHeader("Licenses and Certifications")).toBe(
      "certifications",
    );
    expect(canonicalSectionFromHeader("Community Service")).toBe("volunteer");
    expect(canonicalSectionFromHeader("Extra-Curricular Activities")).toBe(
      "leadership",
    );
  });

  it("maps Education & Training after ampersand folding", () => {
    expect(canonicalSectionFromHeader("Education & Training")).toBe(
      "education",
    );
    expect(canonicalSectionFromHeader("EDUCATION AND TRAINING")).toBe(
      "education",
    );
  });

  it("round-trips every SECTION_ALIASES entry through header folding", () => {
    for (const id of RESUME_SECTION_IDS) {
      for (const alias of SECTION_ALIASES[id]) {
        expect(canonicalSectionFromHeader(alias), alias).toBe(id);
      }
    }
  });

  it("canonicalSectionFromHeader itself strips bidi and diacritics", () => {
    expect(canonicalSectionFromHeader("\u202E LANGUAGES \u202C")).toBe(
      "languages",
    );
    expect(canonicalSectionFromHeader("Éducation")).toBe("education");
    expect(canonicalSectionFromHeader(`${"\u202E".repeat(40)} Skills`)).toBe(
      "skills",
    );
  });

  it("sectionForBlock canonicalizes plural kinds stored on a block", () => {
    const dirty = {
      ...block("experience", "AWS SAA", "Amazon"),
      kind: "certifications",
    } as unknown as ExperienceBlock;
    expect(sectionForBlock(dirty)).toBe("certifications");
  });

  it("two-column layout still emits volunteer (right-column fallthrough)", () => {
    const content: ResumeContent = {
      header: HEADER,
      experience: [entry("e1", "Engineer", "Acme")],
      volunteer: [entry("v1", "Mentor", "Code.org")],
    };
    const result = renderResume(TYPST_ATS_TWO_COLUMN_TEMPLATE, content, [
      "experience",
    ]);
    expect(result.source).toContain("Mentor");
    expect(result.source).toContain("Code.org");
  });

  it("SECTION_ALIASES has unique aliases across sections", () => {
    const seen = new Map<string, string>();
    for (const id of RESUME_SECTION_IDS) {
      for (const alias of SECTION_ALIASES[id]) {
        const prev = seen.get(alias);
        expect(
          prev,
          `alias '${alias}' claimed by ${prev} and ${id}`,
        ).toBeUndefined();
        seen.set(alias, id);
      }
    }
  });
});

describe("end-to-end: every block kind survives drafts → template → ATS", () => {
  it("prints and parses all eight career kinds", () => {
    const kinds = [...BLOCK_KINDS];
    const drafts: RewrittenBlockDraft[] = kinds.map((kind, i) => {
      const b = block(kind, `Title ${kind}`, `Org ${kind}`);
      b.id = `blk_${i}`;
      return {
        block: b,
        bullets: [
          {
            id: b.bullets[0]!.id,
            text: b.bullets[0]!.canonical,
            usedCanonical: true,
          },
        ],
        evidence: [],
        score: 1,
        components: {
          embedding: 0,
          skills: 1,
          persona: 0,
          recency: 0,
          seniority: 0,
        },
      };
    });
    const content = draftsToContent(
      drafts,
      HEADER,
      {
        roleTitle: "Engineer",
        seniority: "senior",
        mustHaveSkills: [],
        niceToHaveSkills: [],
        domains: [],
        atsKeywords: [],
        toneSignals: [],
        responsibilitiesText: "",
        qualificationsText: "",
      },
      ["experience"],
    );
    expect(content.experience).toHaveLength(1);
    expect(content.projects).toHaveLength(1);
    expect(content.publications).toHaveLength(1);
    expect(content.education).toHaveLength(1);
    expect(content.leadership).toHaveLength(1);
    expect(content.certifications).toHaveLength(1);
    expect(content.awards).toHaveLength(1);
    expect(content.volunteer).toHaveLength(1);

    for (const tmpl of [
      TYPST_ATS_SINGLE_TEMPLATE,
      TYPST_ATS_TWO_COLUMN_TEMPLATE,
    ]) {
      const rendered = renderResume(tmpl, content, ["experience"]);
      expect(rendered.source).toContain("Title volunteer");
      expect(rendered.source).toContain("Title certification");
      expect(rendered.source).toContain("Title award");
      const plain = renderedContentPlainText(content);
      const detected = simulateAtsParsing(plain, "generic")
        .sections.filter((s) => s.detected)
        .map((s) => s.name);
      expect(detected).toEqual(
        expect.arrayContaining([
          "experience",
          "projects",
          "publications",
          "education",
          "leadership",
          "certifications",
          "awards",
          "volunteer",
        ]),
      );
    }
  });
});
