import { invoke } from "@tauri-apps/api/core";
import { usePersonalizationStore } from "@/stores/personalization-store";
import type { UserProfile } from "@/stores/personalization-store";

export type PersonalizationEvent =
  | "chat_sent"
  | "suggestion_clicked"
  | "follow_up_clicked"
  | "predictive_accepted"
  | "space_active"
  | "feature_used"
  | "document_class_compiled";

export interface BehavioralProfile {
  version: number;
  enabled: boolean;
  updatedAtMs: number;
  interactionCount: number;
  identity: UserProfile;
  prefersConcise: number;
  prefersDetailed: number;
  prefersFormal: number;
  prefersCasual: number;
  shortPrompts: number;
  longPrompts: number;
  spaceKinds: Record<string, number>;
  featureCounts: Record<string, number>;
  recentTopics: string[];
  favoriteDocumentClasses: Record<string, number>;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Fire-and-forget behavioral signal for the on-device adaptation layer. */
export function recordPersonalizationEvent(
  event: PersonalizationEvent,
  payload?: Record<string, string | number | boolean | null | undefined>,
): void {
  try {
    if (!usePersonalizationStore.getState().personalizationEnabled) return;
    const p = invoke("record_personalization_event", {
      event,
      payload: payload ?? null,
    });
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // Passive background learning — never surface to the user.
      });
    }
  } catch {
    // Passive background learning — never surface to the user.
  }
}

/** Debounced sync of the identity profile to the Rust prompt builder. */
export function scheduleIdentityProfileSync(profile: UserProfile): void {
  if (!usePersonalizationStore.getState().personalizationEnabled) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void invoke("sync_identity_profile", {
      identity: {
        name: profile.name,
        role: profile.role,
        affiliation: profile.affiliation,
        writingStyle: profile.writingStyle,
        researchInterests: profile.researchInterests,
        customInstructions: profile.customInstructions,
      },
    }).catch(() => {});
  }, 400);
}

export async function syncPersonalizationEnabled(
  enabled: boolean,
): Promise<void> {
  await invoke("set_personalization_enabled", { enabled });
  if (enabled) {
    scheduleIdentityProfileSync(usePersonalizationStore.getState().profile);
  }
}

export async function getBehavioralProfile(): Promise<BehavioralProfile> {
  return invoke<BehavioralProfile>("get_personalization_profile");
}

export async function clearBehavioralPersonalization(): Promise<void> {
  await invoke("clear_personalization_profile");
}

/** Compact hint for AI assist suggestion prompts (identity only). */
export function personalizationAssistHint(): string {
  const { profile, personalizationEnabled } =
    usePersonalizationStore.getState();
  if (!personalizationEnabled) return "";

  const parts: string[] = [];
  if (profile.writingStyle.trim()) {
    parts.push(`User writing style: ${profile.writingStyle.trim()}`);
  }
  if (profile.researchInterests.length > 0) {
    parts.push(
      `User research interests: ${profile.researchInterests.slice(0, 6).join(", ")}`,
    );
  }
  if (profile.role.trim()) {
    parts.push(`User role: ${profile.role.trim()}`);
  }
  return parts.length > 0 ? `${parts.join("\n")}\n\n` : "";
}

export function describeLearnedStyle(profile: BehavioralProfile): string[] {
  const bits: string[] = [];
  if (profile.prefersConcise > profile.prefersDetailed + 1) {
    bits.push("Prefers concise answers");
  } else if (profile.prefersDetailed > profile.prefersConcise + 1) {
    bits.push("Prefers detailed explanations");
  }
  if (profile.prefersFormal > profile.prefersCasual + 1) {
    bits.push("Formal tone");
  } else if (profile.prefersCasual > profile.prefersFormal + 1) {
    bits.push("Casual tone");
  }
  if (profile.shortPrompts > profile.longPrompts + 2) {
    bits.push("Usually asks briefly");
  } else if (profile.longPrompts > profile.shortPrompts + 2) {
    bits.push("Often wants thorough help");
  }
  return bits;
}
