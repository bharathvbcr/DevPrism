import { create } from "zustand";

export type WorkspaceBannerKind = "error" | "warning" | "info";

export interface WorkspaceBanner {
  id: string;
  kind: WorkspaceBannerKind;
  title: string;
  message: string;
  /** When set, the banner reappears if the same key is posted again after dismiss. */
  dedupeKey?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

interface WorkspaceBannerState {
  banners: WorkspaceBanner[];
  dismissedKeys: Set<string>;
  show: (banner: Omit<WorkspaceBanner, "id"> & { id?: string }) => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

let nextBannerId = 0;

export const useWorkspaceBannerStore = create<WorkspaceBannerState>(
  (set, get) => ({
    banners: [],
    dismissedKeys: new Set(),
    show: (banner) => {
      const dedupeKey = banner.dedupeKey;
      if (dedupeKey && get().dismissedKeys.has(dedupeKey)) return;

      const id = banner.id ?? `banner-${++nextBannerId}`;
      set((s) => {
        const withoutDupes = dedupeKey
          ? s.banners.filter((b) => b.dedupeKey !== dedupeKey)
          : s.banners;
        return {
          banners: [
            ...withoutDupes,
            {
              id,
              kind: banner.kind,
              title: banner.title,
              message: banner.message,
              dedupeKey,
              actionLabel: banner.actionLabel,
              onAction: banner.onAction,
              secondaryActionLabel: banner.secondaryActionLabel,
              onSecondaryAction: banner.onSecondaryAction,
            },
          ],
        };
      });
    },
    dismiss: (id) => {
      set((s) => {
        const target = s.banners.find((b) => b.id === id);
        const dismissedKeys = new Set(s.dismissedKeys);
        if (target?.dedupeKey) dismissedKeys.add(target.dedupeKey);
        return {
          banners: s.banners.filter((b) => b.id !== id),
          dismissedKeys,
        };
      });
    },
    clearAll: () => set({ banners: [], dismissedKeys: new Set() }),
  }),
);

export function showWorkspaceInfo(
  title: string,
  message: string,
  options?: {
    dedupeKey?: string;
    actionLabel?: string;
    onAction?: () => void;
  },
) {
  showWorkspaceBanner({
    kind: "info",
    title,
    message,
    dedupeKey: options?.dedupeKey,
    actionLabel: options?.actionLabel,
    onAction: options?.onAction,
  });
}

export function showWorkspaceWarning(
  title: string,
  message: string,
  options?: {
    dedupeKey?: string;
    actionLabel?: string;
    onAction?: () => void;
    secondaryActionLabel?: string;
    onSecondaryAction?: () => void;
  },
) {
  showWorkspaceBanner({
    kind: "warning",
    title,
    message,
    dedupeKey: options?.dedupeKey,
    actionLabel: options?.actionLabel,
    onAction: options?.onAction,
    secondaryActionLabel: options?.secondaryActionLabel,
    onSecondaryAction: options?.onSecondaryAction,
  });
}

/** Post a persistent workspace banner (survives until dismissed). */
export function showWorkspaceBanner(
  banner: Omit<WorkspaceBanner, "id"> & { id?: string },
) {
  useWorkspaceBannerStore.getState().show(banner);
}

export function showWorkspaceError(
  title: string,
  message: string,
  options?: {
    dedupeKey?: string;
    actionLabel?: string;
    onAction?: () => void;
    secondaryActionLabel?: string;
    onSecondaryAction?: () => void;
  },
) {
  showWorkspaceBanner({
    kind: "error",
    title,
    message,
    dedupeKey: options?.dedupeKey,
    actionLabel: options?.actionLabel,
    onAction: options?.onAction,
    secondaryActionLabel: options?.secondaryActionLabel,
    onSecondaryAction: options?.onSecondaryAction,
  });
}
