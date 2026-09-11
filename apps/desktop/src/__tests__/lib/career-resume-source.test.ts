import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import {
  RESUME_SOURCE_MAX_BYTES,
  isResumeImportFileName,
  isZipFileName,
  pickResumeTexEntry,
  readResumeSourceFromFile,
  readResumeSourceFromZipBytes,
} from "@/lib/career/resume-source";

function makeFile(name: string, data: Uint8Array, type = ""): File {
  const file = new File([new Uint8Array(data)], name, { type });
  // jsdom's File lacks .text()/.arrayBuffer().
  Object.defineProperty(file, "text", {
    value: async () => new TextDecoder().decode(data),
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => data.slice().buffer as ArrayBuffer,
  });
  return file;
}

describe("isZipFileName", () => {
  it("detects zip extensions case-insensitively", () => {
    expect(isZipFileName("resume.ZIP")).toBe(true);
    expect(isZipFileName("overleaf-archive.zip")).toBe(true);
    expect(isZipFileName("main.tex")).toBe(false);
  });
});

describe("pickResumeTexEntry", () => {
  it("prefers main.tex over other candidates in a wrapper-rooted archive", () => {
    const entries = unzipSync(
      zipSync({
        "overleaf/main.tex": strToU8("\\documentclass{article}MAIN"),
        "overleaf/sections/experience.tex": strToU8("EXPERIENCE"),
        "overleaf/refs.bib": strToU8("@misc{x}"),
      }),
    );
    const picked = pickResumeTexEntry(entries);
    expect(picked?.name).toBe("main.tex");
    expect(picked?.text).toBe("\\documentclass{article}MAIN");
  });

  it("falls back to the shallowest .tex when no known basename exists", () => {
    const entries = unzipSync(
      zipSync({
        "pkg/deep/nested/a.tex": strToU8("deep"),
        "pkg/shallow.tex": strToU8("shallow"),
      }),
    );
    expect(pickResumeTexEntry(entries)?.name).toBe("shallow.tex");
  });

  it("ignores __MACOSX noise and zip-slip entry names", () => {
    const entries: Record<string, Uint8Array> = {
      "__MACOSX/._main.tex": strToU8("junk"),
      "../escape.tex": strToU8("bad"),
      "ok.tex": strToU8("good"),
    };
    const picked = pickResumeTexEntry(entries);
    expect(picked?.name).toBe("ok.tex");
    expect(picked?.text).toBe("good");
  });

  it("returns null when the archive has no .tex entries", () => {
    const entries = unzipSync(zipSync({ "refs.bib": strToU8("@misc{x}") }));
    expect(pickResumeTexEntry(entries)).toBeNull();
  });
});

describe("readResumeSourceFromZipBytes", () => {
  it("extracts the primary tex source from a wrapper-rooted archive", async () => {
    const bytes = zipSync({
      "resume/main.tex": strToU8("\\documentclass{article}"),
      "resume/logo.png": new Uint8Array([1, 2, 3]),
    });
    const out = await readResumeSourceFromZipBytes(bytes, "resume.zip");
    expect(out.label).toBe("main.tex");
    expect(out.source).toContain("documentclass");
  });

  it("inlines \\input of sibling tex files from the archive", async () => {
    const bytes = zipSync({
      "resume/main.tex": strToU8(
        "\\documentclass{article}\\begin{document}\\input{Experience}\\end{document}",
      ),
      "resume/Experience.tex": strToU8(
        "\\section{Experience}\\resumeItem{Shipped}",
      ),
    });
    const out = await readResumeSourceFromZipBytes(bytes, "resume.zip");
    expect(out.source).toContain("Shipped");
    expect(out.source).not.toMatch(/\\input\{Experience\}/);
  });

  it("rejects bytes that are not a zip archive", async () => {
    await expect(
      readResumeSourceFromZipBytes(strToU8("definitely not a zip"), "x.zip"),
    ).rejects.toThrow(/not a valid zip/);
  });

  it("falls back to a markdown resume when the archive has no .tex", async () => {
    const bytes = zipSync({
      "notes.md": strToU8("# Jane Doe\n\nExperience\n"),
    });
    const out = await readResumeSourceFromZipBytes(bytes, "notes.zip");
    expect(out.label).toBe("notes.md");
    expect(out.source).toContain("Jane Doe");
  });

  it("rejects archives with neither tex nor markdown/text resumes", async () => {
    const bytes = zipSync({ "refs.bib": strToU8("@misc{x}") });
    await expect(
      readResumeSourceFromZipBytes(bytes, "refs.zip"),
    ).rejects.toThrow(/does not contain a resume source/);
  });
});

