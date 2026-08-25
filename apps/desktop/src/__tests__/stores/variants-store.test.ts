import { describe, it, expect, vi } from "vitest";
import { deriveOwner, useVariantsStore } from "@/stores/variants-store";
import { useDocumentStore } from "@/stores/document-store";

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

describe("useVariantsStore.switchTo", () => {
  it("ignores a second switch while one is already in flight", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openProjectMock = vi.fn(() => openGate);
    useDocumentStore.setState({ openProject: openProjectMock });

    useVariantsStore.setState({
      ownerRoot: "/owner",
      activeVariantId: null,
      variants: [
        {
          id: "v1",
          name: "V1",
          status: "draft",
          jd: "",
          createdAt: 1,
          path: "/owner/.prism/variants/v1",
        },
        {
          id: "v2",
          name: "V2",
          status: "draft",
          jd: "",
          createdAt: 2,
          path: "/owner/.prism/variants/v2",
        },
      ],
      loading: false,
      switching: false,
    });

    const first = useVariantsStore.getState().switchTo("v1");
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(useVariantsStore.getState().switching).toBe(true);
    expect(openProjectMock).toHaveBeenCalledTimes(1);

    const second = useVariantsStore.getState().switchTo("v2");
    await second;
    // The overlapping switch was a no-op.
    expect(openProjectMock).toHaveBeenCalledTimes(1);
    expect(useVariantsStore.getState().switching).toBe(true);

    releaseOpen();
    await first;
    expect(useVariantsStore.getState().activeVariantId).toBe("v1");
    expect(useVariantsStore.getState().switching).toBe(false);
  });
});
