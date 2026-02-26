import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { documentDir } from "@tauri-apps/api/path";
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  PaperclipIcon,
  XIcon,
  SparklesIcon,
  UploadIcon,
  ChevronRightIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { exists, join } from "@/lib/tauri/fs";
import { getTemplateById, getTemplateSkeleton, BIB_TEMPLATE } from "@/lib/template-registry";
import { TemplateGallery } from "@/components/template-gallery";
import { getFallbackThumbnail } from "@/components/template-gallery/template-card";

// ─── Helpers ───

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// ─── Wizard Component ───

export type CreationMode = "template" | "scratch";
type WizardStep = "template" | "details";

interface ProjectWizardProps {
  mode: CreationMode;
  onBack: () => void;
}

export function ProjectWizard({ mode, onBack }: ProjectWizardProps) {
  const [step, setStep] = useState<WizardStep>(mode === "scratch" ? "details" : "template");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    mode === "scratch" ? "blank" : null,
  );
  const [purpose, setPurpose] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [refFilesOpen, setRefFilesOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const lastProjectFolder = useProjectStore((s) => s.lastProjectFolder);
  const setLastProjectFolder = useProjectStore((s) => s.setLastProjectFolder);
  const openProject = useDocumentStore((s) => s.openProject);

  const template = selectedTemplateId ? getTemplateById(selectedTemplateId) : undefined;

  // Auto-focus textarea when entering details step
  useEffect(() => {
    if (step === "details") {
      // Small delay to let the DOM settle after step transition
      const timer = setTimeout(() => textareaRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [step]);

  // Default project folder from lastProjectFolder or ~/Documents
  useEffect(() => {
    if (projectFolder) return;
    if (lastProjectFolder) {
      setProjectFolder(lastProjectFolder);
    } else {
      documentDir().then((dir) => setProjectFolder(dir)).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-generate project name from purpose (unless manually edited)
  useEffect(() => {
    if (nameManuallyEdited) return;
    const slug = slugify(purpose);
    setProjectName(slug || "");
  }, [purpose, nameManuallyEdited]);

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplateId(id);
    setStep("details");
  };

  const handleBack = () => {
    if (step === "template" || mode === "scratch") {
      onBack();
    } else {
      setStep("template");
    }
  };

  const handleChooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Location for New Project",
    });
    if (selected) {
      setProjectFolder(selected);
      setLastProjectFolder(selected);
    }
  }, [setLastProjectFolder]);

  const handleAddAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      title: "Add Reference Files",
      filters: [
        {
          name: "Documents & Images",
          extensions: [
            "pdf", "tex", "bib", "txt", "md",
            "png", "jpg", "jpeg", "gif", "svg",
            "csv", "tsv", "json",
          ],
        },
      ],
    });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    }
  }, []);

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  // Listen for Tauri drag-drop events (OS file drops)
  useEffect(() => {
    if (step !== "details") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter") {
          setIsDragOver(true);
          setRefFilesOpen(true); // auto-open section on drag
        } else if (type === "drop") {
          setIsDragOver(false);
          const paths = (event.payload as { paths: string[] }).paths;
          if (paths?.length > 0) {
            setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn(); else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [step]);

  const handleCreate = async () => {
    if (!template || !projectFolder || !projectName.trim()) return;
    setIsCreating(true);

    try {
      const projectPath = await join(projectFolder, projectName.trim());
      await mkdir(projectPath, { recursive: true }).catch(() => {});

      // Write main.tex — skeleton only (preamble + empty body).
      const mainTexPath = await join(projectPath, template.mainFileName);
      const mainExists = await exists(mainTexPath);
      if (!mainExists) {
        await writeTextFile(mainTexPath, getTemplateSkeleton(template));
      }

      // Write references.bib for templates that use bibliography
      if (template.hasBibliography) {
        const bibPath = await join(projectPath, "references.bib");
        const bibExists = await exists(bibPath);
        if (!bibExists) {
          await writeTextFile(bibPath, BIB_TEMPLATE);
        }
      }

      // Import attachments into project
      if (attachments.length > 0) {
        const attachmentsDir = await join(projectPath, "attachments");
        await mkdir(attachmentsDir, { recursive: true }).catch(() => {});
      }

      // Build the initial prompt for Claude
      if (purpose.trim()) {
        const attachmentNames = attachments.map((p) => p.split("/").pop()).filter(Boolean);
        const attachmentSection = attachmentNames.length > 0
          ? `\n### Reference Files\n${attachmentNames.map((n) => `- \`${n}\``).join("\n")}\n\nPlease review them and incorporate relevant information.\n`
          : "";

        const prompt = [
          `## New ${template.name} Project`,
          "",
          `| | |`,
          `|---|---|`,
          `| **Template** | \`${template.documentClass}\` |`,
          `| **File** | \`${template.mainFileName}\` |`,
          "",
          `> The file currently contains only the LaTeX preamble (packages, styling, custom commands) with an empty document body.`,
          "",
          `### What I want to create`,
          "",
          purpose.trim(),
          attachmentSection,
          `### Instructions`,
          "",
          `Please generate the full document content based on my description. Keep the existing preamble and fill in the document body (between \`\\begin{document}\` and \`\\end{document}\`) with appropriate title, author, sections, and content. Make it a complete, well-structured **${template.name.toLowerCase()}** ready for me to refine.`,
        ].join("\n");

        useClaudeChatStore.getState().newSession();
        useClaudeChatStore.getState().setPendingInitialPrompt(prompt);
      }

      // Persist folder choice
      setLastProjectFolder(projectFolder);

      // Open the project
      addRecentProject(projectPath);
      await openProject(projectPath);

      // Import attachments after project is open
      if (attachments.length > 0) {
        await useDocumentStore.getState().importFiles(attachments, "attachments");
      }
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = template && projectFolder && projectName.trim();

  // Step indicator
  const totalSteps = mode === "template" ? 2 : 1;
  const currentStepIndex = step === "template" ? 0 : mode === "template" ? 1 : 0;

  const headerTitle = step === "template" ? "Choose a Template" : "Project Details";

  const FallbackThumbnail = template ? getFallbackThumbnail(template) : null;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 pt-[var(--titlebar-height)] h-[calc(48px+var(--titlebar-height))]">
        <Button variant="ghost" size="icon" className="size-7" onClick={handleBack}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">{headerTitle}</span>
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          {Array.from({ length: totalSteps }, (_, i) => (
            <div
              key={i}
              className={`size-2 rounded-full ${i <= currentStepIndex ? "bg-foreground" : "bg-muted-foreground/30"}`}
            />
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {step === "template" ? (
          <TemplateGallery onSelectTemplate={handleSelectTemplate} />
        ) : (
          <div className="flex h-full items-center justify-center overflow-y-auto">
            <div className="mx-auto w-full max-w-lg space-y-5 p-6">
              {/* Template indicator with thumbnail */}
              {template && mode === "template" && (
                <button
                  onClick={() => setStep("template")}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/50"
                >
                  {FallbackThumbnail && (
                    <div
                      className="size-10 shrink-0 overflow-hidden rounded-md border border-border bg-card"
                      style={{ aspectRatio: template.aspectRatio }}
                    >
                      <FallbackThumbnail color={template.accentColor} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{template.name}</div>
                    <div className="text-muted-foreground text-xs truncate">{template.description}</div>
                  </div>
                  <span className="shrink-0 text-muted-foreground text-xs">Change</span>
                </button>
              )}

              {/* Purpose — hero element */}
              <div className="space-y-2">
                <label className="font-medium text-sm">What are you writing?</label>
                <Textarea
                  ref={textareaRef}
                  placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  rows={5}
                  className="resize-none text-base"
                />
                <p className="text-muted-foreground text-xs">
                  Claude will use this to customize your template with relevant content and structure.
                </p>
              </div>

              {/* Reference files — collapsible */}
              <div>
                <button
                  onClick={() => setRefFilesOpen(!refFilesOpen)}
                  className="flex w-full items-center gap-2 py-1.5 text-left"
                >
                  <ChevronRightIcon
                    className={`size-4 text-muted-foreground transition-transform ${refFilesOpen ? "rotate-90" : ""}`}
                  />
                  <span className="text-sm text-muted-foreground">Reference files</span>
                  <span className="text-xs text-muted-foreground/60">(optional)</span>
                  {attachments.length > 0 && (
                    <span className="ml-auto rounded-full bg-foreground/10 px-2 py-0.5 text-xs text-muted-foreground">
                      {attachments.length}
                    </span>
                  )}
                </button>
                {refFilesOpen && (
                  <div className="mt-2 space-y-2">
                    <div
                      className={`rounded-lg border-2 border-dashed p-3 transition-colors ${
                        isDragOver
                          ? "border-primary bg-primary/5"
                          : attachments.length > 0
                            ? "border-border bg-muted/20"
                            : "border-muted-foreground/20 bg-muted/10"
                      }`}
                    >
                      {attachments.length > 0 && (
                        <div className="mb-2 space-y-1.5">
                          {attachments.map((path) => (
                            <div
                              key={path}
                              className="flex items-center gap-2 rounded-md bg-background px-3 py-1.5 text-sm"
                            >
                              <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate text-xs">{path.split("/").pop()}</span>
                              <button
                                onClick={() => handleRemoveAttachment(path)}
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                              >
                                <XIcon className="size-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {isDragOver ? (
                        <div className="flex flex-col items-center gap-1.5 py-2 text-primary">
                          <UploadIcon className="size-5" />
                          <span className="text-xs font-medium">Drop to add</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-1.5 py-2">
                          <span className="text-xs text-muted-foreground">
                            Drag & drop files here
                          </span>
                          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={handleAddAttachments}>
                            <PaperclipIcon className="size-3.5" />
                            Browse files
                          </Button>
                        </div>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      PDFs, images, .bib, .tex, or data files to include as references.
                    </p>
                  </div>
                )}
              </div>

              {/* Project location — collapsible */}
              <div>
                <button
                  onClick={() => setLocationOpen(!locationOpen)}
                  className="flex w-full items-center gap-2 py-1.5 text-left"
                >
                  <ChevronRightIcon
                    className={`size-4 text-muted-foreground transition-transform ${locationOpen ? "rotate-90" : ""}`}
                  />
                  <span className="text-sm text-muted-foreground">Project location</span>
                  {projectFolder && projectName.trim() && (
                    <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground/60 max-w-[200px]">
                      .../{projectFolder.split("/").pop()}/{projectName.trim()}
                    </span>
                  )}
                </button>
                {locationOpen && (
                  <div className="mt-2 space-y-2">
                    <div className="flex gap-2">
                      <Input
                        placeholder="Project name"
                        value={projectName}
                        onChange={(e) => {
                          setProjectName(e.target.value);
                          setNameManuallyEdited(true);
                        }}
                        className="flex-1"
                      />
                      <Button variant="outline" className="shrink-0 gap-1.5" onClick={handleChooseFolder}>
                        <FolderOpenIcon className="size-4" />
                        {projectFolder ? "Change" : "Choose folder"}
                      </Button>
                    </div>
                    {projectFolder && (
                      <p className="truncate text-muted-foreground text-xs">
                        {projectFolder}/{projectName.trim() || "..."}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Create button */}
              <Button
                className="w-full gap-2"
                size="lg"
                disabled={!canCreate || isCreating}
                onClick={handleCreate}
              >
                {isCreating ? (
                  "Creating..."
                ) : purpose.trim() ? (
                  <>
                    <SparklesIcon className="size-4" />
                    Create & Generate with AI
                  </>
                ) : (
                  "Create Project"
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
