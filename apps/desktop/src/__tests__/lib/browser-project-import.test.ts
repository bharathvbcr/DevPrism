import { describe, expect, it } from "vitest";
import {
  sanitizeProjectName,
  safeZipRelativePath,
  singleRootPrefix,
} from "@/lib/browser-project/constants";
import { displayProjectPathLabel } from "@/lib/browser-project/fsa-persistence";

describe("browser project import helpers", () => {
  it("sanitizes unsafe folder names", () => {
    expect(sanitizeProjectName("  my/paper  ")).toBe("my-paper");
    expect(sanitizeProjectName("...")).toBe("latex-project");
  });

  it("detects a single wrapper directory in zip entries", () => {
    expect(
      singleRootPrefix(["paper/main.tex", "paper/refs.bib", "paper/fig/a.png"]),
    ).toBe("paper");
    expect(singleRootPrefix(["main.tex", "other/main.tex"])).toBeNull();
  });

  it("rejects zip-slip paths", () => {
    expect(safeZipRelativePath("../secret.tex")).toBeNull();
    expect(safeZipRelativePath("paper/main.tex")).toBe("paper/main.tex");
  });

  it("labels browser project paths for display", () => {
    expect(displayProjectPathLabel("opfs://my-thesis")).toBe("my-thesis");
    expect(displayProjectPathLabel("fsa://abc")).toBe("Linked folder");
    expect(displayProjectPathLabel("/Users/me/paper", "My Paper")).toBe(
      "My Paper",
    );
  });
});
