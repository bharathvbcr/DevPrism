import { describe, expect, it } from "vitest";
import {
  computeEmbeddingText,
  createEmptyBlock,
  parseCommaList,
  parseSkillsList,
} from "@/lib/career/block-helpers";
import {
  extractResumeDeterministic,
  mergeResumeHeader,
  mergeResumeSummary,
  parseExtractedBlocks,
  tryParseJsonLoose,
} from "@/lib/career/extract-resume";
import { canonicalizeBlockKind } from "@/lib/resume-sections";
import type { HeaderFields } from "@/lib/resume-templates";

describe("tryParseJsonLoose", () => {
  it("parses fenced JSON", () => {
    const raw = 'Here:\n```json\n{"blocks":[]}\n```';
    expect(tryParseJsonLoose(raw)).toEqual({ blocks: [] });
  });

  it("recovers object after prose", () => {
    expect(tryParseJsonLoose('Sure. {"a":1}')).toEqual({ a: 1 });
  });
});

describe("parseExtractedBlocks", () => {
  it("maps LLM payload into draft ExperienceBlock[]", () => {
    const raw = JSON.stringify({
      blocks: [
        {
          kind: "experience",
          title: "ML Engineer",
          org: "Acme",
          dateStart: "2021-03",
          dateEnd: null,
          domains: ["mlops"],
          skills: ["python", "pytorch"],
          seniorityLevel: "senior",
          bullets: ["Built training pipelines", "Cut latency 40%"],
          facts: ["Owned on-call for training cluster", "Migrated to Ray"],
        },
      ],
    });
    const blocks = parseExtractedBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe("ML Engineer");
    expect(blocks[0].org).toBe("Acme");
    expect(blocks[0].dateRange).toEqual({ start: "2021-03", end: null });
    expect(blocks[0].skills.map((s) => s.name)).toEqual(["python", "pytorch"]);
    expect(blocks[0].bullets.map((b) => b.canonical)).toEqual([
      "Built training pipelines",
      "Cut latency 40%",
    ]);
    expect(blocks[0].facts.map((f) => f.text)).toEqual([
      "Owned on-call for training cluster",
      "Migrated to Ray",
    ]);
    expect(blocks[0].facts.every((f) => f.source === "import")).toBe(true);
    expect(blocks[0].id).toMatch(/^exp_/);
  });

  it("defaults facts to [] when omitted (backward compatible)", () => {
    const raw = JSON.stringify({
      blocks: [
        {
          title: "Engineer",
          org: "Lab",
          bullets: ["Shipped X"],
        },
      ],
    });
    const blocks = parseExtractedBlocks(raw);
    expect(blocks[0].facts).toEqual([]);
  });

  it("skips empty rows and tolerates alternate field names", () => {
    const raw = JSON.stringify({
      blocks: [
        { title: "", org: "" },
        {
          role: "Intern",
          company: "Lab",
          kind: "project",
          bullets: ["Did science"],
        },
      ],
    });
    const blocks = parseExtractedBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe("Intern");
    expect(blocks[0].org).toBe("Lab");
    expect(blocks[0].kind).toBe("project");
  });

  it("returns [] for unparseable output", () => {
    expect(parseExtractedBlocks("not json")).toEqual([]);
  });

  it("canonicalizes plural and synonym kinds instead of coercing to experience", () => {
    const blocks = parseExtractedBlocks(
      JSON.stringify({
        blocks: [
          {
            kind: "certifications",
            title: "AWS SAA",
            org: "Amazon",
            bullets: ["Passed"],
          },
          {
            kind: "Certificates",
            title: "CKA",
            org: "CNCF",
            bullets: ["Passed"],
          },
          {
            kind: "awards",
            title: "Best Paper",
            org: "NeurIPS",
            bullets: ["Systems"],
          },
          {
            kind: "projects",
            title: "Compiler",
            org: "Personal",
            bullets: ["Shipped"],
          },
          {
            kind: "publications",
            title: "Nature paper",
            org: "Nature",
            bullets: ["Accepted"],
          },
          {
            kind: "  volunteer experience  ",
            title: "Mentor",
            org: "Code.org",
            bullets: ["Mentored 12"],
          },
        ],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "certification",
      "certification",
      "award",
      "project",
      "publication",
      "volunteer",
    ]);
  });

  it("fails closed on unknown/hostile kinds without throwing", () => {
    expect(() =>
      parseExtractedBlocks(
        JSON.stringify({
          blocks: [
            { kind: 12, title: "X", org: "Y", bullets: ["z"] },
            { kind: "drop-table", title: "X", org: "Y", bullets: ["z"] },
            { kind: { $gt: "" }, title: "X", org: "Y", bullets: ["z"] },
          ],
        }),
      ),
    ).not.toThrow();
    const blocks = parseExtractedBlocks(
      JSON.stringify({
        blocks: [{ kind: "drop-table", title: "X", org: "Y", bullets: ["z"] }],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual([]);
  });

  it("still defaults an omitted kind to experience", () => {
    const blocks = parseExtractedBlocks(
      JSON.stringify({
        blocks: [{ title: "Engineer", org: "Acme", bullets: ["Shipped"] }],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["experience"]);
  });

  it("omits unknown kinds instead of stuffing them into experience", () => {
    const blocks = parseExtractedBlocks(
      JSON.stringify({
        blocks: [
          { kind: "drop-table", title: "X", org: "Y", bullets: ["z"] },
          { kind: 12, title: "X", org: "Y", bullets: ["z"] },
          { title: "Engineer", org: "Acme", bullets: ["Shipped"] },
        ],
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["experience"]);
    expect(blocks[0]?.title).toBe("Engineer");
  });

  it("clamps oversized extract payloads instead of materializing thousands of blocks", () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => ({
      kind: "experience",
      title: `Role ${i}`,
      org: `Org ${i}`,
      bullets: ["Did a thing"],
    }));
    const parsed = parseExtractedBlocks(JSON.stringify({ blocks }));
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThanOrEqual(200);
  });
});

describe("block helpers", () => {
  it("computeEmbeddingText joins title, org, domains, skills, bullets", () => {
    const block = createEmptyBlock({
      title: "Eng",
      org: "Acme",
      domains: ["ml"],
      skills: [{ name: "python", level: 3 }],
      bullets: [
        {
          id: "blt_1",
          canonical: "Shipped X",
          variants: {},
          metrics: [],
          evidenceRefs: [],
          locked: false,
        },
      ],
    });
    expect(computeEmbeddingText(block)).toBe(
      "Eng\nAcme\nml\npython\nShipped X",
    );
  });

  it("parseCommaList and parseSkillsList trim tokens", () => {
    expect(parseCommaList(" a, b ; c\nd ")).toEqual(["a", "b", "c", "d"]);
    expect(parseSkillsList("rust, go")).toEqual([
      { name: "rust", level: 3 },
      { name: "go", level: 3 },
    ]);
  });
});

describe("canonicalizeBlockKind IgniteCV synonyms", () => {
  it("maps community service and extracurricular kinds", () => {
    expect(canonicalizeBlockKind("community service")).toBe("volunteer");
    expect(canonicalizeBlockKind("community involvement")).toBe("volunteer");
    expect(canonicalizeBlockKind("extra curricular activities")).toBe(
      "leadership",
    );
  });
});

describe("extractResumeDeterministic", () => {
  it("parses Jake-style LaTeX resume sections into career blocks", () => {
    const src = String.raw`
\section{Experience}
\resumeSubheading{ML Engineer}{Jan 2021 -- Present}{Acme}{Remote}
\resumeItemListStart
\resumeItem{Built training pipelines}
\resumeItem{Cut latency 40\%}
\resumeItemListEnd
\section{Projects}
\resumeSubheading{Compiler}{2024}{Personal}{}
\resumeItem{Shipped a bytecode VM}
\section{Honors \& Awards}
\resumeSubheading{Best Paper}{2022}{NeurIPS}{}
\section{Volunteer Experience}
\resumeSubheading{Mentor}{2021 -- 2022}{Code.org}{}
\resumeItem{Mentored 12 students}
`;
    const extracted = extractResumeDeterministic(src);
    expect(extracted.blocks.map((b) => b.kind)).toEqual([
      "experience",
      "project",
      "award",
      "volunteer",
    ]);
    expect(extracted.blocks[0]?.title).toBe("ML Engineer");
    expect(extracted.blocks[0]?.org).toBe("Acme");
    expect(extracted.blocks[0]?.bullets.map((b) => b.canonical)).toEqual([
      "Built training pipelines",
      "Cut latency 40%",
    ]);
    expect(extracted.blocks[2]?.title).toBe("Best Paper");
    expect(extracted.blocks[3]?.kind).toBe("volunteer");
  });

  it("parses resumeProfessionalExperience and unwraps cvonly/resonly", () => {
    const src = String.raw`
\section{Professional Experience}
\resumeProfessionalExperience{AI Engineer}{SofTech}{FEB 2026 to Present}
\cvonly{%
\resumeItemListStart
\resumeItem{Ship LLM features end to end}
\resumeItemListEnd%
}
\resonly{%
\resumeItemListStart
\resumeItem{Shipped production LLM features}
\resumeItemListEnd%
}
`;
    const extracted = extractResumeDeterministic(src);
    expect(extracted.blocks).toHaveLength(1);
    expect(extracted.blocks[0]?.title).toBe("AI Engineer");
    expect(extracted.blocks[0]?.org).toBe("SofTech");
    expect(extracted.blocks[0]?.dateRange.end).toBeNull();
    expect(extracted.blocks[0]?.bullets.map((b) => b.canonical)).toEqual(
      expect.arrayContaining([
        "Ship LLM features end to end",
        "Shipped production LLM features",
      ]),
    );
  });

  it("parses IgniteCV-style markdown/plain-text sections including skills and summary", () => {
    const src = `
Jane Doe
jane@example.com
+1 (415) 555-0100
https://linkedin.com/in/janedoe
https://github.com/janedoe

Summary
Staff engineer shipping ML systems.

Experience
Acme | ML Engineer | 2021 -- Present
- Built training pipelines
- Cut latency 40%

Education
MIT | BSc Computer Science | 2018

Skills
Python, PyTorch, Rust

Languages
English, Tamil

Certifications
AWS SAA | Amazon | 2023
`;
    const extracted = extractResumeDeterministic(src);
    expect(extracted.header.fullName).toBe("Jane Doe");
    expect(extracted.header.email).toBe("jane@example.com");
    expect(extracted.header.linkedinUrl).toContain("linkedin.com/in/janedoe");
    expect(extracted.header.githubUrl).toContain("github.com/janedoe");
    expect(extracted.summary).toMatch(/Staff engineer/i);
    expect(extracted.skillGroups.some((g) => /python/i.test(g.items))).toBe(
      true,
    );
    const kinds = extracted.blocks.map((b) => b.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["experience", "education", "certification"]),
    );
    expect(
      extracted.blocks
        .find((b) => b.kind === "experience")
        ?.skills.map((s) => s.name),
    ).toEqual(expect.arrayContaining(["Python", "PyTorch", "Rust"]));
    expect(
      extracted.blocks
        .find((b) => b.kind === "experience")
        ?.skills.map((s) => s.name),
    ).not.toEqual(expect.arrayContaining(["English", "Tamil"]));
    const cert = extracted.blocks.find((b) => b.kind === "certification");
    expect(cert?.title).toBe("AWS SAA");
    expect(cert?.org).toBe("Amazon");
    expect(extracted.skillGroups.some((g) => g.label === "Languages")).toBe(
      true,
    );
  });

  it("reads a Jake-style LaTeX contact header without keeping command residue", () => {
    const src = String.raw`
\documentclass[letterpaper,11pt]{article}
\begin{document}
\textbf{\Huge \scshape Jane Doe} \\
San Francisco, CA \\
\href{mailto:jane@example.com}{jane@example.com} \\
\href{https://linkedin.com/in/janedoe}{linkedin.com/in/janedoe} \\
\href{https://github.com/janedoe}{github.com/janedoe}
\section{Experience}
\resumeSubheading{ML Engineer}{2021}{Acme}{Remote}
\resumeItem{Shipped}
\end{document}
`;
    const extracted = extractResumeDeterministic(src);
    expect(extracted.header.fullName).toBe("Jane Doe");
    expect(extracted.header.email).toBe("jane@example.com");
    expect(extracted.header.cityRegion).toBe("San Francisco, CA");
    expect(extracted.header.linkedinUrl).toContain("linkedin.com/in/janedoe");
    expect(extracted.header.githubUrl).toContain("github.com/janedoe");
    expect(extracted.header.fullName).not.toMatch(/textbf|scshape|Huge/);
  });

  it("fails closed on unclosed braces instead of hanging or inventing blocks", () => {
    const hostile = `\\section{Experience}\n\\resumeSubheading{Role}{2020}{Acme}{Remote\n\\resumeItem{no close`;
    const extracted = extractResumeDeterministic(hostile.repeat(50));
    expect(extracted.blocks.length).toBeLessThanOrEqual(200);
  });

  it("clamps a flood of latex entries", () => {
    const flood = Array.from(
      { length: 400 },
      (_, i) =>
        `\\resumeSubheading{Role ${i}}{2020}{Org ${i}}{}\n\\resumeItem{Did ${i}}\n`,
    ).join("");
    const extracted = extractResumeDeterministic(
      `\\section{Experience}\n${flood}`,
    );
    expect(extracted.blocks.length).toBeGreaterThan(0);
    expect(extracted.blocks.length).toBeLessThanOrEqual(200);
  });
});

describe("mergeResumeHeader", () => {
  it("fills empty fields and never overwrites a user-entered value", () => {
    const existing: HeaderFields = {
      fullName: "Ada",
      cityRegion: "",
      email: "",
      phone: "",
    };
    const merged = mergeResumeHeader(existing, {
      fullName: "Someone Else",
      email: "ada@example.com",
      linkedinUrl: "https://linkedin.com/in/ada",
    });
    expect(merged.fullName).toBe("Ada");
    expect(merged.email).toBe("ada@example.com");
    expect(merged.linkedinUrl).toContain("linkedin.com");
  });
});

describe("mergeResumeSummary", () => {
  it("fills an empty summary and never overwrites a user-entered one", () => {
    expect(mergeResumeSummary("", "Staff engineer shipping ML.")).toBe(
      "Staff engineer shipping ML.",
    );
    expect(mergeResumeSummary("Keep me", "Someone else")).toBe("Keep me");
  });
});
