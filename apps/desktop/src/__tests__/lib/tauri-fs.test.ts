import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  getProjectFileType,
  scanProjectFolder,
  shouldSkipProjectDirectory,
} from "@/lib/tauri/fs";

describe("tauri fs helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getProjectFileType", () => {
    it("classifies editable project files", () => {
      expect(getProjectFileType("main.tex")).toBe("tex");
      expect(getProjectFileType("chapter.TEX")).toBe("tex");
      expect(getProjectFileType("refs.bib")).toBe("bib");
      expect(getProjectFileType("output.pdf")).toBe("pdf");
      expect(getProjectFileType("figure.png")).toBe("image");
      expect(getProjectFileType("custom.sty")).toBe("style");
      expect(getProjectFileType("notes.md")).toBe("other");
      expect(getProjectFileType("script.py")).toBe("other");
    });

    it("ignores LaTeX build artifacts", () => {
      expect(getProjectFileType("main.aux")).toBeNull();
      expect(getProjectFileType("main.synctex.gz")).toBeNull();
    });

    it("keeps imported document/reference files visible", () => {
      expect(getProjectFileType("archive.zip")).toBe("other");
      expect(getProjectFileType("paper.docx")).toBe("other");
      expect(getProjectFileType("data.xlsx")).toBe("other");
      expect(getProjectFileType("movie.mp4")).toBe("other");
    });

    it("ignores compiled/build artifacts and native binaries", () => {
      expect(getProjectFileType("module.pyc")).toBeNull();
      expect(getProjectFileType("module.pyo")).toBeNull();
      expect(getProjectFileType("native.pyd")).toBeNull();
      expect(getProjectFileType("lib.so")).toBeNull();
      expect(getProjectFileType("app.exe")).toBeNull();
      expect(getProjectFileType("obj.o")).toBeNull();
    });
  });

  describe("shouldSkipProjectDirectory", () => {
    it("skips hidden and generated dependency directories", () => {
      expect(shouldSkipProjectDirectory(".git")).toBe(true);
      expect(shouldSkipProjectDirectory(".venv")).toBe(true);
      expect(shouldSkipProjectDirectory("node_modules")).toBe(true);
      expect(shouldSkipProjectDirectory("__pycache__")).toBe(true);
      expect(shouldSkipProjectDirectory("venv")).toBe(true);
      expect(shouldSkipProjectDirectory("ENV")).toBe(true);
    });

    it("keeps normal project folders visible", () => {
      expect(shouldSkipProjectDirectory("chapters")).toBe(false);
      expect(shouldSkipProjectDirectory("figures")).toBe(false);
      expect(shouldSkipProjectDirectory("attachments")).toBe(false);
    });
  });

  describe("scanProjectFolder", () => {
    it("delegates the native walk to the single-command Rust scanner", async () => {
      // The recursive walk moved to `scan_project_folder` in lib.rs so a
      // project open is one IPC round trip instead of one readDir per
      // directory plus one stat per file. Directory-skip and file-type
      // rules are mirrored there (see project_scan::tests) and remain
      // exercised here for the browser path via fs-shared helpers above.
      const canned = {
        files: [
          {
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            type: "tex",
            fileSize: 0,
          },
        ],
        folders: ["chapters"],
      };
      vi.mocked(invoke).mockResolvedValue(canned as any);

      const result = await scanProjectFolder("/project");

      expect(invoke).toHaveBeenCalledWith("scan_project_folder", {
        rootPath: "/project",
      });
      expect(result).toEqual(canned);
    });
  });
});
