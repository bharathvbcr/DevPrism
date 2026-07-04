import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTauri } from "@/lib/runtime/is-tauri";

describe("isTauri mock default", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it("defaults to true in unit tests (desktop behavior)", () => {
    expect(isTauri()).toBe(true);
  });

  it("can be toggled off to simulate browser preview", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    expect(isTauri()).toBe(false);
  });
});
