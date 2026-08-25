import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { attachHighlights } from "@/lib/highlight-persistence";
import {
  useAnnotationStore,
  type PdfHighlight,
} from "@/stores/annotation-store";

const FILE_PATH = "/proj/.claudeprism/highlights.json";
const BAD_PATH = "/proj/.claudeprism/highlights.json.bad";

function makeHighlight(): PdfHighlight {
  return {
    id: "h1",
    pageIndex: 0,
    colorId: "yellow",
    rgb: [1, 0.9, 0.3],
    css: "rgb(255, 230, 80)",
    quads: [[10, 10, 100, 10, 10, 24, 100, 24]],
    text: "selected",
    createdAt: 1,
  };
}

describe("highlight-persistence corrupt file handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(exists).mockResolvedValue(true as never);
    useAnnotationStore.setState({ highlightsByRoot: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function mutateStore() {
    useAnnotationStore.setState({
      highlightsByRoot: { "doc.pdf": [makeHighlight()] },
    });
    await vi.advanceTimersByTimeAsync(500);
  }

  it("backs up the corrupt file and disables persistence until a reload succeeds", async () => {
    const corrupt = "{not valid json...";
    vi.mocked(readTextFile).mockResolvedValue(corrupt as never);

    await attachHighlights("/proj");

    // Raw bytes preserved in a .bad backup next to the original.
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledWith(BAD_PATH, corrupt);

    // Store was reset, but mutating it must NOT persist emptiness over the
    // corrupt file — no save fires even after the debounce window.
    await mutateStore();
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile).not.toHaveBeenCalledWith(
      FILE_PATH,
      expect.anything(),
    );

    // A successful explicit load re-enables persistence.
    const good = JSON.stringify({
      version: 1,
      highlightsByRoot: { restored: [makeHighlight()] },
    });
    vi.mocked(readTextFile).mockResolvedValue(good as never);
    await attachHighlights("/proj");
    // The detach-flush during re-attach is still suppressed; only the
    // post-reload mutation persists.
    vi.mocked(writeTextFile).mockClear();
    await mutateStore();
    expect(writeTextFile).toHaveBeenCalledWith(
      FILE_PATH,
      expect.stringContaining('"highlightsByRoot"'),
    );
  });

  it("persists normally when the file loads cleanly", async () => {
    vi.mocked(readTextFile).mockResolvedValue(
      JSON.stringify({
        version: 1,
        highlightsByRoot: { kept: [] },
      }) as never,
    );

    await attachHighlights("/proj");

    await mutateStore();
    expect(writeTextFile).toHaveBeenCalledWith(
      FILE_PATH,
      expect.stringContaining('"version": 1'),
    );
  });
});
