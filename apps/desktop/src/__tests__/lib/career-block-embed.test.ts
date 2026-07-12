import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createEmptyBlock, newBlockFact } from "@/lib/career";
import type { ExperienceBlock } from "@/lib/career/types";

vi.mock("@/lib/ai-assist", () => ({
  aiEmbed: vi.fn(),
}));

import { aiEmbed } from "@/lib/ai-assist";
import {
  backfillFactEmbeddings,
  embedFacts,
  persistBlockEmbedding,
} from "@/lib/career/block-embed";

const invokeMock = vi.mocked(invoke);
const aiEmbedMock = vi.mocked(aiEmbed);

function blockWithFacts(): ExperienceBlock {
  return createEmptyBlock({
    id: "exp_1",
    title: "Engineer",
    org: "Acme",
    bullets: [
      {
        id: "b1",
        canonical: "Shipped caching",
        variants: {},
        metrics: [],
        evidenceRefs: [],
        locked: false,
      },
    ],
    facts: [
      newBlockFact("Operated a 50-node Kubernetes cluster", {
        id: "fct_1",
        skills: ["Kubernetes"],
      }),
      newBlockFact("   ", { id: "fct_blank" }),
    ],
  });
}

describe("fact embed helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiEmbedMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3]),
    );
    invokeMock.mockResolvedValue(undefined as never);
  });

  it("embedFacts stores ownerKind fact embeddings", async () => {
    const result = await embedFacts({
      facts: [
        { id: "fct_1", text: "Cut latency 40%" },
        { id: "fct_2", text: "Owned k8s rollout" },
      ],
    });

    expect(result).toEqual({
      embedded: 2,
      skipped: 0,
      deferred: false,
    });
    expect(aiEmbedMock).toHaveBeenCalledWith([
      "Cut latency 40%",
      "Owned k8s rollout",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("career_store_embeddings", {
      items: [
        expect.objectContaining({
          ownerId: "fct_1",
          ownerKind: "fact",
          vec: [0.1, 0.2, 0.3],
        }),
        expect.objectContaining({
          ownerId: "fct_2",
          ownerKind: "fact",
          vec: [0.1, 0.2, 0.3],
        }),
      ],
    });
  });

  it("embedFacts returns deferred with fact backfill hint on embed failure", async () => {
    aiEmbedMock.mockRejectedValue(new Error("E_NO_MODEL: no embedding model"));

    const result = await embedFacts({
      facts: [{ id: "fct_1", text: "Cut latency 40%" }],
    });

    expect(result.deferred).toBe(true);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.error).toMatch(/backfillFactEmbeddings\(\)/);
    expect(result.error).toMatch(/Facts stored/i);
  });

  it("backfillFactEmbeddings lists blocks and embeds non-empty facts", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "career_list_blocks") {
        return [blockWithFacts()] as never;
      }
      return undefined as never;
    });

    const result = await backfillFactEmbeddings();

    expect(result.embedded).toBe(1);
    expect(aiEmbedMock).toHaveBeenCalledWith([
      "Operated a 50-node Kubernetes cluster",
    ]);
    expect(invokeMock).toHaveBeenCalledWith(
      "career_list_blocks",
      expect.objectContaining({ missingEmbeddingsOnly: false }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "career_store_embeddings",
      expect.objectContaining({
        items: [
          expect.objectContaining({
            ownerId: "fct_1",
            ownerKind: "fact",
          }),
        ],
      }),
    );
  });

  it("persistBlockEmbedding includes fact ownerKind alongside block and bullet", async () => {
    const block = blockWithFacts();
    const result = await persistBlockEmbedding(block);

    expect(result.deferred).toBe(false);
    expect(result.embedded).toBeGreaterThanOrEqual(3);

    const storeCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "career_store_embeddings",
    );
    const kinds = storeCalls.flatMap(([, args]) => {
      const items = (args as { items: { ownerKind: string }[] }).items;
      return items.map((i) => i.ownerKind);
    });
    expect(kinds).toEqual(expect.arrayContaining(["block", "bullet", "fact"]));
  });
});
