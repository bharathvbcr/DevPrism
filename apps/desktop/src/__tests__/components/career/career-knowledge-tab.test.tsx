import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KbChunkRow, KbSourceRow } from "@/lib/career";

const listKbSources = vi.fn(async () => [] as KbSourceRow[]);
const listKbChunks = vi.fn(async () => [] as KbChunkRow[]);

vi.mock("@/lib/career", () => ({
  listKbSources: (...args: unknown[]) => listKbSources(...(args as [])),
  listKbChunks: (...args: unknown[]) => listKbChunks(...(args as [])),
  deleteKbSource: vi.fn(async () => {}),
  backfillKbEmbeddings: vi.fn(),
  ingestFilePath: vi.fn(),
  ingestMarkdownText: vi.fn(),
  ingestMindmapText: vi.fn(),
  seedPublicationsFromBibtex: vi.fn(),
}));

vi.mock("@/lib/platform-dialog", () => ({
  pickProjectFiles: vi.fn(async () => null),
}));

vi.mock("@/lib/home-flow-events", () => ({
  dispatchOpenSettings: vi.fn(),
}));

vi.mock("@/lib/ollama", () => ({
  RECOMMENDED_EMBED_MODEL: { id: "nomic-embed-text" },
  getOllamaBaseUrl: vi.fn(() => "http://localhost:11434"),
  resolveOllamaCredential: vi.fn(() => null),
}));

vi.mock("@/stores/ollama-pull-store", () => ({
  useOllamaPullStore: vi.fn(
    (selector: (s: { pulling: boolean; pull: () => void }) => unknown) =>
      selector({ pulling: false, pull: () => {} }),
  ),
}));

vi.mock("@/stores/claude-setup-store", () => ({
  useClaudeSetupStore: {
    getState: vi.fn(() => ({ openAiCredentials: [] })),
  },
}));

vi.mock("@/components/career/publication-import-wizard", () => ({
  PublicationImportWizard: () => null,
}));

const changeHandlers = new Set<() => void>();
vi.mock("@/lib/career/db-events", () => ({
  CAREER_DB_CHANGED_EVENT: "career-db-changed",
  onCareerDbChanged: vi.fn((handler: () => void) => {
    changeHandlers.add(handler);
    return () => changeHandlers.delete(handler);
  }),
  debounce: (fn: () => void) => fn,
}));

import { CareerKnowledgeTab } from "@/components/career/career-knowledge-tab";
import { useCareerStore } from "@/stores/career-store";

const source = {
  id: "src_1",
  sourceType: "markdown",
  uri: "/tmp/kb.md",
  title: "KB doc",
  contentHash: "h1",
  ingestedAt: 1,
  chunkCount: 3,
} satisfies KbSourceRow;

describe("CareerKnowledgeTab source coverage display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listKbSources.mockResolvedValue([]);
    listKbChunks.mockResolvedValue([]);
  });

  it("shows per-source missing-embed badges when coverage is verified", async () => {
    listKbSources.mockResolvedValue([source]);
    listKbChunks.mockResolvedValue([
      { id: "c1", sourceId: "src_1" } as KbChunkRow,
    ]);

    render(<CareerKnowledgeTab />);

    await waitFor(() => {
      expect(screen.getByText("KB doc")).toBeInTheDocument();
    });
    expect(screen.getByText(/1 missing embed/i)).toBeInTheDocument();
  });

  it("flags unknown embed coverage instead of implying chunks are embedded", async () => {
    listKbSources.mockResolvedValue([source]);
    listKbChunks.mockRejectedValue(new Error("database is locked"));

    render(<CareerKnowledgeTab />);

    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't verify embed coverage/),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/missing embed/i)).toBeNull();
  });

  it("refetches sources when an external DB change event arrives", async () => {
    listKbSources.mockResolvedValue([source]);
    render(<CareerKnowledgeTab />);
    await waitFor(() => {
      expect(screen.getByText("KB doc")).toBeInTheDocument();
    });
    const callsAfterMount = listKbSources.mock.calls.length;

    for (const handler of [...changeHandlers]) handler();

    await waitFor(() => {
      expect(listKbSources.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
  });

  it("keeps shared coverage in sync when refresh runs", async () => {
    listKbSources.mockResolvedValue([source]);
    useCareerStore.setState({ kbSourceCount: null });

    render(<CareerKnowledgeTab />);
    await waitFor(() => {
      expect(useCareerStore.getState().kbSourceCount).toBe(1);
    });
  });

  it("opens the source viewer with stored chunks when a source is clicked", async () => {
    const user = userEvent.setup();
    listKbSources.mockResolvedValue([source]);
    listKbChunks.mockResolvedValue([
      {
        id: "chk_2",
        sourceId: "src_1",
        text: "# Intro\n\nStored chunk body",
        meta: { index: 0, headingPath: [] },
        hasEmbedding: true,
      } as KbChunkRow,
    ]);

    render(<CareerKnowledgeTab />);
    await waitFor(() => {
      expect(screen.getByText("KB doc")).toBeInTheDocument();
    });

    await user.click(screen.getByText("KB doc"));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("KB doc");
    expect(dialog).toHaveTextContent("1 chunks");
    await waitFor(() => {
      expect(dialog.textContent).toContain("Stored chunk body");
    });
  });
});
