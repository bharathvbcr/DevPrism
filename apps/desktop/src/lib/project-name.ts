export function normalizeProjectName(name: string): string {
  return name.trim();
}

export function getProjectNameError(name: string): string | null {
  const trimmed = normalizeProjectName(name);
  if (!trimmed) return "Enter a project name";
  if (trimmed === "." || trimmed === "..") {
    return "Project name cannot be . or ..";
  }
  if (/[\x00-\x1f\\/<>:"|?*]/.test(trimmed) || /[\s.]$/.test(trimmed)) {
    return "Project name contains characters Windows cannot use";
  }
  return null;
}
