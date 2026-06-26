import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  useAnnotationStore,
  type PdfHighlight,
} from "@/stores/annotation-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("highlight-persistence");

/** Per-project metadata dir, shared with comments (`.claudeprism/`). */
const META_DIR = ".claudeprism";
const FILE_NAME = "highlights.json";
const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 400;

interface HighlightsFile {
  version: number;
  highlightsByRoot: Record<string, PdfHighlight[]>;
}

let currentProjectRoot: string | null = null;
let unsubscribe: (() => void) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Suppress saves while we're loading state into the store. */
let loading = false;

async function metaDir(projectRoot: string): Promise<string> {
  return join(projectRoot, META_DIR);
}

async function filePath(projectRoot: string): Promise<string> {
  return join(projectRoot, META_DIR, FILE_NAME);
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, SAVE_DEBOUNCE_MS);
}

async function saveNow(): Promise<void> {
  const projectRoot = currentProjectRoot;
  if (!projectRoot) return;
  const map = useAnnotationStore.getState().highlightsByRoot;
  const isEmpty = Object.values(map).every((arr) => arr.length === 0);
  try {
    const path = await filePath(projectRoot);
    // Don't create a file for a project that has never had a highlight.
    if (isEmpty && !(await exists(path))) return;
    const dir = await metaDir(projectRoot);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    const data: HighlightsFile = {
      version: SCHEMA_VERSION,
      highlightsByRoot: map,
    };
    await writeTextFile(path, JSON.stringify(data, null, 2));
  } catch (e) {
    log.error("Failed to save highlights", { error: String(e) });
  }
}

/** Load a project's highlights into the store and start persisting changes.
 *  Flushes/detaches any previously attached project first. */
export async function attachHighlights(projectRoot: string): Promise<void> {
  detachHighlights();
  currentProjectRoot = projectRoot;
  loading = true;
  try {
    const path = await filePath(projectRoot);
    if (await exists(path)) {
      const raw = await readTextFile(path);
      const parsed = JSON.parse(raw) as Partial<HighlightsFile>;
      useAnnotationStore.setState({
        highlightsByRoot: parsed.highlightsByRoot ?? {},
      });
    } else {
      useAnnotationStore.setState({ highlightsByRoot: {} });
    }
  } catch (e) {
    log.error("Failed to load highlights", { error: String(e) });
    useAnnotationStore.setState({ highlightsByRoot: {} });
  } finally {
    loading = false;
  }

  unsubscribe = useAnnotationStore.subscribe((state, prev) => {
    if (loading) return;
    if (state.highlightsByRoot === prev.highlightsByRoot) return;
    scheduleSave();
  });
}

/** Flush pending changes and stop persisting (e.g. on project close/switch). */
export function detachHighlights(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // Flush the latest state synchronously-launched (captures the root before reset).
  void saveNow();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  currentProjectRoot = null;
}
