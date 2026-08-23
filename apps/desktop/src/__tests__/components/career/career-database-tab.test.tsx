import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { KbSourceRow } from "@/lib/career";

vi.mock("@/lib/career", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/career")>();
  return {
    ...actual,
    listKbSources: vi.fn(async () => [] as KbSourceRow[]),
  };
});

import { CareerDatabaseTab } from "@/components/career/career-database-tab";
import { listKbSources } from "@/lib/career";
import { useCareerStore } from "@/stores/career-store";

const kbSource = {
  id: "src_1",
  sourceType: "markdown",
  uri: "/tmp/kb.md",
  title: "kb.md",
  contentHash: "h",
  ingestedAt: 1,
  chunkCount: 3,
} satisfies KbSourceRow;

describe("CareerDatabaseTab first-run guide", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listKbSources).mockResolvedValue([]);
    useCareerStore.setState({
      careerOpen: true,
      activeTab: "database",
      blocks: [],
      personas: [],
      selectedBlockId: null,
      selectedPersonaId: null,
      blocksMissingEmbeddings: 0,
      kbSourceCount: null,
      loading: false,
      saving: false,
      error: null,
      resumeImportRequested: false,
    });
  });

  it("marks the knowledge step ready when KB sources exist", async () => {
    vi.mocked(listKbSources).mockResolvedValue([kbSource]);
    render(<CareerDatabaseTab />);

    await waitFor(() => {
      expect(screen.getByText(/Knowledge base ready/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/1 source ingested/i)).toBeInTheDocument();
    expect(screen.queryByText(/Ingest papers, notes, or evidence/i)).toBeNull();
  });

  it("keeps the ingest prompt when no KB sources exist", async () => {
    render(<CareerDatabaseTab />);

    await waitFor(() => {
      expect(vi.mocked(listKbSources)).toHaveBeenCalled();
    });
    expect(
      screen.getByText(/Ingest papers, notes, or evidence/i),
    ).toBeInTheDocument();
  });

  it("keeps the ingest prompt when the source lookup fails", async () => {
    vi.mocked(listKbSources).mockRejectedValue(new Error("db unavailable"));
    render(<CareerDatabaseTab />);

    expect(
      screen.getByText(/Ingest papers, notes, or evidence/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(vi.mocked(listKbSources)).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Knowledge base ready/i)).toBeNull();
  });

  it("re-renders the knowledge step when coverage is pushed to the store", async () => {
    render(<CareerDatabaseTab />);
    await waitFor(() => {
      expect(useCareerStore.getState().kbSourceCount).toBe(0);
    });
    expect(
      screen.getByText(/Ingest papers, notes, or evidence/i),
    ).toBeInTheDocument();

    useCareerStore.setState({ kbSourceCount: 3 });

    await waitFor(() => {
      expect(screen.getByText(/Knowledge base ready/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/3 sources ingested/i)).toBeInTheDocument();
    expect(screen.queryByText(/Ingest papers, notes, or evidence/i)).toBeNull();
  });
});
