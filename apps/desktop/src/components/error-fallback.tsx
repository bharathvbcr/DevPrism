import { useState } from "react";
import type { FallbackProps } from "react-error-boundary";
import { generateBugReport } from "@/lib/debug/bug-report";

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyDebugInfo = async () => {
    try {
      const report = await generateBugReport();
      // Append the crash error to the report
      const errorInfo = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) };
      const fullReport = JSON.parse(report);
      fullReport.crash_error = errorInfo;
      await navigator.clipboard.writeText(JSON.stringify(fullReport, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: copy just the error
      const text = error instanceof Error
        ? `${error.message}\n\n${error.stack ?? ""}`
        : String(error);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
      <div className="max-w-2xl w-full space-y-4">
        <h1 className="text-2xl font-bold text-destructive">
          Something went wrong
        </h1>
        <p className="text-sm text-muted-foreground">
          An unexpected error occurred. You can try again or reload the app.
        </p>

        <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-4 text-xs whitespace-pre-wrap">
          {error instanceof Error
            ? `${error.message}${error.stack ? `\n\n${error.stack}` : ""}`
            : String(error)}
        </pre>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={handleCopyDebugInfo}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            {copied ? "Copied!" : "Copy Debug Info"}
          </button>
        </div>
      </div>
    </div>
  );
}
