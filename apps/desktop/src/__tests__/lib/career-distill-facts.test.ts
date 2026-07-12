import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  distillFactsFromNotes,
  parseDistilledFacts,
} from "@/lib/career/distill-facts";

vi.mock("@/lib/ai-assist", () => ({
  canUseAiAssist: vi.fn(() => true),
  aiComplete: vi.fn(),
}));

import { aiComplete, canUseAiAssist } from "@/lib/ai-assist";

describe("parseDistilledFacts", () => {
  it("maps structured facts with skills and metrics", () => {
    const raw = JSON.stringify({
      facts: [
        {
          text: "Cut p99 latency 40%",
          skills: ["latency", "observability"],
          metrics: [{ value: "40%", kind: "improvement" }],
        },
        "Owned Kubernetes rollout",
      ],
    });
    const facts = parseDistilledFacts(raw);
    expect(facts).toHaveLength(2);
    expect(facts[0].text).toBe("Cut p99 latency 40%");
    expect(facts[0].skills).toEqual(["latency", "observability"]);
    expect(facts[0].metrics).toEqual([{ value: "40%", kind: "improvement" }]);
    expect(facts[0].source).toBe("distilled");
    expect(facts[0].id).toMatch(/^fct_/);
    expect(facts[1].text).toBe("Owned Kubernetes rollout");
    expect(facts[1].skills).toEqual([]);
  });

  it("tolerates alternate field names and string metrics", () => {
    const raw = JSON.stringify({
      facts: [
        {
          point: "Scaled to 2M users",
          metrics: ["2M users"],
        },
      ],
    });
    const facts = parseDistilledFacts(raw, "import");
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe("Scaled to 2M users");
    expect(facts[0].metrics).toEqual([{ value: "2M users", kind: "metric" }]);
    expect(facts[0].source).toBe("import");
  });

  it("returns [] for unparseable output", () => {
    expect(parseDistilledFacts("not json")).toEqual([]);
  });
});

describe("distillFactsFromNotes", () => {
  beforeEach(() => {
    vi.mocked(canUseAiAssist).mockReturnValue(true);
    vi.mocked(aiComplete).mockReset();
  });

  it("calls aiComplete and returns parsed facts", async () => {
    vi.mocked(aiComplete).mockResolvedValue(
      JSON.stringify({
        facts: [{ text: "Shipped feature X", skills: ["rust"], metrics: [] }],
      }),
    );
    const facts = await distillFactsFromNotes("- Shipped feature X with Rust");
    expect(aiComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "json",
        temperature: 0.1,
      }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe("Shipped feature X");
    expect(facts[0].skills).toEqual(["rust"]);
  });

  it("rejects short notes", async () => {
    await expect(distillFactsFromNotes("hi")).rejects.toThrow(/Paste a few/);
  });

  it("rejects when AI is unavailable", async () => {
    vi.mocked(canUseAiAssist).mockReturnValue(false);
    await expect(
      distillFactsFromNotes("- enough text here for distill"),
    ).rejects.toThrow(/unavailable/i);
  });
});
