import { useRef, useState } from "react";
import { Loader2Icon, SparklesIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { useDocumentStore } from "@/stores/document-store";
import { canUseAiAssist, summarizeSection } from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { PdfPreview } from "./pdf-preview";
import ReactMarkdown from "react-markdown";
import { ScrollArea } from "@/components/ui/scroll-area";

// Simple code block syntax highlighting could be added here if needed

/** AI "Summarize" affordance for the artifact preview header. */
function ArtifactSummarize({ content }: { content: string }) {
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  if (!aiSummarize || !canUseAiAssist()) return null;

  const handleSummarize = () => {
    const text = content.trim();
    if (!text) {
      toast.error("Nothing to summarize");
      return;
    }
    const id = ++requestIdRef.current;
    setLoading(true);
    setSummary(null);
    summarizeSection(text)
      .then((next) => {
        if (id === requestIdRef.current) setSummary(next.trim());
      })
      .catch(() => {
        if (id === requestIdRef.current) toast.error("Could not summarize");
      })
      .finally(() => {
        if (id === requestIdRef.current) setLoading(false);
      });
  };

  const dismiss = () => {
    requestIdRef.current++;
    setSummary(null);
    setLoading(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleSummarize}
        disabled={loading}
        title="Summarize with AI"
        className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/80 px-2 py-1 text-muted-foreground text-xs transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-60"
      >
        {loading ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <SparklesIcon className="size-3.5" />
        )}
        Summarize
      </button>
      {summary !== null && (
        <div className="absolute top-full right-0 z-20 mt-2 w-80 max-w-[80vw] rounded-md border bg-popover p-3 text-popover-foreground text-sm shadow-md">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
              <SparklesIcon className="size-3" />
              AI summary
            </span>
            <button
              type="button"
              onClick={dismiss}
              title="Dismiss"
              className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {summary || "No summary available."}
          </p>
        </div>
      )}
    </div>
  );
}

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
          <ArtifactSummarize content={activeFile.content || ""} />
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
        <ArtifactSummarize content={activeFile.content || ""} />
      </div>
      <ScrollArea className="flex-1 p-6">
        <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-4 font-mono text-sm">
          <code>{activeFile.content || ""}</code>
        </pre>
      </ScrollArea>
    </div>
  );
}
