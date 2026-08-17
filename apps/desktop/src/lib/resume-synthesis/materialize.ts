import { mkdir } from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createFileOnDisk,
  deleteFolderFromDisk,
  exists,
  join,
  readTexFileContent,
  scanProjectFolder,
  writeTexFileContent,
} from "@/lib/tauri/fs";
import {
  createVariant,
  deleteVariant,
  type VariantInfo,
} from "@/lib/tauri/variants";
import { normalizeProjectName, getProjectNameError } from "@/lib/project-name";
import {
  getResumeTemplate,
  templateEngine,
  type ResumeEngine,
} from "@/lib/resume-templates";
import { suggestVersionName } from "@/lib/variant-status";
import { useCareerStore } from "@/stores/career-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { useSpacesStore } from "@/stores/spaces-store";
import { deriveOwner, useVariantsStore } from "@/stores/variants-store";
import type { SynthesisResult } from "./types";

/** Folder-safe slug from a version / JD title (e.g. "Acme — ML Eng" → "acme-ml-eng"). */
export function slugFromVersionName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "tailored-resume";
}

/** Slug from JD text — first non-empty line, folder-safe. */
export function slugFromJd(jdText: string): string {
  const firstLine =
    jdText
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  if (!firstLine) return "resume";
  const slug = firstLine
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "resume";
}

/** Human label for a resume template id. */
export function templateDisplayName(templateId: string): string {
  if (templateId === "ats-single-column") return "ATS single column";
  return templateId
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Suggest a version name from JD text (reuses shared heuristic). */
export function versionNameFromJd(jdText: string, roleTitle?: string): string {
  const fromJd = suggestVersionName(jdText);
  if (fromJd) return fromJd;
  const role = roleTitle?.trim();
  if (role) return role.slice(0, 70);
  return "Tailored resume";
}

export interface ResumeMasterOption {
  path: string;
  name: string;
  /** True when this is the currently open workspace project. */
  isOpen: boolean;
}

/** Candidate master resume projects: open project + recent projects in resume spaces. */
export function listResumeMasterOptions(): ResumeMasterOption[] {
  const openRoot = useDocumentStore.getState().projectRoot;
  const recent = useProjectStore.getState().recentProjects;
  const spaces = useSpacesStore.getState();
  const seen = new Set<string>();
  const out: ResumeMasterOption[] = [];

  const push = (path: string, name: string, isOpen: boolean) => {
    const { owner } = deriveOwner(path);
    const key = owner.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: owner, name, isOpen });
  };

  if (openRoot) {
    const { owner } = deriveOwner(openRoot);
    const name =
      recent.find(
        (p) =>
          p.path.replace(/[\\/]+$/, "").toLowerCase() === owner.toLowerCase(),
      )?.name ??
      owner.split(/[/\\]/).pop() ??
      "Current project";
    push(owner, name, true);
  }

  for (const p of recent) {
    const space = spaces.spaceForProject(p.path);
    // Prefer resume-space projects; also allow unassigned recent projects so
    // first-time users can pick a master without creating a space first.
    if (space && space.kind !== "resume") continue;
    push(p.path, p.name, false);
  }

  return out;
}

async function findMainSource(
  projectPath: string,
  engine: ResumeEngine,
): Promise<{
  relativePath: string;
  absolutePath: string;
  content: string;
} | null> {
  const { files } = await scanProjectFolder(projectPath);
  // Only consider sources the target engine can actually compile — a Typst
  // run must never overwrite a LaTeX master, or vice versa.
  const wantType = engine === "typst" ? "typst" : "tex";
  const ext = engine === "typst" ? ".typ" : ".tex";
  const texFiles = files.filter((f) => f.type === wantType);
  if (texFiles.length === 0) return null;

  const preferred =
    texFiles.find(
      (f) =>
        f.relativePath === `main${ext}` ||
        f.relativePath === `document${ext}` ||
        f.relativePath === `resume${ext}` ||
        f.relativePath.endsWith(`/main${ext}`) ||
        f.relativePath.endsWith(`/resume${ext}`),
    ) ?? texFiles[0];

  let content = "";
  try {
    content = await readTexFileContent(preferred.absolutePath);
  } catch {
    content = "";
  }
  return {
    relativePath: preferred.relativePath,
    absolutePath: preferred.absolutePath,
    content,
  };
}

function assignProjectToResumeSpace(projectPath: string, masterPath?: string) {
  const spaces = useSpacesStore.getState();
  if (masterPath) {
    const masterSpace = spaces.spaceForProject(masterPath);
    if (masterSpace) {
      spaces.assignProject(projectPath, masterSpace.id);
      return;
    }
  }
  const resumeSpace = spaces.spaces.find((s) => s.kind === "resume");
  if (resumeSpace) {
    spaces.assignProject(projectPath, resumeSpace.id);
  }
}

function unassignProject(projectPath: string) {
  try {
    useSpacesStore.getState().assignProject(projectPath, null);
  } catch {
    // best-effort
  }
}

/**
 * Best-effort rollback after a mid-flight materialize failure:
 * delete created variant or folder and unassign from spaces.
 */
