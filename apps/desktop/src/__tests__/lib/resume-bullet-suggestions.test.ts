import { describe, expect, it } from "vitest";
import {
  analyzeBulletQuality,
  buildResumeBulletSuggestions,
  bulletQualityGrade,
  bulletQualityInsights,
  bulletQualityScore,
  diagnoseBulletItems,
  findSuggestionById,
  parseLatexItemBodies,
  recommendedBulletTarget,
  suggestionIdForInsight,
} from "@/lib/resume-bullet-suggestions";

const WEAK_BULLETS = `\\begin{itemize}
  \\item Responsible for maintaining the API
  \\item Worked on improving deployment pipelines
  \\item Helped the team ship features faster
\\end{itemize}`;

const STRONG_BULLETS = `\\begin{itemize}
  \\item Reduced API latency 35% by adding Redis across 5 services
  \\item Cut deploy time 40% by rebuilding CI/CD in GitHub Actions
  \\item Shipped 12 features to 2M users with 99.9% uptime
\\end{itemize}`;

describe("parseLatexItemBodies", () => {
  it("extracts bullet bodies", () => {
    const bodies = parseLatexItemBodies(STRONG_BULLETS);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain("35%");
  });
});

describe("analyzeBulletQuality", () => {
  it("flags weak openers and missing metrics", () => {
    const quality = analyzeBulletQuality(WEAK_BULLETS);
    expect(quality.weakOpeners).toBeGreaterThan(0);
    expect(quality.withoutMetrics).toBe(3);
  });

  it("scores strong bullets higher on metrics", () => {
    const quality = analyzeBulletQuality(STRONG_BULLETS);
    expect(quality.withoutMetrics).toBe(0);
    expect(quality.weakOpeners).toBe(0);
  });
});

describe("recommendedBulletTarget", () => {
  it("suggests fewer bullets when resume spans multiple pages", () => {
    const quality = analyzeBulletQuality(STRONG_BULLETS);
    const target = recommendedBulletTarget(
      {
        bulletText: STRONG_BULLETS,
        itemCount: 3,
        compiledPageCount: 2,
      },
      quality,
    );
    expect(target).toBe(2);
  });

  it("suggests 3 when role has 5 bullets", () => {
    const text = `\\begin{itemize}
${Array.from({ length: 5 }, (_, i) => `  \\item Achievement ${i + 1} with impact`).join("\n")}
\\end{itemize}`;
    const quality = analyzeBulletQuality(text);
    expect(
      recommendedBulletTarget({ bulletText: text, itemCount: 5 }, quality),
    ).toBe(3);
  });
});

describe("bulletQualityInsights", () => {
  it("surfaces page overflow and metric gaps", () => {
    const quality = analyzeBulletQuality(WEAK_BULLETS);
    const insights = bulletQualityInsights(quality, {
      bulletText: WEAK_BULLETS,
      itemCount: 3,
      compiledPageCount: 2,
    });
    expect(insights.some((i) => i.includes("pages"))).toBe(true);
    expect(insights.some((i) => i.includes("metrics"))).toBe(true);
  });
});

describe("buildResumeBulletSuggestions", () => {
  it("includes metric and verb refinements for weak bullets", () => {
    const suggestions = buildResumeBulletSuggestions({
      bulletText: WEAK_BULLETS,
      itemCount: 3,
    });
    const ids = suggestions.map((s) => s.id);
    expect(ids).toContain("add-metrics");
    expect(ids).toContain("stronger-verbs");
  });

  it("includes JD matching when a job description exists", () => {
    const suggestions = buildResumeBulletSuggestions({
      bulletText: STRONG_BULLETS,
      itemCount: 3,
      hasJobDescription: true,
    });
    expect(suggestions.some((s) => s.id === "match-jd")).toBe(true);
  });

  it("includes fit-one-page when compiled length overflows", () => {
    const fourBullets = `\\begin{itemize}
  \\item Reduced API latency 35% by adding Redis across 5 services
  \\item Cut deploy time 40% by rebuilding CI/CD in GitHub Actions
  \\item Shipped 12 features to 2M users with 99.9% uptime
  \\item Mentored 4 engineers on system design
\\end{itemize}`;
    const suggestions = buildResumeBulletSuggestions({
      bulletText: fourBullets,
      itemCount: 4,
      compiledPageCount: 2,
    });
    expect(suggestions.some((s) => s.id === "fit-one-page")).toBe(true);
  });

  it("includes advice chips for dense single-bullet roles", () => {
    const text = `\\begin{itemize}
  \\item Built and maintained the entire payments platform including fraud detection, reconciliation, and reporting for three years across multiple teams and services
\\end{itemize}`;
    const suggestions = buildResumeBulletSuggestions({
      bulletText: text,
      itemCount: 1,
    });
    expect(suggestions.some((s) => s.id === "how-to-split")).toBe(true);
  });
});

describe("bulletQualityScore", () => {
  it("scores strong bullets higher than weak ones", () => {
    const weak = analyzeBulletQuality(WEAK_BULLETS);
    const strong = analyzeBulletQuality(STRONG_BULLETS);
    expect(bulletQualityScore(strong)).toBeGreaterThan(bulletQualityScore(weak));
    expect(bulletQualityGrade(bulletQualityScore(strong))).toBe("Strong");
  });
});

describe("diagnoseBulletItems", () => {
  it("tags weak bullets with issues", () => {
    const items = diagnoseBulletItems(WEAK_BULLETS);
    expect(items.some((i) => i.issues.includes("weak-opener"))).toBe(true);
    expect(items.some((i) => i.issues.includes("no-metric"))).toBe(true);
  });
});

describe("suggestionIdForInsight", () => {
  it("maps insights to fix ids", () => {
    expect(suggestionIdForInsight("2 bullets lack metrics")).toBe("add-metrics");
    expect(suggestionIdForInsight("Some bullets overlap — consider merging")).toBe(
      "remove-redundancy",
    );
  });

  it("finds suggestions by id", () => {
    const suggestions = buildResumeBulletSuggestions({
      bulletText: WEAK_BULLETS,
      itemCount: 3,
    });
    expect(findSuggestionById(suggestions, "add-metrics")?.label).toBe(
      "Add metrics",
    );
  });
});
