import { create } from "zustand";
import {
  variantList,
  variantGet,
  variantCreate,
  variantUpdate,
  variantDelete,
  variantBindJd,
  diffVariant,
  type VariantInfo,
  type CreateVariantOptions,
  type UpdateVariantPatch,
  type VariantFileDiff,
} from "@/lib/tauri/variants";
import { deriveOwner } from "@/stores/variants-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSpacesStore } from "@/stores/spaces-store";
import { useEditorTabsStore } from "@/stores/editor-tabs-store";
import {
  stopStreamingTab,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("resume-variants");

interface ResumeVariantsState {
  ownerRoot: string | null;
  activeVariantId: string | null;
  variants: VariantInfo[];
  selectedVariant: VariantInfo | null;
  loading: boolean;
  switching: boolean;

  sync: (projectRoot: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  get: (variantId: string) => Promise<VariantInfo>;
  create: (
    name: string,
    jd?: string,
    status?: string,
    options?: CreateVariantOptions,
  ) => Promise<VariantInfo>;
  update: (
    variantId: string,
    patch: UpdateVariantPatch,
  ) => Promise<VariantInfo>;
  bindJd: (
    variantId: string,
    jdText: string,
    company?: string,
    role?: string,
  ) => Promise<VariantInfo>;
  remove: (variantId: string) => Promise<void>;
  switchTo: (variantId: string | null) => Promise<void>;
  diff: (variantId: string) => Promise<VariantFileDiff[]>;
}

async function prepareForSwitch(): Promise<void> {
  const docStore = useDocumentStore.getState();
  await docStore.saveAllFiles();

  const chatState = useClaudeChatStore.getState();
  const tabs = Array.isArray(chatState.tabs) ? chatState.tabs : [];
  const streamingTabs = tabs.filter((tab) => tab.isStreaming);
  if (streamingTabs.length > 0) {
    await Promise.all(
      streamingTabs.map((tab) => stopStreamingTab(tab.id).catch(() => {})),
    );
  }
}

export const useResumeVariantsStore = create<ResumeVariantsState>()(
  (set, get) => ({
    ownerRoot: null,
    activeVariantId: null,
    variants: [],
    selectedVariant: null,
    loading: false,
    switching: false,

    sync: async (projectRoot) => {
      if (!projectRoot) {
        set({
          ownerRoot: null,
          activeVariantId: null,
          variants: [],
          selectedVariant: null,
        });
        return;
      }
      const { owner, activeVariantId } = deriveOwner(projectRoot);
      set({ ownerRoot: owner, activeVariantId, loading: true });
      try {
        const variants = await variantList(owner);
        if (get().ownerRoot !== owner) return;
        const selected =
          variants.find((v) => v.id === activeVariantId) ?? variants[0] ?? null;
        set({ variants, selectedVariant: selected, loading: false });
      } catch (err) {
        log.error("Failed to list variants", { error: String(err) });
        if (get().ownerRoot === owner) {
          set({ variants: [], selectedVariant: null, loading: false });
        }
      }
    },

    refresh: async () => {
      const { ownerRoot, activeVariantId } = get();
      if (!ownerRoot) return;
      try {
        const variants = await variantList(ownerRoot);
        if (get().ownerRoot === ownerRoot) {
          const selected =
            variants.find((v) => v.id === activeVariantId) ??
            variants[0] ??
            null;
          set({ variants, selectedVariant: selected });
        }
      } catch (err) {
        log.error("Failed to refresh variants", { error: String(err) });
      }
    },

    get: async (variantId: string) => {
      const { ownerRoot } = get();
      if (!ownerRoot) throw new Error("No project open");
      const info = await variantGet(ownerRoot, variantId);
      set((s) => ({
        variants: s.variants.map((v) => (v.id === variantId ? info : v)),
        selectedVariant:
          s.selectedVariant?.id === variantId ? info : s.selectedVariant,
      }));
      return info;
    },

    create: async (name, jd, status, options) => {
      const { ownerRoot } = get();
      if (!ownerRoot) throw new Error("No project open");
      await useDocumentStore.getState().saveAllFiles();
      const info = await variantCreate(ownerRoot, name, jd, status, options);

      const spaces = useSpacesStore.getState();
      const space = spaces.spaceForProject(ownerRoot);
      if (space) spaces.assignProject(info.path, space.id);

      set((s) => ({
        variants: [info, ...s.variants],
        selectedVariant: info,
      }));
      await get().switchTo(info.id);
      return info;
    },

    update: async (variantId, patch) => {
      const { ownerRoot } = get();
      if (!ownerRoot) throw new Error("No project open");
      const info = await variantUpdate(ownerRoot, variantId, patch);
      set((s) => ({
        variants: s.variants.map((v) => (v.id === variantId ? info : v)),
        selectedVariant:
          s.selectedVariant?.id === variantId ? info : s.selectedVariant,
      }));
      return info;
    },

    bindJd: async (variantId, jdText, company, role) => {
      const { ownerRoot } = get();
      if (!ownerRoot) throw new Error("No project open");
      const info = await variantBindJd(
        ownerRoot,
        variantId,
        jdText,
        company,
        role,
      );
      set((s) => ({
        variants: s.variants.map((v) => (v.id === variantId ? info : v)),
        selectedVariant:
          s.selectedVariant?.id === variantId ? info : s.selectedVariant,
      }));
      return info;
    },

    remove: async (variantId) => {
      const { ownerRoot, activeVariantId } = get();
      if (!ownerRoot) return;
      if (activeVariantId === variantId) {
        await get().switchTo(null);
      }
      await variantDelete(ownerRoot, variantId);
      set((s) => {
        const remaining = s.variants.filter((v) => v.id !== variantId);
        return {
          variants: remaining,
          selectedVariant:
            s.selectedVariant?.id === variantId
              ? (remaining[0] ?? null)
              : s.selectedVariant,
        };
      });
    },

    switchTo: async (variantId) => {
      const { ownerRoot, variants, activeVariantId } = get();
      if (!ownerRoot) return;
      if (get().switching) return;
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

        const docState = useDocumentStore.getState();
        const tabsStore = useEditorTabsStore.getState();
        tabsStore.resetTabs();

        const mainFile =
          docState.files.find(
            (f) =>
              f.name === "main.typ" ||
              f.name === "resume.typ" ||
              f.name === "main.tex" ||
              f.name === "document.tex",
          ) ||
          docState.files.find((f) => f.id === docState.activeFileId) ||
          docState.files[0];

        if (mainFile) {
          tabsStore.openTab(
            {
              id: mainFile.id,
              path: mainFile.relativePath,
              title: mainFile.name,
            },
            { activate: true },
          );
          docState.setActiveFile(mainFile.id);
        }

        set({
          activeVariantId: variantId,
          selectedVariant: variants.find((v) => v.id === variantId) ?? null,
        });
      } finally {
        set({ switching: false });
      }
    },

    diff: async (variantId) => {
      const { ownerRoot } = get();
      if (!ownerRoot) throw new Error("No project open");
      return diffVariant(ownerRoot, variantId);
    },
  }),
);
