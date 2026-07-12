import { describe, expect, it } from "vitest";
import {
  computeEmbeddingText,
  createEmptyBlock,
  parseCommaList,
  parseSkillsList,
} from "@/lib/career/block-helpers";
import {
  parseExtractedBlocks,
  tryParseJsonLoose,
} from "@/lib/career/extract-resume";

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
