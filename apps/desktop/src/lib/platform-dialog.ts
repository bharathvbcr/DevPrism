import { isTauri } from "@/lib/runtime/is-tauri";
import { pickBrowserProjectFolder } from "@/lib/browser-project/pick-folder";
import { stageBrowserFile } from "@/lib/browser-project/attachment-staging";

export async function pickProjectFolder(options: {
  title: string;
}): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: options.title,
    });
    return typeof selected === "string" && selected ? selected : null;
  }
  return pickBrowserProjectFolder();
}

export async function pickProjectFiles(options: {
  title: string;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string[] | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: options.multiple ?? false,
      title: options.title,
      filters: options.filters,
    });
    if (!selected) return null;
    return Array.isArray(selected) ? selected : [selected];
  }
  return pickBrowserProjectFiles(options);
}

function pickBrowserProjectFiles(options: {
  title: string;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string[] | null> {
  const accept = buildAcceptAttribute(options.filters);
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? false;
    if (accept) input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const files = input.files ? [...input.files] : [];
      input.remove();
      if (files.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(files.map((file) => stageBrowserFile(file)));
      } catch (err) {
        reject(err);
      }
    });

    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });

    void options.title;
    input.click();
  });
}

function buildAcceptAttribute(
  filters?: Array<{ name: string; extensions: string[] }>,
): string | undefined {
  if (!filters?.length) return undefined;
  const extensions = filters.flatMap((f) => f.extensions);
  if (extensions.length === 0) return undefined;
  return extensions.map((ext) => `.${ext.replace(/^\./, "")}`).join(",");
}

export async function saveProjectFile(options: {
  title: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selected = await save({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    return typeof selected === "string" ? selected : null;
  }
  return pickBrowserSaveTarget(options);
}

/** Browser has no native save dialog — pick a file target via input. */
function pickBrowserSaveTarget(options: {
  title: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | null> {
  void options.title;
  void options.defaultPath;
  return pickBrowserProjectFiles({
    title: options.title,
    multiple: false,
    filters: options.filters,
  }).then((paths) => paths?.[0] ?? null);
}
