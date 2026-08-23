/**
 * Hardened ATS simulation, keyword heatmap, and JD metadata extraction.
 *
 * Ported from IgniteCV (github.com/bharathvbcr/IgniteCV) services
 * `atsService.ts`, `keywordAnalysisService.ts`, and `metadataExtractor.ts`,
 * natively integrated into the career pipeline. Every adversarial case here
 * corresponds to a concrete defect in the upstream implementation:
 * dynamic RegExp built from unescaped JD words, O(n²) dedupe, ASCII-only
 * `\w` destroying non-Latin text, content lines misclassified as section
 * headers, and unbounded inputs.
 */
import { describe, expect, it } from "vitest";
import type { ResumeContent } from "@/lib/resume-templates/types";
import {
  ATS_MAX_INPUT_CHARS,
  analyzeJdMetadata,
  atsRulesFor,
  countBoundaryHits,
  detectAtsSystems,
  extractJdKeywords,
  formatForAts,
  generateKeywordHeatmap,
  renderedContentPlainText,
  simulateAtsParsing,
  splitResumeIntoSections,
} from "@/lib/resume-synthesis/ats-simulate";

describe("atsRulesFor", () => {
  it("exposes the seven ATS systems with their required sections", () => {
    expect(atsRulesFor("taleo").requiredSections).toEqual(["experience"]);
    expect(atsRulesFor("workday").requiredSections).toEqual([
      "experience",
      "education",
    ]);
    expect(atsRulesFor("icims").requiredSections).toEqual([
      "experience",
      "education",
    ]);
    expect(atsRulesFor("greenhouse").removeFormatting).toBe(false);
    expect(atsRulesFor("lever").plainTextOnly).toBe(false);
    expect(atsRulesFor("generic").sectionOrder.length).toBeGreaterThan(0);
  });
});

describe("detectAtsSystems", () => {
  it("detects named systems from the JD and falls back to generic", () => {
    expect(detectAtsSystems("Apply through our Workday portal")).toContain(
      "workday",
    );
    const none = detectAtsSystems("No portal mentioned at all");
    expect(none).toEqual(["generic"]);
  });

  it("never crashes on hostile inputs", () => {
    expect(detectAtsSystems("")).toEqual(["generic"]);
    expect(detectAtsSystems("\u0000\u202E workday")).toContain("workday");
    expect(detectAtsSystems("WORKDAY".repeat(10_000))).toContain("workday");
    expect(detectAtsSystems("greenhouse (lever) icims")).toHaveLength(3);
  });
});

