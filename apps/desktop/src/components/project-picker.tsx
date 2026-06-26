import {
  type ComponentType,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, stat } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import {
  FolderOpenIcon,
  XIcon,
  FileTextIcon,
  SparklesIcon,
  CheckCircle2Icon,
  CircleIcon,
  DownloadIcon,
  Loader2Icon,
  KeyRoundIcon,
  SearchIcon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
  GithubIcon,
  LayersIcon,
  CheckIcon,
  MoreVerticalIcon,
  PencilIcon,
  Trash2Icon,
  FileArchiveIcon,
  GraduationCapIcon,
  BriefcaseIcon,
  FlaskConicalIcon,
  BookOpenIcon,
  RocketIcon,
  StarIcon,
  HeartIcon,
  CodeIcon,
  LightbulbIcon,
  ZapIcon,
  UserIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PersonalizationSettings } from "./personalization-settings";
import { useProjectStore } from "@/stores/project-store";
import {
  useSpacesStore,
  type Space,
  type SpaceKind,
  SPACE_COLORS,
} from "@/stores/spaces-store";
import {
  SPACE_KIND_OPTIONS,
  inferSpaceKind,
  spaceKindLabel,
  spaceFeatureConfig,
  bundledSkillsForKind,
} from "@/lib/space-features";
import { installBundledSkills } from "@/lib/tauri/skills";
import {
  setupNewProjectInSpace,
  formatNewProjectSetupToast,
  applySpaceModelForProject,
} from "@/lib/space-project";
import { masterFileNameForKind } from "@/lib/space-master";
import { useDocumentStore } from "@/stores/document-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  getOllamaBaseUrl,
  listOllamaModels,
  resolveOllamaCredential,
  type OllamaModelInfo,
} from "@/lib/ollama";
import { useOllamaStatus } from "@/hooks/use-ollama-status";
import { OllamaSetupHints } from "@/components/ollama-setup-hints";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import {
  useSettingsStore,
  type HomepageDateField,
} from "@/stores/settings-store";
import { compileLatex } from "@/lib/latex-compiler";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { exists, join, scanProjectFolder } from "@/lib/tauri/fs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ProjectWizard, type CreationMode } from "./project-wizard";
import { ClaudeSetup } from "./claude-setup";
import { cn } from "@/lib/utils";
import {
  canUseAiAssist,
  summarizeSection,
  semanticRank,
} from "@/lib/ai-assist";
import { suggestSpaceMeta } from "@/lib/ai-extras";

interface DefaultProject {
  path: string;
  name: string;
  last_modified: number;
  has_main_tex: boolean;
}

type ProjectPickerSection = "projects" | "settings";
type SettingsDetailSection = "provider" | "environment" | "editor" | "ai" | "personalization";

type RecentProject = {
  path: string;
  name: string;
  lastOpened: number;
};

type ProjectPreviewData = {
  createdAt: number | null;
  modifiedAt: number | null;
} & (
  | { kind: "pdf"; url: string }
  | { kind: "tex"; fileName: string; lines: string[] }
  | { kind: "empty" }
);

type ProjectPreviewState =
  | { status: "loading" }
  | { status: "ready"; data: ProjectPreviewData }
  | { status: "error" };

/**
 * Icons a user can pick for a space. The `key` is what's persisted on the
 * space (Space.icon); keep keys stable so saved spaces keep their icon.
 */
const SPACE_ICONS: { key: string; Icon: LucideIcon }[] = [
  { key: "layers", Icon: LayersIcon },
  { key: "graduation-cap", Icon: GraduationCapIcon },
  { key: "briefcase", Icon: BriefcaseIcon },
  { key: "flask", Icon: FlaskConicalIcon },
  { key: "book", Icon: BookOpenIcon },
  { key: "rocket", Icon: RocketIcon },
  { key: "star", Icon: StarIcon },
  { key: "heart", Icon: HeartIcon },
  { key: "code", Icon: CodeIcon },
  { key: "lightbulb", Icon: LightbulbIcon },
  { key: "file", Icon: FileTextIcon },
];

const SPACE_ICON_MAP = new Map(SPACE_ICONS.map(({ key, Icon }) => [key, Icon]));

/**
 * Custom MIME used when dragging a project card onto a space (or "All Projects")
 * to reassign it. Distinct from OS file drops, which Tauri handles separately.
 */
const PROJECT_DND_MIME = "application/x-devprism-project";

/** Is this drag carrying a project card (vs. an OS file / something else)? */
function isProjectDrag(event: ReactDragEvent): boolean {
  return event.dataTransfer.types.includes(PROJECT_DND_MIME);
}

/**
 * Renders a space's chosen icon tinted with its color, or a plain colored dot
 * when no icon is set (the default / legacy state).
 */
