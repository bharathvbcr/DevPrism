import { invoke } from "@tauri-apps/api/core";

/**
 * Tailored document versions ("variants"). One master document (e.g. a resume)
 * gets a set of tailored copies — one per target (e.g. per job description) —
 * each living under `<project>/.prism/variants/<slug>/`. See `variants.rs` for
 * the on-disk model.
 */

/** Pipeline state for a tailored version. Free-form on the Rust side; this is
 * the set the UI offers. */
export type VariantStatus =
  | "draft"
  | "applied"
  | "interview"
  | "offer"
  | "rejected"
  | "archived";

export interface VariantInfo {
  /** Slug — also the variant's folder name. Stable for the variant's life. */
  id: string;
  name: string;
  status: string;
  /** The target text this version was tailored for (e.g. the job description). */
  jd: string;
  /** Creation time, epoch milliseconds. */
  createdAt: number;
  /** Absolute path to the variant's project folder (open it like any project). */
  path: string;
}

/** List all versions for the project that owns `projectRoot` (owner is derived,
 * so passing a variant path works too). */
export function listVariants(projectRoot: string): Promise<VariantInfo[]> {
  return invoke<VariantInfo[]>("list_variants", { projectRoot });
}

/** Snapshot the master into a new tailored version and return it. */
export function createVariant(
  projectRoot: string,
  name: string,
  jd: string,
  status: string,
): Promise<VariantInfo> {
  return invoke<VariantInfo>("create_variant", {
    projectRoot,
    name,
    jd,
    status,
  });
}

/** Patch a version's metadata. Omitted fields are left unchanged. */
export function updateVariant(
  projectRoot: string,
  variantId: string,
  patch: { name?: string; status?: string; jd?: string },
): Promise<VariantInfo> {
  return invoke<VariantInfo>("update_variant", {
    projectRoot,
    variantId,
    name: patch.name ?? null,
    status: patch.status ?? null,
    jd: patch.jd ?? null,
  });
}

/** Permanently delete a version and its folder. */
export function deleteVariant(
  projectRoot: string,
  variantId: string,
): Promise<void> {
  return invoke<void>("delete_variant", { projectRoot, variantId });
}

/** One changed text file when comparing a version against its master
 * (`oldContent` = master, `newContent` = variant). */
export interface VariantFileDiff {
  filePath: string;
  status: "added" | "modified" | "deleted";
  oldContent: string | null;
  newContent: string | null;
}

/** Compare a version against its master, one entry per changed text file. */
export function diffVariant(
  projectRoot: string,
  variantId: string,
): Promise<VariantFileDiff[]> {
  return invoke<VariantFileDiff[]>("diff_variant", { projectRoot, variantId });
}
