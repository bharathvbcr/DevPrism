import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import {
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

  it("rejects bytes that are not a zip archive", async () => {
    await expect(
      readResumeSourceFromZipBytes(strToU8("definitely not a zip"), "x.zip"),
    ).rejects.toThrow(/not a valid zip/);
  });

  it("rejects archives without any tex files", async () => {
    const bytes = zipSync({ "notes.md": strToU8("# hi") });
    await expect(
      readResumeSourceFromZipBytes(bytes, "notes.zip"),
    ).rejects.toThrow(/does not contain any LaTeX/);
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
    ).rejects.toThrow(/\.zip archive or a \.tex file/);
  });

  it("rejects an empty .tex file", async () => {
    await expect(
      readResumeSourceFromFile(makeFile("empty.tex", strToU8("   \n"))),
    ).rejects.toThrow(/is empty/);
  });
});
