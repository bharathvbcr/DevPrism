import { describe, expect, it, vi } from "vitest";
import type { ExperienceBlock, Persona } from "@/lib/career/types";
import {
  computeAtsCoveragePct,
  enforceBulletInvariants,
  repairFlagged,
} from "@/lib/resume-synthesis";
import type {
  CriticResult,
  JDProfile,
  RewrittenBlockDraft,
} from "@/lib/resume-synthesis/types";
import {
  renderTemplate,
  setSlotPlainText,
  ATS_RESUME_TEMPLATE,
} from "@/lib/resume-templates";
import type { ResumeContent } from "@/lib/resume-templates/types";

function draft(
  bullets: Array<{ id: string; text: string }>,
  skills: string[] = [],
): RewrittenBlockDraft {
  const block: ExperienceBlock = {
    id: "exp_1",
    kind: "experience",
    title: "Engineer",
    org: "Acme",
    dateRange: { start: "2022-01", end: null },
    personas: [],
    domains: [],
    skills: skills.map((name) => ({ name, level: 4 as const })),
    seniorityLevel: "senior",
    bullets: bullets.map((b) => ({
      id: b.id,
      canonical: b.text,
      variants: {},
      metrics: [],
      evidenceRefs: [],
      locked: false,
    })),
    facts: [],
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  return {
    block,
    bullets: bullets.map((b) => ({
      id: b.id,
      text: b.text,
      usedCanonical: false,
      fallbackReason: null,
    })),
    evidence: [],
    score: 0.8,
    components: {
      embedding: 0.8,
      skills: 0.8,
      persona: 1,
      recency: 0.5,
      seniority: 1,
    },
  };
}

describe("computeAtsCoveragePct", () => {
  it("scores keyword ∩ bullet/skill text with word boundaries", () => {
    const pct = computeAtsCoveragePct(
      [
        draft(
          [
            {
              id: "b1",
              text: "Built Python services and ML pipelines",
            },
          ],
          ["PyTorch"],
        ),
      ],
      ["Python", "PyTorch", "Kubernetes"],
    );
    // 2 of 3
    expect(pct).toBe(67);
  });

  it("does not count Java toward JavaScript keyword", () => {
    const pct = computeAtsCoveragePct(
      [draft([{ id: "b1", text: "Wrote Java backends" }])],
      ["JavaScript"],
    );
    expect(pct).toBe(0);
  });
});

describe("enforceBulletInvariants fallback reasons", () => {
  const bullet = {
    id: "b1",
    canonical: "Cut latency 40%",
    variants: {},
    metrics: [{ value: "40%", kind: "pct" as const }],
    evidenceRefs: [],
    locked: false,
  };

  it("returns null reason when AI text kept", () => {
    const out = enforceBulletInvariants(
      "Cut latency 40% with caching",
      bullet,
      140,
    );
    expect(out.usedCanonical).toBe(false);
    expect(out.fallbackReason).toBeNull();
  });

  it("returns latex-rejected / metrics-lost / over-budget / locked", () => {
    expect(
      enforceBulletInvariants("bad \\vspace{1em}", bullet, 140).fallbackReason,
    ).toBe("latex-rejected");
    expect(
      enforceBulletInvariants("Cut latency a lot", bullet, 140).fallbackReason,
    ).toBe("metrics-lost");
    expect(
      enforceBulletInvariants(`${"x".repeat(200)} 40%`, bullet, 50)
        .fallbackReason,
    ).toBe("over-budget");
    expect(
      enforceBulletInvariants("ignored", { ...bullet, locked: true }, 140)
        .fallbackReason,
    ).toBe("locked");
    expect(enforceBulletInvariants("   ", bullet, 140).fallbackReason).toBe(
      "llm-failed",
    );
  });
});

describe("header slot repair + href escaping", () => {
  it("renders LinkedIn URLs without escaping underscores", () => {
    const content: ResumeContent = {
      header: {
        fullName: "Jane Doe",
        cityRegion: "SF",
        email: "jane@example.com",
        phone: "555",
        linkedinUrl: "https://linkedin.com/in/jane_doe",
        linkedinLabel: "LinkedIn",
        githubUrl: "https://github.com/org/my_repo",
        githubLabel: "GitHub",
      },
      experience: [],
    };
    const { tex } = renderTemplate(ATS_RESUME_TEMPLATE, content);
    expect(tex).toContain("\\href{https://linkedin.com/in/jane_doe}{LinkedIn}");
    expect(tex).toContain("\\href{https://github.com/org/my_repo}{GitHub}");
    // URL argument must keep underscores; label text may still escape.
    expect(tex).toMatch(/\\href\{https:\/\/linkedin\.com\/in\/jane_doe\}/);
    expect(tex).not.toMatch(
      /\\href\{https:\/\/linkedin\.com\/in\/jane\\_doe\}/,
    );
  });

  it("setSlotPlainText restores header:contact and header:links", () => {
    const content: ResumeContent = {
      header: {
        fullName: "Jane",
        cityRegion: "poison",
        email: "bad@x.com",
        phone: "000",
        linkedinUrl: "https://linkedin.com/in/jane_doe",
        linkedinLabel: "poison",
        githubUrl: "https://github.com/me",
      },
      experience: [],
    };
    const contact = setSlotPlainText(
      content,
      "header:contact",
      "Seattle · jane@example.com · 555-0100",
    );
    expect(contact.header.cityRegion).toBe("Seattle");
    expect(contact.header.email).toBe("jane@example.com");
    expect(contact.header.phone).toBe("555-0100");

    const links = setSlotPlainText(
      content,
      "header:links",
      "LinkedIn · GitHub",
    );
    expect(links.header.linkedinLabel).toBe("LinkedIn");
    expect(links.header.githubLabel).toBe("GitHub");
  });
});

describe("repairFlagged round isolation", () => {
  const persona: Persona = {
    id: "ai",
    label: "AI",
    skillWeights: {},
    defaultTemplateId: "ats-single-column",
    sectionOrder: ["experience"],
    toneDirective: "concise",
  };

  const profile: JDProfile = {
    roleTitle: "Engineer",
    seniority: "senior",
    mustHaveSkills: ["Python"],
    niceToHaveSkills: [],
    domains: [],
    atsKeywords: ["Python"],
    toneSignals: [],
    responsibilitiesText: "",
    qualificationsText: "",
  };

  it("does not re-repair bullets that succeeded in round 1", async () => {
    const base = draft(
      [
        { id: "b_good", text: "Shipped Python services with 40% gain" },
        { id: "b_bad", text: "Did stuff without metrics" },
      ],
      ["Python"],
    );
    // Attach metrics so round-1 success for b_good is kept, and b_bad can be fixed.
    base.block.bullets = [
      {
        id: "b_good",
        canonical: "Shipped Python services with 40% gain",
        variants: {},
        metrics: [{ value: "40%", kind: "pct" }],
        evidenceRefs: [],
        locked: false,
      },
      {
        id: "b_bad",
        canonical: "Cut latency 25% with caching",
        variants: {},
        metrics: [{ value: "25%", kind: "pct" }],
        evidenceRefs: [],
        locked: false,
      },
    ];
    base.bullets = [
      {
        id: "b_good",
        text: "Shipped Python services with 40% gain",
        usedCanonical: false,
        fallbackReason: null,
      },
      {
        id: "b_bad",
        text: "Did stuff without metrics",
        usedCanonical: false,
        fallbackReason: null,
      },
    ];

    const critique: CriticResult = {
      atsCoveragePct: 50,
      verdicts: [
        {
          blockId: "exp_1",
          bulletId: "b_good",
          grounded: false,
          keywordHits: [],
          flags: ["ungrounded"],
        },
        {
          blockId: "exp_1",
          bulletId: "b_bad",
          grounded: false,
          keywordHits: [],
          flags: ["unsupported metric"],
        },
      ],
      programmaticFlags: [],
    };

    const callLabels: string[] = [];
    const llmJson = vi.fn(
      async <T>(opts: {
        label?: string;
        validate: (v: unknown) => v is T;
      }): Promise<T> => {
        const label = opts.label ?? "";
        callLabels.push(label);
        if (label === "repair:exp_1:b_good") {
          const v = {
            bullets: [
              {
                id: "b_good",
                text: "Delivered Python APIs with 40% gain",
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        if (label === "repair:exp_1:b_bad") {
          // Round 1 fails validation path → stillBad; round 2 succeeds.
          const attempt = callLabels.filter(
            (l) => l === "repair:exp_1:b_bad",
          ).length;
          if (attempt === 1) {
            throw new Error("transient");
          }
          const v = {
            bullets: [
              {
                id: "b_bad",
                text: "Cut latency 25% with caching",
              },
            ],
          };
          if (!opts.validate(v)) throw new Error("bad");
          return v as T;
        }
        throw new Error(`unexpected ${label}`);
      },
    );

    const out = await repairFlagged([base], critique, profile, persona, 140, {
      llmJson: llmJson as never,
      maxRetries: 2,
    });

    const goodCalls = callLabels.filter((l) => l === "repair:exp_1:b_good");
    const badCalls = callLabels.filter((l) => l === "repair:exp_1:b_bad");
    // Round 1 repairs both; round 2 only retries still-failing b_bad.
    expect(goodCalls).toHaveLength(1);
    expect(badCalls).toHaveLength(2);

    const bullets = out[0]!.bullets;
    expect(bullets.find((b) => b.id === "b_good")?.text).toContain("40%");
    expect(bullets.find((b) => b.id === "b_good")?.usedCanonical).toBe(false);
    expect(bullets.find((b) => b.id === "b_bad")?.text).toContain("25%");
  });

  it("rethrows AbortError from repair llm instead of keeping flagged bullets", async () => {
    const base = draft(
      [{ id: "b1", text: "Did stuff without metrics" }],
      ["Python"],
    );
    base.block.bullets = [
      {
        id: "b1",
        canonical: "Cut latency 25% with caching",
        variants: {},
        metrics: [{ value: "25%", kind: "pct" }],
        evidenceRefs: [],
        locked: false,
      },
    ];
    base.bullets = [
      {
        id: "b1",
        text: "Did stuff without metrics",
        usedCanonical: false,
        fallbackReason: null,
      },
    ];

    const critique: CriticResult = {
      atsCoveragePct: 10,
      verdicts: [
        {
          blockId: "exp_1",
          bulletId: "b1",
          grounded: false,
          keywordHits: [],
          flags: ["ungrounded"],
        },
      ],
      programmaticFlags: [],
    };

    const llmJson = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });

    await expect(
      repairFlagged([base], critique, profile, persona, 140, {
        llmJson: llmJson as never,
        maxRetries: 1,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
