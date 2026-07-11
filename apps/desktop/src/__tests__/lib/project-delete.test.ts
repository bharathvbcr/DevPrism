import { describe, expect, it } from "vitest";
import {
  deleteProjectDialogCopy,
  projectDeleteKind,
} from "@/lib/project-delete";

describe("project delete helpers", () => {
  it("classifies project paths by storage kind", () => {
    expect(projectDeleteKind("/Users/me/thesis")).toBe("disk");
    expect(projectDeleteKind("opfs://my-thesis")).toBe("opfs");
    expect(projectDeleteKind("fsa://abc123")).toBe("fsa");
  });

  it("uses delete wording for disk and imported browser projects", () => {
    const opfs = deleteProjectDialogCopy("opfs", "My Thesis");
    expect(opfs.title).toBe("Delete project");
    expect(opfs.action).toBe("Delete");

    const disk = deleteProjectDialogCopy("disk", "Paper");
    expect(disk.title).toBe("Delete project");
    expect(disk.action).toBe("Delete");
    expect(disk.description).toContain("Paper");
  });

  it("uses remove wording for linked folders", () => {
    expect(deleteProjectDialogCopy("fsa", "Linked").action).toBe("Remove");
  });
});
