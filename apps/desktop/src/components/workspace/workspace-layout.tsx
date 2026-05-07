import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { ArtifactPreview } from "./preview/artifact-preview";
import { useDocumentStore } from "@/stores/document-store";
import { DevPrismLogo } from "@/components/devprism-logo";

export function WorkspaceLayout() {
  const initialized = useDocumentStore((s) => s.initialized);

  if (!initialized) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <DevPrismLogo imageClassName="size-12" />
        <div className="text-muted-foreground">Loading project...</div>
      </div>
    );
  }

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={15} minSize={10} maxSize={25}>
        <Sidebar />
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      <Panel defaultSize={42.5} minSize={25}>
        <LatexEditor />
      </Panel>

      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-ring" />

      <Panel defaultSize={42.5} minSize={25}>
        <ArtifactPreview />
      </Panel>
    </PanelGroup>
  );
}
