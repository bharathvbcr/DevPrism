import { useState, useCallback, useEffect, useRef } from "react";
import { pickProjectFolder, pickProjectFiles } from "@/lib/platform-dialog";
import { isTauri } from "@/lib/runtime/is-tauri";
import {
  collectBrowserDropFiles,
  hasBrowserFileDrag,
} from "@/lib/browser-project/drag-drop";
import { stageBrowserFile } from "@/lib/browser-project/attachment-staging";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { homeDir } from "@tauri-apps/api/path";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  FolderOpenIcon,
  PaperclipIcon,
  XIcon,
  SparklesIcon,
  UploadIcon,
  ChevronDownIcon,
  FileTextIcon,
  MapPinIcon,
  Loader2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "@/components/ui/inline-banner";
import { useSetupFlowStore } from "@/stores/setup-flow-store";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { exists, join } from "@/lib/tauri/fs";
import {
  setupNewProjectInSpace,
  formatNewProjectSetupToast,
} from "@/lib/space-project";
import {
  getTemplateById,
  getTemplateSkeleton,
  BIB_TEMPLATE,
} from "@/lib/template-registry";
import { TemplateGallery } from "@/components/template-gallery";
import { DEFAULT_CLAUDE_MD } from "@/lib/default-claude-md";
import { DEFAULT_AGENT_MD } from "@/lib/default-agent-md";
import {
  buildReferenceFilesSection,
  importReferenceFiles,
} from "@/lib/project-attachments";
import { getProjectNameError, normalizeProjectName } from "@/lib/project-name";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist, suggestProjectName } from "@/lib/ai-assist";
import { useSpacesStore } from "@/stores/spaces-store";
import {
  inferSpaceKind,
  spaceKindLabel,
  bundledSkillsForKind,
} from "@/lib/space-features";
import { masterFileNameForKind } from "@/lib/space-master";
import { cn } from "@/lib/utils";
import { WizardSetupChecklist } from "./wizard-setup-checklist";

function WizardOnboardingStep({ step }: { step: 1 | 2 }) {
  const launchedFromOnboarding = useSetupFlowStore(
    (s) => s.launchedFromOnboarding,
  );
  if (!launchedFromOnboarding) return null;
  return (
    <div
      className="shrink-0 border-primary/20 border-b bg-primary/5 px-4 py-2 text-center text-muted-foreground text-xs"
      role="status"
    >
      <span className="font-medium text-foreground">Step {step} of 2</span>
      {" — "}
      {step === 1 ? "Choose how to start" : "Create your project"}
    </div>
  );
}

// ─── Helpers ───

function NewProjectSpaceHint({ className }: { className?: string }) {
  const activeSpaceId = useSpacesStore((s) => s.activeSpaceId);
  const spaces = useSpacesStore((s) => s.spaces);
  const space = spaces.find((s) => s.id === activeSpaceId) ?? null;
  if (!space) return null;

  const kind = inferSpaceKind(space);
  const skills = bundledSkillsForKind(kind);
  const master = kind !== "general" ? masterFileNameForKind(kind) : null;

  const details: string[] = [`added to ${space.name}`];
  if (skills?.length) {
    details.push(`install ${skills.join(", ")} skills`);
  }
  if (master) {
    details.push(`create ${master}`);
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-muted-foreground text-xs leading-relaxed",
        className,
      )}
    >
      <span className="font-medium text-foreground">
        {spaceKindLabel(kind)} space active —{" "}
      </span>
      New projects will be {details.join(" · ")}.
    </div>
  );
}

// ─── Wizard Component ───

export type CreationMode = "template" | "scratch";
export type WizardMode = CreationMode;

interface ProjectWizardProps {
  mode: WizardMode;
  onBack: () => void;
  onSelectMode?: (mode: CreationMode) => void;
  onOpenSettings?: () => void;
}

export function ProjectWizard({
  mode,
  onBack,
  onSelectMode,
  onOpenSettings,
}: ProjectWizardProps) {
  // ── Template mode: the primary creation surface ──
  // The gallery is inline; picking a template opens a single TemplatePreview
  // dialog that hosts preview + name + location together (no extra steps).
  // "Start blank" keeps the scratch path one click away without an
  // intermediate chooser screen.
  if (mode === "template") {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-[calc(48px+var(--titlebar-height))] shrink-0 items-center gap-3 border-border/60 border-b px-4 pt-[var(--titlebar-height)]">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-lg"
            onClick={onBack}
            aria-label="Back to projects"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="font-semibold text-sm">Create New Project</span>
          {onSelectMode && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => onSelectMode("scratch")}
            >
              <FileTextIcon className="size-3.5" />
              Start blank instead
            </Button>
          )}
        </div>
        <WizardOnboardingStep step={2} />
        <NewProjectSpaceHint className="mx-4 mt-3 shrink-0" />
        <WizardSetupChecklist
          className="mx-4 mt-3 shrink-0"
          onOpenSettings={onOpenSettings}
        />
        <div className="flex-1 overflow-hidden">
          <TemplateGallery onOpenSettings={onOpenSettings} />
        </div>
      </div>
    );
  }

  // ── Scratch mode: inline details form ──
  return <ScratchForm onBack={onBack} onOpenSettings={onOpenSettings} />;
}

