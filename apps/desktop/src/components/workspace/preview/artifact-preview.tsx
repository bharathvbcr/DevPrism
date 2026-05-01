import { useDocumentStore } from "@/stores/document-store";
import { PdfPreview } from "./pdf-preview";
import ReactMarkdown from "react-markdown";
import { ScrollArea } from "@/components/ui/scroll-area";

// Simple code block syntax highlighting could be added here if needed

export function ArtifactPreview() {
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);

  const activeFile = files.find((f) => f.id === activeFileId);

  if (!activeFile) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/20">
        <div className="text-muted-foreground text-sm">
          No artifact selected
        </div>
      </div>
    );
  }

  // If it's a LaTeX file, show the PDF preview.
  if (
    activeFile.type === "tex" ||
    activeFile.name.endsWith(".tex") ||
    activeFile.name.endsWith(".ltx")
  ) {
    return <PdfPreview />;
  }

  // If it's a Markdown file, render markdown
  if (activeFile.name.endsWith(".md") || activeFile.name.endsWith(".mdx")) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center justify-between border-b bg-muted/10 px-4">
          <div className="font-medium text-sm">Markdown Preview</div>
        </div>
        <ScrollArea className="prose prose-sm dark:prose-invert max-w-none flex-1 p-6">
          <ReactMarkdown>{activeFile.content || ""}</ReactMarkdown>
        </ScrollArea>
      </div>
    );
  }

  // Otherwise (Code/Text), render plain text or syntax highlighted code block
  // Using a read-only representation for artifact preview
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b bg-muted/10 px-4">
        <div className="font-medium text-sm">
          Code Preview ({activeFile.name})
        </div>
      </div>
      <ScrollArea className="flex-1 p-6">
        <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-4 font-mono text-sm">
          <code>{activeFile.content || ""}</code>
        </pre>
      </ScrollArea>
    </div>
  );
}