async function rollbackMaterialize(state: {
  masterPath: string | null;
  variant: VariantInfo | null;
  projectPath: string | null;
  createdNewFolder: boolean;
}): Promise<void> {
  const { masterPath, variant, projectPath, createdNewFolder } = state;
  try {
    if (variant && masterPath) {
      await deleteVariant(masterPath, variant.id);
    } else if (createdNewFolder && projectPath) {
      await deleteFolderFromDisk(projectPath);
    }
  } catch {
    // best-effort
  }
  if (projectPath) unassignProject(projectPath);
}

export interface MaterializeOptions {
  result: SynthesisResult;
  jdText: string;
  versionName: string;
  /** Absolute path to master resume project, or null to create a new project. */
  masterProjectPath: string | null;
  /** Parent folder when creating a new project (optional — prompts if missing). */
  parentFolder?: string | null;
}

export interface MaterializeResult {
  projectPath: string;
  texRelativePath: string;
  variant: VariantInfo | null;
  usedProposedChange: boolean;
}

/**
 * Write synthesis output into a variant (preferred) or a new resume project,
 * open it in the workspace, and register a proposed-change merge review when
 * there is a prior baseline.
 *
 * On mid-flight failure after creating a variant/folder, best-effort rolls back
 * (delete variant/folder, unassign space) before rethrowing.
 */
export async function materializeSynthesis(
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const versionName =
    options.versionName.trim() || versionNameFromJd(options.jdText);
  const tex = options.result.tex;
  // An unknown template id means a run persisted before this template existed;
  // those were all LaTeX, so that is the safe default.
  const template = getResumeTemplate(options.result.templateId);
  const engine: ResumeEngine = template ? templateEngine(template) : "latex";
  const mainFileName = engine === "typst" ? "resume.typ" : "resume.tex";

  let projectPath: string | null = null;
  let variant: VariantInfo | null = null;
  let oldContent = "";
  let texRelativePath = mainFileName;
  let texAbsolutePath: string | null = null;
  let createdNewFolder = false;
  const masterPath = options.masterProjectPath;

  try {
    if (masterPath) {
      if (!(await exists(masterPath))) {
        throw new Error("Master resume project folder no longer exists.");
      }
      variant = await createVariant(
        masterPath,
        versionName,
        options.jdText,
        "draft",
      );
      projectPath = variant.path;
      assignProjectToResumeSpace(projectPath, masterPath);

      const existing = await findMainSource(projectPath, engine);
      if (existing) {
        texRelativePath = existing.relativePath;
        texAbsolutePath = existing.absolutePath;
        oldContent = existing.content;
      } else {
        texAbsolutePath = await createFileOnDisk(projectPath, mainFileName, "");
        texRelativePath = mainFileName;
        oldContent = "";
      }
      await writeTexFileContent(texAbsolutePath, tex);
    } else {
      let parent = options.parentFolder?.trim() || null;
      if (!parent) {
        parent = useProjectStore.getState().lastProjectFolder;
      }
      if (!parent) {
        const selected = await openDialog({
          directory: true,
          multiple: false,
          title: "Choose folder for new resume project",
        });
        parent = typeof selected === "string" ? selected : null;
      }
      if (!parent) {
        throw new Error("Choose a folder for the new resume project.");
      }

      const folderName =
        normalizeProjectName(slugFromVersionName(versionName)) ||
        "tailored-resume";
      const nameError = getProjectNameError(folderName);
      if (nameError) throw new Error(nameError);

      projectPath = await join(parent, folderName);
      if (await exists(projectPath)) {
        // Disambiguate with a short suffix.
        projectPath = await join(
          parent,
          `${folderName}-${Date.now().toString(36)}`,
        );
      }
      await mkdir(projectPath, { recursive: true });
      createdNewFolder = true;
      texAbsolutePath = await createFileOnDisk(projectPath, mainFileName, tex);
      texRelativePath = mainFileName;
      oldContent = "";
      assignProjectToResumeSpace(projectPath);
      useProjectStore.getState().setLastProjectFolder(parent);
    }

    useProjectStore.getState().addRecentProject(projectPath, versionName);
    useCareerStore.getState().closeCareer();
    await useDocumentStore.getState().openProject(projectPath);
    await useVariantsStore.getState().sync(projectPath);

    let usedProposedChange = false;
    // Merge review is most useful when we overwrote a master snapshot in a variant.
    if (variant && oldContent !== tex && texAbsolutePath) {
      useProposedChangesStore.getState().addChange({
        id: `synthesis-${options.result.runId ?? "unsaved"}`,
        filePath: texRelativePath,
        absolutePath: texAbsolutePath,
        oldContent:
          oldContent.length > 0 ? oldContent : "% (empty master snapshot)\n",
        newContent: tex,
        toolName: "Write",
      });
      usedProposedChange = true;
    }

    return {
      projectPath,
      texRelativePath,
      variant,
      usedProposedChange,
    };
  } catch (err) {
    await rollbackMaterialize({
      masterPath,
      variant,
      projectPath,
      createdNewFolder,
    });
    throw err;
  }
}
