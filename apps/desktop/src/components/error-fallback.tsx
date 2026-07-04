import type { FallbackProps } from "react-error-boundary";

import { Button } from "@/components/ui/button";

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl space-y-4">
        <h1 className="font-bold text-2xl text-destructive">
          Something went wrong
        </h1>
        <p className="text-muted-foreground text-sm">
          An unexpected error occurred. You can try again or reload the app.
        </p>

        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-4 text-xs">
          {error instanceof Error
            ? `${error.message}${error.stack ? `\n\n${error.stack}` : ""}`
            : String(error)}
        </pre>

        <div className="flex gap-2">
          <Button onClick={resetErrorBoundary}>Try again</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}
