import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  FileTextIcon,
  FolderIcon,
  HomeIcon,
  FolderPlusIcon,
  ImageIcon,
  PlusIcon,
  Trash2Icon,
  PencilIcon,
  UploadIcon,
  RefreshCwIcon,
  ListIcon,
  BookOpenIcon,
  HashIcon,
  GithubIcon,
  SettingsIcon,
  PanelLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronsDownUpIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  AppWindowIcon,
  FlaskConicalIcon,
  TerminalIcon,
  MessageSquareIcon,
  SearchIcon,
  XIcon,
  PinIcon,
  PinOffIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  LocateFixedIcon,
  PaletteIcon,
  CheckIcon,
  BanIcon,
  FilesIcon,
  type LucideIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { useVariantsStore } from "@/stores/variants-store";
import { useSpacesStore } from "@/stores/spaces-store";
import { useHistoryStore } from "@/stores/history-store";
import {
  useFileMarksStore,
  projectMarks,
  FILE_COLORS,
  FILE_COLOR_HEX,
  FILE_COLOR_LABEL,
  type FileColor,
  type FileMark,
} from "@/stores/file-marks-store";
import { cn } from "@/lib/utils";
import { ZoteroPanel, ZoteroHeader } from "@/components/workspace/zotero-panel";
import {
  BibliographyPanel,
  BibliographyHeader,
} from "@/components/workspace/bibliography-panel";
import { SpaceFeaturesBar } from "@/components/workspace/space-features-bar";
import {
  CommentsPanel,
  CommentsHeader,
} from "@/components/workspace/comments-panel";
import { useCommentsStore } from "@/stores/comments-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readTexFileContent } from "@/lib/tauri/fs";
import { toast } from "sonner";
import {
  SparklesIcon,
  DownloadIcon,
  Loader2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { UvSetupDialog } from "@/components/uv-setup";
import { triggerForwardSync } from "@/lib/forward-sync";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("sidebar");
const FILES_AUTO_REFRESH_INTERVAL_MS = 12_000;
const FILES_REFRESH_MIN_SPIN_MS = 400;

// ─── Sidebar sections (one visible at a time, picked from the tab rail) ───

type SidebarSection =
  | "files"
  | "outline"
  | "bibliography"
  | "zotero"
  | "comments"
  | "environment";

const SIDEBAR_SECTIONS: {
  id: SidebarSection;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "files", label: "Files", icon: FolderIcon },
  { id: "outline", label: "Outline", icon: ListIcon },
  { id: "bibliography", label: "BibTeX", icon: BookOpenIcon },
  { id: "zotero", label: "Zotero", icon: FileTextIcon },
  { id: "comments", label: "Comments", icon: MessageSquareIcon },
  { id: "environment", label: "Environment", icon: AppWindowIcon },
];

const SIDEBAR_SECTION_STORAGE_KEY = "devprism.sidebarSection";

function readStoredSidebarSection(): SidebarSection {
  try {
    const saved = localStorage.getItem(SIDEBAR_SECTION_STORAGE_KEY);
    if (SIDEBAR_SECTIONS.some((s) => s.id === saved)) {
      return saved as SidebarSection;
    }
  } catch {
    // localStorage unavailable — fall back to default
  }
  return "files";
}

// ─── Table of Contents ───

interface TocItem {
  level: number;
  title: string;
  line: number;
}

function parseTableOfContents(content: string): TocItem[] {
  const lines = content.split("\n");
  const toc: TocItem[] = [];
  const sectionRegex =
    /\\(section|subsection|subsubsection|chapter|part)\*?\s*\{([^}]*)\}/;
  const levelMap: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };
  lines.forEach((line, index) => {
    const match = line.match(sectionRegex);
    if (match) {
      const [, type, title] = match;
      toc.push({
        level: levelMap[type] ?? 2,
        title: title.trim(),
        line: index + 1,
      });
    }
  });
  return toc;
}

// ─── File Tree Builder ───

interface TreeNode {
  name: string;
  relativePath: string;
  // "other" is a synthetic, non-draggable group that collects the non-.tex
  // files of a folder so the editable .tex sources stay uncluttered.
  type: "folder" | "file" | "other";
  file?: ProjectFile;
  children: TreeNode[];
}

// Synthetic relativePath for a folder's "Other Files" group. The NUL prefix
// can't occur in a real path, so it never collides with a file or folder.
// Built via fromCharCode so no literal NUL byte lands in the source file.
const OTHER_GROUP_PREFIX = `${String.fromCharCode(0)}other:`;
function otherGroupKey(parentPath: string) {
  return `${OTHER_GROUP_PREFIX}${parentPath}`;
}

/** Collapse-tracking key for an "Other Files" group (groups default to open). */
function otherCollapseKey(otherKey: string) {
  return `collapsed:${otherKey}`;
}

function isTexFileName(name: string) {
  return name.toLowerCase().endsWith(".tex");
}

/** Total number of files nested under a folder node (recurses subfolders and
 * the synthetic "Other Files" group). Used to label collapsed folders. */
function countFileDescendants(node: TreeNode): number {
  let total = 0;
  for (const child of node.children) {
    if (child.type === "file") total += 1;
    else total += countFileDescendants(child);
  }
  return total;
}

type FileTreeItemType = "file" | "folder";

interface FileTreeSelectionItem {
  type: FileTreeItemType;
  path: string;
}

function fileTreeSelectionKey(item: FileTreeSelectionItem) {
  return `${item.type}:${item.path}`;
}

function fileTreeSelectionItemFromKey(
  key: string,
): FileTreeSelectionItem | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;

  const type = key.slice(0, separator);
  const path = key.slice(separator + 1);
  if ((type !== "file" && type !== "folder") || !path) return null;

  return { type, path };
}

function isInsideFolder(path: string, folderPath: string) {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function parentFolderOfPath(path: string): string | undefined {
  return path.includes("/")
    ? path.substring(0, path.lastIndexOf("/"))
    : undefined;
}

function normalizeSelectionItems(items: FileTreeSelectionItem[]) {
  const folders = items
    .filter((item) => item.type === "folder")
    .sort((a, b) => a.path.length - b.path.length)
    .filter(
      (item, index, all) =>
        !all
          .slice(0, index)
          .some((folder) => isInsideFolder(item.path, folder.path)),
    );

  const files = items.filter(
    (item) =>
      item.type === "file" &&
      !folders.some((folder) => isInsideFolder(item.path, folder.path)),
  );

  return { files, folders };
}

function buildFileTree(
  files: ProjectFile[],
  folders: string[],
  pinnedPaths: Set<string>,
  pinOrders: Map<string, number>,
): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  function getOrCreateFolder(path: string): TreeNode[] {
    if (!path) return root;
    if (folderMap.has(path)) return folderMap.get(path)!.children;

    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(parentPath);

    const folder: TreeNode = {
      name,
      relativePath: path,
      type: "folder",
      children: [],
    };
    folderMap.set(path, folder);
    parentChildren.push(folder);
    return folder.children;
  }

  // Ensure all known folders exist as nodes (including empty ones)
  for (const folderPath of folders) {
    getOrCreateFolder(folderPath);
  }

  for (const file of files) {
    const parts = file.relativePath.split("/");
    const fileName = parts[parts.length - 1];
    const folderPath = parts.slice(0, -1).join("/");
    const parentChildren = getOrCreateFolder(folderPath);

    parentChildren.push({
      name: fileName,
      relativePath: file.relativePath,
      type: "file",
      file,
      children: [],
    });
  }

  // Sort: folders first, then pinned files (by manual pin order), then alphabetical
  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      if (a.type === "file") {
        const aPinned = pinnedPaths.has(a.relativePath);
        const bPinned = pinnedPaths.has(b.relativePath);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        if (aPinned && bPinned) {
          const aOrder = pinOrders.get(a.relativePath) ?? 0;
          const bOrder = pinOrders.get(b.relativePath) ?? 0;
          if (aOrder !== bOrder) return aOrder - bOrder;
        }
      }
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.type === "folder") sortNodes(node.children);
    }
  }
  sortNodes(root);

  // Collapse each folder's non-.tex files into a synthetic "Other Files" group
  // at the bottom of that folder. Order within a folder becomes: subfolders,
  // then .tex files, then the Other Files group. Operates on already-sorted
  // nodes so the relative order inside each bucket is preserved.
  function groupOtherFiles(nodes: TreeNode[], parentPath: string): TreeNode[] {
    const folders = nodes.filter((n) => n.type === "folder");
    for (const folder of folders) {
      folder.children = groupOtherFiles(folder.children, folder.relativePath);
    }
    const texFiles = nodes.filter(
      (n) => n.type === "file" && isTexFileName(n.name),
    );
    const otherFiles = nodes.filter(
      (n) => n.type === "file" && !isTexFileName(n.name),
    );

    const grouped: TreeNode[] = [...folders, ...texFiles];
    if (otherFiles.length > 0) {
      grouped.push({
        name: "Other Files",
        relativePath: otherGroupKey(parentPath),
        type: "other",
        children: otherFiles,
      });
    }
    return grouped;
  }

  return groupOtherFiles(root, "");
}

// ─── File Icon ───

function getFileIcon(file: ProjectFile) {
  if (file.type === "image") return <ImageIcon className="size-4 shrink-0" />;
  if (file.type === "pdf")
    return <FileSpreadsheetIcon className="size-4 shrink-0" />;
  if (file.type === "style")
    return <FileCodeIcon className="size-4 shrink-0" />;
  if (file.type === "other") return <FileIcon className="size-4 shrink-0" />;
  return <FileTextIcon className="size-4 shrink-0" />;
}

// ─── App Version (resolved once from Tauri) ───

let _appVersion = "";
getVersion().then((v) => {
  _appVersion = v;
});
function useAppVersion() {
  const [version, setVersion] = useState(_appVersion);
  useEffect(() => {
    if (!version) getVersion().then(setVersion);
  }, [version]);
  return version || "…";
}

// ─── Sidebar ───

