import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useScholarLMStore } from "@/stores/scholarlm-store";

const invokeMock = vi.mocked(invoke);

function resetStore() {
  useScholarLMStore.setState({
    repoPath: "",
    binaryPath: "",
    offline: true,
    maxIterations: 0,
  });
}

describe("scholarlm-store", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({} as never);
    resetStore();
  });

  describe("setMaxIterations", () => {
    it("clamps to a non-negative integer", () => {
      const { setMaxIterations } = useScholarLMStore.getState();
      setMaxIterations(5.9);
      expect(useScholarLMStore.getState().maxIterations).toBe(5);
      setMaxIterations(0);
      expect(useScholarLMStore.getState().maxIterations).toBe(0);
      setMaxIterations(-3);
      expect(useScholarLMStore.getState().maxIterations).toBe(0);
      setMaxIterations(Number.NaN);
      expect(useScholarLMStore.getState().maxIterations).toBe(0);
    });
  });

  it("does not inject a hardcoded default repo path when unconfigured", async () => {
    // The old build shipped a hardcoded author-machine path here; an empty repo
    // must now be forwarded verbatim so the Rust side prompts "set it in Settings".
    await useScholarLMStore.getState().research("what is X?");
    expect(invokeMock).toHaveBeenCalledWith(
      "wisdev_research",
      expect.objectContaining({ repoPath: "" }),
    );
  });

  it("research trims the repo path, defaults binary to null, forwards offline, and nulls iterations when 0", async () => {
    const s = useScholarLMStore.getState();
    s.setRepoPath("  /tmp/wisdev  ");
    s.setOffline(true);
    s.setMaxIterations(0);
    await useScholarLMStore.getState().research("q");
    expect(invokeMock).toHaveBeenCalledWith("wisdev_research", {
      repoPath: "/tmp/wisdev",
      binary: null,
      query: "q",
      offline: true,
      iterations: null,
    });
  });

  it("research forwards an explicit binary and iterations when set", async () => {
    const s = useScholarLMStore.getState();
    s.setRepoPath("/tmp/w");
    s.setBinaryPath("  /tmp/bin/wisdev  ");
    s.setOffline(false);
    s.setMaxIterations(3);
    await useScholarLMStore.getState().research("q");
    expect(invokeMock).toHaveBeenCalledWith("wisdev_research", {
      repoPath: "/tmp/w",
      binary: "/tmp/bin/wisdev",
      query: "q",
      offline: false,
      iterations: 3,
    });
  });

  it("docgen forwards repo, binary, topic, format, and offline", async () => {
    const s = useScholarLMStore.getState();
    s.setRepoPath("/tmp/w");
    s.setOffline(false);
    await useScholarLMStore
      .getState()
      .docgen("Quantum error correction", "latex");
    expect(invokeMock).toHaveBeenCalledWith("wisdev_docgen", {
      repoPath: "/tmp/w",
      binary: null,
      topic: "Quantum error correction",
      format: "latex",
      offline: false,
    });
  });
});
