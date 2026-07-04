import { InlineBanner } from "@/components/ui/inline-banner";
import { isTauri } from "@/lib/runtime/is-tauri";

const DISMISS_KEY = "devprism-browser-preview-banner-dismissed";

export function BrowserPreviewBanner() {
  if (isTauri()) return null;
  if (sessionStorage.getItem(DISMISS_KEY) === "1") return null;

  return (
    <InlineBanner
      kind="info"
      title="Browser preview mode"
      message="Projects open from in-browser storage or a linked folder. LaTeX compile, native AI, and some file dialogs need the desktop app (pnpm dev:desktop)."
      actionLabel="Dismiss"
      onAction={() => sessionStorage.setItem(DISMISS_KEY, "1")}
      onDismiss={() => sessionStorage.setItem(DISMISS_KEY, "1")}
    />
  );
}