function LayoutPaneSwitcher({
  controls,
  collapsed = false,
  onQuickToggleSidebar,
  side = "bottom",
  align = "end",
  buttonClassName,
}: {
  controls?: LayoutControls;
  collapsed?: boolean;
  onQuickToggleSidebar?: () => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  buttonClassName?: string;
}) {
  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "transition-transform duration-300 ease-in-out hover:scale-105",
        buttonClassName,
      )}
      onClick={onQuickToggleSidebar}
      title="Layout"
      aria-label="Layout"
    >
      <PanelLeftIcon
        className={cn(
          "size-3.5 transition-transform duration-300 ease-in-out",
          collapsed && "rotate-180",
        )}
      />
    </Button>
  );

  if (!controls) return trigger;

  return (
    <HoverCard openDelay={80} closeDelay={140}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={align}
        sideOffset={8}
        className="w-44 rounded-2xl border-border/70 bg-popover/95 p-1.5 shadow-2xl backdrop-blur"
      >
        <div className="space-y-1">
          <LayoutToggleRow
            icon={FileCodeIcon}
            label="Code"
            checked={controls.codeVisible}
            onCheckedChange={controls.setCodeVisible}
          />
          <LayoutToggleRow
            icon={FileTextIcon}
            label="PDF"
            checked={controls.pdfVisible}
            onCheckedChange={controls.setPdfVisible}
          />
          <LayoutToggleRow
            icon={PanelLeftIcon}
            label="Sidebar"
            checked={controls.sidebarVisible}
            onCheckedChange={controls.setSidebarVisible}
          />
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function LayoutToggleRow({
  icon: Icon,
  label,
  checked,
  onCheckedChange,
}: {
  icon: LucideIcon;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors hover:bg-accent/70",
        checked && "bg-accent/45 text-accent-foreground",
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium text-sm">
        {label}
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-foreground" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-background transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  layoutControls?: LayoutControls;
}

interface LayoutControls {
  codeVisible: boolean;
  pdfVisible: boolean;
  sidebarVisible: boolean;
  setCodeVisible: (visible: boolean) => void;
  setPdfVisible: (visible: boolean) => void;
  setSidebarVisible: (visible: boolean) => void;
}

export function Sidebar({
  collapsed = false,
  onToggleCollapsed,
  layoutControls,
}: SidebarProps) {
  const appVersion = useAppVersion();
  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const deleteFile = useDocumentStore((s) => s.deleteFile);
  const deleteFolder = useDocumentStore((s) => s.deleteFolder);
  const renameFile = useDocumentStore((s) => s.renameFile);
  const renameProject = useDocumentStore((s) => s.renameProject);
  const createNewFile = useDocumentStore((s) => s.createNewFile);
  const createFolder = useDocumentStore((s) => s.createFolder);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const activeFileContent = useDocumentStore((s) => {
    const active = s.files.find((f) => f.id === s.activeFileId);
    return active?.content ?? "";
  });
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );
  const requestRevealInTree = useDocumentStore((s) => s.requestRevealInTree);
  const _insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const moveFile = useDocumentStore((s) => s.moveFile);
  const moveFolder = useDocumentStore((s) => s.moveFolder);
  const closeProject = useDocumentStore((s) => s.closeProject);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const folders = useDocumentStore((s) => s.folders);

  // ─── Per-file marks (pin to top + color tag), scoped to this project ───
  const allFileMarks = useFileMarksStore((s) => s.marks);
  const togglePinMark = useFileMarksStore((s) => s.togglePin);
  const setColorMark = useFileMarksStore((s) => s.setColor);
  const reorderPins = useFileMarksStore((s) => s.reorderPins);
  const fileMarks = useMemo(
    () =>
      projectRoot
        ? projectMarks(allFileMarks, projectRoot)
        : new Map<string, FileMark>(),
    [allFileMarks, projectRoot],
  );
  const pinnedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const [path, mark] of fileMarks) {
      if (mark.pinned) set.add(path);
    }
    return set;
  }, [fileMarks]);
  const pinOrders = useMemo(() => {
    const orders = new Map<string, number>();
    for (const [path, mark] of fileMarks) {
      if (mark.pinned) orders.set(path, mark.pinOrder ?? 0);
    }
    return orders;
  }, [fileMarks]);
  const handleTogglePin = useCallback(
    (relativePath: string) => {
      if (projectRoot) togglePinMark(projectRoot, relativePath);
    },
    [projectRoot, togglePinMark],
  );
  const handleSetColor = useCallback(
    (relativePath: string, color: FileColor | null) => {
      if (projectRoot) setColorMark(projectRoot, relativePath, color);
    },
    [projectRoot, setColorMark],
  );

  // Pinned .tex files float to the top of their own folder, so reordering only
  // ever shuffles a file among the pinned siblings sharing its parent folder.
  const pinnedSiblingsOf = useCallback(
    (relativePath: string) => {
      const parent = parentFolderOfPath(relativePath) ?? "";
      return files
        .filter(
          (f) =>
            f.name.toLowerCase().endsWith(".tex") &&
            pinnedPaths.has(f.relativePath) &&
            (parentFolderOfPath(f.relativePath) ?? "") === parent,
        )
        .sort((a, b) => {
          const aOrder = pinOrders.get(a.relativePath) ?? 0;
          const bOrder = pinOrders.get(b.relativePath) ?? 0;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.name.localeCompare(b.name);
        })
        .map((f) => f.relativePath);
    },
    [files, pinnedPaths, pinOrders],
  );

  const getPinMoveState = useCallback(
    (relativePath: string) => {
      const siblings = pinnedSiblingsOf(relativePath);
      const index = siblings.indexOf(relativePath);
      return {
        canUp: index > 0,
        canDown: index >= 0 && index < siblings.length - 1,
      };
    },
    [pinnedSiblingsOf],
  );

  const handleMovePin = useCallback(
    (relativePath: string, direction: "up" | "down") => {
      if (!projectRoot) return;
      const siblings = pinnedSiblingsOf(relativePath);
      const index = siblings.indexOf(relativePath);
      if (index === -1) return;
      const swapWith = direction === "up" ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= siblings.length) return;
      const reordered = [...siblings];
      [reordered[index], reordered[swapWith]] = [
        reordered[swapWith],
        reordered[index],
      ];
      reorderPins(projectRoot, reordered);
    },
    [projectRoot, pinnedSiblingsOf, reorderPins],
  );

  const [isRefreshingFiles, setIsRefreshingFiles] = useState(false);
  const refreshFilesInFlightRef = useRef<Promise<void> | null>(null);
  // When a tailored version is open, `projectRoot` points at the variant
  // folder; the header should still show the *master* project's name (the
  // version name is shown by the VersionSwitcher just below).
  const ownerRoot = useVariantsStore((s) => s.ownerRoot);
  const onVariant = useVariantsStore((s) => s.activeVariantId !== null);
  const projectName = useMemo(() => {
    const source = (ownerRoot ?? projectRoot)?.replace(/[\\/]+$/, "");
    return source?.split(/[/\\]/).pop() || "Desktop";
  }, [ownerRoot, projectRoot]);

  // ─── Active sidebar section (tab rail shows one at a time) ───
  const [activeSection, setActiveSection] = useState<SidebarSection>(
    readStoredSidebarSection,
  );
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_SECTION_STORAGE_KEY, activeSection);
    } catch {
      // ignore persistence failures
    }
  }, [activeSection]);
  const openCommentCount = useCommentsStore(
    (s) => s.comments.filter((c) => c.status === "open").length,
  );

  // Switch to a section, expanding the sidebar first if it's collapsed.
  const openSection = useCallback(
    (section: SidebarSection) => {
      setActiveSection(section);
      if (collapsed) onToggleCollapsed?.();
    },
    [collapsed, onToggleCollapsed],
  );

  // Press "/" anywhere outside a text field to jump straight to the file filter.
  useEffect(() => {
    const handleSlash = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      if (!fileFilterRef.current) return;
      event.preventDefault();
      openSection("files");
      // Focus after the section switch (and any sidebar expand) has rendered.
      requestAnimationFrame(() => {
        fileFilterRef.current?.focus();
        fileFilterRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleSlash);
    return () => window.removeEventListener("keydown", handleSlash);
  }, [openSection]);

  // Arrow-key navigation for the tab rail (ARIA tabs pattern).
  const tabRailRef = useRef<HTMLDivElement>(null);
  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const navKeys = [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ];
      if (!navKeys.includes(event.key)) return;
      event.preventDefault();

      const count = SIDEBAR_SECTIONS.length;
      const current = SIDEBAR_SECTIONS.findIndex((s) => s.id === activeSection);
      let next = current;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (current - 1 + count) % count;
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (current + 1) % count;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = count - 1;
      }

      const nextId = SIDEBAR_SECTIONS[next].id;
      setActiveSection(nextId);
      tabRailRef.current
        ?.querySelector<HTMLButtonElement>(`#sidebar-tab-${nextId}`)
        ?.focus();
    },
    [activeSection],
  );

  const runRefreshFiles = useCallback(
    async ({ showSpinner = true }: { showSpinner?: boolean } = {}) => {
      if (!projectRoot) return;
      if (refreshFilesInFlightRef.current) {
        await refreshFilesInFlightRef.current;
        return;
      }

      const startedAt = Date.now();
      if (showSpinner) setIsRefreshingFiles(true);

      const refreshTask = (async () => {
        try {
          await refreshFiles();
        } catch (err) {
          log.error("Refresh files failed", { error: String(err) });
        } finally {
          if (showSpinner) {
            const elapsed = Date.now() - startedAt;
            if (elapsed < FILES_REFRESH_MIN_SPIN_MS) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, FILES_REFRESH_MIN_SPIN_MS - elapsed),
              );
            }
            setIsRefreshingFiles(false);
          }
          refreshFilesInFlightRef.current = null;
        }
      })();

      refreshFilesInFlightRef.current = refreshTask;
      await refreshTask;
    },
    [projectRoot, refreshFiles],
  );

  useEffect(() => {
    if (!projectRoot) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void runRefreshFiles({ showSpinner: false });
      }
    };

    const intervalId = window.setInterval(
      refreshIfVisible,
      FILES_AUTO_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [projectRoot, runRefreshFiles]);

  // ─── Native OS file drop (Tauri onDragDropEvent) ───
  const sidebarFilesRef = useRef<HTMLDivElement>(null);
  const fileFilterRef = useRef<HTMLInputElement>(null);
  const nativeDropTargetRef = useRef<string | null>(null);
  const [nativeDragOver, setNativeDragOver] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;

        if (type === "over" || type === "enter") {
          const payload = event.payload as {
            position: { x: number; y: number };
          };
          const { x, y } = payload.position;
          // Tauri reports physical pixels; elementFromPoint expects logical (CSS) pixels
          const logicalX = x / window.devicePixelRatio;
          const logicalY = y / window.devicePixelRatio;

          const el = document.elementFromPoint(logicalX, logicalY);
          const filesArea = sidebarFilesRef.current;

          if (!filesArea || !el || !filesArea.contains(el)) {
            // Not over the sidebar file tree
            if (nativeDropTargetRef.current !== null) {
              nativeDropTargetRef.current = null;
              setNativeDragOver(null);
            }
            return;
          }

          // Walk up from the hovered element to find the closest drop-folder target
          const folderEl = el.closest(
            "[data-drop-folder]",
          ) as HTMLElement | null;
          const folder = folderEl?.dataset.dropFolder ?? "__root__";
          nativeDropTargetRef.current = folder;
          setNativeDragOver(folder);
        } else if (type === "drop") {
          const payload = event.payload as {
            paths: string[];
            position: { x: number; y: number };
          };
          const { paths, position } = payload;
          const logicalX = position.x / window.devicePixelRatio;
          const logicalY = position.y / window.devicePixelRatio;

          const el = document.elementFromPoint(logicalX, logicalY);
          const filesArea = sidebarFilesRef.current;

          if (!filesArea || !el || !filesArea.contains(el)) {
            setNativeDragOver(null);
            nativeDropTargetRef.current = null;
            return;
          }

          const targetFolder =
            nativeDropTargetRef.current === "__root__"
              ? undefined
              : (nativeDropTargetRef.current ?? undefined);

          // Mark as handled so chat-composer doesn't also process it
          (window as any).__sidebarHandledDrop = true;
          setTimeout(() => {
            (window as any).__sidebarHandledDrop = false;
          }, 200);

          try {
            await importFiles(paths, targetFolder);
          } catch (err) {
            log.error("Native drop import failed", { error: String(err) });
          }

          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        } else if (type === "leave") {
          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not in Tauri environment (dev mode)
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [importFiles]);

  // Track selected folder for paste target
  const [pasteTargetFolder, setPasteTargetFolder] = useState<
    string | undefined
  >();

  // ─── Cmd+V paste files from OS clipboard ───
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "v") return;

      // Don't intercept paste in text inputs / editor (contentEditable)
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      )
        return;

      try {
        const paths = await invoke<string[]>("read_clipboard_file_paths");
        if (paths.length > 0) {
          e.preventDefault();
          await importFiles(paths, pasteTargetFolder);
        }
      } catch (err) {
        log.error("Read clipboard failed", { error: String(err) });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [importFiles, pasteTargetFolder]);

  const [selectedItemKeys, setSelectedItemKeys] = useState<Set<string>>(
    new Set(),
  );

  const existingItemKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const file of files) {
      keys.add(fileTreeSelectionKey({ type: "file", path: file.relativePath }));
    }
    for (const folder of folders) {
      keys.add(fileTreeSelectionKey({ type: "folder", path: folder }));
    }
    return keys;
  }, [files, folders]);

  useEffect(() => {
    setSelectedItemKeys((prev) => {
      const next = new Set(
        [...prev].filter((key) => existingItemKeys.has(key)),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [existingItemKeys]);

  const selectedItemsFromKeys = useCallback(
    (keys: Iterable<string>) =>
      Array.from(keys)
        .map(fileTreeSelectionItemFromKey)
        .filter((item): item is FileTreeSelectionItem => {
          if (!item) return false;
          return existingItemKeys.has(fileTreeSelectionKey(item));
        }),
    [existingItemKeys],
  );

  const getEffectiveSelectionItems = useCallback(
    (fallback: FileTreeSelectionItem) => {
      const fallbackKey = fileTreeSelectionKey(fallback);
      if (selectedItemKeys.has(fallbackKey)) {
        return selectedItemsFromKeys(selectedItemKeys);
      }
      return [fallback];
    },
    [selectedItemKeys, selectedItemsFromKeys],
  );

  const getEffectiveSelectionCount = useCallback(
    (fallback: FileTreeSelectionItem) =>
      getEffectiveSelectionItems(fallback).length,
    [getEffectiveSelectionItems],
  );

  const selectedAffectedFileCount = useCallback(
    (items: FileTreeSelectionItem[]) => {
      const { files: selectedFiles, folders: selectedFolders } =
        normalizeSelectionItems(items);
      const affected = new Set(selectedFiles.map((item) => item.path));

      for (const folder of selectedFolders) {
        for (const file of files) {
          if (isInsideFolder(file.relativePath, folder.path)) {
            affected.add(file.relativePath);
          }
        }
      }

      return affected.size;
    },
    [files],
  );

  const canDeleteSelection = useCallback(
    (fallback: FileTreeSelectionItem) => {
      const items = getEffectiveSelectionItems(fallback);
      const affected = selectedAffectedFileCount(items);
      return items.length > 0 && affected < files.length;
    },
    [files.length, getEffectiveSelectionItems, selectedAffectedFileCount],
  );

  const [pendingDeleteItems, setPendingDeleteItems] = useState<
    FileTreeSelectionItem[] | null
  >(null);
  const [isDeletingSelection, setIsDeletingSelection] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const canDeleteItems = useCallback(
    (items: FileTreeSelectionItem[]) => {
      const affected = selectedAffectedFileCount(items);
      return items.length > 0 && affected < files.length;
    },
    [files.length, selectedAffectedFileCount],
  );

  const requestDeleteItems = useCallback(
    (items: FileTreeSelectionItem[]) => {
      if (!canDeleteItems(items)) return;
      const { files: selectedFiles, folders: selectedFolders } =
        normalizeSelectionItems(items);
      setPendingDeleteItems([...selectedFolders, ...selectedFiles]);
      setDeleteError("");
    },
    [canDeleteItems],
  );

  const handleTreeItemContextMenu = useCallback(
    (item: FileTreeSelectionItem) => {
      const key = fileTreeSelectionKey(item);
      setPasteTargetFolder(
        item.type === "folder" ? item.path : parentFolderOfPath(item.path),
      );
      setSelectedItemKeys((prev) => (prev.has(key) ? prev : new Set([key])));
    },
    [],
  );

  const handleTreeItemClick = useCallback(
    (
      item: FileTreeSelectionItem,
      event: React.MouseEvent,
      onPrimaryClick: () => void,
    ) => {
      setPasteTargetFolder(
        item.type === "folder" ? item.path : parentFolderOfPath(item.path),
      );

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const key = fileTreeSelectionKey(item);
        setSelectedItemKeys((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }

      setSelectedItemKeys(new Set());
      onPrimaryClick();
    },
    [],
  );

  const requestDeleteSelection = useCallback(
    (fallback: FileTreeSelectionItem) => {
      requestDeleteItems(getEffectiveSelectionItems(fallback));
    },
    [getEffectiveSelectionItems, requestDeleteItems],
  );

  const confirmDeleteSelection = useCallback(async () => {
    if (!pendingDeleteItems || isDeletingSelection) return;

    setIsDeletingSelection(true);
    setDeleteError("");
    try {
      const { files: selectedFiles, folders: selectedFolders } =
        normalizeSelectionItems(pendingDeleteItems);

      for (const file of selectedFiles) {
        await Promise.resolve(deleteFile(file.path) as unknown);
      }
      for (const folder of selectedFolders) {
        await deleteFolder(folder.path);
      }

      setPendingDeleteItems(null);
      setSelectedItemKeys(new Set());
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeletingSelection(false);
    }
  }, [deleteFile, deleteFolder, isDeletingSelection, pendingDeleteItems]);

  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }

      const selectedItems = selectedItemsFromKeys(selectedItemKeys);
      if (selectedItems.length > 0) {
        event.preventDefault();
        requestDeleteItems(selectedItems);
        return;
      }

      if (activeFileId) {
        event.preventDefault();
        requestDeleteItems([{ type: "file", path: activeFileId }]);
      }
    };

    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [
    activeFileId,
    requestDeleteItems,
    selectedItemKeys,
    selectedItemsFromKeys,
  ]);

  // dnd-kit drag-and-drop (uses PointerSensor — works in Tauri WKWebView).
  // Hold-to-drag: a plain click always switches the file (it can never be
  // mistaken for a drag), and a drag only begins after a brief press-and-hold.
  // A distance-based constraint started a drag after just 5px of movement,
  // which suppressed the follow-up click and made file switching feel flaky.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );
  const [activeDrag, setActiveDrag] = useState<{
    id: string;
    type: "file" | "folder";
    name: string;
    count: number;
  } | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { type, name } = event.active.data.current as {
        type: "file" | "folder";
        name: string;
      };
      const item: FileTreeSelectionItem = {
        type,
        path: event.active.id as string,
      };
      const key = fileTreeSelectionKey(item);
      setActiveDrag({
        id: item.path,
        type,
        name,
        count: selectedItemKeys.has(key) ? getEffectiveSelectionCount(item) : 1,
      });
    },
    [getEffectiveSelectionCount, selectedItemKeys],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDrag(null);
      const { active, over } = event;
      if (!over) return;

      const draggedPath = active.id as string;
      const draggedType = (active.data.current as { type: string }).type;
      const targetId = over.id as string;
      const targetFolder = targetId === "__root__" ? null : targetId;

      const draggedItem: FileTreeSelectionItem = {
        type: draggedType === "folder" ? "folder" : "file",
        path: draggedPath,
      };
      const draggedKey = fileTreeSelectionKey(draggedItem);
      const movingItems = selectedItemKeys.has(draggedKey)
        ? selectedItemsFromKeys(selectedItemKeys)
        : [draggedItem];
      const { files: movingFiles, folders: movingFolders } =
        normalizeSelectionItems(movingItems);

      if (
        targetFolder &&
        movingFolders.some((folder) =>
          isInsideFolder(targetFolder, folder.path),
        )
      ) {
        return;
      }

      try {
        for (const file of movingFiles) {
          const parent = parentFolderOfPath(file.path) ?? null;
          if (targetFolder === parent) continue;
          await moveFile(file.path, targetFolder);
        }

        for (const folder of movingFolders) {
          const parent = parentFolderOfPath(folder.path) ?? null;
          if (targetFolder === parent) continue;
          await moveFolder(folder.path, targetFolder);
        }

        setSelectedItemKeys(new Set());
      } catch (err) {
        log.error("DnD move failed", { error: String(err) });
      }
    },
    [moveFile, moveFolder, selectedItemKeys, selectedItemsFromKeys],
  );

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogFolder, setAddDialogFolder] = useState<string | undefined>();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogParent, setFolderDialogParent] = useState<
    string | undefined
  >();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [projectRenameDialogOpen, setProjectRenameDialogOpen] = useState(false);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [projectRenameError, setProjectRenameError] = useState("");
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");

  // Folder expand/collapse
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const tree = useMemo(
    () => buildFileTree(files, folders, pinnedPaths, pinOrders),
    [files, folders, pinnedPaths, pinOrders],
  );

  // ─── File filter ───
  // Narrows the tree to files whose path matches, keeping their ancestor
  // folders and force-expanding them so every match is visible.
  const [fileFilter, setFileFilter] = useState("");
  const normalizedFileFilter = fileFilter.trim().toLowerCase();
  const { displayTree, filterExpandedFolders, filterMatchCount } =
    useMemo(() => {
      if (!normalizedFileFilter) {
        return {
          displayTree: tree,
          filterExpandedFolders: null as Set<string> | null,
          filterMatchCount: 0,
        };
      }
      const matchingFiles = files.filter((f) =>
        f.relativePath.toLowerCase().includes(normalizedFileFilter),
      );
      const keepFolders = new Set<string>();
      for (const f of matchingFiles) {
        const parts = f.relativePath.split("/");
        for (let i = 1; i < parts.length; i++) {
          keepFolders.add(parts.slice(0, i).join("/"));
        }
      }
      return {
        displayTree: buildFileTree(
          matchingFiles,
          [...keepFolders],
          pinnedPaths,
          pinOrders,
        ),
        filterExpandedFolders: keepFolders,
        filterMatchCount: matchingFiles.length,
      };
    }, [tree, normalizedFileFilter, files, pinnedPaths, pinOrders]);
  const effectiveExpandedFolders = filterExpandedFolders ?? expandedFolders;

  // On project load, expand the folders holding pinned .tex files so every pin
  // is visible by default. Read pins through a ref and key the effect on the
  // project root alone, so it fires once per opened project and never fights a
  // user who later collapses a folder or toggles a pin.
  const pinnedPathsRef = useRef(pinnedPaths);
  pinnedPathsRef.current = pinnedPaths;
  useEffect(() => {
    if (!projectRoot) return;
    const paths = pinnedPathsRef.current;
    if (paths.size === 0) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const path of paths) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          const folder = parts.slice(0, i).join("/");
          if (!next.has(folder)) {
            next.add(folder);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [projectRoot]);

  // Auto-expand parent folders of the active file so it stays visible
  useEffect(() => {
    if (!activeFileId) return;
    const parts = activeFileId.split("/");
    if (parts.length <= 1) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (!next.has(folder)) {
          next.add(folder);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeFileId]);

  // ─── Reveal-in-tree (from breadcrumb clicks / "reveal active file") ───
  const revealRequest = useDocumentStore((s) => s.revealRequest);
  const clearRevealRequest = useDocumentStore((s) => s.clearRevealRequest);
  useEffect(() => {
    if (!revealRequest) return;
    const { path, type } = revealRequest;

    // Switch to Files (expanding the sidebar pane if it's collapsed).
    openSection("files");

    // Expand every ancestor folder (and the folder itself when revealing one).
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      const upto = type === "folder" ? parts.length : parts.length - 1;
      for (let i = 1; i <= upto; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });

    // Highlight via the existing selection/active mechanisms.
    if (type === "file") {
      setActiveFile(path);
      setSelectedItemKeys(new Set());
    } else {
      setSelectedItemKeys(
        new Set([fileTreeSelectionKey({ type: "folder", path })]),
      );
    }

    // Scroll the row into view once the expand has rendered.
    const timer = window.setTimeout(() => {
      const rows =
        sidebarFilesRef.current?.querySelectorAll<HTMLElement>(
          "[data-tree-path]",
        );
      rows?.forEach((row) => {
        if (row.dataset.treePath === path) {
          row.scrollIntoView({ block: "nearest" });
        }
      });
    }, 60);

    clearRevealRequest();
    return () => window.clearTimeout(timer);
  }, [revealRequest, clearRevealRequest, setActiveFile, openSection]);

  const toggleFolder = useCallback((path: string) => {
    setPasteTargetFolder(path);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Outline
  const toc = useMemo(
    () => parseTableOfContents(activeFileContent),
    [activeFileContent],
  );

  // ─── Outline scroll-spy ───
  // Char offset of each line start, so we can map the cursor to its section.
  const lineStartOffsets = useMemo(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const line of activeFileContent.split("\n")) {
      offsets.push(offset);
      offset += line.length + 1;
    }
    return offsets;
  }, [activeFileContent]);
  const cursorPosition = useDocumentStore((s) => s.cursorPosition);
  const activeTocIndex = useMemo(() => {
    let active = -1;
    for (let i = 0; i < toc.length; i++) {
      const start = lineStartOffsets[toc[i].line - 1] ?? 0;
      if (start <= cursorPosition) active = i;
      else break;
    }
    return active;
  }, [toc, lineStartOffsets, cursorPosition]);

  const handleTocClick = useCallback(
    (line: number) => {
      const position = lineStartOffsets[line - 1] ?? 0;
      requestJumpToPosition(position);
      void triggerForwardSync({ line });
    },
    [lineStartOffsets, requestJumpToPosition],
  );

  // Keep the active outline entry scrolled into view while editing.
  const activeTocRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeSection !== "outline" || activeTocIndex < 0) return;
    activeTocRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeTocIndex, activeSection]);

  // Check if a name already exists in the given folder
  // Case-insensitive on macOS/Windows (default case-insensitive filesystems)
  const isCaseInsensitiveFs =
    navigator.platform.startsWith("Mac") ||
    navigator.platform.startsWith("Win");
  const nameExistsIn = useCallback(
    (name: string, folder?: string) => {
      const targetPath = folder ? `${folder}/${name}` : name;
      const cmp = (a: string, b: string) =>
        isCaseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
      const existsAsFile = files.some((f) => cmp(f.relativePath, targetPath));
      const existsAsFolder = folders.some((f) => cmp(f, targetPath));
      return existsAsFile || existsAsFolder;
    },
    [files, folders, isCaseInsensitiveFs],
  );

  // Handlers
  const [nameError, setNameError] = useState("");

  const handleAddFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    if (nameExistsIn(name, addDialogFolder)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    // Auto-append .tex if no extension provided
    const finalName = /\.\w+$/.test(name) ? name : `${name}.tex`;
    const lower = finalName.toLowerCase();
    const type: "tex" | "image" = /\.(png|jpg|jpeg|gif|svg|bmp|webp)$/.test(
      lower,
    )
      ? "image"
      : "tex";
    createNewFile(finalName, type, addDialogFolder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(false);
    setAddDialogFolder(undefined);
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (nameExistsIn(name, folderDialogParent)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    createFolder(name, folderDialogParent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(false);
    setFolderDialogParent(undefined);
  };

  const handleImport = async (targetFolder?: string) => {
    const selected = await openDialog({
      multiple: true,
    });
    if (selected && projectRoot) {
      const paths = Array.isArray(selected) ? selected : [selected];
      await importFiles(paths, targetFolder);
    }
  };

  const openRenameDialog = (id: string, name: string) => {
    setRenameFileId(id);
    setRenameValue(name);
    setNameError("");
    setRenameDialogOpen(true);
  };

  const openProjectRenameDialog = () => {
    if (!projectRoot) return;
    setProjectRenameValue(projectName);
    setProjectRenameError("");
    setProjectRenameDialogOpen(true);
  };

  const handleProjectRename = async () => {
    const name = projectRenameValue.trim();
    if (!name || isRenamingProject) return;
    setIsRenamingProject(true);
    setProjectRenameError("");
    try {
      await renameProject(name);
      setProjectRenameDialogOpen(false);
    } catch (err) {
      setProjectRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRenamingProject(false);
    }
  };

  const handleRename = () => {
    const name = renameValue.trim();
    if (!renameFileId || !name) return;
    // Check duplicate: find the parent folder of the file being renamed
    const file = files.find((f) => f.id === renameFileId);
    const parentFolder = file?.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : undefined;
    const isSameName = isCaseInsensitiveFs
      ? name.toLowerCase() === file?.name.toLowerCase()
      : name === file?.name;
    if (nameExistsIn(name, parentFolder) && !isSameName) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    renameFile(renameFileId, name);
    setRenameDialogOpen(false);
    setRenameFileId(null);
    setRenameValue("");
    setNameError("");
  };

  const openNewFileDialog = (folder?: string) => {
    setAddDialogFolder(folder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(true);
  };

  const openNewFolderDialog = (parent?: string) => {
    setFolderDialogParent(parent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(true);
  };

  // ─── Render ───

  const pendingDeleteCount = pendingDeleteItems?.length ?? 0;
  const pendingDeletePreview = pendingDeleteItems?.slice(0, 4) ?? [];

  const collapsedRail = (
    <div className="flex h-full w-full min-w-0 flex-col items-center bg-sidebar text-sidebar-foreground">
      <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] w-full items-center justify-center border-sidebar-border border-b">
        <LayoutPaneSwitcher
          controls={layoutControls}
          collapsed={collapsed}
          onQuickToggleSidebar={onToggleCollapsed}
          side="right"
          align="start"
          buttonClassName="size-7"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 py-2">
        {SIDEBAR_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Button
              key={section.id}
              variant="ghost"
              size="icon"
              className={cn(
                "relative size-7 transition-transform duration-300 ease-in-out hover:scale-105",
                activeSection === section.id &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              onClick={() => openSection(section.id)}
              title={section.label}
              aria-label={`Open ${section.label}`}
            >
              <Icon className="size-3.5" />
              {section.id === "comments" && openCommentCount > 0 && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-500" />
              )}
            </Button>
          );
        })}
      </div>
      <div className="flex h-9 w-full items-center justify-center border-sidebar-border border-t">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 transition-transform duration-300 ease-in-out hover:scale-105"
          onClick={closeProject}
          title="Close Project"
          aria-label="Close Project"
        >
          <HomeIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="relative h-full overflow-hidden bg-sidebar text-sidebar-foreground">
      <div
        className={cn(
          "absolute inset-y-0 left-0 z-10 w-full transition-[opacity,transform] duration-300 ease-in-out",
          collapsed
            ? "translate-x-0 opacity-100"
            : "pointer-events-none -translate-x-1 opacity-0",
        )}
        aria-hidden={!collapsed}
      >
        {collapsedRail}
      </div>
      <div
        className={cn(
          "h-full w-full min-w-0 transition-[opacity,transform] duration-300 ease-in-out",
          collapsed
            ? "pointer-events-none -translate-x-2 opacity-0"
            : "translate-x-0 opacity-100",
        )}
        aria-hidden={collapsed}
      >
        <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
          {/* Header — padded top for macOS overlay titlebar */}
          <div className="grid h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2 border-sidebar-border border-b px-3">
            <div className="flex items-center justify-start">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 transition-all duration-150 ease-out hover:scale-105"
                onClick={closeProject}
                title="Close Project"
                aria-label="Close Project"
              >
                <HomeIcon className="size-3.5" />
              </Button>
            </div>
            <button
              type="button"
              className={cn(
                "w-full min-w-0 rounded-md px-2 py-1 font-semibold text-sm transition-colors",
                projectRoot && !onVariant
                  ? "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  : "cursor-default",
              )}
              onClick={openProjectRenameDialog}
              disabled={!projectRoot || onVariant}
              title={
                onVariant
                  ? "Switch to Master to rename the project"
                  : projectRoot
                    ? "Rename project folder"
                    : undefined
              }
              aria-label="Rename project folder"
            >
              <span className="block truncate">{projectName}</span>
            </button>
            <div className="flex items-center justify-end">
              <LayoutPaneSwitcher
                controls={layoutControls}
                collapsed={collapsed}
                onQuickToggleSidebar={onToggleCollapsed}
                side="bottom"
                align="end"
                buttonClassName="size-6"
              />
            </div>
          </div>

          {/* Space-specific features (tailored versions, quick actions) */}
          <SpaceFeaturesBar />

          {/* Section tab rail — one section visible at a time */}
          <div
            ref={tabRailRef}
            role="tablist"
            aria-label="Sidebar sections"
            onKeyDown={handleTabKeyDown}
            className="flex shrink-0 items-stretch border-sidebar-border border-b"
          >
            {SIDEBAR_SECTIONS.map((section) => {
              const isActive = activeSection === section.id;
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  id={`sidebar-tab-${section.id}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`sidebar-panel-${section.id}`}
                  tabIndex={isActive ? 0 : -1}
                  title={section.label}
                  aria-label={section.label}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    "relative flex h-9 flex-1 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/50 hover:text-foreground focus-visible:bg-sidebar-accent/50 focus-visible:text-foreground",
                    isActive && "text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {section.id === "comments" && openCommentCount > 0 && (
                    <span className="absolute top-1.5 right-2 size-1.5 rounded-full bg-amber-500" />
                  )}
                  {isActive && (
                    <span className="absolute inset-x-2.5 bottom-0 h-0.5 rounded-full bg-foreground" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Active section content */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Files */}
            <div
              ref={sidebarFilesRef}
              id="sidebar-panel-files"
              role="tabpanel"
              aria-labelledby="sidebar-tab-files"
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                activeSection !== "files" && "hidden",
              )}
              data-sidebar-files
            >
              <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-sidebar-border border-b px-3">
                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wider">
                  <FolderIcon className="size-3 shrink-0" />
                  <span className="truncate font-medium">Files</span>
                  {files.length > 0 && (
                    <span className="shrink-0 rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] tracking-normal">
                      {files.length}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    title="Reveal active file"
                    aria-label="Reveal active file"
                    disabled={!activeFileId}
                    onClick={() =>
                      activeFileId && requestRevealInTree(activeFileId, "file")
                    }
                  >
                    <LocateFixedIcon className="size-3" />
                  </Button>
                  {folders.length > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-5"
                      title="Collapse all folders"
                      aria-label="Collapse all folders"
                      disabled={
                        !!normalizedFileFilter || expandedFolders.size === 0
                      }
                      onClick={() => setExpandedFolders(new Set())}
                    >
                      <ChevronsDownUpIcon className="size-3" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    title="Refresh"
                    aria-label="Refresh files"
                    aria-busy={isRefreshingFiles}
                    disabled={isRefreshingFiles}
                    onClick={() => void runRefreshFiles()}
                  >
                    <RefreshCwIcon
                      className={cn(
                        "size-3",
                        isRefreshingFiles && "animate-spin",
                      )}
                    />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5"
                        title="Add"
                        aria-label="Add file or folder"
                      >
                        <PlusIcon className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openNewFileDialog()}>
                        <FileTextIcon className="mr-2 size-4" />
                        New LaTeX File
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openNewFolderDialog()}>
                        <FolderPlusIcon className="mr-2 size-4" />
                        New Folder
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => handleImport()}>
                        <UploadIcon className="mr-2 size-4" />
                        Import File
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {files.length > 0 && (
                <div className="shrink-0 px-2 py-1.5">
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={fileFilterRef}
                      type="text"
                      value={fileFilter}
                      onChange={(e) => setFileFilter(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && fileFilter) {
                          e.preventDefault();
                          e.stopPropagation();
                          setFileFilter("");
                        }
                      }}
                      placeholder="Filter files…"
                      aria-label="Filter files"
                      className={cn(
                        "h-7 w-full rounded-md border border-sidebar-border bg-background pl-7 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
                        normalizedFileFilter ? "pr-20" : "pr-7",
                      )}
                    />
                    {normalizedFileFilter && (
                      <span className="pointer-events-none absolute top-1/2 right-7 -translate-y-1/2 font-mono text-[10px] text-muted-foreground tabular-nums">
                        {filterMatchCount} of {files.length}
                      </span>
                    )}
                    {fileFilter && (
                      <button
                        type="button"
                        onClick={() => setFileFilter("")}
                        title="Clear filter"
                        aria-label="Clear filter"
                        className="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                      >
                        <XIcon className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              )}
              <DndContext
                sensors={sensors}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <DroppableRoot
                      nativeDragOver={nativeDragOver === "__root__"}
                    >
                      {displayTree.length === 0 &&
                        (normalizedFileFilter ? (
                          <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-muted-foreground text-xs">
                            <SearchIcon className="size-4 opacity-60" />
                            <span>No files match</span>
                            <span className="max-w-full truncate opacity-70">
                              “{fileFilter.trim()}”
                            </span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openNewFileDialog()}
                            className="flex w-full flex-col items-center gap-1 rounded-md px-3 py-6 text-center text-muted-foreground text-xs transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
                          >
                            <FolderPlusIcon className="size-4 opacity-60" />
                            <span>No files yet</span>
                            <span className="opacity-70">
                              Add a file, or drop one here
                            </span>
                          </button>
                        ))}
                      {displayTree.map((node) => (
                        <FileTreeNode
                          key={node.relativePath}
                          node={node}
                          depth={0}
                          activeFileId={activeFileId}
                          selectedItemKeys={selectedItemKeys}
                          expandedFolders={effectiveExpandedFolders}
                          onToggleFolder={toggleFolder}
                          onSelectFile={(id: string) => {
                            const parent = parentFolderOfPath(id);
                            setPasteTargetFolder(parent);
                            setActiveFile(id);
                          }}
                          onItemClick={handleTreeItemClick}
                          onItemContextMenu={handleTreeItemContextMenu}
                          onNewFile={openNewFileDialog}
                          onNewFolder={openNewFolderDialog}
                          onImport={handleImport}
                          onRename={openRenameDialog}
                          onDeleteSelection={requestDeleteSelection}
                          canDeleteSelection={canDeleteSelection}
                          getEffectiveSelectionCount={
                            getEffectiveSelectionCount
                          }
                          fileMarks={fileMarks}
                          onTogglePin={handleTogglePin}
                          onSetColor={handleSetColor}
                          onMovePin={handleMovePin}
                          getPinMoveState={getPinMoveState}
                          nativeDragOver={nativeDragOver}
                        />
                      ))}
                    </DroppableRoot>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => openNewFileDialog()}>
                      <FileTextIcon className="mr-2 size-4" />
                      New File
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => openNewFolderDialog()}>
                      <FolderPlusIcon className="mr-2 size-4" />
                      New Folder
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => handleImport()}>
                      <UploadIcon className="mr-2 size-4" />
                      Import File
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                <DragOverlay dropAnimation={null}>
                  {activeDrag && (
                    <div className="flex items-center gap-2 rounded-md bg-sidebar px-2 py-1 text-sm shadow-lg ring-1 ring-ring">
                      {activeDrag.type === "folder" ? (
                        <FolderIcon className="size-4 shrink-0" />
                      ) : (
                        <FileTextIcon className="size-4 shrink-0" />
                      )}
                      <span className="truncate">
                        {activeDrag.count > 1
                          ? `${activeDrag.count} selected`
                          : activeDrag.name}
                      </span>
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            </div>

            {/* Outline */}
            <div
              id="sidebar-panel-outline"
              role="tabpanel"
              aria-labelledby="sidebar-tab-outline"
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                activeSection !== "outline" && "hidden",
              )}
            >
              <div className="flex h-8 shrink-0 items-center gap-1.5 border-sidebar-border border-b px-3 text-muted-foreground text-xs uppercase tracking-wider">
                <ListIcon className="size-3 shrink-0" />
                <span className="font-medium">Outline</span>
                {toc.length > 0 && (
                  <span className="rounded bg-sidebar-accent px-1.5 py-0.5 font-mono text-[10px] tracking-normal">
                    {toc.length}
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {toc.length > 0 ? (
                  toc.map((item, index) => {
                    const isActive = index === activeTocIndex;
                    return (
                      <button
                        key={index}
                        ref={isActive ? activeTocRef : undefined}
                        aria-current={isActive ? "location" : undefined}
                        className={cn(
                          "relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm transition-colors",
                          isActive
                            ? "bg-sidebar-accent/60 text-sidebar-accent-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
                            : "hover:bg-sidebar-accent/50",
                        )}
                        style={{
                          paddingLeft: `${(item.level - 1) * 12 + 8}px`,
                        }}
                        onClick={() => handleTocClick(item.line)}
                      >
                        <HashIcon
                          className={cn(
                            "size-3 shrink-0",
                            isActive ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                        <span className="truncate">{item.title}</span>
                      </button>
                    );
                  })
                ) : (
                  <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-muted-foreground text-xs">
                    <ListIcon className="size-4 opacity-60" />
                    <span>No sections yet</span>
                    <span className="opacity-70">
                      {"Add \\section{…} headings to outline your document"}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Bibliography */}
            <div
              id="sidebar-panel-bibliography"
              role="tabpanel"
              aria-labelledby="sidebar-tab-bibliography"
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                activeSection !== "bibliography" && "hidden",
              )}
            >
              <div className="flex h-8 shrink-0 items-center border-sidebar-border border-b">
                <BibliographyHeader />
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <BibliographyPanel />
              </div>
            </div>

            {/* Zotero */}
            <div
              id="sidebar-panel-zotero"
              role="tabpanel"
              aria-labelledby="sidebar-tab-zotero"
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                activeSection !== "zotero" && "hidden",
              )}
            >
              <div className="flex h-8 shrink-0 items-center border-sidebar-border border-b">
                <ZoteroHeader />
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ZoteroPanel />
              </div>
            </div>

            {/* Comments */}
            <div
              id="sidebar-panel-comments"
              role="tabpanel"
              aria-labelledby="sidebar-tab-comments"
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                activeSection !== "comments" && "hidden",
              )}
            >
              <div className="flex h-8 shrink-0 items-center border-sidebar-border border-b">
                <CommentsHeader />
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <CommentsPanel />
              </div>
            </div>

            {/* Environment */}
            <div
              id="sidebar-panel-environment"
              role="tabpanel"
              aria-labelledby="sidebar-tab-environment"
              className={cn(
                "min-h-0 flex-1 overflow-y-auto",
                activeSection !== "environment" && "hidden",
              )}
            >
              <EnvironmentSection projectPath={projectRoot} />
            </div>
          </div>

          {/* Footer */}
          <div className="flex h-9 items-center justify-between border-sidebar-border border-t px-3 text-muted-foreground text-xs">
            <span className="truncate">DevPrism v{appVersion}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                title="Settings"
                aria-label="Settings"
                onClick={() => {
                  // Settings lives in the project picker; close the project and
                  // ask the picker to open straight on its Settings section.
                  useSpacesStore.getState().setPendingPickerSection("settings");
                  closeProject();
                }}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-6" asChild>
                <a
                  href="https://github.com/bharathvbcr/DevPrism"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="GitHub"
                >
                  <GithubIcon className="size-3.5" />
                </a>
              </Button>
            </div>
          </div>

          {/* New File Dialog */}
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogContent className="overflow-hidden sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  New File{addDialogFolder ? ` in ${addDialogFolder}` : ""}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  placeholder="filename.tex"
                  value={newFileName}
                  onChange={(e) => {
                    setNewFileName(e.target.value);
                    setNameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddFile();
                  }}
                  autoFocus
                />
                {nameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setAddDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleAddFile} disabled={!newFileName.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* New Folder Dialog */}
          <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  New Folder
                  {folderDialogParent ? ` in ${folderDialogParent}` : ""}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  placeholder="folder name"
                  value={newFolderName}
                  onChange={(e) => {
                    setNewFolderName(e.target.value);
                    setNameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFolder();
                  }}
                  autoFocus
                />
                {nameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setFolderDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim()}
                >
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Rename Project Dialog */}
          <Dialog
            open={projectRenameDialogOpen}
            onOpenChange={(open) => {
              if (!isRenamingProject) setProjectRenameDialogOpen(open);
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Rename Project</DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  value={projectRenameValue}
                  onChange={(e) => {
                    setProjectRenameValue(e.target.value);
                    setProjectRenameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleProjectRename();
                  }}
                  autoFocus
                />
                {projectRenameError && (
                  <p className="text-destructive text-xs">
                    {projectRenameError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setProjectRenameDialogOpen(false)}
                  disabled={isRenamingProject}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleProjectRename}
                  disabled={!projectRenameValue.trim() || isRenamingProject}
                >
                  {isRenamingProject ? "Renaming..." : "Rename"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Rename Dialog */}
          <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Rename</DialogTitle>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Input
                  value={renameValue}
                  onChange={(e) => {
                    setRenameValue(e.target.value);
                    setNameError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                  }}
                  autoFocus
                />
                {nameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setRenameDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleRename}>Rename</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Delete confirmation */}
          <Dialog
            open={!!pendingDeleteItems}
            onOpenChange={(open) => {
              if (!open && !isDeletingSelection) {
                setPendingDeleteItems(null);
                setDeleteError("");
              }
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  Delete {pendingDeleteCount === 1 ? "Item" : "Items"}
                </DialogTitle>
                <DialogDescription>
                  {pendingDeleteCount === 1
                    ? "This item will be removed from disk."
                    : `${pendingDeleteCount} selected items will be removed from disk.`}
                </DialogDescription>
              </DialogHeader>
              {pendingDeletePreview.length > 0 && (
                <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-muted/40 px-3 py-2">
                  <div className="space-y-1">
                    {pendingDeletePreview.map((item) => (
                      <div
                        key={fileTreeSelectionKey(item)}
                        className="min-w-0 break-all font-mono text-muted-foreground text-xs"
                      >
                        {item.type === "folder" ? "Folder" : "File"}:{" "}
                        {item.path}
                      </div>
                    ))}
                    {pendingDeleteCount > pendingDeletePreview.length && (
                      <div className="text-muted-foreground text-xs">
                        +{pendingDeleteCount - pendingDeletePreview.length} more
                      </div>
                    )}
                  </div>
                </div>
              )}
              {deleteError && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                  {deleteError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (isDeletingSelection) return;
                    setPendingDeleteItems(null);
                    setDeleteError("");
                  }}
                  disabled={isDeletingSelection}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void confirmDeleteSelection()}
                  disabled={!pendingDeleteItems || isDeletingSelection}
                >
                  {isDeletingSelection ? "Deleting..." : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}

// ─── File Tree Node ───

// ─── dnd-kit helpers ───

function DroppableRoot({
  children,
  nativeDragOver,
}: {
  children: React.ReactNode;
  nativeDragOver?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "__root__" });
  return (
    <div
      ref={setNodeRef}
      data-drop-folder="__root__"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto p-1",
        (isOver || nativeDragOver) && "bg-accent/30",
      )}
    >
      {children}
    </div>
  );
}

function DroppableFolder({
  id,
  children,
  nativeDragOver,
}: {
  id: string;
  children: React.ReactNode;
  nativeDragOver?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-drop-folder={id}
      className={cn((isOver || nativeDragOver) && "rounded-md bg-accent/30")}
    >
      {children}
    </div>
  );
}

// ─── File Tree Node ───

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  activeFileId: string;
  selectedItemKeys: Set<string>;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (id: string) => void;
  onItemClick: (
    item: FileTreeSelectionItem,
    event: React.MouseEvent,
    onPrimaryClick: () => void,
  ) => void;
  onItemContextMenu: (item: FileTreeSelectionItem) => void;
  onNewFile: (folder?: string) => void;
  onNewFolder: (parent?: string) => void;
  onImport: (folder?: string) => void;
  onRename: (id: string, name: string) => void;
  onDeleteSelection: (fallback: FileTreeSelectionItem) => void;
  canDeleteSelection: (fallback: FileTreeSelectionItem) => boolean;
  getEffectiveSelectionCount: (fallback: FileTreeSelectionItem) => number;
  fileMarks: Map<string, FileMark>;
  onTogglePin: (relativePath: string) => void;
  onSetColor: (relativePath: string, color: FileColor | null) => void;
  onMovePin: (relativePath: string, direction: "up" | "down") => void;
  getPinMoveState: (relativePath: string) => {
    canUp: boolean;
    canDown: boolean;
  };
  nativeDragOver?: string | null;
}

// Hover-revealed Rename/Delete controls overlaid on a tree row. Rendered as a
// sibling of the row <button> (not a child — buttons can't nest) inside a
// `group relative` wrapper. The container is pointer-events-none so the fade
// area still passes clicks through to the row; only the icons are interactive.
function RowActions({
  onRename,
  onDelete,
  renameDisabled,
  deleteDisabled,
  deleteLabel = "Delete",
  leading,
}: {
  onRename: () => void;
  onDelete: () => void;
  renameDisabled?: boolean;
  deleteDisabled?: boolean;
  deleteLabel?: string;
  // Status markers (pin/dirty/comment count, folder size…) mirrored into the
  // overlay so they stay visible when the hover actions cover the row's end.
  leading?: React.ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 bg-gradient-to-l from-sidebar-accent via-sidebar-accent to-transparent pl-5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      {leading && (
        <span className="mr-0.5 flex items-center gap-1.5">{leading}</span>
      )}
      <button
        type="button"
        title="Rename"
        aria-label="Rename"
        disabled={renameDisabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRename();
        }}
        className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:bg-background/70 focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 group-focus-within:pointer-events-auto group-hover:pointer-events-auto"
      >
        <PencilIcon className="size-3.5" />
      </button>
      <button
        type="button"
        title={deleteLabel}
        aria-label={deleteLabel}
        disabled={deleteDisabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-destructive focus-visible:bg-background/70 focus-visible:text-destructive focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 group-focus-within:pointer-events-auto group-hover:pointer-events-auto"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}

function FileTreeNode({
  node,
  depth,
  activeFileId,
  selectedItemKeys,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onItemClick,
  onItemContextMenu,
  onNewFile,
  onNewFolder,
  onImport,
  onRename,
  onDeleteSelection,
  canDeleteSelection,
  getEffectiveSelectionCount,
  fileMarks,
  onTogglePin,
  onSetColor,
  onMovePin,
  getPinMoveState,
  nativeDragOver,
}: FileTreeNodeProps) {
  const isExpanded = expandedFolders.has(node.relativePath);

  // Synthetic "Other Files" group: collapses a folder's non-.tex files. It is
  // not selectable, draggable, or a drop target — just an expand/collapse
  // header. Groups default to open (tracked via an inverted collapse key).
  if (node.type === "other") {
    const otherExpanded = !expandedFolders.has(
      otherCollapseKey(node.relativePath),
    );
    return (
      <div>
        <button
          type="button"
          className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-muted-foreground text-sm transition-colors hover:bg-sidebar-accent/50"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={() => onToggleFolder(otherCollapseKey(node.relativePath))}
        >
          {otherExpanded ? (
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <FilesIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs uppercase tracking-wider">
            Other Files
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {node.children.length}
          </span>
        </button>
        {otherExpanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              selectedItemKeys={selectedItemKeys}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              onItemClick={onItemClick}
              onItemContextMenu={onItemContextMenu}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onImport={onImport}
              onRename={onRename}
              onDeleteSelection={onDeleteSelection}
              canDeleteSelection={canDeleteSelection}
              getEffectiveSelectionCount={getEffectiveSelectionCount}
              fileMarks={fileMarks}
              onTogglePin={onTogglePin}
              onSetColor={onSetColor}
              onMovePin={onMovePin}
              getPinMoveState={getPinMoveState}
              nativeDragOver={nativeDragOver}
            />
          ))}
      </div>
    );
  }

  if (node.type === "folder") {
    const folderItem: FileTreeSelectionItem = {
      type: "folder",
      path: node.relativePath,
    };
    const isSelected = selectedItemKeys.has(fileTreeSelectionKey(folderItem));
    const effectiveSelectionCount = getEffectiveSelectionCount(folderItem);
    const batchOperation = effectiveSelectionCount > 1;
    const fileCount = countFileDescendants(node);
    const folderCount =
      !isExpanded && fileCount > 0 ? (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          {fileCount}
        </span>
      ) : null;

    return (
      <DroppableFolder
        id={node.relativePath}
        nativeDragOver={nativeDragOver === node.relativePath}
      >
        <DraggableItem id={node.relativePath} type="folder" name={node.name}>
          <div className="group relative">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  aria-pressed={isSelected}
                  data-tree-path={node.relativePath}
                  title={node.relativePath}
                  className={cn(
                    "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm transition-colors hover:bg-sidebar-accent/50",
                    isSelected &&
                      "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                  style={{ paddingLeft: `${depth * 12 + 4}px` }}
                  onClick={(event) =>
                    onItemClick(folderItem, event, () =>
                      onToggleFolder(node.relativePath),
                    )
                  }
                  onContextMenu={() => onItemContextMenu(folderItem)}
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  {folderCount}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => onNewFile(node.relativePath)}>
                  <FileTextIcon className="mr-2 size-4" />
                  New File Here
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onNewFolder(node.relativePath)}>
                  <FolderPlusIcon className="mr-2 size-4" />
                  New Folder
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onImport(node.relativePath)}>
                  <UploadIcon className="mr-2 size-4" />
                  Import File Here
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => onRename(node.relativePath, node.name)}
                  disabled={batchOperation}
                >
                  <PencilIcon className="mr-2 size-4" />
                  Rename
                </ContextMenuItem>
                <ContextMenuItem
                  variant="destructive"
                  onClick={() => onDeleteSelection(folderItem)}
                  disabled={!canDeleteSelection(folderItem)}
                >
                  <Trash2Icon className="mr-2 size-4" />
                  {batchOperation
                    ? `Delete ${effectiveSelectionCount} selected`
                    : "Delete"}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <RowActions
              onRename={() => onRename(node.relativePath, node.name)}
              onDelete={() => onDeleteSelection(folderItem)}
              renameDisabled={batchOperation}
              deleteDisabled={!canDeleteSelection(folderItem)}
              deleteLabel={
                batchOperation
                  ? `Delete ${effectiveSelectionCount} selected`
                  : "Delete folder"
              }
              leading={folderCount}
            />
          </div>
        </DraggableItem>
        {isExpanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              selectedItemKeys={selectedItemKeys}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              onItemClick={onItemClick}
              onItemContextMenu={onItemContextMenu}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onImport={onImport}
              onRename={onRename}
              onDeleteSelection={onDeleteSelection}
              canDeleteSelection={canDeleteSelection}
              getEffectiveSelectionCount={getEffectiveSelectionCount}
              fileMarks={fileMarks}
              onTogglePin={onTogglePin}
              onSetColor={onSetColor}
              onMovePin={onMovePin}
              getPinMoveState={getPinMoveState}
              nativeDragOver={nativeDragOver}
            />
          ))}
      </DroppableFolder>
    );
  }

  // File node
  const file = node.file!;
  const fileItem: FileTreeSelectionItem = {
    type: "file",
    path: file.relativePath,
  };
  const isSelected = selectedItemKeys.has(fileTreeSelectionKey(fileItem));
  const effectiveSelectionCount = getEffectiveSelectionCount(fileItem);
  const batchOperation = effectiveSelectionCount > 1;

  // Pin/color marks apply to .tex files only.
  const isTex = file.name.toLowerCase().endsWith(".tex");
  const mark = isTex ? fileMarks.get(file.relativePath) : undefined;
  const isPinned = !!mark?.pinned;
  const colorHex = mark?.color ? FILE_COLOR_HEX[mark.color] : undefined;
  const pinMove = isPinned
    ? getPinMoveState(file.relativePath)
    : { canUp: false, canDown: false };

  // Status markers shared between the row itself and the hover-actions overlay,
  // so they stay visible when the rename/delete controls cover the row's end.
  const markers = (
    <>
      {isPinned && (
        <PinIcon
          className="size-3 shrink-0 rotate-45 fill-current text-muted-foreground"
          aria-label="Pinned"
        />
      )}
      <FileCommentBadge filePath={file.relativePath} />
      {file.isDirty && (
        <span
          className="size-2 shrink-0 rounded-full bg-primary"
          title="Modified"
        />
      )}
    </>
  );

  return (
    <DraggableItem id={file.relativePath} type="file" name={node.name}>
      <div className="group relative">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              aria-pressed={isSelected}
              data-tree-path={file.relativePath}
              title={file.relativePath}
              className={cn(
                "relative flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm transition-colors",
                (file.id === activeFileId || isSelected) &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
                file.id === activeFileId &&
                  "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
                file.id !== activeFileId &&
                  !isSelected &&
                  "hover:bg-sidebar-accent/50",
              )}
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
              onClick={(event) =>
                onItemClick(fileItem, event, () => {
                  useHistoryStore.getState().stopReview();
                  onSelectFile(file.id);
                })
              }
              onContextMenu={() => onItemContextMenu(fileItem)}
            >
              <span className="size-4 shrink-0" aria-hidden="true" />
              <span
                className="flex shrink-0 items-center"
                style={colorHex ? { color: colorHex } : undefined}
              >
                {getFileIcon(file)}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                style={colorHex ? { color: colorHex } : undefined}
              >
                {node.name}
              </span>
              {markers}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {isTex && (
              <>
                <ContextMenuItem onClick={() => onTogglePin(file.relativePath)}>
                  {isPinned ? (
                    <PinOffIcon className="mr-2 size-4" />
                  ) : (
                    <PinIcon className="mr-2 size-4" />
                  )}
                  {isPinned ? "Unpin" : "Pin to top"}
                </ContextMenuItem>
                {isPinned && (pinMove.canUp || pinMove.canDown) && (
                  <>
                    <ContextMenuItem
                      disabled={!pinMove.canUp}
                      onClick={() => onMovePin(file.relativePath, "up")}
                    >
                      <ArrowUpIcon className="mr-2 size-4" />
                      Move pin up
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={!pinMove.canDown}
                      onClick={() => onMovePin(file.relativePath, "down")}
                    >
                      <ArrowDownIcon className="mr-2 size-4" />
                      Move pin down
                    </ContextMenuItem>
                  </>
                )}
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <PaletteIcon className="mr-2 size-4" />
                    Color
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {FILE_COLORS.map((color) => (
                      <ContextMenuItem
                        key={color}
                        onClick={() => onSetColor(file.relativePath, color)}
                      >
                        <span
                          className="mr-2 size-3 shrink-0 rounded-full"
                          style={{ backgroundColor: FILE_COLOR_HEX[color] }}
                        />
                        {FILE_COLOR_LABEL[color]}
                        {mark?.color === color && (
                          <CheckIcon className="ml-auto size-3.5" />
                        )}
                      </ContextMenuItem>
                    ))}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => onSetColor(file.relativePath, null)}
                      disabled={!mark?.color}
                    >
                      <BanIcon className="mr-2 size-4" />
                      No color
                    </ContextMenuItem>
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem
              onClick={() => onRename(file.id, file.name)}
              disabled={batchOperation}
            >
              <PencilIcon className="mr-2 size-4" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => onDeleteSelection(fileItem)}
              disabled={!canDeleteSelection(fileItem)}
            >
              <Trash2Icon className="mr-2 size-4" />
              {batchOperation
                ? `Delete ${effectiveSelectionCount} selected`
                : "Delete"}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <RowActions
          onRename={() => onRename(file.id, file.name)}
          onDelete={() => onDeleteSelection(fileItem)}
          renameDisabled={batchOperation}
          deleteDisabled={!canDeleteSelection(fileItem)}
          deleteLabel={
            batchOperation
              ? `Delete ${effectiveSelectionCount} selected`
              : "Delete"
          }
          leading={markers}
        />
      </div>
    </DraggableItem>
  );
}

// ─── File-tree comment count badge ───
//
// Small chip next to each file showing the open-comment count. Hidden when
// there are no open comments. Click intentionally not handled separately —
// the file row already handles selection.

function FileCommentBadge({ filePath }: { filePath: string }) {
  const count = useCommentsStore(
    (s) =>
      s.comments.filter((c) => c.file_path === filePath && c.status === "open")
        .length,
  );
  const hasClaude = useCommentsStore((s) =>
    s.comments.some(
      (c) =>
        c.file_path === filePath &&
        c.status === "open" &&
        c.author === "claude",
    ),
  );
  if (count === 0) return null;
  return (
    <span
      className={cn(
        "flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 font-bold text-[9px] text-white leading-none",
        hasClaude
          ? "bg-violet-600 dark:bg-violet-500"
          : "bg-amber-600 dark:bg-amber-500",
      )}
      title={`${count} open comment${count === 1 ? "" : "s"}`}
    >
      {count}
    </span>
  );
}

// ─── Environment Section (Python + Skills) ───

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

function EnvironmentSection({ projectPath }: { projectPath: string | null }) {
  // ── Python / uv ──
  const venvReady = useUvSetupStore((s) => s.venvReady);
  const uvStatus = useUvSetupStore((s) => s.status);
  const [showUvDialog, setShowUvDialog] = useState(false);

  // ── Scientific Skills ──
  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // ── DevPrism custom skills ──
  const [showDevprismSkills, setShowDevprismSkills] = useState(false);
  // ── Auto-discovered project context (master/instruction/data files) ──
  const [contextCount, setContextCount] = useState<number | null>(null);

  useEffect(() => {
    if (!projectPath) {
      setContextCount(null);
      return;
    }
    invoke<number>("count_project_context", { projectPath })
      .then(setContextCount)
      .catch(() => setContextCount(null));
  }, [projectPath]);

  const checkSkillsStatus = useCallback(async () => {
    try {
      const globalStatus = await invoke<SkillsStatus>(
        "check_skills_installed",
        {
          projectPath: null,
        },
      );
      setSkillsStatus(globalStatus);
    } catch {
      // Ignore errors silently
    }
  }, []);

  useEffect(() => {
    checkSkillsStatus();
  }, [checkSkillsStatus]);

  // Lazy import onboarding
  const [OnboardingComponent, setOnboardingComponent] =
    useState<React.ComponentType<{
      onClose: () => void;
    }> | null>(null);

  useEffect(() => {
    if (showOnboarding && !OnboardingComponent) {
      import(
        "@/components/scientific-skills/scientific-skills-onboarding"
      ).then((mod) =>
        setOnboardingComponent(() => mod.ScientificSkillsOnboarding),
      );
    }
  }, [showOnboarding, OnboardingComponent]);

  const pythonLabel = venvReady
    ? "Active"
    : uvStatus === "not-installed"
      ? "Not installed"
      : uvStatus === "ready"
        ? "No venv"
        : "";
  const skillsLabel = skillsStatus?.installed
    ? `${skillsStatus.skill_count} skills`
    : "Not installed";

  return (
    <>
      <div>
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-sidebar-border border-b px-3 text-muted-foreground text-xs uppercase tracking-wider">
          <AppWindowIcon className="size-3 shrink-0" />
          <span className="font-medium">Environment</span>
        </div>
        <div className="space-y-0.5 px-1 pb-1.5">
          {/* Python / uv row */}
          <button
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => setShowUvDialog(true)}
          >
            <TerminalIcon
              className={cn(
                "size-3.5 shrink-0",
                venvReady ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs">Python</span>
            <span
              className={cn(
                "shrink-0 text-xs",
                venvReady ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {pythonLabel}
            </span>
          </button>
          {/* Scientific Skills row */}
          <button
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => setShowOnboarding(true)}
          >
            <FlaskConicalIcon
              className={cn(
                "size-3.5 shrink-0",
                skillsStatus?.installed
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs">Skills</span>
            <span
              className={cn(
                "shrink-0 text-xs",
                skillsStatus?.installed
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {skillsLabel}
            </span>
          </button>
          {/* DevPrism custom skills row */}
          <button
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => setShowDevprismSkills(true)}
          >
            <WandSparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs">
              DevPrism skills
            </span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
          {/* Auto-discovered project context */}
          {contextCount !== null && (
            <div
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
              title="Master/instruction/data files the agent reads automatically at the start of each task (see docs/CONTEXT_FILES.md)"
            >
              <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">Context</span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {contextCount === 0
                  ? "none"
                  : `${contextCount} file${contextCount === 1 ? "" : "s"}`}
              </span>
            </div>
          )}
        </div>
      </div>

      <UvSetupDialog
        open={showUvDialog}
        onClose={() => setShowUvDialog(false)}
      />

      <DevPrismSkillsDialog
        open={showDevprismSkills}
        projectPath={projectPath}
        onClose={() => {
          setShowDevprismSkills(false);
          checkSkillsStatus();
        }}
      />

      {showOnboarding && OnboardingComponent && (
        <OnboardingComponent
          onClose={() => {
            setShowOnboarding(false);
            checkSkillsStatus();
          }}
        />
      )}
    </>
  );
}

// ─── DevPrism custom skills dialog ───
//
// Install the bundled offline skill packages into the current project, or create
// a brand-new custom skill on the go. Both call Tauri commands and require an
// open project (so the skills land in <project>/.claude/skills).

function DevPrismSkillsDialog({
  open,
  projectPath,
  onClose,
}: {
  open: boolean;
  projectPath: string | null;
  onClose: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  // ── "Add a Markdown file as a skill" form ──
  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const [addingMd, setAddingMd] = useState(false);
  const [mdFileId, setMdFileId] = useState<string>("");
  const [mdName, setMdName] = useState("");
  const [mdDescription, setMdDescription] = useState("");
  // Tracks the file whose name we last auto-filled, so the periodic file-list
  // refresh doesn't clobber a name the user typed.
  const mdNameSourceRef = useRef<string>("");

  // Project Markdown files the user can register as a skill (the editor's open
  // file, if it's an .md, sorts first so it's the default pick).
  const mdFiles = useMemo(() => {
    const md = files.filter((f) => f.name.toLowerCase().endsWith(".md"));
    return md.sort((a, b) => {
      if (a.id === activeFileId) return -1;
      if (b.id === activeFileId) return 1;
      return a.relativePath.localeCompare(b.relativePath);
    });
  }, [files, activeFileId]);

  // Mirror the backend's folder-name sanitization so the user sees the resulting
  // slug and we can block names that sanitize to nothing.
  const skillSlug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const mdSlug = mdName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Reset the form whenever the dialog closes so it doesn't reopen pre-filled.
  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setInstructions("");
      setMdDescription("");
    }
  }, [open]);

  // When the dialog opens (or the file list changes), default the Markdown
  // picker to the editor's open file, falling back to the first .md file.
  useEffect(() => {
    if (!open) return;
    setMdFileId((current) => {
      if (current && mdFiles.some((f) => f.id === current)) return current;
      return mdFiles[0]?.id ?? "";
    });
  }, [open, mdFiles]);

  // Derive the skill name from the picked file's base name (e.g. notes.md →
  // notes), but only when the selection changes — not on every list refresh —
  // so a user-edited name is preserved.
  useEffect(() => {
    if (mdFileId === mdNameSourceRef.current) return;
    const file = mdFiles.find((f) => f.id === mdFileId);
    if (file) {
      setMdName(file.name.replace(/\.md$/i, ""));
      mdNameSourceRef.current = mdFileId;
    }
  }, [mdFileId, mdFiles]);

  const handleInstallBundled = async () => {
    if (!projectPath) {
      toast.error("Open a project first.");
      return;
    }
    setInstalling(true);
    try {
      const installed = await invoke<unknown[]>("install_bundled_skills", {
        projectPath,
      });
      const count = Array.isArray(installed) ? installed.length : 0;
      toast.success(
        `Installed ${count} DevPrism skill${count === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      toast.error(`Failed to install skills: ${String(err)}`);
    } finally {
      setInstalling(false);
    }
  };

  const handleCreate = async () => {
    if (!projectPath) {
      toast.error("Open a project first.");
      return;
    }
    if (!skillSlug || !description.trim()) return;
    setCreating(true);
    try {
      await invoke("create_custom_skill", {
        projectPath,
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      });
      toast.success(`Created skill "${name.trim()}".`);
      setName("");
      setDescription("");
      setInstructions("");
    } catch (err) {
      toast.error(`Failed to create skill: ${String(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleAddFromMarkdown = async () => {
    if (!projectPath) {
      toast.error("Open a project first.");
      return;
    }
    const file = mdFiles.find((f) => f.id === mdFileId);
    if (!file || !mdSlug) return;
    setAddingMd(true);
    try {
      // Prefer the in-memory content (reflects unsaved edits); fall back to disk
      // for large files whose content wasn't auto-loaded.
      const content =
        file.content ?? (await readTexFileContent(file.absolutePath));
      await invoke("create_skill_from_markdown", {
        projectPath,
        name: mdName.trim(),
        description: mdDescription.trim(),
        content: content ?? "",
      });
      toast.success(`Added "${mdName.trim()}" as a skill.`);
      setMdDescription("");
    } catch (err) {
      toast.error(`Failed to add skill: ${String(err)}`);
    } finally {
      setAddingMd(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>DevPrism skills</DialogTitle>
          <DialogDescription>
            Install the bundled offline skills, or create your own custom skill
            for this project. Skills run locally — no internet required.
          </DialogDescription>
        </DialogHeader>

        {!projectPath && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-600 text-xs dark:text-amber-400">
            Open a project to manage its skills.
          </p>
        )}

        <Card className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <div className="font-medium text-sm">Bundled skills</div>
            <p className="text-muted-foreground text-xs">
              Resume, Manuscript, Statement, LaTeX Toolkit, Thesis, Beamer,
              Project Space. Re-installing overwrites same-named skills in this
              project.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0 gap-1.5"
            disabled={!projectPath || installing}
            onClick={() => void handleInstallBundled()}
          >
            {installing ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )}
            Install
          </Button>
        </Card>

        <Card className="space-y-2.5 p-3">
          <div className="flex items-center gap-1.5 font-medium text-sm">
            <SparklesIcon className="size-3.5" />
            Create a custom skill
          </div>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Skill name (e.g. Grant Proposal)"
            aria-label="Skill name"
          />
          {name.trim() &&
            (skillSlug ? (
              <p className="text-[11px] text-muted-foreground">
                Folder:{" "}
                <code className="rounded bg-muted px-1">{skillSlug}</code>
              </p>
            ) : (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Name must contain letters or numbers.
              </p>
            ))}
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="When should the agent use this skill?"
            aria-label="When the agent should use this skill"
            aria-required
          />
          <Textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Steps the agent should follow (optional)"
            aria-label="Skill instructions"
            rows={4}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={
                !projectPath || creating || !skillSlug || !description.trim()
              }
              onClick={() => void handleCreate()}
            >
              {creating ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
              Create skill
            </Button>
          </div>
        </Card>

        <Card className="space-y-2.5 p-3">
          <div className="flex items-center gap-1.5 font-medium text-sm">
            <FileTextIcon className="size-3.5" />
            Add a Markdown file as a skill
          </div>
          {mdFiles.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No <code className="rounded bg-muted px-1">.md</code> files in
              this project yet. Open or create one to register it as a skill.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground text-xs">
                Turn an existing Markdown file — including the one open in the
                editor — into a skill. Its contents become the skill body.
              </p>
              <Select value={mdFileId} onValueChange={setMdFileId}>
                <SelectTrigger className="w-full" aria-label="Markdown file">
                  <SelectValue placeholder="Select a Markdown file" />
                </SelectTrigger>
                <SelectContent>
                  {mdFiles.map((file) => (
                    <SelectItem key={file.id} value={file.id}>
                      {file.relativePath}
                      {file.id === activeFileId ? " (open in editor)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={mdName}
                onChange={(event) => setMdName(event.target.value)}
                placeholder="Skill name"
                aria-label="Skill name"
              />
              {mdName.trim() &&
                (mdSlug ? (
                  <p className="text-[11px] text-muted-foreground">
                    Folder:{" "}
                    <code className="rounded bg-muted px-1">{mdSlug}</code>
                  </p>
                ) : (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    Name must contain letters or numbers.
                  </p>
                ))}
              <Input
                value={mdDescription}
                onChange={(event) => setMdDescription(event.target.value)}
                placeholder="When should the agent use this skill? (optional)"
                aria-label="When the agent should use this skill"
              />
              <p className="text-[11px] text-muted-foreground">
                Leave blank to reuse the file's frontmatter description or first
                paragraph.
              </p>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={!projectPath || addingMd || !mdFileId || !mdSlug}
                  onClick={() => void handleAddFromMarkdown()}
                >
                  {addingMd ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  Add as skill
                </Button>
              </div>
            </>
          )}
        </Card>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Draggable wrapper ───

function DraggableItem({
  id,
  type,
  name,
  children,
}: {
  id: string;
  type: "file" | "folder";
  name: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { type, name },
  });

  // Wrap listeners to log pointer events
  const wrappedListeners = listeners
    ? Object.fromEntries(
        Object.entries(listeners).map(([key, handler]) => [
          key,
          (e: React.PointerEvent) => {
            (handler as (e: React.PointerEvent) => void)(e);
          },
        ]),
      )
    : {};

  return (
    <div
      ref={setNodeRef}
      {...wrappedListeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {children}
    </div>
  );
}
