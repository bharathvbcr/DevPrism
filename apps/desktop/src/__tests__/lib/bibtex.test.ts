import { describe, it, expect } from "vitest";
import {
  appendBibEntry,
  importBibEntries,
  parseBibFile,
  removeBibEntry,
  replaceBibEntry,
  serializeBibEntry,
} from "@/lib/bibtex";

const SAMPLE = `@article{smith2024,
  title = {A Great Paper},
  author = {Smith, Jane},
  year = {2024},
  journal = {Nature},
}
`;

describe("parseBibFile", () => {
  it("parses entry keys and display fields", () => {
    const [entry] = parseBibFile(SAMPLE);
    expect(entry.key).toBe("smith2024");
    expect(entry.type).toBe("article");
    expect(entry.title).toBe("A Great Paper");
    expect(entry.author).toBe("Smith, Jane");
    expect(entry.year).toBe("2024");
  });
});

describe("bib mutations", () => {
  it("replaces an entry in place", () => {
    const [entry] = parseBibFile(SAMPLE);
    const updated = replaceBibEntry(SAMPLE, entry, {
      key: "smith2024",
      type: "article",
      fields: {
        title: "Updated Title",
        author: "Smith, Jane",
        year: "2025",
      },
    });
    expect(updated).toContain("Updated Title");
    expect(updated).toContain("year = {2025}");
  });

  it("removes an entry", () => {
    const [entry] = parseBibFile(SAMPLE);
    const updated = removeBibEntry(SAMPLE, entry);
    expect(updated.trim()).toBe("");
  });

  it("appends a new entry", () => {
    const updated = appendBibEntry("", {
      key: "jones2023",
      type: "book",
      fields: { title: "Book", author: "Jones" },
    });
    expect(updated).toContain("@book{jones2023");
    expect(
      serializeBibEntry({
        key: "k",
        type: "misc",
        fields: { note: "x" },
      }),
    ).toContain("@misc{k");
  });

  it("imports pasted entries and skips duplicate keys", () => {
    const pasted = `@book{jones2023,
  title = {Book},
  author = {Jones},
}
@article{smith2024,
  title = {Duplicate},
}`;
    const { content, added, skipped } = importBibEntries(SAMPLE, pasted);
    expect(added).toBe(1);
    expect(skipped).toBe(1);
    expect(content).toContain("@book{jones2023");
    expect(content).not.toContain("Duplicate");
  });
});