// ─── Scratch mode form (no template preview) ───

function ScratchForm({
  onBack,
  onOpenSettings,
}: {
  onBack: () => void;
  onOpenSettings?: () => void;
}) {
  const [purpose, setPurpose] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectNameError, setProjectNameError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [refFilesOpen, setRefFilesOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);

  const projectNameRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── AI-suggested project name (from purpose) ──
  const aiNaming = useSettingsStore((s) => s.aiNaming);
  const [nameSuggesting, setNameSuggesting] = useState(false);
  const nameTouchedRef = useRef(false);
  const nameSuggestDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const nameSuggestRequestRef = useRef(0);

  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const lastProjectFolder = useProjectStore((s) => s.lastProjectFolder);
  const setLastProjectFolder = useProjectStore((s) => s.setLastProjectFolder);
  const openProject = useDocumentStore((s) => s.openProject);

  const template = getTemplateById("blank")!;

  useEffect(() => {
    const timer = setTimeout(() => projectNameRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (projectFolder) return;
    if (lastProjectFolder) {
      setProjectFolder(lastProjectFolder);
    } else {
      homeDir()
        .then((home) => join(home, "Documents", "DevPrism"))
        .then(async (dir) => {
          await mkdir(dir, { recursive: true }).catch(() => {});
          setProjectFolder(dir);
        })
        .catch((err) =>
          console.warn("Failed to resolve default project folder:", err),
        );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Debounced AI name suggestion from the purpose text ──
  // Only prefills while the user has not manually edited the name field.
  useEffect(() => {
    if (nameSuggestDebounceRef.current) {
      clearTimeout(nameSuggestDebounceRef.current);
    }

    if (!aiNaming || !canUseAiAssist()) return;
    if (nameTouchedRef.current) return;

    const goal = purpose.trim();
    if (goal.length < 12) return;

    nameSuggestDebounceRef.current = setTimeout(() => {
      const id = ++nameSuggestRequestRef.current;
      setNameSuggesting(true);
      void suggestProjectName(goal)
        .then((suggested) => {
          if (id !== nameSuggestRequestRef.current) return;
          if (nameTouchedRef.current) return;
          const normalized = normalizeProjectName(suggested);
          if (normalized) {
            setProjectName(normalized);
            setProjectNameError("");
          }
        })
        .catch(() => {
          // Passive/background AI: fail silently.
        })
        .finally(() => {
          if (id === nameSuggestRequestRef.current) setNameSuggesting(false);
        });
    }, 800);

    return () => {
      if (nameSuggestDebounceRef.current) {
        clearTimeout(nameSuggestDebounceRef.current);
      }
    };
  }, [purpose, aiNaming]);

  const handleChooseFolder = useCallback(async () => {
    const selected = await pickProjectFolder({
      title: "Choose Location for New Project",
    });
    if (selected) {
      setProjectFolder(selected);
      setLastProjectFolder(selected);
    }
  }, [setLastProjectFolder]);

  const handleAddAttachments = useCallback(async () => {
    const selected = await pickProjectFiles({
      multiple: true,
      title: "Add Reference Files",
    });
    if (selected) {
      setAttachments((prev) => [
        ...prev,
        ...selected.filter((p) => !prev.includes(p)),
      ]);
    }
  }, []);

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  // Drag-drop
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    if (isTauri()) {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (cancelled) return;
          const { type } = event.payload;
          if (type === "enter") {
            setIsDragOver(true);
            setRefFilesOpen(true);
          } else if (type === "drop") {
            setIsDragOver(false);
            const paths = (event.payload as { paths: string[] }).paths;
            if (paths?.length > 0) {
              setAttachments((prev) => [
                ...prev,
                ...paths.filter((p) => !prev.includes(p)),
              ]);
            }
          } else if (type === "leave") {
            setIsDragOver(false);
          }
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    }

    const onDragOver = (event: DragEvent) => {
      if (!hasBrowserFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setIsDragOver(true);
      setRefFilesOpen(true);
    };
    const onDragLeave = () => setIsDragOver(false);
    const onDrop = (event: DragEvent) => {
      if (isTauri() || !hasBrowserFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setIsDragOver(false);
      void collectBrowserDropFiles(event.dataTransfer!).then((items) => {
        if (items.length === 0) return;
        setAttachments((prev) => [
          ...prev,
          ...items
            .map((item) => stageBrowserFile(item.file))
            .filter((p) => !prev.includes(p)),
        ]);
      });
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const handleCreate = async () => {
    const name = normalizeProjectName(projectName);
    const nameError = getProjectNameError(projectName);
    if (!template || !projectFolder || nameError) {
      setProjectNameError(nameError ?? "");
      return;
    }
    setIsCreating(true);
    setCreateError(null);

    try {
      const projectPath = await join(projectFolder, name);
      if (await exists(projectPath)) {
        setProjectNameError("A folder with this name already exists here");
        return;
      }
      await mkdir(projectPath, { recursive: true });

      // Create CLAUDE.md for Claude Code context
      const claudeMdPath = await join(projectPath, "CLAUDE.md");
      const claudeMdExists = await exists(claudeMdPath);
      if (!claudeMdExists) {
        await writeTextFile(claudeMdPath, DEFAULT_CLAUDE_MD);
      }

      // Create AGENTS.md so agent backends that read the AGENTS.md convention
      // (and DevPrism's native local agent) get the same project context.
      const agentMdPath = await join(projectPath, "AGENTS.md");
      const agentMdExists = await exists(agentMdPath);
      if (!agentMdExists) {
        await writeTextFile(agentMdPath, DEFAULT_AGENT_MD);
      }

      const mainTexPath = await join(projectPath, template.mainFileName);
      const mainExists = await exists(mainTexPath);
      if (!mainExists) {
        await writeTextFile(mainTexPath, getTemplateSkeleton(template));
      }

      if (template.hasBibliography) {
        const bibPath = await join(projectPath, "references.bib");
        const bibExists = await exists(bibPath);
        if (!bibExists) {
          await writeTextFile(bibPath, BIB_TEMPLATE);
        }
      }

      const referenceFiles =
        attachments.length > 0
          ? await importReferenceFiles(projectPath, attachments)
          : [];

      if (purpose.trim()) {
        const attachmentSection = buildReferenceFilesSection(referenceFiles);

        const prompt = [
          `## New ${template.name} Project`,
          "",
          `**Template:** \`${template.documentClass}\`  `,
          `**File:** \`${template.mainFileName}\``,
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

      setLastProjectFolder(projectFolder);
      const setup = await setupNewProjectInSpace(projectPath, {
        mainTexPath,
      });
      addRecentProject(projectPath);
      await openProject(projectPath);
      useSetupFlowStore.getState().completeOnboarding();
      const toastMsg = formatNewProjectSetupToast(setup, "Project created");
      toast.success(toastMsg);
    } catch (err) {
      console.error("Failed to create project:", err);
      setCreateError(
        err instanceof Error ? err.message : "Could not create the project.",
      );
    } finally {
      setIsCreating(false);
    }
  };

  const canCreate = Boolean(
    template && projectFolder && !getProjectNameError(projectName),
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex h-[calc(48px+var(--titlebar-height))] shrink-0 items-center gap-3 border-border/60 border-b px-4 pt-[var(--titlebar-height)]">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-lg"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <span className="font-semibold text-sm">New Document</span>
      </div>
      <WizardOnboardingStep step={2} />

      {/* Form */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[520px] space-y-4 px-6 py-10">
          <WizardSetupChecklist onOpenSettings={onOpenSettings} />
          {/* Project name */}
          <div className="space-y-2.5">
            <div>
              <span className="flex items-center gap-1.5 font-semibold text-sm">
                Project name
                {nameSuggesting && (
                  <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
                )}
              </span>
              <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                This becomes the folder name on disk.
              </p>
            </div>
            <Input
              ref={projectNameRef}
              placeholder="e.g., flashvid-paper"
              value={projectName}
              onChange={(e) => {
                nameTouchedRef.current = true;
                setProjectName(e.target.value);
                setProjectNameError("");
              }}
              onBlur={() =>
                setProjectNameError(getProjectNameError(projectName) ?? "")
              }
              className="rounded-xl border-border/60 bg-card/30 text-sm focus-visible:bg-card/50"
            />
            {projectNameError && (
              <p className="text-destructive text-xs">{projectNameError}</p>
            )}
          </div>

          {/* Purpose */}
          <div className="space-y-2.5">
            <div>
              <span className="font-semibold text-sm">
                What are you writing?
              </span>
              <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                Describe your document and Claude will generate tailored
                content.
              </p>
            </div>
            <Textarea
              ref={textareaRef}
              placeholder="e.g., A research paper on transformer architectures for protein structure prediction, targeting NeurIPS 2025..."
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={4}
              className="resize-none rounded-xl border-border/60 bg-card/30 text-sm leading-relaxed placeholder:text-muted-foreground/50 focus-visible:bg-card/50"
            />
          </div>

          {/* Collapsible sections */}
          <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/60 bg-card/30">
            {/* Reference files */}
            <div>
              <button
                type="button"
                aria-expanded={refFilesOpen}
                aria-controls="wizard-reffiles-panel"
                onClick={() => setRefFilesOpen(!refFilesOpen)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                  <FileTextIcon className="size-3.5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-sm">Reference files</span>
                  {attachments.length > 0 && (
                    <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 font-semibold text-[10px] text-primary leading-none">
                      {attachments.length}
                    </span>
                  )}
                </div>
                <ChevronDownIcon
                  className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${refFilesOpen ? "rotate-180" : ""}`}
                />
              </button>
              {refFilesOpen && (
                <div id="wizard-reffiles-panel" className="space-y-3 px-4 pb-4">
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {attachments.map((path) => (
                        <div
                          key={path}
                          className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 py-1 pr-1.5 pl-2.5 text-xs transition-colors hover:bg-muted/60"
                        >
                          <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/70" />
                          <span className="max-w-[140px] truncate text-foreground/80">
                            {path.split(/[/\\]/).pop()}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${path.split(/[/\\]/).pop()}`}
                            onClick={() => handleRemoveAttachment(path)}
                            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                          >
                            <XIcon className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleAddAttachments}
                    className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed p-4 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isDragOver
                        ? "scale-[1.01] border-primary bg-primary/5"
                        : "border-border/60 hover:border-border hover:bg-muted/20"
                    }`}
                  >
                    {isDragOver ? (
                      <>
                        <UploadIcon className="size-5 text-primary" />
                        <span className="font-medium text-primary text-xs">
                          Drop to add
                        </span>
                      </>
                    ) : (
                      <>
                        <UploadIcon className="size-5 text-muted-foreground/40" />
                        <div className="text-center">
                          <span className="text-muted-foreground/70 text-xs">
                            Drag & drop or{" "}
                          </span>
                          <span className="font-medium text-foreground/70 underline decoration-border underline-offset-2">
                            browse files
                          </span>
                        </div>
                        <span className="text-[10px] text-muted-foreground/40">
                          PDF, TEX, BIB, images, or data files
                        </span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Project location */}
            <div>
              <button
                type="button"
                aria-expanded={locationOpen}
                aria-controls="wizard-location-panel"
                onClick={() => setLocationOpen(!locationOpen)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                  <MapPinIcon className="size-3.5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-sm">Project location</span>
                </div>
                {!locationOpen && projectFolder && projectName.trim() && (
                  <span className="min-w-0 max-w-[180px] truncate rounded-md bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground/60">
                    .../{projectFolder.split(/[/\\]/).pop()}/
                    {normalizeProjectName(projectName)}
                  </span>
                )}
                <ChevronDownIcon
                  className={`size-4 text-muted-foreground/60 transition-transform duration-200 ${locationOpen ? "rotate-180" : ""}`}
                />
              </button>
              {locationOpen && (
                <div
                  id="wizard-location-panel"
                  className="space-y-2.5 px-4 pb-4"
                >
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground/60">
                      {projectFolder
                        ? `${projectFolder}/${normalizeProjectName(projectName) || "..."}`
                        : "Choose a location"}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5 rounded-lg border-border/60"
                      onClick={handleChooseFolder}
                    >
                      <FolderOpenIcon className="size-3.5" />
                      {projectFolder ? "Change" : "Choose"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Create button */}
          <div className="space-y-3 pt-1">
            {createError && (
              <InlineBanner
                kind="error"
                title="Could not create project"
                message={createError}
                onDismiss={() => setCreateError(null)}
              />
            )}
            <Button
              className="w-full gap-2 rounded-xl font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.99]"
              size="lg"
              disabled={!canCreate || isCreating}
              onClick={handleCreate}
            >
              {isCreating ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  Creating project...
                </>
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
      </div>
    </div>
  );
}
