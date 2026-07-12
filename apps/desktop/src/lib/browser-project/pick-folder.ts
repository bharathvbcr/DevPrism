import { browserRootPath } from "./constants";
import { persistFsaRoot } from "./fsa-persistence";
import { registerPickedFolder } from "./fsa-store";
import { importLooseFiles } from "./import";

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
};

export async function pickBrowserProjectFolder(): Promise<string | null> {
  const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker({ mode: "readwrite" });
      const id = registerPickedFolder(handle);
      await persistFsaRoot(id, handle, handle.name);
      return browserRootPath("fsa", id);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return null;
      }
      throw err;
    }
  }

  return pickFolderViaHiddenInput();
}

function pickFolderViaHiddenInput(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const files = input.files ? [...input.files] : [];
      input.remove();
      if (files.length === 0) {
        resolve(null);
        return;
      }
      void importLooseFiles(files)
        .then((project) => resolve(project.path))
        .catch(reject);
    });

    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });

    input.click();
  });
}