describe("readResumeSourceFromFile", () => {
  it("reads a loose .tex file directly", async () => {
    const file = makeFile("cv.tex", strToU8("\\begin{document}hi"));
    const out = await readResumeSourceFromFile(file);
    expect(out.source).toContain("begin{document}");
    expect(out.label).toBe("cv.tex");
  });

  it("unwraps a dropped zip file via the File API", async () => {
    const bytes = zipSync({ "archive/main.tex": strToU8("ZIPPED") });
    const out = await readResumeSourceFromFile(makeFile("archive.zip", bytes));
    expect(out.source).toBe("ZIPPED");
    expect(out.label).toBe("main.tex");
  });

  it("rejects unsupported file types", async () => {
    await expect(
      readResumeSourceFromFile(makeFile("photo.png", new Uint8Array([9]))),
    ).rejects.toThrow(/zip, \.tex, \.pdf, \.md, or \.txt/);
  });

  it("rejects Word documents instead of silently dropping them", async () => {
    await expect(
      readResumeSourceFromFile(
        makeFile(
          "resume.docx",
          strToU8("PK"),
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ),
    ).rejects.toThrow(/docx is not supported/i);
  });

  it("rejects an empty .tex file", async () => {
    await expect(
      readResumeSourceFromFile(makeFile("empty.tex", strToU8("   \n"))),
    ).rejects.toThrow(/is empty/);
  });

  it("reads a loose markdown resume", async () => {
    const out = await readResumeSourceFromFile(
      makeFile(
        "cv.md",
        strToU8("# Ada Lovelace\n\n## Experience\n- Built the engine"),
      ),
    );
    expect(out.label).toBe("cv.md");
    expect(out.source).toContain("Ada Lovelace");
  });

  it("reads a loose text resume", async () => {
    const out = await readResumeSourceFromFile(
      makeFile("cv.txt", strToU8("Ada Lovelace\nExperience\nEngineer at Acme")),
    );
    expect(out.source).toContain("Engineer at Acme");
  });

  it("extracts PDF text through the injected extractor", async () => {
    const file = makeFile(
      "resume.pdf",
      new Uint8Array([37, 80, 68, 70]),
      "application/pdf",
    );
    const out = await readResumeSourceFromFile(file, {
      extractPdfText: async () => "Jane Doe\nExperience\nEngineer at Acme",
    });
    expect(out.label).toBe("resume.pdf");
    expect(out.source).toContain("Jane Doe");
  });

  it("rejects files over the byte cap before reading", async () => {
    const file = makeFile("huge.txt", strToU8("ok"));
    Object.defineProperty(file, "size", { value: RESUME_SOURCE_MAX_BYTES + 1 });
    await expect(readResumeSourceFromFile(file)).rejects.toThrow(/exceeds/);
  });
});

describe("isResumeImportFileName", () => {
  it("accepts the IgniteCV porting surface without Word", () => {
    expect(isResumeImportFileName("a.PDF")).toBe(true);
    expect(isResumeImportFileName("a.md")).toBe(true);
    expect(isResumeImportFileName("a.txt")).toBe(true);
    expect(isResumeImportFileName("a.tex")).toBe(true);
    expect(isResumeImportFileName("a.zip")).toBe(true);
    expect(isResumeImportFileName("a.docx")).toBe(false);
    expect(isResumeImportFileName("photo.png")).toBe(false);
  });
});
