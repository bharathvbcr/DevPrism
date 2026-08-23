import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KbChunkRow, KbSourceRow } from "@/lib/career";
const listKbChunks = vi.fn(async () => [] as KbChunkRow[]);

vi.mock("@/lib/career", () => ({
  listKbChunks: (...args: unknown[]) => listKbChunks(...(args as [])),
}));

import { KbSourceViewerDialog } from "@/components/career/kb-source-viewer-dialog";

const source = {
  id: "src_kb",
  sourceType: "markdown",
  uri: "/tmp/devprism-career-kb.md",
  title: "devprism-career-kb",
  contentHash: "h1",
  ingestedAt: 1,
  chunkCount: 108,
} satisfies KbSourceRow;

/** Backend returns rows in random UUID id order — not document order. */
function backendOrder(): KbChunkRow[] {
  return [
    {
      id: "chk_c",
      sourceId: source.id,
      text: "Section > B\n\nSecond body",
      meta: { index: 1, headingPath: ["Section", "B"] },
      hasEmbedding: true,
    },
    {
      id: "chk_a",
      sourceId: source.id,
      text: "Section > A\n\nFirst body",
      meta: { index: 0, headingPath: ["Section", "A"] },
      hasEmbedding: true,
    },
    {
      id: "chk_d",
      sourceId: source.id,
      text: "Orphan no index",
      meta: {},
      hasEmbedding: false,
    },
    {
      id: "chk_b",
      sourceId: source.id,
      text: "Section > C\n\nThird body",
      meta: { index: 2, headingPath: ["Section", "C"] },
      hasEmbedding: false,
    },
  ];
}

function renderDialog(open = true) {
  return render(
    <KbSourceViewerDialog
      source={open ? source : null}
      open={open}
      onOpenChange={vi.fn()}
    />,
  );
}

describe("KbSourceViewerDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listKbChunks.mockResolvedValue(backendOrder());
  });

  it("shows chunks in document order despite scrambled ids", async () => {
    renderDialog();

    await waitFor(() => {
      expect(screen.getByText(/4 chunks/)).toBeInTheDocument();
    });
    const items = screen.getAllByRole("button", { name: /embedded|no embed/ });
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("First body");
    expect(items[1]).toHaveTextContent("Second body");
    expect(items[2]).toHaveTextContent("Third body");
    expect(items[3]).toHaveTextContent("Orphan no index");
  });

  it("expands a chunk to reveal full text with the duplicated heading line stripped", async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(/4 chunks/)).toBeInTheDocument();
    });

    await user.click(screen.getAllByRole("button", { name: /embedded/i })[0]!);

    // Radix portals the dialog into document.body, not the render container.
    await waitFor(() => {
      expect(document.body.querySelector("pre")).not.toBeNull();
    });
    const pre = document.body.querySelector("pre")!;
    // Full body shown; the duplicated "Section > A" heading line is stripped.
    expect(pre.textContent).toBe("First body");
  });

  it("filters chunks by query across text and headings", async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(/4 chunks/)).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Filter chunks"), "third");
    expect(await screen.findByText(/1 of 4/)).toBeInTheDocument();
    expect(screen.queryByText("First body")).toBeNull();

    await user.clear(screen.getByLabelText("Filter chunks"));
    await user.type(screen.getByLabelText("Filter chunks"), "zzz-nothing");
    expect(await screen.findByText(/No chunks match/)).toBeInTheDocument();
  });

  it("summarizes embed coverage and flags missing embeddings", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("2 embedded")).toBeInTheDocument();
    });
    expect(screen.getByText("2 missing embeds")).toBeInTheDocument();
  });

  it("shows an error state with retry when loading fails", async () => {
    listKbChunks.mockRejectedValueOnce(new Error("database is locked"));
    renderDialog();

    expect(await screen.findByText("database is locked")).toBeInTheDocument();
    expect(screen.queryByText(/chunks$/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/4 chunks/)).toBeInTheDocument();
    expect(listKbChunks).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state for a source with zero chunks", async () => {
    listKbChunks.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText(/no stored chunks/i)).toBeInTheDocument();
  });

  it("renders nothing and skips loading when closed or sourceless", () => {
    renderDialog(false);
    expect(screen.queryByText(/Loading chunks/)).toBeNull();
    expect(listKbChunks).not.toHaveBeenCalled();
  });

  it("ignores a stale slow response when the viewed source changes mid-flight", async () => {
    let resolveA: (rows: KbChunkRow[]) => void = () => {};
    listKbChunks.mockImplementationOnce(
      () =>
        new Promise<KbChunkRow[]>((resolve) => {
          resolveA = resolve;
        }),
    );
    const { rerender } = render(
      <KbSourceViewerDialog
        source={{ ...source, id: "src_A", title: "Source A" }}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const chunkB: KbChunkRow = {
      id: "chk_b",
      sourceId: "src_B",
      text: "Source B chunk",
      meta: { index: 0 },
      hasEmbedding: true,
    };
    listKbChunks.mockResolvedValueOnce([chunkB]);
    rerender(
      <KbSourceViewerDialog
        source={{ ...source, id: "src_B", title: "Source B" }}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("1 chunks");
      expect(document.body.textContent).toContain("Source B chunk");
    });

    resolveA([
      {
        id: "chk_a",
        sourceId: "src_A",
        text: "Stale Source A chunk",
        meta: { index: 0 },
        hasEmbedding: true,
      },
    ]);
    await waitFor(() => {
      // A's late response must be discarded, not rendered under B's title.
      expect(listKbChunks).toHaveBeenCalledTimes(2);
    });
    expect(document.body.textContent).toContain("Source B chunk");
    expect(document.body.textContent).not.toContain("Stale Source A chunk");
  });
});
