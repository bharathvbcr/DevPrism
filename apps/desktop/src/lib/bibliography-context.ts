import { parseBibFile } from "@/lib/bibtex";
import { useDocumentStore } from "@/stores/document-store";

/** Compact bibliography summary for agent prompts. */
export function buildBibliographyContext(): string | null {
  const files = useDocumentStore.getState().files;
  const bibFiles = files.filter(
    (f) => f.type === "bib" || f.name.toLowerCase().endsWith(".bib"),
  );
  if (bibFiles.length === 0) return null;

  const lines: string[] = [];
  let totalEntries = 0;
  for (const file of bibFiles.slice(0, 4)) {
    const content = file.content ?? "";
    const count = content ? parseBibFile(content).length : 0;
    totalEntries += count;
    lines.push(`- \`${file.relativePath}\`: ${count} entries`);
  }
  if (bibFiles.length > 4) {
    lines.push(`- …and ${bibFiles.length - 4} more .bib files`);
  }

  return [
    "## BIBLIOGRAPHY",
    `${bibFiles.length} bibliography file(s), ~${totalEntries} entries total.`,
    lines.join("\n"),
    "Read these files for citation keys before suggesting \\cite{…} or editing .bib entries.",
  ].join("\n");
}
