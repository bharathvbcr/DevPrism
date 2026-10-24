/**
 * The model recorded with each stored career vector must be the model that
 * actually produced it.
 *
 * The fake backend below behaves like `ai_embed`: given `model: null` it
 * auto-picks the first embedding model the server lists (as
 * `ollama::first_embedding_model` does), and it records which model really
 * embedded each batch. The server here lists `embeddinggemma-2-tessl` first,
 * which is what the planned tessl-embed server advertises.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { embedBlocks, backfillBlockEmbeddings } from "@/lib/career/block-embed";
import { backfillKbEmbeddings, embedChunks } from "@/lib/career/ingest/embed";
import type { EmbeddingItem, ExperienceBlock } from "@/lib/career/types";
import { createEmptyBlock } from "@/lib/career";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/stores/claude-chat-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/claude-chat-store")>();
  return {
    ...actual,
    useClaudeChatStore: {
      getState: vi.fn(() => ({
        selectedProviderCredentialId: null,
        selectedProviderModels: {},
      })),
    },
  };
});

vi.mock("@/stores/claude-setup-store", () => ({
  useClaudeSetupStore: {
    getState: vi.fn(() => ({ openAiCredentials: [] })),
  },
}));

const invokeMock = vi.mocked(invoke);

/** Embedding models the fake server lists, in `/api/tags` order. */
const SERVER_MODELS = ["embeddinggemma-2-tessl", "nomic-embed-text"];

interface FakeBackend {
  /** Model that actually embedded each `ai_embed` call. */
  used: string[];
  embedArgs: Record<string, unknown>[];
  stored: EmbeddingItem[];
  calls: { cmd: string; args: Record<string, unknown> }[];
}

function installFakeBackend(blocks: ExperienceBlock[] = []): FakeBackend {
  const fake: FakeBackend = { used: [], embedArgs: [], stored: [], calls: [] };
  const pick = (model: unknown): string =>
    typeof model === "string" && model.trim()
      ? model.trim()
      : SERVER_MODELS[0]!;
  invokeMock.mockImplementation(async (cmd: string, raw?: unknown) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    fake.calls.push({ cmd, args });
    switch (cmd) {
      case "ai_resolve_embed_model":
        return pick(args.model) as never;
      case "ai_embed": {
        fake.embedArgs.push(args);
        fake.used.push(pick(args.model));
        return (args.texts as string[]).map(() => [0.6, 0.8]) as never;
      }
      case "career_store_embeddings":
        fake.stored.push(...(args.items as EmbeddingItem[]));
        return undefined as never;
      case "career_list_kb_chunks":
        return [
          {
            id: "chk_1",
            sourceId: "src_1",
            text: "alpha",
            meta: {},
            hasEmbedding: false,
          },
        ] as never;
      case "career_list_blocks":
        return blocks as never;
      default:
        return undefined as never;
    }
  });
  return fake;
}

function expectLabelsMatchUsedModel(fake: FakeBackend) {
  expect(fake.stored.length).toBeGreaterThan(0);
  expect(fake.used.length).toBeGreaterThan(0);
  const used = new Set(fake.used);
  expect(used.size).toBe(1);
  const [usedModel] = [...used];
  for (const item of fake.stored) {
    expect(item.model).toBe(usedModel);
  }
}

describe("career embeddings record the model that produced them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ embedModel: null, embedBaseUrl: null });
  });

  it("KB chunk vectors carry the backend's auto-picked model, not a frontend default", async () => {
    const fake = installFakeBackend();
    const result = await embedChunks({
      chunks: [
        { id: "chk_1", text: "alpha" },
        { id: "chk_2", text: "beta" },
      ],
    });
    expect(result.deferred).toBe(false);
    expectLabelsMatchUsedModel(fake);
    expect(fake.stored[0]!.model).toBe("embeddinggemma-2-tessl");
  });

  it("block vectors carry the backend's auto-picked model, not a frontend default", async () => {
    const fake = installFakeBackend();
    const result = await embedBlocks({
      blocks: [{ id: "exp_1", text: "Engineer at Acme" }],
    });
    expect(result.deferred).toBe(false);
    expectLabelsMatchUsedModel(fake);
  });

  it("the embedModel / embedBaseUrl settings choose the server and model, and the label follows", async () => {
    useSettingsStore.setState({
      embedModel: "embeddinggemma-2-tessl",
      embedBaseUrl: "http://127.0.0.1:11435",
    });
    const fake = installFakeBackend();
    await embedChunks({ chunks: [{ id: "chk_1", text: "alpha" }] });

    expect(fake.embedArgs).toHaveLength(1);
    expect(fake.embedArgs[0]).toMatchObject({
      model: "embeddinggemma-2-tessl",
      baseUrl: "http://127.0.0.1:11435",
      providerCredentialId: null,
    });
    expectLabelsMatchUsedModel(fake);
  });

  it("with no embed settings the request goes to the Ollama base, as before", async () => {
    const fake = installFakeBackend();
    await embedChunks({ chunks: [{ id: "chk_1", text: "alpha" }] });
    expect(fake.embedArgs[0]).toMatchObject({
      baseUrl: "http://localhost:11434",
      providerCredentialId: null,
    });
  });

  it("an explicit model option is both the model sent and the label stored", async () => {
    const fake = installFakeBackend();
    await embedChunks({
      chunks: [{ id: "chk_1", text: "alpha" }],
      model: "nomic-embed-text",
    });
    expect(fake.used).toEqual(["nomic-embed-text"]);
    expectLabelsMatchUsedModel(fake);
  });

  it("KB backfill asks for chunks missing under the model it will embed with", async () => {
    useSettingsStore.setState({ embedModel: "embeddinggemma-2-tessl" });
    const fake = installFakeBackend();
    await backfillKbEmbeddings();
    const list = fake.calls.find((c) => c.cmd === "career_list_kb_chunks");
    expect(list?.args).toMatchObject({
      missingEmbeddingsOnly: true,
      model: "embeddinggemma-2-tessl",
    });
    expectLabelsMatchUsedModel(fake);
  });

  it("block backfill asks for blocks missing under the model it will embed with", async () => {
    useSettingsStore.setState({ embedModel: "embeddinggemma-2-tessl" });
    const block = createEmptyBlock({
      id: "exp_1",
      title: "Engineer",
      org: "Acme",
    });
    const fake = installFakeBackend([block]);
    await backfillBlockEmbeddings();
    const missingList = fake.calls.find(
      (c) =>
        c.cmd === "career_list_blocks" && c.args.missingEmbeddingsOnly === true,
    );
    expect(missingList?.args).toMatchObject({
      model: "embeddinggemma-2-tessl",
    });
    expectLabelsMatchUsedModel(fake);
  });
});
