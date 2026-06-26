import { invoke } from "@tauri-apps/api/core";

export interface SkillInfo {
  id: string;
  name: string;
  domain: string;
  description: string;
  folder: string;
}

/** Install bundled DevPrism skills. Pass `only` to install a subset by folder name. */
export function installBundledSkills(
  projectPath: string,
  only?: string[] | null,
): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("install_bundled_skills", {
    projectPath,
    only: only && only.length > 0 ? only : null,
  });
}

export function listInstalledSkills(projectPath: string): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("list_installed_skills", { projectPath });
}
