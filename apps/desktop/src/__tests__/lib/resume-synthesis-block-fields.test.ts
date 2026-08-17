import { describe, expect, it } from "vitest";
import { draftsToContent } from "@/lib/resume-synthesis/orchestrator";
import { createEmptyBlock, newBullet } from "@/lib/career/block-helpers";
import type { RewrittenBlockDraft } from "@/lib/resume-synthesis/types";
import type { HeaderFields } from "@/lib/resume-templates";

const HEADER: HeaderFields = {
  fullName: "Ada",
  cityRegion: "",
  email: "",
  phone: "",
};

const PROFILE = {
  mustHaveSkills: [],
  niceToHaveSkills: [],
  atsKeywords: [],
} as unknown as Parameters<typeof draftsToContent>[2];

function draft(overrides: Record<string, unknown>): RewrittenBlockDraft {
  const block = createEmptyBlock({
    id: "edu_1",
    kind: "education",
    title: "BSc Mathematics",
    org: "University",
    dateRange: { start: "2016", end: "2020" },
    bullets: [newBullet("Studied things.")],
    ...overrides,
  });
  return {
    block,
    bullets: [{ text: "Studied things.", usedCanonical: true }],
    evidence: [],
    score: 1,
    components: {},
  } as unknown as RewrittenBlockDraft;
}

describe("draftsToContent field mapping", () => {
  it("carries location, url, urlLabel and extra (GPA) onto the rendered block", () => {
    // These are rendered by the template but were previously never populated,
    // making GPA / location / org links unreachable in every resume.
    const content = draftsToContent(
      [
        draft({
          location: "Cambridge, UK",
          url: "https://uni.example",
          urlLabel: "uni",
          extra: "GPA 3.9/4.0",
        }),
      ],
      HEADER,
      PROFILE,
      ["education"],
    );
    const edu = content.education?.[0];
    expect(edu).toBeDefined();
    expect(edu?.location).toBe("Cambridge, UK");
    expect(edu?.url).toBe("https://uni.example");
    expect(edu?.urlLabel).toBe("uni");
    expect(edu?.extra).toBe("GPA 3.9/4.0");
    // The extra line is locked content, so it gets a canonical fallback too.
    expect(edu?.canonicalExtra).toBe("GPA 3.9/4.0");
  });

  it("leaves the fields undefined when the block has none", () => {
    const content = draftsToContent([draft({})], HEADER, PROFILE, [
      "education",
    ]);
    const edu = content.education?.[0];
    expect(edu?.location).toBeUndefined();
    expect(edu?.url).toBeUndefined();
    expect(edu?.extra).toBeUndefined();
  });
});
