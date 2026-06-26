import { describe, it, expect } from "vitest";
import { deriveOwner } from "@/stores/variants-store";

describe("deriveOwner", () => {
  it("treats a plain unix project path as the master", () => {
    expect(deriveOwner("/home/u/Documents/DevPrism/Resume")).toEqual({
      owner: "/home/u/Documents/DevPrism/Resume",
      activeVariantId: null,
    });
  });

  it("treats a plain windows project path as the master", () => {
    expect(deriveOwner("C:\\Users\\u\\Documents\\DevPrism\\Resume")).toEqual({
      owner: "C:\\Users\\u\\Documents\\DevPrism\\Resume",
      activeVariantId: null,
    });
  });

  it("strips a unix variant suffix back to the owner", () => {
    expect(
      deriveOwner("/home/u/Documents/DevPrism/Resume/.prism/variants/acme-pm"),
    ).toEqual({
      owner: "/home/u/Documents/DevPrism/Resume",
      activeVariantId: "acme-pm",
    });
  });

  it("strips a windows variant suffix back to the owner", () => {
    expect(
      deriveOwner(
        "C:\\Users\\u\\Documents\\DevPrism\\Resume\\.prism\\variants\\acme-pm",
      ),
    ).toEqual({
      owner: "C:\\Users\\u\\Documents\\DevPrism\\Resume",
      activeVariantId: "acme-pm",
    });
  });

  it("normalizes a trailing separator", () => {
    expect(deriveOwner("/home/u/Resume/.prism/variants/acme-pm/")).toEqual({
      owner: "/home/u/Resume",
      activeVariantId: "acme-pm",
    });
  });

  it("does not treat a project that merely contains 'variants' as a variant", () => {
    expect(deriveOwner("/home/u/my-variants-project")).toEqual({
      owner: "/home/u/my-variants-project",
      activeVariantId: null,
    });
    // `variants` not directly under `.prism` → still the master.
    expect(deriveOwner("/home/u/Resume/variants/foo")).toEqual({
      owner: "/home/u/Resume/variants/foo",
      activeVariantId: null,
    });
  });
});
