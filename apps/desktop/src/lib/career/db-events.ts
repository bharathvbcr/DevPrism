import { listen } from "@tauri-apps/api/event";

/**
 * Emitted by the Rust-side career.db change watcher whenever *another*
 * connection (in-app MCP server, `--mcp-stdio` process) commits to
 * career.db. Mirrors `CAREER_DB_CHANGED_EVENT` in career_db/mod.rs.
 */
export const CAREER_DB_CHANGED_EVENT = "career-db-changed";

/**
 * Subscribe to external career.db commits. Returns an unsubscribe function;
 * safe to call before the underlying Tauri listener resolves.
 */
export function onCareerDbChanged(handler: () => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen(CAREER_DB_CHANGED_EVENT, () => handler()).then((fn) => {
    if (disposed) {
      fn();
    } else {
      unlisten = fn;
    }
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Trailing-edge debounce so a burst of commits (multi-chunk ingest, backfill)
 * produces a single refresh instead of one per commit.
 */
export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
