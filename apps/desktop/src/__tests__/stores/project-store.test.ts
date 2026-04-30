import { invoke } from "@tauri-apps/api/core";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProjectStore } from "@/stores/project-store";

describe("useProjectStore", () => {
  beforeEach(() => {
    // Reset the store between tests
    useProjectStore.setState({
      recentProjects: [],
      linkedProjects: [],
      lastProjectFolder: null,
    });
    vi.clearAllMocks();
  });

  describe("addRecentProject", () => {
    it("adds a project with extracted name", () => {
      useProjectStore.getState().addRecentProject("/Users/dev/my-thesis");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/Users/dev/my-thesis");
      expect(recentProjects[0].name).toBe("my-thesis");
    });

    it("moves duplicate to front and deduplicates", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.addRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(2);
      expect(recentProjects[0].path).toBe("/a");
      expect(recentProjects[1].path).toBe("/b");
    });

    it("limits to MAX_RECENT (10) entries", () => {
      const store = useProjectStore.getState();
      for (let i = 0; i < 12; i++) {
        store.addRecentProject(`/project-${i}`);
      }
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(10);
      // Most recent should be first
      expect(recentProjects[0].path).toBe("/project-11");
    });

    it("extracts name from path correctly", () => {
      useProjectStore.getState().addRecentProject("/a/b/c/deep-folder");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "deep-folder",
      );
    });

    it("uses full path as name if no segments", () => {
      useProjectStore.getState().addRecentProject("standalone");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "standalone",
      );
    });
  });

  describe("removeRecentProject", () => {
    it("removes a project by path", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.removeRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/b");
    });
  });

  describe("linked projects", () => {
    it("adds detailed linked project metadata through backend command", async () => {
      vi.mocked(invoke).mockResolvedValue([]);

      await useProjectStore
        .getState()
        .addLinkedProject("DevCouncil", "/repo/devcouncil", [], {
          tags: ["agent", "desktop"],
          role: "Owner",
          description: "Native provider integration",
        });

      expect(invoke).toHaveBeenCalledWith(
        "add_linked_project",
        expect.objectContaining({
          name: "DevCouncil",
          path: "/repo/devcouncil",
          tags: ["agent", "desktop"],
          role: "Owner",
          description: "Native provider integration",
        }),
      );
    });

    it("refreshes analysis through backend command", async () => {
      vi.mocked(invoke).mockResolvedValue([]);

      await useProjectStore.getState().analyzeLinkedProject("project-1");

      expect(invoke).toHaveBeenCalledWith("analyze_linked_project", {
        id: "project-1",
      });
    });
  });
});
