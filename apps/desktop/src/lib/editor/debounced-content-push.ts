export interface DebouncedContentPush {
  /** Queue the latest content for `fileId`; coalesces rapid calls. */
  schedule: (fileId: string, content: string) => void;
  /** Commit all queued content immediately. */
  flush: () => void;
  /** Drop all queued content without committing. */
  cancel: () => void;
  /** True when `fileId` has queued-but-uncommitted content. */
  hasPending: (fileId: string) => boolean;
}

/**
 * Coalesces editor keystrokes into periodic store commits.
 *
 * The editor is CodeMirror's source of truth while typing; committing every
 * keystroke re-renders every component subscribed to the document store and
 * rebuilds derived structures (sidebar tree, outline, starter prompts).
 * This pushes a trailing snapshot once per interval, with explicit flush
 * points for save/compile/file-switch so nothing is lost.
 *
 * Pending state is keyed per file: overlapping edits to different files
 * (rapid tab switches inside one interval, split editors) must never let a
 * later schedule overwrite an earlier file's un-flushed keystrokes.
 */
export function createDebouncedContentPush(
  intervalMs: number,
  commit: (fileId: string, content: string) => void,
): DebouncedContentPush {
  /** fileId → latest queued content (insertion order = recency). */
  let pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (pending.size === 0) return;
    const queued = [...pending.entries()];
    pending = new Map();
    for (const [fileId, content] of queued) {
      commit(fileId, content);
    }
  };

  const schedule = (fileId: string, content: string) => {
    pending.set(fileId, content);
    if (timer === null) {
      timer = setTimeout(flush, intervalMs);
    }
  };

  const cancel = () => {
    clearTimer();
    pending = new Map();
  };

  return {
    schedule,
    flush,
    cancel,
    hasPending: (fileId) => pending.has(fileId),
  };
}
