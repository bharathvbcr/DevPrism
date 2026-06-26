import type { SnapshotInfo } from "@/stores/history-store";
import type { TrackChangesMeta } from "@/lib/latex-track-changes";

function stripSnapshotPrefix(message: string): string {
  return message.replace(/^\[.*?\]\s*/, "").trim();
}

/**
 * Collapse the snapshot list the way the history panel displays it: when a
 * [restore] snapshot appears, skip everything between it and the snapshot it
 * restored to. The diff for a reviewed snapshot is computed against its parent
 * in THIS list, so callers must derive the "from" parent from here too (not the
 * raw snapshot array) or the comparison label won't match the diffed parent.
 */
export function linearizeSnapshots(snapshots: SnapshotInfo[]): SnapshotInfo[] {
  const result: SnapshotInfo[] = [];
  let skipUntilSha: string | null = null;
  for (const snap of snapshots) {
    if (skipUntilSha) {
      if (snap.id.startsWith(skipUntilSha)) {
        skipUntilSha = null;
        result.push(snap);
      }
      continue;
    }
    result.push(snap);
    if (snap.message.startsWith("[restore]")) {
      const match = snap.message.match(/Restored to ([a-f0-9]+)/);
      if (match) skipUntilSha = match[1];
    }
  }
  return result;
}

/** The parent a reviewed snapshot is diffed against in the linear list. */
export function linearParentOf(
  snapshots: SnapshotInfo[],
  snapshotId: string,
): SnapshotInfo | undefined {
  const linear = linearizeSnapshots(snapshots);
  const idx = linear.findIndex((s) => s.id === snapshotId);
  return idx >= 0 ? linear[idx + 1] : undefined;
}

/** Build human-readable labels for a snapshot comparison. */
export function buildTrackChangesMeta(
  from: SnapshotInfo | null | undefined,
  to: SnapshotInfo,
): TrackChangesMeta {
  return {
    fromLabel:
      from?.labels[0] ??
      (from
        ? stripSnapshotPrefix(from.message) || from.id.slice(0, 7)
        : "Previous"),
    toLabel:
      to.labels[0] ?? (stripSnapshotPrefix(to.message) || to.id.slice(0, 7)),
  };
}
