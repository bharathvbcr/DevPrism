import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyFileToProject: vi.fn(),
  join: vi.fn(),
  createPdfTextSidecar: vi.fn(),
  isPdfPath: vi.fn((path: string) => path.toLowerCase().endsWith(".pdf")),
}));

vi.mock("@/lib/tauri/fs", () => ({
  copyFileToProject: mocks.copyFileToProject,
  join: mocks.join,
}));

vi.mock("@/lib/pdf-text-extractor", () => ({
  createPdfTextSidecar: mocks.createPdfTextSidecar,
  isPdfPath: mocks.isPdfPath,
}));

import {
  buildReferenceFilesSection,
  importReferenceFilesWithSidecars,
} from "@/lib/project-attachments";

describe("project attachment helpers", () => {
  beforeEach(() => {
    mocks.copyFileToProject.mockReset();
    mocks.join.mockReset();
    mocks.createPdfTextSidecar.mockReset();
    mocks.isPdfPath.mockClear();
  });

  it("imports PDFs and creates extracted text sidecars", async () => {
    mocks.copyFileToProject.mockResolvedValueOnce("attachments/paper.pdf");
    mocks.join.mockResolvedValueOnce("C:/project/attachments/paper.pdf");
    mocks.createPdfTextSidecar.mockResolvedValueOnce({
      sidecarRelativePath: "attachments/paper.pdf.txt",
    });

    const files = await importReferenceFilesWithSidecars("C:/project", [
      "C:/source/paper.pdf",
    ]);

    expect(mocks.copyFileToProject).toHaveBeenCalledWith(
      "C:/project",
      "C:/source/paper.pdf",
      "attachments/paper.pdf",
    );
    expect(mocks.createPdfTextSidecar).toHaveBeenCalledWith(
      "C:/project",
      "attachments/paper.pdf",
      "C:/project/attachments/paper.pdf",
    );
    expect(files).toEqual([
      {
        relativePath: "attachments/paper.pdf",
        sidecarRelativePath: "attachments/paper.pdf.txt",
      },
    ]);
  });

  it("keeps imported PDF references when sidecar extraction fails", async () => {
    mocks.copyFileToProject.mockResolvedValueOnce("attachments/paper.pdf");
    mocks.join.mockResolvedValueOnce("C:/project/attachments/paper.pdf");
    mocks.createPdfTextSidecar.mockRejectedValueOnce(
      new Error("cannot extract"),
    );

    const files = await importReferenceFilesWithSidecars("C:/project", [
      "C:/source/paper.pdf",
    ]);

    expect(files[0]).toMatchObject({
      relativePath: "attachments/paper.pdf",
      sidecarError: "cannot extract",
    });
  });

  it("builds a prompt section that points models at PDF sidecars", () => {
    const section = buildReferenceFilesSection([
      {
        relativePath: "attachments/paper.pdf",
        sidecarRelativePath: "attachments/paper.pdf.txt",
      },
      { relativePath: "attachments/data.csv" },
    ]);

    expect(section).toContain("### Reference Files");
    expect(section).toContain(
      "`attachments/paper.pdf` (extracted text: `attachments/paper.pdf.txt`)",
    );
    expect(section).toContain("`attachments/data.csv`");
    expect(section).toContain("For PDFs, read the extracted text sidecar");
  });
});