function SpaceGlyph({
  space,
  className,
}: {
  space: Pick<Space, "color" | "icon">;
  className?: string;
}) {
  const Icon = space.icon ? SPACE_ICON_MAP.get(space.icon) : undefined;
  if (Icon) {
    return (
      <Icon
        className={cn("size-3.5 shrink-0", className)}
        style={{ color: space.color }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className={cn("size-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: space.color }}
      aria-hidden
    />
  );
}

function NewProjectSpaceHint() {
  const activeSpaceId = useSpacesStore((s) => s.activeSpaceId);
  const spaces = useSpacesStore((s) => s.spaces);
  const space = useMemo(
    () => spaces.find((s) => s.id === activeSpaceId) ?? null,
    [spaces, activeSpaceId],
  );
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
    <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
      <span className="font-medium text-foreground">
        {spaceKindLabel(kind)} space active —{" "}
      </span>
      New projects will be {details.join(" · ")}.
    </div>
  );
}

const projectPreviewCache = new Map<string, ProjectPreviewData>();
const projectPreviewRequests = new Map<string, Promise<ProjectPreviewData>>();
let projectPreviewCompileQueue: Promise<void> = Promise.resolve();

// One AI summary per project per session, keyed by project path (not the
// preview cache key, which also folds in lastOpened — the blurb shouldn't be
// recomputed just because a project moved to the top of the list).
const projectBlurbCache = new Map<string, string>();
const projectBlurbRequests = new Map<string, Promise<string>>();
// Cap concurrent local-model calls so hovering across many cards doesn't fan
// out into a flood of simultaneous Ollama requests.
const MAX_CONCURRENT_BLURBS = 2;
let activeBlurbCount = 0;
const blurbWaiters: (() => void)[] = [];

function acquireBlurbSlot(): Promise<void> {
  if (activeBlurbCount < MAX_CONCURRENT_BLURBS) {
    activeBlurbCount += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    blurbWaiters.push(() => {
      activeBlurbCount += 1;
      resolve();
    });
  });
}

function releaseBlurbSlot(): void {
  activeBlurbCount -= 1;
  const next = blurbWaiters.shift();
  if (next) next();
}

export function ProjectPicker() {
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [wizardMode, setWizardMode] = useState<CreationMode | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [activeSection, setActiveSection] = useState<ProjectPickerSection>(
    () => useSpacesStore.getState().pendingPickerSection ?? "projects",
  );
  // The in-project sidebar can deep-link here (e.g. its Settings button closes
  // the project and asks the picker to open on Settings). Consume the request
  // once so a later manual "All Projects" navigation isn't overridden.
  useEffect(() => {
    if (useSpacesStore.getState().pendingPickerSection) {
      useSpacesStore.getState().setPendingPickerSection(null);
    }
  }, []);
  const [settingsDetailSection, setSettingsDetailSection] =
    useState<SettingsDetailSection>("provider");
  const [searchQuery, setSearchQuery] = useState("");
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<RecentProject | null>(null);
  const [spaceDialog, setSpaceDialog] = useState<{
    editingId: string | null;
    name: string;
    kind: SpaceKind;
    color: string;
    icon: string | null;
    description: string;
  } | null>(null);
  const [installingSkills, setInstallingSkills] = useState(false);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<Space | null>(
    null,
  );
  // True while a project card is being dragged, so drop targets can light up.
  const [isDraggingProject, setIsDraggingProject] = useState(false);
  const defaultProjectsDiscoveredRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchShortcutLabel = "⌘ K";

  const recentProjects = useProjectStore((s) => s.recentProjects);
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const removeRecentProject = useProjectStore((s) => s.removeRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);

  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const checkClaudeStatus = useClaudeSetupStore((s) => s.checkStatus);
  const isClaudeReady = claudeStatus === "ready";

  useEffect(() => {
    checkClaudeStatus();
    getVersion().then(setAppVersion);
  }, [checkClaudeStatus]);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" ||
        event.altKey ||
        event.shiftKey ||
        (!event.metaKey && !event.ctrlKey)
      ) {
        return;
      }

      event.preventDefault();
      setActiveSection("projects");
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  useEffect(() => {
    if (defaultProjectsDiscoveredRef.current || recentProjects.length > 0) {
      return;
    }
    defaultProjectsDiscoveredRef.current = true;

    let cancelled = false;

    async function discoverDefaultProjects() {
      try {
        const projects = await invoke<DefaultProject[]>(
          "list_default_projects",
        );
        if (cancelled || projects.length === 0) return;

        for (const project of [...projects].reverse()) {
          addRecentProject(project.path);
        }
      } catch (err) {
        console.warn("Failed to discover default projects:", err);
      }
    }

    discoverDefaultProjects();

    return () => {
      cancelled = true;
    };
  }, [addRecentProject, recentProjects.length]);

  // When a project belongs to a space with a default model, apply that model to
  // the currently-selected provider credential (e.g. the local Ollama provider),
  // so opening a project in a space switches the agent to the space's model.
  const applySpaceModel = (path: string) => {
    applySpaceModelForProject(path);
  };

  const handleOpenFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open Project Folder",
      });
      if (typeof selected === "string" && selected) {
        await openProject(selected);
        addRecentProject(selected);
        applySpaceModel(selected);
      }
    } catch (err) {
      console.warn("Failed to open selected project folder:", err);
      toast.error("Failed to open project folder", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleOpenRecent = async (path: string) => {
    try {
      await openProject(path);
      addRecentProject(path);
      applySpaceModel(path);
    } catch (err) {
      removeRecentProject(path);
      assignProject(path, null);
      console.warn("Failed to open recent project:", { path, error: err });
    }
  };

  const handleSelectMode = (mode: CreationMode) => {
    setShowModeDialog(false);
    setWizardMode(mode);
  };

  // ─── Drag-and-drop import (.zip LaTeX archives / project folders) ───
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const importDroppedPaths = async (paths: string[]) => {
    const isZipName = (p: string) => p.toLowerCase().endsWith(".zip");

    // Classify by what's actually on disk, not just the extension.
    const zips: string[] = [];
    const dirs: string[] = [];
    const files: string[] = [];
    for (const p of paths) {
      let isDirectory = false;
      try {
        isDirectory = (await stat(p)).isDirectory;
      } catch {
        // Unreadable / not a real path — fall back to the name heuristic.
      }
      if (isDirectory) {
        dirs.push(p);
      } else if (isZipName(p)) {
        zips.push(p);
      } else {
        files.push(p);
      }
    }

    if (zips.length === 0 && dirs.length === 0 && files.length === 0) {
      if (paths.length > 0) {
        toast.error("Unsupported drop", {
          description: "Drop a .zip archive, LaTeX files, or a project folder.",
        });
      }
      return;
    }

    setIsImporting(true);
    let firstPath: string | null = null;
    try {
      // 1) Each .zip becomes its own extracted project.
      for (const zip of zips) {
        try {
          const imported = await invoke<{ path: string; name: string }>(
            "import_zip_project",
            { zipPath: zip },
          );
          const setup = await setupNewProjectInSpace(imported.path);
          addRecentProject(imported.path);
          applySpaceModel(imported.path);
          firstPath = firstPath ?? imported.path;
          toast.success(
            formatNewProjectSetupToast(setup, `Imported "${imported.name}"`),
          );
        } catch (err) {
          console.warn("Failed to import zip project:", { zip, error: err });
          toast.error("Failed to import archive", {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (files.length > 0) {
        // 2) Loose files (a bare main.tex + refs.bib + images, plus any figure
        //    folders dropped alongside) are bundled into one new project.
        try {
          const imported = await invoke<{ path: string; name: string }>(
            "import_loose_files",
            { paths: [...files, ...dirs] },
          );
          const setup = await setupNewProjectInSpace(imported.path);
          addRecentProject(imported.path);
          applySpaceModel(imported.path);
          firstPath = firstPath ?? imported.path;
          toast.success(
            formatNewProjectSetupToast(setup, `Created "${imported.name}"`),
          );
        } catch (err) {
          console.warn("Failed to create project from files:", { error: err });
          toast.error("Failed to create project from files", {
            description: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // 3) Only folders dropped → open each as an existing project.
        for (const folder of dirs) {
          addRecentProject(folder);
          applySpaceModel(folder);
          firstPath = firstPath ?? folder;
        }
      }

      // Opening a project unmounts this view, so only open one (the first).
      if (firstPath) {
        await openProject(firstPath);
      }
    } finally {
      setIsImporting(false);
    }
  };

  // Keep a stable listener that always calls the latest handler closure.
  const importDroppedPathsRef = useRef(importDroppedPaths);
  importDroppedPathsRef.current = importDroppedPaths;
  // Guards read by the (once-registered) listener without re-subscribing.
  const importingRef = useRef(false);
  const wizardModeRef = useRef(wizardMode);
  wizardModeRef.current = wizardMode;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { type } = event.payload;
        // While the wizard is open or an import is running, ignore OS drops so
        // we never yank the user out of a flow or start a second import.
        const blocked = wizardModeRef.current !== null || importingRef.current;
        if (type === "enter" || type === "over") {
          if (!blocked) setIsDragging(true);
        } else if (type === "leave") {
          setIsDragging(false);
        } else if (type === "drop") {
          setIsDragging(false);
          if (blocked) return;
          const paths = (event.payload as { paths?: string[] }).paths ?? [];
          importingRef.current = true;
          void importDroppedPathsRef.current(paths).finally(() => {
            importingRef.current = false;
          });
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not in a Tauri webview (e.g. plain browser dev) — drag-drop is a no-op.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ─── Project Spaces ───
  const spaces = useSpacesStore((s) => s.spaces);
  const projectSpace = useSpacesStore((s) => s.projectSpace);
  const activeSpaceId = useSpacesStore((s) => s.activeSpaceId);
  const setActiveSpace = useSpacesStore((s) => s.setActiveSpace);
  const createSpace = useSpacesStore((s) => s.createSpace);
  const updateSpace = useSpacesStore((s) => s.updateSpace);
  const deleteSpace = useSpacesStore((s) => s.deleteSpace);
  const assignProject = useSpacesStore((s) => s.assignProject);
  const setSpaceDefaults = useSpacesStore((s) => s.setSpaceDefaults);
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const setNativeAgentEnabled = useSettingsStore(
    (s) => s.setNativeAgentEnabled,
  );
  const aiAssistEnabled = useSettingsStore((s) => s.aiAssistEnabled);
  const setAiAssistEnabled = useSettingsStore((s) => s.setAiAssistEnabled);
  const aiGrammarHints = useSettingsStore((s) => s.aiGrammarHints);
  const setAiGrammarHints = useSettingsStore((s) => s.setAiGrammarHints);
  const aiPredictiveText = useSettingsStore((s) => s.aiPredictiveText);
  const setAiPredictiveText = useSettingsStore((s) => s.setAiPredictiveText);
  const aiContextSuggestions = useSettingsStore((s) => s.aiContextSuggestions);
  const setAiContextSuggestions = useSettingsStore(
    (s) => s.setAiContextSuggestions,
  );
  const aiLintFix = useSettingsStore((s) => s.aiLintFix);
  const setAiLintFix = useSettingsStore((s) => s.setAiLintFix);
  const aiCompileAssist = useSettingsStore((s) => s.aiCompileAssist);
  const setAiCompileAssist = useSettingsStore((s) => s.setAiCompileAssist);
  const aiBibAssist = useSettingsStore((s) => s.aiBibAssist);
  const setAiBibAssist = useSettingsStore((s) => s.setAiBibAssist);
  const aiChatFollowUps = useSettingsStore((s) => s.aiChatFollowUps);
  const setAiChatFollowUps = useSettingsStore((s) => s.setAiChatFollowUps);
  const aiPredictiveActions = useSettingsStore((s) => s.aiPredictiveActions);
  const setAiPredictiveActions = useSettingsStore(
    (s) => s.setAiPredictiveActions,
  );
  const aiChatGhostText = useSettingsStore((s) => s.aiChatGhostText);
  const setAiChatGhostText = useSettingsStore((s) => s.setAiChatGhostText);
  const aiPromptImprove = useSettingsStore((s) => s.aiPromptImprove);
  const setAiPromptImprove = useSettingsStore((s) => s.setAiPromptImprove);
  const aiAutoTitles = useSettingsStore((s) => s.aiAutoTitles);
  const setAiAutoTitles = useSettingsStore((s) => s.setAiAutoTitles);
  const aiSummarize = useSettingsStore((s) => s.aiSummarize);
  const setAiSummarize = useSettingsStore((s) => s.setAiSummarize);
  const aiNaming = useSettingsStore((s) => s.aiNaming);
  const setAiNaming = useSettingsStore((s) => s.setAiNaming);
  const aiTemplateRecommend = useSettingsStore((s) => s.aiTemplateRecommend);
  const setAiTemplateRecommend = useSettingsStore(
    (s) => s.setAiTemplateRecommend,
  );
  const aiProjectBlurb = useSettingsStore((s) => s.aiProjectBlurb);
  const setAiProjectBlurb = useSettingsStore((s) => s.setAiProjectBlurb);
  const aiCommentAssist = useSettingsStore((s) => s.aiCommentAssist);
  const setAiCommentAssist = useSettingsStore((s) => s.setAiCommentAssist);
  const aiSemanticSearch = useSettingsStore((s) => s.aiSemanticSearch);
  const setAiSemanticSearch = useSettingsStore((s) => s.setAiSemanticSearch);
  const aiCommandAssist = useSettingsStore((s) => s.aiCommandAssist);
  const setAiCommandAssist = useSettingsStore((s) => s.setAiCommandAssist);
  const aiSnippetFill = useSettingsStore((s) => s.aiSnippetFill);
  const setAiSnippetFill = useSettingsStore((s) => s.setAiSnippetFill);
  const aiVisionCaption = useSettingsStore((s) => s.aiVisionCaption);
  const setAiVisionCaption = useSettingsStore((s) => s.setAiVisionCaption);
  const aiCommandPalette = useSettingsStore((s) => s.aiCommandPalette);
  const setAiCommandPalette = useSettingsStore((s) => s.setAiCommandPalette);
  const nativeNumCtx = useSettingsStore((s) => s.nativeNumCtx);
  const setNativeNumCtx = useSettingsStore((s) => s.setNativeNumCtx);
  const nativeTemperature = useSettingsStore((s) => s.nativeTemperature);
  const setNativeTemperature = useSettingsStore((s) => s.setNativeTemperature);
  const nativeOllamaModel = useSettingsStore((s) => s.nativeOllamaModel);
  const setNativeOllamaModel = useSettingsStore((s) => s.setNativeOllamaModel);
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const [settingsOllamaModels, setSettingsOllamaModels] = useState<
    OllamaModelInfo[]
  >([]);
  const [settingsOllamaModelsLoading, setSettingsOllamaModelsLoading] =
    useState(false);
  const [settingsOllamaModelsError, setSettingsOllamaModelsError] = useState<
    string | null
  >(null);
  const settingsOllamaBaseUrl = useMemo(
    () => getOllamaBaseUrl(resolveOllamaCredential(openAiCredentials, null)),
    [openAiCredentials],
  );
  const compilerBackend = useSettingsStore((s) => s.compilerBackend);
  const setCompilerBackend = useSettingsStore((s) => s.setCompilerBackend);
  const autoCompile = useSettingsStore((s) => s.autoCompile);
  const setAutoCompile = useSettingsStore((s) => s.setAutoCompile);
  const pdfDarkMode = useSettingsStore((s) => s.pdfDarkMode);
  const setPdfDarkMode = useSettingsStore((s) => s.setPdfDarkMode);
  const homepageDateField = useSettingsStore((s) => s.homepageDateField);
  const setHomepageDateField = useSettingsStore((s) => s.setHomepageDateField);
  const activeSpace = useMemo(
    () => spaces.find((s) => s.id === activeSpaceId) ?? null,
    [spaces, activeSpaceId],
  );

  useEffect(() => {
    if (!nativeAgentEnabled || settingsDetailSection !== "provider") return;

    let cancelled = false;
    setSettingsOllamaModelsLoading(true);
    setSettingsOllamaModelsError(null);
    void listOllamaModels(settingsOllamaBaseUrl)
      .then((models) => {
        if (!cancelled) setSettingsOllamaModels(models);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSettingsOllamaModels([]);
          setSettingsOllamaModelsError(
            err instanceof Error ? err.message : String(err),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSettingsOllamaModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    nativeAgentEnabled,
    settingsDetailSection,
    settingsOllamaBaseUrl,
  ]);

  const chatOllamaModels = useMemo(
    () =>
      settingsOllamaModels.filter((model) => model.chatCapable),
    [settingsOllamaModels],
  );
  const { status: settingsOllamaStatus, refresh: refreshSettingsOllamaStatus } =
    useOllamaStatus(
    settingsOllamaBaseUrl,
    nativeAgentEnabled && settingsDetailSection === "provider",
  );

  const reloadSettingsOllamaModels = useCallback(() => {
    setSettingsOllamaModelsLoading(true);
    setSettingsOllamaModelsError(null);
    void listOllamaModels(settingsOllamaBaseUrl)
      .then((models) => setSettingsOllamaModels(models))
      .catch((err: unknown) => {
        setSettingsOllamaModels([]);
        setSettingsOllamaModelsError(
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => setSettingsOllamaModelsLoading(false));
    void refreshSettingsOllamaStatus();
  }, [refreshSettingsOllamaStatus, settingsOllamaBaseUrl]);

  // Track whether the user has hand-edited name/description in the space dialog,
  // so an AI suggestion only fills fields the user left untouched.
  const [spaceFieldTouched, setSpaceFieldTouched] = useState<{
    name: boolean;
    description: boolean;
  }>({ name: false, description: false });
  const [spaceMetaPending, setSpaceMetaPending] = useState(false);
  const spaceMetaRequestIdRef = useRef(0);

  const openNewSpaceDialog = () => {
    setSpaceFieldTouched({ name: false, description: false });
    setSpaceMetaPending(false);
    spaceMetaRequestIdRef.current += 1;
    setSpaceDialog({
      editingId: null,
      name: "",
      kind: "general",
      color: SPACE_COLORS[spaces.length % SPACE_COLORS.length],
      icon: null,
      description: "",
    });
  };

  const openEditSpaceDialog = (space: Space) => {
    // An existing space already has a name/description the user chose; treat
    // them as touched so AI fill doesn't clobber them without asking.
    setSpaceFieldTouched({
      name: Boolean(space.name.trim()),
      description: Boolean(space.description?.trim()),
    });
    setSpaceMetaPending(false);
    spaceMetaRequestIdRef.current += 1;
    setSpaceDialog({
      editingId: space.id,
      name: space.name,
      kind: space.kind ?? "general",
      color: space.color,
      icon: space.icon ?? null,
      description: space.description ?? "",
    });
  };

  // Display names of projects assigned to the space currently being edited
  // (new spaces have no id yet, so none). Feeds the AI name/description suggest.
  const dialogAssignedProjectNames = useMemo(() => {
    const id = spaceDialog?.editingId;
    if (!id) return [];
    return recentProjects
      .filter((p) => projectSpace[p.path] === id)
      .map((p) => p.name);
  }, [spaceDialog?.editingId, recentProjects, projectSpace]);

  const canSuggestSpaceMeta =
    aiNaming &&
    canUseAiAssist() &&
    dialogAssignedProjectNames.length > 0 &&
    !(spaceFieldTouched.name && spaceFieldTouched.description);

  const handleSuggestSpaceMeta = () => {
    if (!canSuggestSpaceMeta || spaceMetaPending) return;
    const names = dialogAssignedProjectNames;
    const id = ++spaceMetaRequestIdRef.current;
    setSpaceMetaPending(true);
    void suggestSpaceMeta(names)
      .then((meta) => {
        if (id !== spaceMetaRequestIdRef.current) return;
        setSpaceDialog((prev) => {
          if (!prev) return prev;
          let next = prev;
          if (meta.name && !spaceFieldTouched.name) {
            next = { ...next, name: meta.name };
          }
          if (meta.description && !spaceFieldTouched.description) {
            next = { ...next, description: meta.description };
          }
          return next;
        });
      })
      // Passive affordance — fail silently and just stop the spinner.
      .catch(() => {})
      .finally(() => {
        if (id === spaceMetaRequestIdRef.current) setSpaceMetaPending(false);
      });
  };

  // Reassign a dragged project to a space (or null = All Projects / no space).
  const assignProjectViaDrop = (path: string, spaceId: string | null) => {
    if (!path) return;
    const current = useSpacesStore.getState().projectSpace[path] ?? null;
    if (current === spaceId) return;
    assignProject(path, spaceId);
    const name = recentProjects.find((p) => p.path === path)?.name ?? "Project";
    const target = spaceId ? spaces.find((s) => s.id === spaceId) : null;
    toast.success(
      target
        ? `Moved “${name}” to ${target.name}`
        : `Removed “${name}” from its space`,
    );
  };
  // Count per space from the SAME source as the grid/install handler (recentProjects),
  // so the badge can't drift from what's actually shown (and ignores orphaned mappings).
  const spaceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of recentProjects) {
      const id = projectSpace[project.path];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [recentProjects, projectSpace]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  // Projects in the current space (before applying the text query) — the
  // candidate pool both the substring filter and semantic ranking draw from.
  const spaceScopedProjects = useMemo(() => {
    if (!activeSpaceId) return recentProjects;
    return recentProjects.filter((p) => projectSpace[p.path] === activeSpaceId);
  }, [recentProjects, activeSpaceId, projectSpace]);

  const substringMatched = useMemo(() => {
    if (!normalizedSearch) return spaceScopedProjects;
    return spaceScopedProjects.filter(
      (project) =>
        project.name.toLowerCase().includes(normalizedSearch) ||
        project.path.toLowerCase().includes(normalizedSearch),
    );
  }, [normalizedSearch, spaceScopedProjects]);

  // Semantic fallback: when the literal filter surfaces few/zero matches for a
  // >=3-char query, embed-rank the whole space-scoped pool so related projects
  // still appear. Paths most-relevant first; null = no/failed ranking (fall
  // back to the substring list). requestId-guarded + debounced; fails silently.
  const [semanticOrder, setSemanticOrder] = useState<{
    query: string;
    paths: string[];
  } | null>(null);
  const semanticRequestIdRef = useRef(0);
  const semanticDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Substring already covers it well (>=3 hits) or the query is too short —
  // skip the AI pass entirely and keep plain substring behavior.
  const wantsSemantic =
    aiSemanticSearch &&
    normalizedSearch.length >= 3 &&
    substringMatched.length < 3 &&
    spaceScopedProjects.length > substringMatched.length;

  useEffect(() => {
    if (!wantsSemantic || !canUseAiAssist()) {
      setSemanticOrder(null);
      return;
    }
    if (semanticDebounceRef.current) clearTimeout(semanticDebounceRef.current);
    const candidates = spaceScopedProjects;
    const query = normalizedSearch;
    semanticDebounceRef.current = setTimeout(() => {
      const id = ++semanticRequestIdRef.current;
      void semanticRank(
        query,
        candidates.map((p) => `${p.name} ${p.path}`),
      )
        .then((ranked) => {
          if (id !== semanticRequestIdRef.current) return;
          const ordered = ranked
            .filter((r) => r.score > 0.2)
            .map((r) => candidates[r.index]?.path)
            .filter((path): path is string => Boolean(path));
          setSemanticOrder(
            ordered.length > 0 ? { query, paths: ordered } : null,
          );
        })
        .catch(() => {
          if (id === semanticRequestIdRef.current) setSemanticOrder(null);
        });
    }, 400);

    return () => {
      if (semanticDebounceRef.current) clearTimeout(semanticDebounceRef.current);
    };
  }, [wantsSemantic, normalizedSearch, spaceScopedProjects]);

  const visibleProjects = useMemo(() => {
    // Use the semantic ordering only when it's for the live query (avoids
    // showing stale results while the next ranking is in flight).
    if (
      wantsSemantic &&
      semanticOrder &&
      semanticOrder.query === normalizedSearch
    ) {
      const byPath = new Map(spaceScopedProjects.map((p) => [p.path, p]));
      const surfaced = semanticOrder.paths
        .map((path) => byPath.get(path))
        .filter((p): p is (typeof spaceScopedProjects)[number] => Boolean(p));
      if (surfaced.length > 0) return surfaced;
    }
    return substringMatched;
  }, [
    wantsSemantic,
    semanticOrder,
    normalizedSearch,
    spaceScopedProjects,
    substringMatched,
  ]);

  const handleInstallSpaceSkills = async (space: Space) => {
    const projectsInSpace = recentProjects.filter(
      (p) => projectSpace[p.path] === space.id,
    );
    if (projectsInSpace.length === 0) {
      toast.info("Add projects to this space first.");
      return;
    }
    const kind = inferSpaceKind(space);
    const only = bundledSkillsForKind(kind);
    setInstallingSkills(true);
    let succeeded = 0;
    let failed = 0;
    let total = 0;
    for (const project of projectsInSpace) {
      try {
        const installed = await installBundledSkills(project.path, only);
        total += installed.length;
        succeeded += 1;
      } catch (err) {
        failed += 1;
        console.warn("Failed to install skills for", project.path, err);
      }
    }
    setInstallingSkills(false);
    const skillHint =
      only && only.length > 0 ? ` (${only.join(", ")})` : " (full bundle)";
    if (succeeded > 0) {
      toast.success(
        `Installed DevPrism skills${skillHint} into ${succeeded} project${
          succeeded === 1 ? "" : "s"
        } (${total} skill folders)${failed > 0 ? `; ${failed} failed` : ""}.`,
      );
    } else {
      toast.error(
        `Failed to install skills into ${failed} project${failed === 1 ? "" : "s"}.`,
      );
    }
  };

  if (wizardMode) {
    return (
      <ProjectWizard mode={wizardMode} onBack={() => setWizardMode(null)} />
    );
  }

  return (
    <div className="flex h-full bg-background text-foreground">
      <aside
        className={cn(
          "flex shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out",
          isSidebarCollapsed ? "w-12" : "w-56",
        )}
      >
        <div
          className={cn(
            "flex h-[calc(48px+var(--titlebar-height))] items-center gap-2 px-3 pt-[var(--titlebar-height)]",
            isSidebarCollapsed ? "justify-center" : "justify-between",
          )}
        >
          {!isSidebarCollapsed && (
            <div className="flex min-w-0 items-center gap-2">
              <img src="/icon-192.png" alt="DevPrism" className="size-6" />
              <span className="truncate font-semibold text-sm">DevPrism</span>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "rounded-lg text-muted-foreground hover:text-foreground",
              isSidebarCollapsed ? "size-7" : "size-8",
            )}
            onClick={() => setIsSidebarCollapsed((value) => !value)}
            aria-label={
              isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
          >
            <PanelLeftIcon
              className={cn(
                "size-3.5 transition-transform duration-200",
                isSidebarCollapsed && "rotate-180",
              )}
            />
          </Button>
        </div>

        <nav
          className={cn(
            "flex flex-col gap-1",
            isSidebarCollapsed ? "items-center px-0" : "px-2",
          )}
        >
          <ProjectNavButton
            active={activeSection === "projects" && !activeSpaceId}
            collapsed={isSidebarCollapsed}
            icon={FolderOpenIcon}
            onClick={() => {
              setActiveSection("projects");
              setActiveSpace(null);
            }}
            droppable={isDraggingProject}
            onDropProject={(path) => assignProjectViaDrop(path, null)}
          >
            All Projects
          </ProjectNavButton>

          {!isSidebarCollapsed && (
            <div className="mt-2 flex flex-col gap-0.5">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  Spaces
                </span>
                <button
                  type="button"
                  title="New space"
                  aria-label="New space"
                  onClick={openNewSpaceDialog}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </div>
              {spaces.length === 0 ? (
                <p className="px-2 pb-1 text-[11px] text-muted-foreground/60 leading-snug">
                  Group related projects into a space.
                </p>
              ) : (
                spaces.map((space) => (
                  <SpaceNavButton
                    key={space.id}
                    space={space}
                    active={
                      activeSection === "projects" && activeSpaceId === space.id
                    }
                    count={spaceCounts.get(space.id) ?? 0}
                    onSelect={() => {
                      setActiveSection("projects");
                      setActiveSpace(space.id);
                    }}
                    onEdit={() => openEditSpaceDialog(space)}
                    onDelete={() => setDeleteSpaceTarget(space)}
                    droppable={isDraggingProject}
                    onDropProject={(path) =>
                      assignProjectViaDrop(path, space.id)
                    }
                  />
                ))
              )}
            </div>
          )}
        </nav>

        <div
          className={cn(
            "mt-auto flex h-9 items-center border-sidebar-border border-t text-muted-foreground text-xs",
            isSidebarCollapsed ? "justify-center px-0" : "justify-between px-3",
          )}
        >
          {isSidebarCollapsed ? (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "size-6",
                activeSection === "settings" &&
                  "bg-sidebar-accent text-foreground",
              )}
              onClick={() => setActiveSection("settings")}
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon className="size-3.5" />
            </Button>
          ) : (
            <>
              <span className="truncate">DevPrism v{appVersion}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-6",
                    activeSection === "settings" &&
                      "bg-sidebar-accent text-foreground",
                  )}
                  onClick={() => setActiveSection("settings")}
                  title="Settings"
                  aria-label="Settings"
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6" asChild>
                  <a
                    href="https://github.com/bharathvbcr/DevPrism"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="GitHub"
                    aria-label="Open GitHub repository"
                  >
                    <GithubIcon className="size-3.5" />
                  </a>
                </Button>
              </div>
            </>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[calc(48px+var(--titlebar-height))] shrink-0 flex-nowrap items-center gap-3 border-border/70 border-b bg-background px-5">
          <div className="mr-auto flex min-w-0 items-center">
            <h1 className="flex items-center gap-2 truncate font-semibold text-lg leading-none">
              {activeSection === "settings" ? (
                "Settings"
              ) : activeSpace ? (
                <>
                  <SpaceGlyph space={activeSpace} />
                  <span className="truncate">{activeSpace.name}</span>
                </>
              ) : (
                "All Projects"
              )}
            </h1>
          </div>

          {activeSection === "projects" && (
            <div className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2">
              <div className="relative flex min-w-40 flex-1 items-center sm:max-w-sm">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search"
                  className="h-9 w-full rounded-lg border border-input bg-background pr-16 pl-9 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <kbd className="pointer-events-none absolute top-1/2 right-2 flex h-6 min-w-10 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-muted/30 px-1.5 font-medium text-[11px] text-muted-foreground leading-none">
                  {searchShortcutLabel}
                </kbd>
              </div>

              <div
                className="hidden h-9 shrink-0 items-center rounded-lg border border-input p-0.5 sm:flex"
                role="group"
                aria-label="Date shown on project cards"
              >
                {(
                  [
                    { value: "modified", label: "Last edited" },
                    { value: "created", label: "Created" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setHomepageDateField(option.value)}
                    aria-pressed={homepageDateField === option.value}
                    title={
                      option.value === "modified"
                        ? "Show each project's last edited date"
                        : "Show each project's created date"
                    }
                    className={cn(
                      "h-8 rounded-md px-2.5 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      homepageDateField === option.value
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <Button
                onClick={handleOpenFolder}
                variant="secondary"
                className="h-9 shrink-0 gap-1.5 rounded-lg px-3.5"
              >
                <FolderOpenIcon className="size-4" />
                Import
              </Button>
              <Button
                onClick={() => setShowModeDialog(true)}
                className="h-9 shrink-0 gap-1.5 rounded-lg px-4"
              >
                <PlusIcon className="size-4" />
                New
              </Button>
            </div>
          )}
        </header>

        {activeSection === "projects" && activeSpace && (
          <div className="flex flex-wrap items-center gap-3 border-border/60 border-b bg-muted/20 px-5 py-2.5">
            <span className="rounded-md bg-background px-2 py-0.5 font-medium text-[11px] text-muted-foreground ring-1 ring-border/60">
              {spaceKindLabel(inferSpaceKind(activeSpace))}
            </span>
            <span className="text-muted-foreground text-xs">Default model</span>
            <input
              value={activeSpace.defaultModel ?? ""}
              onChange={(event) =>
                setSpaceDefaults(activeSpace.id, {
                  defaultModel: event.target.value,
                })
              }
              placeholder="auto (first installed Ollama model)"
              aria-label={`Default model for ${activeSpace.name}`}
              title="Local model used by default for projects in this space"
              className="h-8 w-56 rounded-md border border-input bg-background px-2.5 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5"
                title="Customize this space"
                onClick={() => openEditSpaceDialog(activeSpace)}
              >
                <PencilIcon className="size-3.5" />
                Edit
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-8 gap-1.5"
                disabled={installingSkills}
                title="Install DevPrism skills into every project in this space"
                onClick={() => void handleInstallSpaceSkills(activeSpace)}
              >
                <SparklesIcon className="size-3.5" />
                {installingSkills ? "Installing…" : "Install skills"}
              </Button>
            </div>
            {activeSpace.description?.trim() ? (
              <p className="w-full text-muted-foreground text-xs leading-snug">
                {activeSpace.description}
              </p>
            ) : (
              <p className="w-full text-muted-foreground text-xs leading-snug">
                {spaceFeatureConfig(activeSpace).description}
              </p>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {activeSection === "settings" ? (
            <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-8 py-7 lg:grid-cols-[13rem_minmax(0,1fr)]">
              <aside className="space-y-1 lg:border-border/60 lg:border-r lg:pr-4">
                <SettingsDetailButton
                  active={settingsDetailSection === "provider"}
                  icon={KeyRoundIcon}
                  label="Provider"
                  meta={isClaudeReady ? "Ready" : "Setup"}
                  onClick={() => setSettingsDetailSection("provider")}
                />
                <SettingsDetailButton
                  active={settingsDetailSection === "environment"}
                  icon={CheckCircle2Icon}
                  label="Environment"
                  meta="Python / Skills"
                  onClick={() => setSettingsDetailSection("environment")}
                />
                <SettingsDetailButton
                  active={settingsDetailSection === "ai"}
                  icon={SparklesIcon}
                  label="AI Features"
                  meta="Predictive / Grammar"
                  onClick={() => setSettingsDetailSection("ai")}
                />
                <SettingsDetailButton
                  active={settingsDetailSection === "personalization"}
                  icon={UserIcon}
                  label="Personalization"
                  meta="User Profile / Tone"
                  onClick={() => setSettingsDetailSection("personalization")}
                />
                <SettingsDetailButton
                  active={settingsDetailSection === "editor"}
                  icon={ZapIcon}
                  label="Compilation"
                  meta="Engine / Auto-compile / Preview"
                  onClick={() => setSettingsDetailSection("editor")}
                />
              </aside>

              <div className="min-w-0">
                {settingsDetailSection === "provider" ? (
                  <SettingsPanel
                    title="Provider"
                    icon={KeyRoundIcon}
                    contentClassName="p-0"
                  >
                    <label className="flex cursor-pointer items-start gap-3 border-border/60 border-b p-4">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={nativeAgentEnabled}
                        onChange={(e) =>
                          setNativeAgentEnabled(e.target.checked)
                        }
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Native local agent (no Claude CLI)
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Run the agent fully offline, talking directly to your
                          local Ollama model — no Claude Code CLI or proxy
                          required. Make sure Ollama is running with a model
                          installed (
                          <code className="rounded bg-muted px-1">
                            ollama pull llama3
                          </code>
                          ). Cloud providers below are used only when this is
                          off.{" "}
                          <a
                            href="https://github.com/bharathvbcr/DevPrism/blob/main/docs/NATIVE_AGENT.md"
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-foreground underline underline-offset-2 hover:text-primary"
                          >
                            Learn more
                          </a>
                        </p>
                      </div>
                    </label>
                    {nativeAgentEnabled && (
                      <div className="flex flex-wrap items-end gap-4 border-border/60 border-b px-4 py-3">
                        <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
                          <span className="text-muted-foreground text-xs">
                            Chat model
                          </span>
                          <select
                            value={nativeOllamaModel ?? ""}
                            disabled={settingsOllamaModelsLoading}
                            onChange={(e) =>
                              setNativeOllamaModel(e.target.value || null)
                            }
                            className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          >
                            <option value="">Auto (first chat model)</option>
                            {chatOllamaModels.map((model) => (
                              <option key={model.name} value={model.name}>
                                {model.name}
                              </option>
                            ))}
                          </select>
                          {settingsOllamaModelsLoading && (
                            <span className="text-[10px] text-muted-foreground">
                              Loading models from {settingsOllamaBaseUrl}…
                            </span>
                          )}
                          {settingsOllamaModelsError && (
                            <span className="text-[10px] text-destructive">
                              {settingsOllamaModelsError}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-muted-foreground text-xs">
                            Context window (num_ctx)
                          </span>
                          <input
                            type="number"
                            min={512}
                            step={512}
                            value={nativeNumCtx}
                            onChange={(e) =>
                              setNativeNumCtx(Number(e.target.value))
                            }
                            className="h-8 w-28 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-muted-foreground text-xs">
                            Temperature
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={2}
                            step={0.1}
                            value={nativeTemperature}
                            onChange={(e) =>
                              setNativeTemperature(Number(e.target.value))
                            }
                            className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          />
                        </label>
                        <p className="text-muted-foreground/70 text-xs">
                          Larger context = more memory/VRAM. Lower temperature =
                          more deterministic edits.
                        </p>
                      </div>
                    )}
                    {nativeAgentEnabled &&
                      settingsDetailSection === "provider" &&
                      (settingsOllamaModelsError ||
                        !settingsOllamaStatus?.connected ||
                        chatOllamaModels.length === 0) && (
                        <div className="border-border/60 border-b px-4 py-3">
                          <OllamaSetupHints
                            baseUrl={settingsOllamaBaseUrl}
                            onModelsChanged={reloadSettingsOllamaModels}
                            connected={Boolean(settingsOllamaStatus?.connected)}
                            chatModels={
                              settingsOllamaStatus?.chatModels ??
                              chatOllamaModels.length
                            }
                          />
                        </div>
                      )}
                    <div className="space-y-3 border-border/60 border-b p-4">
                      <div className="font-medium text-sm">
                        AI writing assist
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Lightweight local AI for grammar hints, predictive text
                        (Tab to accept), contextual suggestions, and one-click
                        selection edits — powered by Ollama or your configured
                        OpenAI-compatible provider.
                      </p>
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 shrink-0 accent-primary"
                          checked={aiAssistEnabled}
                          onChange={(e) => setAiAssistEnabled(e.target.checked)}
                        />
                        <span className="text-sm">
                          Enable AI assist everywhere
                        </span>
                      </label>
                      {aiAssistEnabled && (
                        <div className="ml-7 space-y-2">
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={aiGrammarHints}
                              onChange={(e) =>
                                setAiGrammarHints(e.target.checked)
                              }
                            />
                            Grammar hints on the current line
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={aiPredictiveText}
                              onChange={(e) =>
                                setAiPredictiveText(e.target.checked)
                              }
                            />
                            Predictive completions while typing
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={aiContextSuggestions}
                              onChange={(e) =>
                                setAiContextSuggestions(e.target.checked)
                              }
                            />
                            Contextual action chips in the editor
                          </label>
                        </div>
                      )}
                    </div>
                    <ClaudeSetup variant="embedded" />
                  </SettingsPanel>
                ) : settingsDetailSection === "environment" ? (
                  <SettingsPanel
                    title="Environment"
                    icon={CheckCircle2Icon}
                    contentClassName="p-0"
                  >
                    <EnvironmentStatus appVersion={appVersion} />
                  </SettingsPanel>
                ) : settingsDetailSection === "ai" ? (
                  <SettingsPanel
                    title="AI Features"
                    icon={SparklesIcon}
                    contentClassName="p-0"
                  >
                    <label className="flex cursor-pointer items-start gap-3 border-border/60 border-b p-4">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiAssistEnabled}
                        onChange={(e) => setAiAssistEnabled(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Enable AI assistant features
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Master toggle for all lightweight AI assist features
                          (predictive text, grammar hints, suggestions).
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiPredictiveText}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiPredictiveText(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Predictive text (ghost text)
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Show inline gray ghost text as you type. Press{" "}
                          <kbd className="rounded bg-muted px-1">Tab</kbd> to
                          accept or{" "}
                          <kbd className="rounded bg-muted px-1">Esc</kbd> to
                          dismiss.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiGrammarHints}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiGrammarHints(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          AI grammar & style checks
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Scan the paragraph around your cursor after you pause
                          typing. Highlights grammar, style, or spelling errors
                          with quick-fix options.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiContextSuggestions}
                        disabled={!aiAssistEnabled}
                        onChange={(e) =>
                          setAiContextSuggestions(e.target.checked)
                        }
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Contextual prompt suggestions
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Display context-aware quick action chips above the
                          status bar based on your active document's contents.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiLintFix}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiLintFix(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Direct lint fixes
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Fix LaTeX lint problems in one click via local AI
                          instead of opening the full chat.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiCompileAssist}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiCompileAssist(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Compile error assist
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Explain compilation failures and route fixes through
                          AI from the PDF preview error screen.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiBibAssist}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiBibAssist(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Bibliography completion
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Generate or complete BibTeX entries from a DOI, URL,
                          or citation hint.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiChatFollowUps}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiChatFollowUps(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Chat follow-up suggestions
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Show AI-suggested next prompts after the assistant
                          replies in the chat drawer.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiContextSuggestions}
                        disabled={!aiAssistEnabled}
                        onChange={(e) =>
                          setAiContextSuggestions(e.target.checked)
                        }
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Contextual prompt suggestions
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Display context-aware quick action chips above the
                          status bar based on your active document's contents.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiPredictiveActions}
                        disabled={!aiAssistEnabled}
                        onChange={(e) =>
                          setAiPredictiveActions(e.target.checked)
                        }
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Predictive next-step actions
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Suggest the most likely things to do next on the
                          active document as one-click action chips.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiChatGhostText}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiChatGhostText(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Chat ghost-text completion
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Show inline gray completions as you type in the chat
                          box. Press{" "}
                          <kbd className="rounded bg-muted px-1">Tab</kbd> to
                          accept.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiPromptImprove}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiPromptImprove(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Improve my prompt
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Add a button to rewrite your chat prompt to be clearer
                          and more specific before sending.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiAutoTitles}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiAutoTitles(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          AI chat titles
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Name chat tabs automatically from the conversation
                          instead of a fixed heuristic.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiSummarize}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiSummarize(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          One-click summaries
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Summarize the selected text from the editor toolbar
                          and condense long assistant replies in chat.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiNaming}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiNaming(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          AI naming suggestions
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Propose names for new projects and tailored versions
                          from your description or target text.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiTemplateRecommend}
                        disabled={!aiAssistEnabled}
                        onChange={(e) =>
                          setAiTemplateRecommend(e.target.checked)
                        }
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          AI template recommendations
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Rank templates by what you describe you want to write
                          in the template gallery.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiProjectBlurb}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiProjectBlurb(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Project card summaries
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Show a one-line AI summary of each project on its card
                          in the home screen.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiCommentAssist}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiCommentAssist(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Review &amp; comment assist
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Draft replies to comments, address feedback, and
                          summarize what changed between versions.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiSemanticSearch}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiSemanticSearch(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Semantic search
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          When an exact match isn't found, use local embeddings
                          to surface related passages (e.g. PDF find). Needs an
                          embedding model such as{" "}
                          <code className="rounded bg-muted px-1">
                            nomic-embed-text
                          </code>
                          .
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiCommandAssist}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiCommandAssist(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Command &amp; skill assist
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Summarize undocumented slash commands and rank them by
                          what you type in the command picker.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiSnippetFill}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiSnippetFill(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Insert snippets with AI
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Fill a LaTeX snippet's placeholders from the
                          surrounding document instead of inserting a blank
                          skeleton.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 border-border/60 border-b p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiVisionCaption}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiVisionCaption(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Image captions (vision)
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Generate figure captions / alt-text from a captured
                          region using a local vision model (e.g.{" "}
                          <code className="rounded bg-muted px-1">
                            llava
                          </code>
                          ).
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-3 p-4 ${!aiAssistEnabled ? "pointer-events-none opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={aiCommandPalette}
                        disabled={!aiAssistEnabled}
                        onChange={(e) => setAiCommandPalette(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          AI command palette
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Press{" "}
                          <kbd className="rounded bg-muted px-1">Ctrl/Cmd+K</kbd>{" "}
                          to run actions by name or describe what you want in
                          plain language.
                        </p>
                      </div>
                    </label>
                  </SettingsPanel>
                ) : settingsDetailSection === "personalization" ? (
                  <SettingsPanel
                    title="Personalization"
                    icon={UserIcon}
                    contentClassName="p-0"
                  >
                    <PersonalizationSettings />
                  </SettingsPanel>
                ) : (
                  <SettingsPanel
                    title="Compilation"
                    icon={ZapIcon}
                    contentClassName="p-0"
                  >
                    <div className="flex flex-wrap items-end gap-4 border-border/60 border-b px-4 py-4">
                      <label className="flex flex-col gap-1">
                        <span className="text-muted-foreground text-xs">
                          Engine
                        </span>
                        <select
                          value={compilerBackend}
                          onChange={(e) =>
                            setCompilerBackend(
                              e.target.value as "tectonic" | "texlive",
                            )
                          }
                          className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <option value="tectonic">Tectonic</option>
                          <option value="texlive">TeXLive</option>
                        </select>
                      </label>
                      <p className="max-w-xs text-muted-foreground/70 text-xs">
                        Tectonic is bundled and works offline. TeXLive uses your
                        local installation (pdflatex / xelatex / lualatex).
                      </p>
                    </div>
                    <label className="flex cursor-pointer items-start gap-3 border-border/60 border-b p-4">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={autoCompile}
                        onChange={(e) => setAutoCompile(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Auto-compile on edit
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Automatically recompile the document a short moment
                          after you stop typing. When off, compile manually with
                          the toolbar button or{" "}
                          <kbd className="rounded bg-muted px-1">
                            Cmd/Ctrl+Enter
                          </kbd>
                          .
                        </p>
                      </div>
                    </label>
                    <label className="flex cursor-pointer items-start gap-3 p-4">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={pdfDarkMode}
                        onChange={(e) => setPdfDarkMode(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium text-sm">
                          Dark PDF preview
                        </div>
                        <p className="mt-0.5 text-muted-foreground text-xs">
                          Invert the rendered PDF for a dark-friendly page (dark
                          background, light ink). Affects the on-screen preview
                          only — the exported PDF is unchanged.
                        </p>
                      </div>
                    </label>
                  </SettingsPanel>
                )}
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-col gap-4 px-5 py-5">
              {visibleProjects.length === 0 ? (
                <div className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-border border-dashed bg-muted/10 px-6 text-center">
                  {normalizedSearch ? (
                    <>
                      <SearchIcon className="mb-4 size-10 text-muted-foreground/70" />
                      <h2 className="font-semibold text-lg">
                        No projects match “{searchQuery}”
                      </h2>
                      <div className="mt-5 flex flex-wrap justify-center gap-3">
                        <Button
                          variant="outline"
                          onClick={() => setSearchQuery("")}
                        >
                          <XIcon className="mr-2 size-4" />
                          Clear search
                        </Button>
                      </div>
                    </>
                  ) : activeSpace ? (
                    <>
                      <LayersIcon className="mb-4 size-10 text-muted-foreground/70" />
                      <h2 className="font-semibold text-lg">
                        No projects in {activeSpace.name}
                      </h2>
                      <p className="mt-1 max-w-sm text-muted-foreground text-sm">
                        Open a project, then use its actions menu (top-right of
                        the card) and choose “Move to space” to add it here — or
                        assign existing projects from All Projects.
                      </p>
                      <div className="mt-5 flex flex-wrap justify-center gap-3">
                        <Button
                          variant="outline"
                          onClick={() => setActiveSpace(null)}
                        >
                          <FolderOpenIcon className="mr-2 size-4" />
                          View All Projects
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <FileTextIcon className="mb-4 size-10 text-muted-foreground/70" />
                      <h2 className="font-semibold text-lg">No projects</h2>
                      <div className="mt-5 flex flex-wrap justify-center gap-3">
                        <Button onClick={() => setShowModeDialog(true)}>
                          <PlusIcon className="mr-2 size-4" />
                          New
                        </Button>
                        <Button onClick={handleOpenFolder} variant="outline">
                          <FolderOpenIcon className="mr-2 size-4" />
                          Import
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-6 gap-y-6">
                  {visibleProjects.map((project) => (
                    <ProjectPreviewCard
                      key={project.path}
                      project={project}
                      onOpen={() => handleOpenRecent(project.path)}
                      onRemove={() => setRemoveProjectTarget(project)}
                      spaces={spaces}
                      currentSpaceId={projectSpace[project.path] ?? null}
                      onAssign={(spaceId) =>
                        assignProject(project.path, spaceId)
                      }
                      onCreateSpace={openNewSpaceDialog}
                      onDragStateChange={setIsDraggingProject}
                      dateField={homepageDateField}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* New Project mode selection dialog */}
      <Dialog open={showModeDialog} onOpenChange={setShowModeDialog}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>How would you like to start?</DialogDescription>
          </DialogHeader>
          <NewProjectSpaceHint />
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => handleSelectMode("template")}
              className="group flex flex-1 flex-col items-center gap-3 rounded-lg border border-border/70 p-4 text-center transition-colors hover:border-border hover:bg-muted/50"
            >
              <div className="flex size-10 items-center justify-center rounded-md bg-muted/50 transition-colors group-hover:bg-muted">
                <SparklesIcon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <div>
                <div className="font-semibold text-sm">Guided Setup</div>
                <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                  Pick a template and let AI help you get started
                </p>
              </div>
              <span className="rounded-md bg-muted px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
                Recommended
              </span>
            </button>

            <button
              onClick={() => handleSelectMode("scratch")}
              className="group flex flex-1 flex-col items-center gap-3 rounded-lg border border-border/70 p-4 text-center transition-colors hover:border-border hover:bg-muted/50"
            >
              <div className="flex size-10 items-center justify-center rounded-md bg-muted/50 transition-colors group-hover:bg-muted">
                <FileTextIcon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <div>
                <div className="font-semibold text-sm">Blank Document</div>
                <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                  Start with an empty LaTeX file
                </p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create / edit space dialog */}
      <Dialog
        open={!!spaceDialog}
        onOpenChange={(open) => {
          if (!open) setSpaceDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {spaceDialog?.editingId ? "Edit space" : "New space"}
            </DialogTitle>
            <DialogDescription>
              {spaceDialog?.editingId
                ? "Customize this space's type, name, color, icon, and description."
                : "Group related projects and choose which workspace features they get."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!spaceDialog) return;
              const name = spaceDialog.name.trim();
              if (!name) return;
              if (spaceDialog.editingId) {
                updateSpace(spaceDialog.editingId, {
                  name,
                  kind: spaceDialog.kind,
                  color: spaceDialog.color,
                  icon: spaceDialog.icon,
                  description: spaceDialog.description,
                });
              } else {
                const created = createSpace(name, {
                  kind: spaceDialog.kind,
                  color: spaceDialog.color,
                  icon: spaceDialog.icon,
                  description: spaceDialog.description,
                });
                setActiveSection("projects");
                setActiveSpace(created.id);
              }
              setSpaceDialog(null);
            }}
            className="space-y-4"
          >
            {/* Name */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="space-name"
                  className="font-medium text-muted-foreground text-xs"
                >
                  Name
                </label>
                {canSuggestSpaceMeta && (
                  <button
                    type="button"
                    onClick={handleSuggestSpaceMeta}
                    disabled={spaceMetaPending}
                    title={`Suggest a name and description from the ${dialogAssignedProjectNames.length} project${
                      dialogAssignedProjectNames.length === 1 ? "" : "s"
                    } in this space`}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    {spaceMetaPending ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <WandSparklesIcon className="size-3" />
                    )}
                    Suggest with AI
                  </button>
                )}
              </div>
              <input
                id="space-name"
                autoFocus
                value={spaceDialog?.name ?? ""}
                onChange={(event) => {
                  setSpaceFieldTouched((prev) => ({ ...prev, name: true }));
                  setSpaceDialog((prev) =>
                    prev ? { ...prev, name: event.target.value } : prev,
                  );
                }}
                placeholder="e.g. PhD Papers, Job Applications"
                className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>

            {/* Space type */}
            <div className="space-y-1.5">
              <span className="font-medium text-muted-foreground text-xs">
                Type
              </span>
              <div className="grid grid-cols-2 gap-2">
                {SPACE_KIND_OPTIONS.map((option) => {
                  const selected = spaceDialog?.kind === option.kind;
                  return (
                    <button
                      key={option.kind}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setSpaceDialog((prev) =>
                          prev
                            ? {
                                ...prev,
                                kind: option.kind,
                                icon:
                                  prev.editingId || prev.icon
                                    ? prev.icon
                                    : option.defaultIcon,
                              }
                            : prev,
                        )
                      }
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "border-foreground/40 bg-muted"
                          : "border-border/60 hover:bg-muted/60",
                      )}
                    >
                      <div className="font-medium text-sm">{option.label}</div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                        {option.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Color */}
            <div className="space-y-1.5">
              <span className="font-medium text-muted-foreground text-xs">
                Color
              </span>
              <div className="flex flex-wrap gap-2">
                {SPACE_COLORS.map((color) => {
                  const selected = spaceDialog?.color === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use color ${color}`}
                      aria-pressed={selected}
                      onClick={() =>
                        setSpaceDialog((prev) =>
                          prev ? { ...prev, color } : prev,
                        )
                      }
                      style={{ backgroundColor: color }}
                      className={cn(
                        "size-6 rounded-full ring-offset-2 ring-offset-background transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "ring-2 ring-foreground",
                      )}
                    >
                      {selected && (
                        <CheckIcon className="mx-auto size-3.5 text-white drop-shadow" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Icon */}
            <div className="space-y-1.5">
              <span className="font-medium text-muted-foreground text-xs">
                Icon
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  aria-label="No icon"
                  aria-pressed={!spaceDialog?.icon}
                  title="No icon (colored dot)"
                  onClick={() =>
                    setSpaceDialog((prev) =>
                      prev ? { ...prev, icon: null } : prev,
                    )
                  }
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    !spaceDialog?.icon
                      ? "border-foreground/40 bg-muted"
                      : "border-border/60 hover:bg-muted/60",
                  )}
                >
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: spaceDialog?.color }}
                  />
                </button>
                {SPACE_ICONS.map(({ key, Icon }) => {
                  const selected = spaceDialog?.icon === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-label={`Use icon ${key}`}
                      aria-pressed={selected}
                      onClick={() =>
                        setSpaceDialog((prev) =>
                          prev ? { ...prev, icon: key } : prev,
                        )
                      }
                      className={cn(
                        "flex size-8 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "border-foreground/40 bg-muted"
                          : "border-border/60 hover:bg-muted/60",
                      )}
                    >
                      <Icon
                        className="size-4"
                        style={
                          selected ? { color: spaceDialog?.color } : undefined
                        }
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <label
                htmlFor="space-description"
                className="font-medium text-muted-foreground text-xs"
              >
                Description{" "}
                <span className="font-normal text-muted-foreground/60">
                  (optional)
                </span>
              </label>
              <textarea
                id="space-description"
                rows={2}
                value={spaceDialog?.description ?? ""}
                onChange={(event) => {
                  setSpaceFieldTouched((prev) => ({
                    ...prev,
                    description: true,
                  }));
                  setSpaceDialog((prev) =>
                    prev
                      ? { ...prev, description: event.target.value }
                      : prev,
                  );
                }}
                placeholder="What is this space for?"
                className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>

            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSpaceDialog(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!spaceDialog?.name.trim()}>
                {spaceDialog?.editingId ? "Save" : "Create space"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete space confirmation */}
      <Dialog
        open={!!deleteSpaceTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteSpaceTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete space?</DialogTitle>
            <DialogDescription>
              {deleteSpaceTarget && (
                <>
                  This deletes the space{" "}
                  <span className="font-medium text-foreground">
                    {deleteSpaceTarget.name}
                  </span>
                  {(() => {
                    const n = spaceCounts.get(deleteSpaceTarget.id) ?? 0;
                    return n > 0
                      ? ` and unassigns its ${n} project${n === 1 ? "" : "s"}`
                      : "";
                  })()}. Your projects and files are not deleted.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteSpaceTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleteSpaceTarget) return;
                deleteSpace(deleteSpaceTarget.id);
                setDeleteSpaceTarget(null);
              }}
            >
              Delete space
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!removeProjectTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveProjectTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Project</DialogTitle>
            <DialogDescription>
              Remove "{removeProjectTarget?.name ?? "this project"}" from All
              Projects? The project files will stay on disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveProjectTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!removeProjectTarget) return;
                removeRecentProject(removeProjectTarget.path);
                assignProject(removeProjectTarget.path, null);
                setRemoveProjectTarget(null);
              }}
              disabled={!removeProjectTarget}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(isDragging || isImporting) && (
        <div className="pointer-events-none fixed inset-0 z-[9000] flex items-center justify-center bg-background/80 p-8 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-primary/60 border-dashed bg-card px-12 py-10 text-center shadow-lg">
            {isImporting ? (
              <Loader2Icon className="size-8 animate-spin text-primary" />
            ) : (
              <FileArchiveIcon className="size-8 text-primary" />
            )}
            <div>
              <p className="font-semibold text-base">
                {isImporting ? "Importing project…" : "Drop to import"}
              </p>
              <p className="mt-1 text-muted-foreground text-sm">
                {isImporting
                  ? "Extracting your LaTeX archive"
                  : "Release a .zip archive, LaTeX files, or a project folder"}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Environment Status (shown when Claude is ready) ───

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

function projectPreviewCacheKey(project: RecentProject) {
  return `${project.path}:${project.lastOpened}`;
}

function enqueueProjectPreviewCompile<T>(task: () => Promise<T>): Promise<T> {
  const run = projectPreviewCompileQueue.then(task, task);
  projectPreviewCompileQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function firstExistingProjectFile(
  projectPath: string,
  candidates: string[][],
): Promise<{ absolutePath: string; relativePath: string } | null> {
  for (const segments of candidates) {
    const absolutePath = await join(projectPath, ...segments);
    if (await exists(absolutePath)) {
      return {
        absolutePath,
        relativePath: segments.join("/"),
      };
    }
  }
  return null;
}

async function firstExistingPath(
  projectPath: string,
  candidates: string[][],
): Promise<string | null> {
  return (
    (await firstExistingProjectFile(projectPath, candidates))?.absolutePath ??
    null
  );
}

/**
 * Find the project's main LaTeX source for previewing. Prefers the conventional
 * root-level names, but falls back to scanning the tree so imported projects
 * whose entry file is named differently (e.g. `paper.tex`, `src/thesis.tex`)
 * still get a compiled/source preview instead of "No preview". Among scanned
 * candidates, prefers the shallowest file that declares `\documentclass` (the
 * compile root).
 */
async function findMainTexFile(
  projectPath: string,
): Promise<{ absolutePath: string; relativePath: string } | null> {
  const named = await firstExistingProjectFile(projectPath, [
    ["main.tex"],
    ["document.tex"],
  ]);
  if (named) return named;

  let texFiles: { absolutePath: string; relativePath: string }[];
  try {
    const scan = await scanProjectFolder(projectPath);
    texFiles = scan.files
      .filter((f) => f.type === "tex")
      .sort(
        (a, b) =>
          a.relativePath.split("/").length - b.relativePath.split("/").length ||
          a.relativePath.localeCompare(b.relativePath),
      )
      .map((f) => ({
        absolutePath: f.absolutePath,
        relativePath: f.relativePath,
      }));
  } catch {
    return null;
  }
  if (texFiles.length === 0) return null;

  for (const file of texFiles) {
    try {
      if (/\\documentclass/.test(await readTextFile(file.absolutePath))) {
        return file;
      }
    } catch {
      // Unreadable — skip and keep looking.
    }
  }
  // No \documentclass anywhere — best-guess with the shallowest .tex.
  return texFiles[0];
}

async function renderPdfThumbnailFromBytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const client = getMupdfClient();
  let docId: number | null = null;

  try {
    docId = await client.openDocument(buffer);
    const pngBuffer = await client.renderThumbnail(docId, 0, 420);
    const blob = new Blob([new Uint8Array(pngBuffer)], { type: "image/png" });
    return URL.createObjectURL(blob);
  } finally {
    if (docId !== null) {
      await client.closeDocument(docId).catch(() => {});
    }
  }
}

async function renderPdfThumbnail(pdfPath: string): Promise<string> {
  return renderPdfThumbnailFromBytes(await readFile(pdfPath));
}

function texPreviewLines(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12)
    .map((line) => (line.length > 70 ? `${line.slice(0, 67)}...` : line));
}

function statDateToMs(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

async function getProjectCreatedAt(
  projectPath: string,
): Promise<number | null> {
  try {
    const info = (await stat(projectPath)) as {
      birthtime?: unknown;
      ctime?: unknown;
      mtime?: unknown;
    };
    return (
      statDateToMs(info.birthtime) ??
      statDateToMs(info.ctime) ??
      statDateToMs(info.mtime)
    );
  } catch {
    return null;
  }
}

async function statMtimeMs(path: string): Promise<number | null> {
  try {
    const info = (await stat(path)) as { mtime?: unknown };
    return statDateToMs(info.mtime);
  } catch {
    return null;
  }
}

/**
 * When the project was last edited. The folder's mtime only changes when entries
 * are added/removed (not on content edits), so we also fold in the main .tex
 * file's mtime — the best available signal that the document itself changed —
 * and take the most recent of the two.
 */
async function getProjectModifiedAt(
  projectPath: string,
  mainTexPath: string | null,
): Promise<number | null> {
  const [dirMtime, texMtime] = await Promise.all([
    statMtimeMs(projectPath),
    mainTexPath ? statMtimeMs(mainTexPath) : Promise.resolve(null),
  ]);
  if (dirMtime === null) return texMtime;
  if (texMtime === null) return dirMtime;
  return Math.max(dirMtime, texMtime);
}

function formatProjectDate(value: number | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

async function loadProjectPreview(
  project: RecentProject,
): Promise<ProjectPreviewData> {
  const cacheKey = projectPreviewCacheKey(project);
  const cached = projectPreviewCache.get(cacheKey);
  if (cached) return cached;

  const pending = projectPreviewRequests.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    const createdAt = await getProjectCreatedAt(project.path);
    const texFile = await findMainTexFile(project.path);
    const modifiedAt = await getProjectModifiedAt(
      project.path,
      texFile?.absolutePath ?? null,
    );

    const pdfCandidates: string[][] = [
      [".prism", "build", "main.pdf"],
      [".prism", "build", "document.pdf"],
      ["main.pdf"],
      ["document.pdf"],
    ];
    // Also look for a PDF that matches the discovered main .tex (same basename),
    // both in the build dir and next to the source — covers non-standard names.
    if (texFile) {
      const base = texFile.relativePath.replace(/\.tex$/i, "");
      const baseName = base.split("/").pop() ?? base;
      pdfCandidates.push(
        [".prism", "build", `${baseName}.pdf`],
        `${base}.pdf`.split("/"),
        [`${baseName}.pdf`],
      );
    }
    const pdfPath = await firstExistingPath(project.path, pdfCandidates);

    if (pdfPath) {
      const data: ProjectPreviewData = {
        kind: "pdf",
        url: await renderPdfThumbnail(pdfPath),
        createdAt,
        modifiedAt,
      };
      projectPreviewCache.set(cacheKey, data);
      return data;
    }

    if (texFile) {
      try {
        const useTexlive =
          useSettingsStore.getState().compilerBackend === "texlive";
        const pdfBytes = await enqueueProjectPreviewCompile(() =>
          compileLatex(project.path, texFile.relativePath, useTexlive),
        );
        const data: ProjectPreviewData = {
          kind: "pdf",
          url: await renderPdfThumbnailFromBytes(pdfBytes),
          createdAt,
          modifiedAt,
        };
        projectPreviewCache.set(cacheKey, data);
        return data;
      } catch (err) {
        console.warn("Failed to compile project preview:", {
          path: project.path,
          target: texFile.relativePath,
          error: err,
        });
      }

      const fileName = texFile.absolutePath.split(/[\\/]/).pop() ?? "main.tex";
      const data: ProjectPreviewData = {
        kind: "tex",
        fileName,
        lines: texPreviewLines(await readTextFile(texFile.absolutePath)),
        createdAt,
        modifiedAt,
      };
      projectPreviewCache.set(cacheKey, data);
      return data;
    }

    const data: ProjectPreviewData = { kind: "empty", createdAt, modifiedAt };
    projectPreviewCache.set(cacheKey, data);
    return data;
  })();

  projectPreviewRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    projectPreviewRequests.delete(cacheKey);
  }
}

/**
 * Lazily produce a one-line AI summary of a project's main .tex, reusing the
 * same main-file discovery the preview uses. Cached per project path so each
 * project is summarized at most once per session, deduped while in flight, and
 * concurrency-limited so hovering across cards can't flood the local model.
 * Resolves to "" on any failure (caller renders nothing) — never throws.
 */
async function loadProjectBlurb(project: RecentProject): Promise<string> {
  const key = project.path;
  const cached = projectBlurbCache.get(key);
  if (cached !== undefined) return cached;

  const pending = projectBlurbRequests.get(key);
  if (pending) return pending;

  const promise = (async () => {
    await acquireBlurbSlot();
    try {
      const texFile = await findMainTexFile(project.path);
      if (!texFile) return "";
      const content = await readTextFile(texFile.absolutePath);
      const blurb = (await summarizeSection(content)).trim();
      projectBlurbCache.set(key, blurb);
      return blurb;
    } catch (err) {
      console.warn("Failed to summarize project:", { path: project.path, err });
      // Cache the empty result so we don't retry a failing project all session.
      projectBlurbCache.set(key, "");
      return "";
    } finally {
      releaseBlurbSlot();
    }
  })();

  projectBlurbRequests.set(key, promise);
  try {
    return await promise;
  } finally {
    projectBlurbRequests.delete(key);
  }
}

function ProjectPreviewCard({
  project,
  onOpen,
  onRemove,
  spaces,
  currentSpaceId,
  onAssign,
  onCreateSpace,
  onDragStateChange,
  dateField,
}: {
  project: RecentProject;
  onOpen: () => void;
  onRemove: () => void;
  spaces: Space[];
  currentSpaceId: string | null;
  onAssign: (spaceId: string | null) => void;
  onCreateSpace: () => void;
  /** Notify the picker so sidebar spaces can light up as drop targets. */
  onDragStateChange: (dragging: boolean) => void;
  /** Which timestamp to show under the card (created vs. last edited). */
  dateField: HomepageDateField;
}) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ProjectPreviewState>(() => {
    const cached = projectPreviewCache.get(projectPreviewCacheKey(project));
    return cached ? { status: "ready", data: cached } : { status: "loading" };
  });

  // ─── AI one-line summary blurb (gated by aiProjectBlurb) ───
  const aiProjectBlurb = useSettingsStore((s) => s.aiProjectBlurb);
  const [blurb, setBlurb] = useState<string>(
    () => projectBlurbCache.get(project.path) ?? "",
  );
  const [blurbLoading, setBlurbLoading] = useState(false);
  // Fire the (cancellation-safe) summary at most once per card. We throttle by
  // only kicking off on hover/focus rather than for every card on mount, so we
  // never spin up dozens of concurrent local-model calls at once.
  const blurbStartedRef = useRef(false);

  const startBlurb = useCallback(() => {
    if (blurbStartedRef.current) return;
    if (!aiProjectBlurb || !canUseAiAssist()) return;
    const cached = projectBlurbCache.get(project.path);
    if (cached !== undefined) {
      blurbStartedRef.current = true;
      setBlurb(cached);
      return;
    }
    blurbStartedRef.current = true;
    setBlurbLoading(true);
    loadProjectBlurb(project)
      .then((text) => setBlurb(text))
      .catch(() => {
        // loadProjectBlurb never throws, but stay defensive: degrade silently.
      })
      .finally(() => setBlurbLoading(false));
  }, [aiProjectBlurb, project]);
  const dateValue =
    preview.status === "ready"
      ? dateField === "modified"
        ? preview.data.modifiedAt
        : preview.data.createdAt
      : null;
  const dateLabel = formatProjectDate(dateValue);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = projectPreviewCacheKey(project);
    const cached = projectPreviewCache.get(cacheKey);
    if (cached) {
      setPreview({ status: "ready", data: cached });
      return;
    }

    setPreview({ status: "loading" });
    loadProjectPreview(project)
      .then((data) => {
        if (!cancelled) setPreview({ status: "ready", data });
      })
      .catch((err) => {
        console.warn("Failed to load project preview:", {
          path: project.path,
          error: err,
        });
        if (!cancelled) setPreview({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [project]);

  // When this card is reused for a different project (list reorder/filter),
  // reset the blurb to the new project's cached value (or empty) and allow a
  // fresh hover-triggered summary.
  useEffect(() => {
    blurbStartedRef.current = false;
    setBlurbLoading(false);
    setBlurb(projectBlurbCache.get(project.path) ?? "");
  }, [project.path]);

  return (
    <div
      className={cn("group min-w-0", dragging && "opacity-50")}
      onMouseEnter={startBlurb}
      onFocus={startBlurb}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(PROJECT_DND_MIME, project.path);
        event.dataTransfer.effectAllowed = "move";
        setDragging(true);
        onDragStateChange(true);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragStateChange(false);
      }}
    >
      <div className="relative">
        <button
          className="relative aspect-[3/4] w-full cursor-grab overflow-hidden rounded-lg border border-border/70 bg-background text-left outline-none transition-all duration-200 hover:border-foreground/20 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:cursor-grabbing"
          onClick={onOpen}
          tabIndex={-1}
          aria-hidden
        >
          <ProjectPreviewSurface preview={preview} projectName={project.name} />
        </button>
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 border border-border/60 bg-background/90 text-foreground shadow-sm backdrop-blur-sm hover:bg-background"
                aria-label={`Move ${project.name} to a space`}
              >
                <MoreVerticalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="flex items-center gap-2">
                <LayersIcon className="size-3.5" />
                Move to space
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onAssign(null)}>
                <span className="flex-1">No space</span>
                {currentSpaceId === null && <CheckIcon className="size-3.5" />}
              </DropdownMenuItem>
              {spaces.map((space) => (
                <DropdownMenuItem
                  key={space.id}
                  onClick={() => onAssign(space.id)}
                >
                  <SpaceGlyph space={space} />
                  <span className="flex-1 truncate">{space.name}</span>
                  {currentSpaceId === space.id && (
                    <CheckIcon className="size-3.5" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onCreateSpace}>
                <PlusIcon className="size-3.5" />
                <span className="flex-1">New space…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 border border-border/60 bg-background/90 text-foreground shadow-sm backdrop-blur-sm hover:bg-background hover:text-destructive"
            onClick={onRemove}
            aria-label={`Remove ${project.name}`}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <button
        className="mt-2 block w-full truncate rounded-sm text-left font-medium text-sm leading-tight outline-none hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        aria-label={`Open ${project.name}`}
      >
        {project.name}
      </button>
      {aiProjectBlurb && (blurbLoading || blurb) && (
        <div className="mt-1 flex items-start gap-1 text-left text-muted-foreground text-xs leading-snug">
          {blurbLoading ? (
            <Loader2Icon className="mt-px size-3 shrink-0 animate-spin" />
          ) : (
            <SparklesIcon className="mt-px size-3 shrink-0 text-primary/70" />
          )}
          <span className="line-clamp-2">
            {blurbLoading ? "Summarizing…" : blurb}
          </span>
        </div>
      )}
      <div className="mt-1 h-4 truncate text-left text-muted-foreground text-xs">
        {dateLabel &&
          `${dateField === "modified" ? "Edited" : "Created"} ${dateLabel}`}
      </div>
    </div>
  );
}

function ProjectPreviewSurface({
  preview,
  projectName,
}: {
  preview: ProjectPreviewState;
  projectName: string;
}) {
  if (preview.status === "loading") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/10">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (preview.status === "ready" && preview.data.kind === "pdf") {
    return (
      <img
        src={preview.data.url}
        alt={`${projectName} preview`}
        className="h-full w-full bg-white object-cover object-top"
      />
    );
  }

  if (preview.status === "ready" && preview.data.kind === "tex") {
    return (
      <div className="h-full w-full overflow-hidden bg-background">
        <div className="flex h-7 items-center border-border/60 border-b px-2">
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {preview.data.fileName}
          </span>
        </div>
        <div className="space-y-1 px-2 py-2 font-mono text-[10px] text-muted-foreground">
          {preview.data.lines.map((line, index) => (
            <div key={`${index}-${line}`} className="truncate">
              {line}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-muted/10 text-muted-foreground">
      <FileTextIcon className="mb-2 size-5" />
      <span className="text-xs">No preview</span>
    </div>
  );
}

function SpaceNavButton({
  space,
  active,
  count,
  onSelect,
  onEdit,
  onDelete,
  droppable,
  onDropProject,
}: {
  space: Space;
  active: boolean;
  count: number;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** True while a project drag is in progress, so this space can light up. */
  droppable: boolean;
  /** Dropping a project card here reassigns it to this space (path => …). */
  onDropProject: (path: string) => void;
}) {
  const [isOver, setIsOver] = useState(false);
  return (
    <div
      onDragOver={(event) => {
        if (!isProjectDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(event) => {
        if (!isProjectDrag(event)) return;
        event.preventDefault();
        setIsOver(false);
        onDropProject(event.dataTransfer.getData(PROJECT_DND_MIME));
      }}
      className={cn(
        "group/space flex items-center rounded-lg transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        droppable && "ring-1 ring-border ring-inset",
        isOver && "bg-primary/10 text-foreground ring-2 ring-primary",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left font-medium text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        title={space.description?.trim() || space.name}
      >
        <SpaceGlyph space={space} />
        <span className="truncate">{space.name}</span>
        {inferSpaceKind(space) !== "general" && (
          <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] text-muted-foreground uppercase tracking-wide">
            {spaceKindLabel(inferSpaceKind(space)).split(" / ")[0]}
          </span>
        )}
        {count > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
            {count}
          </span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/space:opacity-100"
            aria-label={`${space.name} options`}
          >
            <MoreVerticalIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={onEdit}>
            <PencilIcon className="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2Icon className="size-3.5" />
            Delete space
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ProjectNavButton({
  active,
  collapsed,
  icon: Icon,
  onClick,
  children,
  droppable = false,
  onDropProject,
}: {
  active: boolean;
  collapsed: boolean;
  icon: LucideIcon;
  onClick: () => void;
  children: ReactNode;
  /** True while a project drag is in progress, so this target can light up. */
  droppable?: boolean;
  /** When set, dropping a project card here reassigns it (path => …). */
  onDropProject?: (path: string) => void;
}) {
  const [isOver, setIsOver] = useState(false);
  const canDrop = !!onDropProject;
  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={
        canDrop
          ? (event) => {
              if (!isProjectDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (!isOver) setIsOver(true);
            }
          : undefined
      }
      onDragLeave={canDrop ? () => setIsOver(false) : undefined}
      onDrop={
        canDrop
          ? (event) => {
              if (!isProjectDrag(event)) return;
              event.preventDefault();
              setIsOver(false);
              onDropProject?.(event.dataTransfer.getData(PROJECT_DND_MIME));
            }
          : undefined
      }
      className={cn(
        "flex items-center rounded-lg font-medium text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        collapsed
          ? "size-8 justify-center"
          : "h-10 w-full justify-start gap-3 px-3 text-left",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        droppable && "ring-1 ring-border ring-inset",
        isOver && "bg-primary/10 text-foreground ring-2 ring-primary",
      )}
      title={typeof children === "string" ? children : undefined}
    >
      <Icon className="size-3.5 shrink-0" />
      {!collapsed && <span className="truncate">{children}</span>}
    </button>
  );
}

function SettingsDetailButton({
  active,
  icon: Icon,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          active
            ? "border-border/70 bg-background/70"
            : "border-border/60 bg-muted/20",
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{label}</div>
        <div className="truncate text-muted-foreground text-xs">{meta}</div>
      </div>
    </button>
  );
}

function SettingsPanel({
  title,
  icon: Icon,
  contentClassName,
  children,
}: {
  title: string;
  icon: LucideIcon;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-muted/10">
      <div className="flex items-center gap-3 border-border/60 border-b px-5 py-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-sm">{title}</h2>
        </div>
      </div>
      <div className={cn("p-4", contentClassName)}>{children}</div>
    </section>
  );
}

function EnvironmentStatus({ appVersion }: { appVersion: string }) {
  const uvStatus = useUvSetupStore((s) => s.status);
  const uvVersion = useUvSetupStore((s) => s.version);
  const uvInstalling = useUvSetupStore((s) => s.isInstalling);
  const checkUv = useUvSetupStore((s) => s.checkStatus);
  const installUv = useUvSetupStore((s) => s.install);
  const _finishUvInstall = useUvSetupStore((s) => s._finishInstall);

  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [skillsInstalling, _setSkillsInstalling] = useState(false);
  const [showSkillsOnboarding, setShowSkillsOnboarding] = useState(false);

  const checkSkills = useCallback(async () => {
    try {
      const gs = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      setSkillsStatus(gs);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    checkUv();
    checkSkills();
  }, [checkUv, checkSkills]);

  // Listen for uv install completion
  useEffect(() => {
    const unlisten = listen<boolean>("uv-install-complete", (event) => {
      _finishUvInstall(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [_finishUvInstall]);

  // Lazy load skills onboarding
  const [OnboardingComponent, setOnboardingComponent] = useState<ComponentType<{
    onClose: () => void;
  }> | null>(null);

  useEffect(() => {
    if (showSkillsOnboarding && !OnboardingComponent) {
      import(
        "@/components/scientific-skills/scientific-skills-onboarding"
      ).then((mod) =>
        setOnboardingComponent(() => mod.ScientificSkillsOnboarding),
      );
    }
  }, [showSkillsOnboarding, OnboardingComponent]);

  return (
    <>
      <div className="divide-y divide-border/60">
        {/* Python (uv) */}
        <StatusRow
          ok={uvStatus === "ready"}
          label="Python (uv)"
          detail={
            uvInstalling
              ? "Installing..."
              : uvStatus === "ready"
                ? (uvVersion ?? "Installed")
                : uvStatus === "checking"
                  ? "Checking..."
                  : "Not installed"
          }
          action={
            uvStatus === "not-installed" && !uvInstalling
              ? { label: "Install", onClick: installUv }
              : uvInstalling
                ? { label: "Installing...", loading: true }
                : undefined
          }
        />

        {/* Scientific Skills */}
        <StatusRow
          ok={!!skillsStatus?.installed}
          label="Scientific Skills"
          detail={
            skillsInstalling
              ? "Installing..."
              : skillsStatus?.installed
                ? `${skillsStatus.skill_count} skills`
                : "Not installed"
          }
          action={
            skillsInstalling
              ? { label: "Installing...", loading: true }
              : {
                  label: skillsStatus?.installed ? "Manage" : "Install",
                  onClick: () => setShowSkillsOnboarding(true),
                  icon: skillsStatus?.installed ? "settings" : "download",
                }
          }
        />

        <StatusRow
          ok={true}
          label="DevPrism"
          detail={appVersion ? `v${appVersion}` : "Checking..."}
        />
      </div>

      {showSkillsOnboarding && OnboardingComponent && (
        <OnboardingComponent
          onClose={() => {
            setShowSkillsOnboarding(false);
            checkSkills();
          }}
        />
      )}
    </>
  );
}

function StatusRow({
  ok,
  label,
  detail,
  action,
}: {
  ok: boolean;
  label: string;
  detail: string;
  action?: {
    label: string;
    onClick?: () => void;
    loading?: boolean;
    icon?: "download" | "key" | "settings";
  };
}) {
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-3 px-4 py-3">
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          ok
            ? "border-green-500/20 bg-green-500/10 text-green-600"
            : "border-border/70 bg-muted/30 text-muted-foreground",
        )}
      >
        {ok ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span
          className={cn(
            "w-32 shrink-0 truncate font-medium text-sm",
            ok ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {detail}
        </span>
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 rounded-md px-2.5 text-xs"
          onClick={action.onClick}
          disabled={action.loading}
        >
          {action.loading ? (
            <Loader2Icon className="mr-1 size-3 animate-spin" />
          ) : action.icon === "key" ? (
            <KeyRoundIcon className="mr-1 size-3" />
          ) : action.icon === "settings" ? (
            <SettingsIcon className="mr-1 size-3" />
          ) : (
            <DownloadIcon className="mr-1 size-3" />
          )}
          {action.label}
        </Button>
      )}
    </div>
  );
}
