import { PackageIcon, FileCodeIcon, SparklesIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTemplateStore } from "@/stores/template-store";
import { getTemplateById } from "@/lib/template-registry";

interface TemplatePreviewProps {
  onUseTemplate: (id: string) => void;
}

export function TemplatePreview({ onUseTemplate }: TemplatePreviewProps) {
  const previewTemplateId = useTemplateStore((s) => s.previewTemplateId);
  const closePreview = useTemplateStore((s) => s.closePreview);

  const template = previewTemplateId ? getTemplateById(previewTemplateId) : null;

  if (!template) return null;

  return (
    <Dialog open={!!previewTemplateId} onOpenChange={(open) => !open && closePreview()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden p-0">
        <div className="flex h-full max-h-[85vh] flex-col">
          {/* Header */}
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
            <div className="flex items-start gap-4">
              <div
                className="flex size-10 shrink-0 items-center justify-center rounded-lg"
                style={{ backgroundColor: template.accentColor + "18" }}
              >
                <div
                  className="size-5 rounded"
                  style={{ backgroundColor: template.accentColor }}
                />
              </div>
              <div className="flex-1">
                <DialogTitle className="text-base">{template.name}</DialogTitle>
                <DialogDescription className="mt-0.5">
                  {template.description}
                </DialogDescription>
              </div>
              <Button
                onClick={() => {
                  closePreview();
                  onUseTemplate(template.id);
                }}
                className="gap-1.5"
              >
                <SparklesIcon className="size-4" />
                Use Template
              </Button>
            </div>
          </DialogHeader>

          {/* Content split: code preview + info */}
          <div className="flex flex-1 overflow-hidden">
            {/* LaTeX source preview */}
            <div className="flex-1 overflow-y-auto border-r border-border bg-muted/30 p-4">
              <div className="mb-2 flex items-center gap-1.5 text-muted-foreground text-xs">
                <FileCodeIcon className="size-3.5" />
                <span>{template.mainFileName}</span>
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/80">
                {template.content}
              </pre>
            </div>

            {/* Info sidebar */}
            <div className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto p-4">
              {/* Metadata */}
              <div>
                <div className="mb-2 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                  Details
                </div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Class</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {template.documentClass}
                    </code>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Category</span>
                    <span className="text-xs capitalize">{template.category}</span>
                  </div>
                  {template.hasBibliography && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Bibliography</span>
                      <span className="text-xs">Yes</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Packages */}
              {template.packages.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                    <PackageIcon className="size-3" />
                    Packages ({template.packages.length})
                  </div>
                  <div className="space-y-1.5">
                    {template.packages.map((pkg) => (
                      <div key={pkg.name} className="text-xs">
                        <code className="font-mono text-foreground/80">{pkg.name}</code>
                        <p className="mt-0.5 text-muted-foreground leading-snug">
                          {pkg.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tags */}
              <div>
                <div className="mb-2 font-medium text-xs text-muted-foreground uppercase tracking-wider">
                  Tags
                </div>
                <div className="flex flex-wrap gap-1">
                  {template.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