describe("formatForAts", () => {
  it("strips markdown decoration for strict systems", () => {
    const md =
      "# Header\n**bold** and *italic* and `code`\n[label](https://x.dev)";
    const out = formatForAts(md, "taleo");
    expect(out).not.toMatch(/[#*`[\]]/);
    expect(out).toContain("bold");
    expect(out).toContain("label");
    expect(out).not.toContain("https://x.dev");
  });

  it("preserves accented and non-Latin letters instead of obliterating them", () => {
    // Upstream replaced [^\w\s...] which is ASCII-only: "José García 北京"
    // became "Jos  Garc a       ". The hardened port keeps real letters.
    const out = formatForAts("José García 北京", "generic");
    expect(out).toContain("José");
    expect(out).toContain("García");
    expect(out).toContain("北京");
  });

  it("keeps line structure for plain-text-only systems", () => {
    const out = formatForAts("line one\nline two\n\n\n\nline three", "taleo");
    expect(out.split("\n").map((l) => l.trim())).toEqual([
      "line one",
      "line two",
      "",
      "line three",
    ]);
  });

  it("leaves rich systems untouched apart from clamping", () => {
    const md = "# Title\n**bold**";
    expect(formatForAts(md, "greenhouse")).toBe(md);
  });
});

describe("countBoundaryHits", () => {
  it("matches at token boundaries and rejects substrings", () => {
    expect(countBoundaryHits("Go developer with Golang and go", "go")).toBe(2);
    expect(countBoundaryHits("developer with mongodb", "go")).toBe(0);
    expect(countBoundaryHits("Java on a JavaScript project", "java")).toBe(1);
    expect(countBoundaryHits("skilled in C++, cpp and c++.", "c++")).toBe(2);
    expect(countBoundaryHits("Node.js runtime", "node.js")).toBe(1);
  });

  it("survives regex metacharacters in the needle (upstream crashed)", () => {
    // Upstream built `new RegExp("\\b" + word + "\\b")` from raw JD text;
    // "(remote)", "c++", "s.r." threw or misfired.
    expect(() =>
      countBoundaryHits("fully (remote) role", "(remote)"),
    ).not.toThrow();
    expect(countBoundaryHits("fully (remote) role", "(remote)")).toBe(1);
    expect(countBoundaryHits("R&D and r", "r")).toBe(1); // & is not an edge
    expect(countBoundaryHits("$100 to $200", "$200")).toBe(1);
    expect(countBoundaryHits("a.b.c s.r. end", "s.r.")).toBe(1);
  });

  it("counts overlapping-adjacent occurrences correctly", () => {
    // Global regexes consume the trailing edge character and undercount;
    // the scanner must not.
    expect(countBoundaryHits("k8s k8s k8s", "k8s")).toBe(3);
    expect(countBoundaryHits("x, y, z", ", ")).toBe(0);
  });

  it("returns 0 for degenerate needles and empty hay", () => {
    expect(countBoundaryHits("", "anything")).toBe(0);
    expect(countBoundaryHits("text", "")).toBe(0);
    expect(countBoundaryHits("text", "   ")).toBe(0);
  });
});

describe("extractJdKeywords", () => {
  const JD =
    "We are hiring a Senior Platform Engineer to build scalable platforms. " +
    "The platform team owns Kubernetes clusters and PostgreSQL databases. " +
    "Platform engineers also automate deployments with Terraform.";

  it("ranks frequent domain words first and tiers importance", () => {
    const kws = extractJdKeywords(JD);
    expect(kws.length).toBeGreaterThan(0);
    expect(kws[0]?.word).toBe("platform"); // 4 mentions dominate the JD
    expect(kws[0]?.importance).toBe("high");
    const highCount = kws.filter((k) => k.importance === "high").length;
    expect(highCount).toBe(Math.min(10, kws.length));
    // Counts descend monotonically.
    for (let i = 1; i < kws.length; i++) {
      expect(kws[i]!.count).toBeLessThanOrEqual(kws[i - 1]!.count);
    }
  });

  it("drops stopwords and short noisy tokens", () => {
    const kws = extractJdKeywords(JD);
    const words = kws.map((k) => k.word);
    expect(words).not.toContain("with");
    expect(words).not.toContain("the");
    expect(words).not.toContain("also");
    expect(words.every((w) => w.length > 3)).toBe(true);
  });

  it("keeps hyphenated compounds intact", () => {
    const kws = extractJdKeywords("fast-paced environment fast-paced teams");
    expect(kws.some((k) => k.word === "fast-paced")).toBe(true);
  });

  it("handles empty, huge, and unicode input deterministically", () => {
    expect(extractJdKeywords("")).toEqual([]);
    expect(extractJdKeywords("!!! ???")).toEqual([]);
    const repeated = extractJdKeywords(
      "électricité réseaux réseaux électricité réseaux",
    );
    expect(repeated[0]?.word).toBe("réseaux");
    // Determinism: equal input, equal output.
    expect(extractJdKeywords(JD)).toEqual(extractJdKeywords(JD));
  });

  it("caps output at the requested limit", () => {
    const many = Array.from({ length: 500 }, (_, i) => `skill${i}`).join(" ");
    expect(extractJdKeywords(many, { limit: 25 })).toHaveLength(25);
  });
});

describe("splitResumeIntoSections", () => {
  const RESUME = [
    "Jane Doe",
    "jane@example.com",
    "",
    "SUMMARY",
    "Platform engineer with eight years of experience.",
    "",
    "EXPERIENCE",
    "Staff Engineer, Acme Corp, 2020-2024",
    "Led the migration of 40 services to Kubernetes.",
    "experience working across teams daily.", // trap: must NOT be a header
    "",
    "EDUCATION",
    "B.S. Computer Science, State University, 2016",
    "",
    "TECHNICAL SKILLS:",
    "Go, Kubernetes, PostgreSQL, Terraform",
  ].join("\n");

  it("splits on known header lines and captures bodies", () => {
    const sections = splitResumeIntoSections(RESUME);
    const names = sections.map((s) => s.name);
    expect(names).toEqual([
      "Introduction",
      "Summary",
      "Experience",
      "Education",
      "Skills",
    ]);
    const exp = sections.find((s) => s.name === "Experience");
    expect(exp?.text).toContain("Acme Corp");
    expect(exp?.text).toContain("experience working across teams daily.");
    expect(exp?.text).not.toContain("State University");
  });

  it("does not treat body lines that merely mention header words as headers", () => {
    const sections = splitResumeIntoSections(
      "EXPERIENCE\nexperience with distributed systems\nskills in Python and Go\ngained experience leading teams",
    );
    expect(sections.map((s) => s.name)).toEqual(["Experience"]);
  });

  it("normalizes decorations, casing, numbering, and colons", () => {
    const sections = splitResumeIntoSections(
      "== WORK HISTORY ==\nbuilt things\n1. Education\ncollege\nSkills:\ncoding",
    );
    expect(sections.map((s) => s.name)).toEqual([
      "Experience",
      "Education",
      "Skills",
    ]);
  });

  it("is total on hostile inputs", () => {
    expect(splitResumeIntoSections("")).toEqual([]);
    expect(splitResumeIntoSections("no headers at all\njust text")).toEqual([
      { name: "Introduction", text: "no headers at all\njust text" },
    ]);
    const crlf = splitResumeIntoSections(
      "SUMMARY\r\nshort\r\nEXPERIENCE\r\nwork\r\n",
    );
    expect(crlf.map((s) => s.name)).toEqual(["Summary", "Experience"]);
    // Bidi overrides are stripped, not just zero-width characters.
    const bidi = splitResumeIntoSections("\u202E SKILLS \u202C\nrust");
    expect(bidi.map((s) => s.name)).toEqual(["Skills"]);
  });
});

describe("simulateAtsParsing", () => {
  const RESUME = [
    "Jane Doe",
    "jane@example.com | +1 (415) 555-0100 x1234",
    "https://janedoe.dev https://github.com/janedoe",
    "SUMMARY",
    "Platform engineer.",
    "EXPERIENCE",
    "Staff Engineer, Acme Corp, 2020-2024",
    "Led migration to Kubernetes.",
    "SKILLS",
    "Go, Kubernetes, PostgreSQL",
    "EDUCATION",
    "B.S. Computer Science, State University",
  ].join("\n");

  it("detects sections, contact info, and required-section gaps", () => {
    const report = simulateAtsParsing(RESUME, "workday");
    const detected = report.sections
      .filter((s) => s.detected)
      .map((s) => s.name);
    expect(detected).toEqual(
      expect.arrayContaining(["summary", "experience", "education", "skills"]),
    );
    expect(report.missingRequiredSections).toEqual([]);
    expect(report.system).toBe("workday");
    expect(report.contactInfo.email).toBe("jane@example.com");
    expect(report.contactInfo.phone).toBe("+1 (415) 555-0100 x1234");
    expect(report.contactInfo.links).toHaveLength(2);
    expect(report.contactInfo.name).toBe("Jane Doe");
  });

  it("reports missing required sections for the chosen system", () => {
    const report = simulateAtsParsing("SUMMARY\nJust a summary.", "workday");
    expect(report.missingRequiredSections.sort()).toEqual([
      "education",
      "experience",
    ]);
  });

  it("flags tables/tabs, exotic symbols, and over-long lines", () => {
    const longLine = "x".repeat(140);
    const report = simulateAtsParsing(
      `SUMMARY\nA | B\tC\nEXPERIENCE\nDid ✨ great 💼 things\n${longLine}`,
      "generic",
    );
    expect(report.warnings.some((w) => /table|tab/i.test(w))).toBe(true);
    expect(report.warnings.some((w) => /special|icon/i.test(w))).toBe(true);
    expect(report.warnings.some((w) => /long line|truncat/i.test(w))).toBe(
      true,
    );
  });

  it("ignores digits inside long ID-like numbers when extracting phones", () => {
    const report = simulateAtsParsing(
      "EXPERIENCE\nReference 123456789012345678901234567890 invoice",
      "generic",
    );
    expect(report.contactInfo.phone).toBeNull();
  });

  it("never throws on hostile payloads", () => {
    const hostile = [
      "",
      "\u0000".repeat(1000),
      "((".repeat(500),
      `${"a".repeat(300)}@${"b".repeat(300)}.com`,
      "📞 🎉 ✅".repeat(100),
    ];
    for (const payload of hostile) {
      expect(() => simulateAtsParsing(payload, "generic")).not.toThrow();
    }
    const tiny = simulateAtsParsing("", "taleo");
    expect(tiny.sections.every((s) => !s.detected)).toBe(true);
    expect(tiny.warnings).toEqual([]);
  });

  it("clamps oversized input instead of hanging", () => {
    const giant = `${"word ".repeat(200_000)}SKILLS\ngo`;
    const t0 = Date.now();
    const report = simulateAtsParsing(giant, "generic");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(report.inputChars).toBeLessThanOrEqual(ATS_MAX_INPUT_CHARS);
  });
});

describe("generateKeywordHeatmap", () => {
  it("computes per-section density, heat levels, and critical misses", () => {
    const jd =
      "Requirements: deep Kubernetes operations and PostgreSQL tuning. " +
      "Kafka streaming plus Terraform automation required. " +
      "Kubernetes and Kafka experience preferred; Terraform and PostgreSQL a plus.";
    const resume = [
      "SUMMARY",
      "Engineer.",
      "EXPERIENCE",
      "Ran Kubernetes in production and tuned PostgreSQL clusters.",
      "SKILLS",
      "Kubernetes, PostgreSQL",
    ].join("\n");

    const heat = generateKeywordHeatmap(resume, jd);
    expect(heat.sections.length).toBeGreaterThanOrEqual(3);
    const exp = heat.sections.find((s) => s.name === "Experience");
    expect(exp?.keywords.map((k) => k.word)).toEqual(
      expect.arrayContaining(["kubernetes", "postgresql"]),
    );
    expect(exp?.heatLevel).toBeGreaterThanOrEqual(3);
    expect(heat.overallDensity).toBeGreaterThan(0);
    // The genuinely critical misses (kafka/terraform) are flagged; skills the
    // resume covers are not; frequency-noise words may legitimately rank too.
    const missing = heat.missingCriticalKeywords;
    expect(missing).toContain("kafka");
    expect(missing).toContain("terraform");
    expect(missing).not.toContain("kubernetes");
    expect(missing).not.toContain("postgresql");
    expect(heat.overusedKeywords).toEqual([]);
  });

  it("marks keyword-stuffed resumes as overheated", () => {
    const jd = "Looking for dedicated platform engineers.";
    const stuffed = [
      "SKILLS",
      Array.from({ length: 40 }, () => "platform engineers dedicated").join(
        " ",
      ),
    ].join("\n");
    const heat = generateKeywordHeatmap(stuffed, jd);
    expect(heat.overusedKeywords.sort()).toEqual([
      "dedicated",
      "engineers",
      "platform",
    ]);
    const skills = heat.sections.find((s) => s.name === "Skills");
    expect(skills?.heatLevel).toBe(5);
  });

  it("returns a cold, empty heatmap on empty inputs", () => {
    const heat = generateKeywordHeatmap("", "");
    expect(heat.sections).toEqual([]);
    expect(heat.overallDensity).toBe(0);
    expect(heat.missingCriticalKeywords).toEqual([]);
    expect(heat.overusedKeywords).toEqual([]);
  });

  it("is total under hostile traffic", () => {
    const heat = generateKeywordHeatmap(
      "\u0000\u202E SKILLS\n((",
      "Kubernetes ((( ((( kubernetes",
    );
    expect(Number.isFinite(heat.overallDensity)).toBe(true);
    heat.sections.forEach((s) => {
      expect(Number.isFinite(s.density)).toBe(true);
      expect(s.heatLevel).toBeGreaterThanOrEqual(0);
      expect(s.heatLevel).toBeLessThanOrEqual(5);
    });
  });
});

describe("analyzeJdMetadata", () => {
  it("extracts title, company, location, salary, level, benefits, culture", () => {
    const jd = [
      "Position: Senior Platform Engineer",
      "Company: ExampleCorp is seeking a platform specialist.",
      "Location: Remote (US)",
      "Posted: 03/15/2026",
      "Salary: $120,000 - $150,000",
      "Benefits: 401(k), health insurance, unlimited PTO",
      "We are a fast-paced, collaborative team with an ownership mindset.",
      "Requirements:",
      "- 5 years of Kubernetes",
      "- PostgreSQL tuning",
      "Preferred:",
      "* Terraform experience",
      "Bonus:",
      "+ Rust knowledge",
    ].join("\n");

    const meta = analyzeJdMetadata(jd);
    expect(meta.jobTitle).toBe("Senior Platform Engineer");
    expect(meta.company).toBe("ExampleCorp");
    expect(meta.experienceLevel).toBe("senior");
    expect(meta.salaryRange).toEqual({
      min: 120000,
      max: 150000,
      currency: "$",
    });
    expect(meta.salarySummary).toContain("120,000");
    expect(meta.benefits).toEqual(
      expect.arrayContaining(["401(k)", "health insurance", "unlimited pto"]),
    );
    expect(meta.cultureKeywords).toEqual(
      expect.arrayContaining(["fast-paced", "collaborative", "ownership"]),
    );
    expect(meta.requirements.mustHave.join(" ")).toContain("Kubernetes");
    expect(meta.requirements.preferred.join(" ")).toContain("Terraform");
    expect(meta.requirements.bonusSkills.join(" ")).toContain("Rust");
    expect(meta.postedDate).toBe("03/15/2026");
  });

  it("rejects inverted or nonsense salary ranges instead of reporting them", () => {
    const meta = analyzeJdMetadata("Salary: $150,000 - $120,000");
    expect(meta.salaryRange).toBeNull();
    expect(
      analyzeJdMetadata("Pay: $50-$60 an hour, part time").salaryRange?.min,
    ).toBe(50);
  });

  it("categorizes experience levels across phrasings", () => {
    expect(
      analyzeJdMetadata("VP of Engineering, Director level").experienceLevel,
    ).toBe("executive");
    expect(analyzeJdMetadata("Principal engineer wanted").experienceLevel).toBe(
      "lead",
    );
    expect(analyzeJdMetadata("Junior developer role").experienceLevel).toBe(
      "entry",
    );
    expect(analyzeJdMetadata("Graduate program 2026").experienceLevel).toBe(
      "entry",
    );
    expect(
      analyzeJdMetadata("Mid-level intermediate role").experienceLevel,
    ).toBe("mid");
    expect(analyzeJdMetadata("No signals here").experienceLevel).toBeNull();
  });

  it("is total on hostile inputs", () => {
    for (const payload of [
      "",
      "((( ))) $" + "{jndi:ldap://evil}",
      "\u0000".repeat(500),
    ]) {
      expect(() => analyzeJdMetadata(payload)).not.toThrow();
    }
    const meta = analyzeJdMetadata("");
    expect(meta.jobTitle).toBeNull();
    expect(meta.company).toBeNull();
    expect(meta.requirements.mustHave).toEqual([]);
  });

  it("bounds requirement extraction on pathological JDs", () => {
    const bullets = Array.from({ length: 5000 }, (_, i) => `- req ${i}`).join(
      "\n",
    );
    const meta = analyzeJdMetadata(`Requirements:\n${bullets}`);
    expect(meta.requirements.mustHave.length).toBeLessThanOrEqual(50);
  });
});

describe("renderedContentPlainText", () => {
  it("flattens synthesized ResumeContent the way templates print it", () => {
    const content = {
      header: {
        fullName: "Jane Doe",
        cityRegion: "San Francisco, CA",
        email: "jane@example.com",
        phone: "+1 415 555 0100",
        website: "https://janedoe.dev",
      },
      summary: "Platform engineer.",
      skills: [{ label: "Core", items: "Go, Kubernetes" }],
      experience: [
        {
          id: "e1",
          title: "Staff Engineer",
          org: "Acme",
          dateRange: "2020 – 2024",
          bullets: ["Led migration to Kubernetes with 40% fewer incidents."],
          canonicalBullets: [],
        },
      ],
    } as unknown as ResumeContent;

    const text = renderedContentPlainText(content);
    expect(text).toContain("Jane Doe");
    expect(text).toContain("jane@example.com");
    expect(text).toContain("SUMMARY");
    expect(text).toContain("EXPERIENCE");
    expect(text).toContain("Staff Engineer, Acme");
    expect(text).toContain("40% fewer incidents");
    expect(text).toContain("Core: Go, Kubernetes");

    // And the flattened text must survive the ATS simulator end-to-end.
    const report = simulateAtsParsing(text, "generic");
    expect(report.contactInfo.email).toBe("jane@example.com");
    expect(report.sections.find((s) => s.name === "summary")?.detected).toBe(
      true,
    );
    expect(report.sections.find((s) => s.name === "experience")?.detected).toBe(
      true,
    );
  });

  it("tolerates missing optional parts", () => {
    const text = renderedContentPlainText({
      header: { fullName: "", cityRegion: "", email: "", phone: "" },
      summary: undefined,
      skills: [],
    } as unknown as ResumeContent);
    expect(typeof text).toBe("string");
    expect(() => simulateAtsParsing(text, "generic")).not.toThrow();
  });
});
