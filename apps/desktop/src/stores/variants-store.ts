import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  listVariants,
  createVariant,
  updateVariant,
  deleteVariant,
  type VariantInfo,
} from "@/lib/tauri/variants";
import { useDocumentStore } from "@/stores/document-store";
import { useSpacesStore } from "@/stores/spaces-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("variants");

/**
 * Tailored versions ("variants") of the open project's master document.
 *
 * A variant is a self-contained project folder under
 * `<owner>/.prism/variants/<slug>/`, so "switching" to one is just opening its
 * path. The owning project (and whether we're currently on the master or a
 * variant) is derived from the open `projectRoot`, keeping this store a thin
 * cache over the Rust commands plus the switch orchestration.
 */

/** Split any project path into its owning root and the active variant id
 * (`null` when the path is the master itself). */
export function deriveOwner(projectRoot: string): {
  owner: string;
  activeVariantId: string | null;
} {
  const norm = projectRoot.replace(/[\\/]+$/, "");
  const m = norm.match(/^(.*)[\\/]\.prism[\\/]variants[\\/]([^\\/]+)$/);
  if (m) return { owner: m[1], activeVariantId: m[2] };
  return { owner: norm, activeVariantId: null };
}

interface VariantsState {
  /** Owning project root for the currently open project. */
  ownerRoot: string | null;
  /** Slug of the open variant, or null when the master is open. */
  activeVariantId: string | null;
  variants: VariantInfo[];
  loading: boolean;
  /** True while a project switch (master <-> variant) is in flight. */
  switching: boolean;

  /** Recompute owner/active from a project path and (re)load the variant list. */
  sync: (projectRoot: string | null) => Promise<void>;
  /** Reload the variant list for the current owner. */
  refresh: () => Promise<void>;
  /** Create a tailored version from the master, then switch to it. */
  create: (name: string, jd: string, status: string) => Promise<void>;
  /** Open the master (id = null) or a variant by id. */
  switchTo: (variantId: string | null) => Promise<void>;
  setStatus: (variantId: string, status: string) => Promise<void>;
  rename: (variantId: string, name: string) => Promise<void>;
  setJd: (variantId: string, jd: string) => Promise<void>;
  remove: (variantId: string) => Promise<void>;
}

/** Save pending edits and stop any in-flight agent stream before swapping the
 * project out from under the editor. Mirrors `renameProject`'s guard. */
async function prepareForSwitch(): Promise<void> {
  const docStore = useDocumentStore.getState();
  await docStore.saveAllFiles();

  const chatState = useClaudeChatStore.getState();
  const tabs = Array.isArray(chatState.tabs) ? chatState.tabs : [];
  const streamingTabs = tabs.filter((tab) => tab.isStreaming);
  if (streamingTabs.length > 0) {
    await Promise.all(
      streamingTabs.flatMap((tab) => [
        invoke("cancel_claude_execution", { tabId: tab.id }).catch(() => {}),
        invoke("stop_native_agent", { tabId: tab.id }).catch(() => {}),
      ]),
    );
  }
}

export const useVariantsStore = create<VariantsState>()((set, get) => ({
  ownerRoot: null,
  activeVariantId: null,
  variants: [],
  loading: false,
  switching: false,

  sync: async (projectRoot) => {
    if (!projectRoot) {
      set({ ownerRoot: null, activeVariantId: null, variants: [] });
      return;
    }
    const { owner, activeVariantId } = deriveOwner(projectRoot);
    set({ ownerRoot: owner, activeVariantId, loading: true });
    try {
      const variants = await listVariants(owner);
      // Ignore a late response if the owner changed while we were loading.
      if (get().ownerRoot !== owner) return;
      set({ variants, loading: false });
    } catch (err) {
      log.error("Failed to list variants", { error: String(err) });
      if (get().ownerRoot === owner) set({ variants: [], loading: false });
    }
  },

  refresh: async () => {
    const { ownerRoot } = get();
    if (!ownerRoot) return;
    try {
      const variants = await listVariants(ownerRoot);
      if (get().ownerRoot === ownerRoot) set({ variants });
    } catch (err) {
      log.error("Failed to refresh variants", { error: String(err) });
    }
  },

  create: async (name, jd, status) => {
    const { ownerRoot } = get();
    if (!ownerRoot) throw new Error("No project open");
    // Flush unsaved master edits first — the Rust snapshot copies from disk, so
    // without this the new version would capture stale content.
    await useDocumentStore.getState().saveAllFiles();
    const info = await createVariant(ownerRoot, name, jd, status);

    // Keep the new variant in the master's Space so per-space defaults (e.g.
    // the local model) carry over when it's opened.
    const spaces = useSpacesStore.getState();
    const space = spaces.spaceForProject(ownerRoot);
    if (space) spaces.assignProject(info.path, space.id);

    set((s) => ({ variants: [info, ...s.variants] }));
    await get().switchTo(info.id);
  },

  switchTo: async (variantId) => {
    const { ownerRoot, variants, activeVariantId } = get();
    if (!ownerRoot) return;
    if (variantId === activeVariantId) return;

    const target =
      variantId === null
        ? ownerRoot
        : variants.find((v) => v.id === variantId)?.path;
    if (!target) {
      log.warn("switchTo: unknown variant", { variantId });
      return;
    }

    set({ switching: true });
    try {
      await prepareForSwitch();
      await useDocumentStore.getState().openProject(target);
      set({ activeVariantId: variantId });
    } finally {
      set({ switching: false });
    }
  },

  setStatus: async (variantId, status) => {
    const { ownerRoot } = get();
    if (!ownerRoot) return;
    const info = await updateVariant(ownerRoot, variantId, { status });
    set((s) => ({
      variants: s.variants.map((v) => (v.id === variantId ? info : v)),
    }));
  },

  rename: async (variantId, name) => {
    const { ownerRoot } = get();
    if (!ownerRoot) return;
    const info = await updateVariant(ownerRoot, variantId, { name });
    set((s) => ({
      variants: s.variants.map((v) => (v.id === variantId ? info : v)),
    }));
  },

  setJd: async (variantId, jd) => {
    const { ownerRoot } = get();
    if (!ownerRoot) return;
    const info = await updateVariant(ownerRoot, variantId, { jd });
    set((s) => ({
      variants: s.variants.map((v) => (v.id === variantId ? info : v)),
    }));
  },

  remove: async (variantId) => {
    const { ownerRoot, activeVariantId } = get();
    if (!ownerRoot) return;
    // If deleting the open variant, fall back to the master first so the editor
    // isn't left pointing at a folder we're about to remove.
    if (activeVariantId === variantId) {
      await get().switchTo(null);
    }
    await deleteVariant(ownerRoot, variantId);
    set((s) => ({ variants: s.variants.filter((v) => v.id !== variantId) }));
  },
}));
