import { describe, expect, it } from "vitest";
import ignoredExtensions from "../../lib/tauri/ignored-extensions.json";
import {
  IGNORED_EXTENSIONS,
  getProjectFileType,
} from "../../lib/tauri/fs-shared";

describe("project ignore list", () => {
  it("is the shared JSON, and a .bin reference stays visible", () => {
    expect([...IGNORED_EXTENSIONS]).toEqual(ignoredExtensions);
    expect(ignoredExtensions).not.toContain(".bin");
    expect(getProjectFileType("reference.bin")).toBe("other");
    expect(getProjectFileType("weights.BIN")).toBe("other");
    for (const ext of ignoredExtensions) {
      expect(getProjectFileType(`sample${ext}`)).toBeNull();
    }
  });
});
