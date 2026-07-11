import { describe, expect, it } from "vitest";
import {
  chunkMarkdown,
  chunkMindmap,
  chunkPdfPageTexts,
  flattenFreemind,
  flattenOpml,
  sha1HexSync,
  simplifyObsidian,
  splitByHeadings,
  splitToWindows,
  TARGET_MAX_CHARS,
  TARGET_MIN_CHARS,
  bibEntriesToChunks,
  bibEntriesToPublicationBlocks,
  parseBibtexToPublicationBlocks,
  buildPreparedSource,
} from "@/lib/career/ingest";
import { createHash } from "node:crypto";
import { parseBibFile } from "@/lib/bibtex";

describe("sha1HexSync", () => {
  it("matches node:crypto SHA-1", () => {
    const samples = ["", "hello", "unicode café 🧬", "a".repeat(2000)];
    for (const s of samples) {
      const expected = createHash("sha1").update(s, "utf8").digest("hex");
      expect(sha1HexSync(s)).toBe(expected);
    }
  });
});

describe("splitToWindows", () => {
  it("returns a single window for short text", () => {
    const windows = splitToWindows("Short paragraph.");
    expect(windows).toEqual(["Short paragraph."]);
  });

  it("splits long text near target size with overlap", () => {
    const paras = Array.from({ length: 40 }, (_, i) =>
      `Paragraph ${i} with enough words to accumulate toward the chunk target size for testing.`.repeat(
        2,
      ),
    );
    const text = paras.join("\n\n");
    const windows = splitToWindows(text);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      expect(w.length).toBeGreaterThan(TARGET_MIN_CHARS * 0.4);
      expect(w.length).toBeLessThan(TARGET_MAX_CHARS * 2);
    }
    // Adjacent windows should share some overlap content
    if (windows.length >= 2) {
      const a = windows[0]!;
      const b = windows[1]!;
      const tail = a.slice(-80);
      expect(b.includes(tail.slice(0, 40)) || a.includes(b.slice(0, 40))).toBe(
        true,
      );
    }
  });
});

describe("chunkMarkdown", () => {
  it("tracks heading paths and strips Obsidian wikilinks", () => {
    const md = `---
date: 2024-06-01
---

# Career

Intro with [[DevPrism|the app]] and #tag.

## Projects

Built [[Nextflow]] pipelines for genomics.
`;
    const chunks = chunkMarkdown(md, { sourceTitle: "wiki" });
    expect(chunks.length).toBeGreaterThan(0);
    expect(simplifyObsidian("see [[Page|alias]]")).toBe("see alias");
    const project = chunks.find((c) => c.meta.headingPath.includes("Projects"));
    expect(project).toBeTruthy();
    expect(project!.text).toContain("Nextflow");
    expect(project!.text).not.toContain("[[");
    expect(project!.meta.sourceTitle).toBe("wiki");
    expect(project!.meta.contentHash).toMatch(/^[a-f0-9]{40}$/);
    expect(project!.meta.date).toBe("2024-06-01");
  });

  it("splits by ATX headings into sections", () => {
    const sections = splitByHeadings("# A\n\none\n\n## B\n\ntwo");
    expect(sections).toHaveLength(2);
    expect(sections[0]!.headingPath).toEqual(["A"]);
    expect(sections[1]!.headingPath).toEqual(["A", "B"]);
  });
});

describe("chunkMindmap", () => {
  it("flattens OPML to parent > child paths", () => {
    const opml = `<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="Root">
      <outline text="Child">
        <outline text="Leaf"/>
      </outline>
    </outline>
  </body>
</opml>`;
    expect(flattenOpml(opml)).toEqual([
      "Root",
      "Root > Child",
      "Root > Child > Leaf",
    ]);
    const chunks = chunkMindmap(opml, { sourceTitle: "map" });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.text).toContain("Root > Child > Leaf");
  });

  it("flattens FreeMind XML", () => {
    const mm = `<map>
  <node TEXT="Root">
    <node TEXT="Child"/>
  </node>
</map>`;
    expect(flattenFreemind(mm)).toEqual(["Root", "Root > Child"]);
  });
});

describe("chunkPdfPageTexts", () => {
  it("scopes chunks by page heading", () => {
    const chunks = chunkPdfPageTexts(
      [
        { pageIndex: 0, text: "First page content about ML systems." },
        { pageIndex: 1, text: "Second page content about genomics." },
      ],
      { sourceTitle: "paper.pdf" },
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.meta.headingPath[0] === "Page 1")).toBe(true);
    expect(chunks.some((c) => c.meta.page === 0 || c.meta.page === 1)).toBe(
      true,
    );
  });
});

describe("bibEntriesToChunks", () => {
  it("seeds one chunk per BibTeX entry", () => {
    const bib = `@article{smith2024,
  title = {A Great Paper},
  author = {Smith, Jane},
  year = {2024},
  journal = {Nature},
}
@book{jones2023,
  title = {Book},
  author = {Jones},
  year = {2023},
}
`;
    const entries = parseBibFile(bib);
    const chunks = bibEntriesToChunks(entries, "Zotero");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain("A Great Paper");
    expect(chunks[0]!.meta.citekey).toBe("smith2024");
    expect(chunks[1]!.meta.headingPath).toEqual(["Book"]);
  });
});

describe("bibEntriesToPublicationBlocks", () => {
  it("maps entries to kind publication ExperienceBlocks", () => {
    const bib = `@article{smith2024,
  title = {A Great Paper},
  author = {Smith, Jane},
  year = {2024},
  journal = {Nature},
}
@inproceedings{lee2022,
  title = {Conf Paper},
  author = {Lee},
  year = {2022},
  booktitle = {NeurIPS},
}
`;
    const entries = parseBibFile(bib);
    const blocks = bibEntriesToPublicationBlocks(entries);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.kind).toBe("publication");
    expect(blocks[0]!.title).toBe("A Great Paper");
    expect(blocks[0]!.org).toBe("Nature");
    expect(blocks[0]!.dateRange.start).toBe("2024");
    expect(blocks[0]!.bullets[0]!.canonical).toContain("Smith, Jane");
    expect(blocks[0]!.embeddingText).toContain("A Great Paper");
    expect(blocks[1]!.org).toBe("NeurIPS");
    expect(blocks[1]!.domains).toContain("inproceedings");
  });

  it("parseBibtexToPublicationBlocks throws on empty bib", () => {
    expect(() => parseBibtexToPublicationBlocks("% empty")).toThrow(
      /No BibTeX entries/,
    );
  });
});

describe("ProcessingProgress helpers", () => {
  it("buildPreparedSource assigns chunk indexes and content hash", () => {
    const prepared = buildPreparedSource(
      [
        {
          text: "Hello world",
          meta: {
            sourceTitle: "t",
            headingPath: ["A"],
            contentHash: sha1HexSync("Hello world"),
          },
        },
        {
          text: "Second",
          meta: {
            sourceTitle: "t",
            headingPath: ["B"],
            contentHash: sha1HexSync("Second"),
          },
        },
      ],
      { uri: "file://x", title: "Doc", sourceType: "markdown" },
    );
    expect(prepared.chunks).toHaveLength(2);
    expect(prepared.chunks[0]!.meta.index).toBe(0);
    expect(prepared.chunks[1]!.meta.index).toBe(1);
    expect(prepared.contentHash).toMatch(/^[a-f0-9]{40}$/);
    expect(prepared.title).toBe("Doc");
  });
});
