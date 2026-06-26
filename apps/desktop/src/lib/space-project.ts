import { readTextFile, writeTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@/lib/tauri/fs";
import { useSpacesStore, type Space } from "@/stores/spaces-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  inferSpaceKind,
  bundledSkillsForKind,
  type SpaceKind,
} from "@/lib/space-features";
import { masterFileNameForKind, masterStubForKind } from "@/lib/space-master";
import {
  applyCompileProfile,
  defaultCompileProfileForKind,
} from "@/lib/compile-profiles";
import { installBundledSkills, listInstalledSkills } from "@/lib/tauri/skills";

export interface NewProjectSpaceSetupOptions {
  /** Apply the space's default document-class preset to this .tex file. */
  mainTexPath?: string;
  /** Install bundled skills for the active space kind (default: true). */
  installSkills?: boolean;
  /** Write a starter MASTER.md / RESUME.md if missing (default: true). */
  scaffoldMaster?: boolean;
}

export interface NewProjectSpaceSetupResult {
  spaceName: string | null;
  skillsInstalled: number;
  masterFile: string | null;
}

/** Space currently filtered in the project picker, if any. */
export function activeSpaceForSetup(): Space | null {
  const { activeSpaceId, spaces } = useSpacesStore.getState();
  if (!activeSpaceId) return null;
  return spaces.find((s) => s.id === activeSpaceId) ?? null;
}

export function kindForActiveSpace(): SpaceKind {
  const space = activeSpaceForSetup();
  return space ? inferSpaceKind(space) : "general";
}

/**
 * Assign a newly created project to the space currently selected in the picker
 * (activeSpaceId). Skips if no space is filtered or the project already belongs
 * to a space. Returns the space name when assigned.
 */
export function assignNewProjectToActiveSpace(
  projectPath: string,
): string | null {
  const { activeSpaceId, spaces, projectSpace, assignProject } =
    useSpacesStore.getState();
  if (!activeSpaceId) return null;
  if (projectSpace[projectPath]) return null;

  assignProject(projectPath, activeSpaceId);
  return spaces.find((s) => s.id === activeSpaceId)?.name ?? null;
}

/** Apply a space's default model to the active provider credential. */
export function applySpaceModelForProject(path: string): void {
  const space = useSpacesStore.getState().spaceForProject(path);
  const model = space?.defaultModel?.trim();
  if (!model) return;
  const chat = useClaudeChatStore.getState();
  if (chat.selectedProviderCredentialId) {
    chat.setSelectedProviderModel(chat.selectedProviderCredentialId, model);
  }
}

async function installMissingSkillsForKind(
  projectPath: string,
  kind: SpaceKind,
): Promise<number> {
  const only = bundledSkillsForKind(kind);
  if (!only || only.length === 0) return 0;

  let installedFolders = new Set<string>();
  try {
    const existing = await listInstalledSkills(projectPath);
    installedFolders = new Set(existing.map((s) => s.folder.toLowerCase()));
  } catch {
    // Project may not have a skills dir yet — install all for this kind.
  }

  const missing = only.filter((id) => !installedFolders.has(id.toLowerCase()));
  if (missing.length === 0) return 0;

  const installed = await installBundledSkills(projectPath, missing);
  return installed.length;
}

async function scaffoldMasterFile(
  projectPath: string,
  kind: SpaceKind,
): Promise<string | null> {
  if (kind === "general") return null;
  const fileName = masterFileNameForKind(kind);
  const filePath = await join(projectPath, fileName);
  if (await exists(filePath)) return null;
  await writeTextFile(filePath, masterStubForKind(kind));
  return fileName;
}

async function applyDefaultCompileProfile(
  mainTexPath: string,
  kind: SpaceKind,
): Promise<void> {
  if (kind === "general") return;
  if (!(await exists(mainTexPath))) return;
  const tex = await readTextFile(mainTexPath);
  const profileId = defaultCompileProfileForKind(kind);
  const next = applyCompileProfile(tex, profileId);
  if (next !== tex) {
    await writeTextFile(mainTexPath, next);
  }
}

/**
 * After creating a project folder: assign to the active space, install skills,
 * scaffold a master profile file, and optionally apply a compile preset.
 */
export async function setupNewProjectInSpace(
  projectPath: string,
  options: NewProjectSpaceSetupOptions = {},
): Promise<NewProjectSpaceSetupResult> {
  const { mainTexPath, installSkills = true, scaffoldMaster = true } = options;

  const spaceName = assignNewProjectToActiveSpace(projectPath);
  const space =
    useSpacesStore.getState().spaceForProject(projectPath) ??
    activeSpaceForSetup();
  const kind = space ? inferSpaceKind(space) : kindForActiveSpace();

  let skillsInstalled = 0;
  if (installSkills && kind !== "general") {
    try {
      skillsInstalled = await installMissingSkillsForKind(projectPath, kind);
    } catch (err) {
      console.warn("Failed to install space skills:", err);
    }
  }

  let masterFile: string | null = null;
  if (scaffoldMaster) {
    try {
      masterFile = await scaffoldMasterFile(projectPath, kind);
    } catch (err) {
      console.warn("Failed to scaffold master file:", err);
    }
  }

  if (mainTexPath) {
    try {
      await applyDefaultCompileProfile(mainTexPath, kind);
    } catch (err) {
      console.warn("Failed to apply compile profile:", err);
    }
  }

  applySpaceModelForProject(projectPath);

  return { spaceName, skillsInstalled, masterFile };
}

/** User-facing summary for toasts after project creation. */
export function formatNewProjectSetupToast(
  result: NewProjectSpaceSetupResult,
  projectLabel: string,
): string {
  const parts: string[] = [];
  if (result.spaceName) {
    parts.push(`added to ${result.spaceName}`);
  }
  if (result.skillsInstalled > 0) {
    parts.push(
      `installed ${result.skillsInstalled} skill${result.skillsInstalled === 1 ? "" : "s"}`,
    );
  }
  if (result.masterFile) {
    parts.push(`created ${result.masterFile}`);
  }
  if (parts.length === 0) return projectLabel;
  return `${projectLabel} — ${parts.join(" · ")}`;
}
