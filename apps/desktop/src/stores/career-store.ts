import { create } from "zustand";
import {
  countBlocksMissingEmbeddings,
  deleteBlock as deleteBlockApi,
  deletePersona as deletePersonaApi,
  listBlocks,
  listKbSources,
  listPersonas,
  persistBlockEmbedding,
  upsertBlock as upsertBlockApi,
  upsertPersona as upsertPersonaApi,
  type ExperienceBlock,
  type Persona,
} from "@/lib/career";
import { computeEmbeddingText } from "@/lib/career/block-helpers";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("career-store");

export type CareerTab = "database" | "knowledge" | "synthesize";

interface CareerState {
  /** Top-level App branch: Career view vs ProjectPicker/Workspace. */
  careerOpen: boolean;
  activeTab: CareerTab;

  blocks: ExperienceBlock[];
  personas: Persona[];
  selectedBlockId: string | null;
  selectedPersonaId: string | null;

  /** Blocks with no embedding row (for Database tab badge). */
  blocksMissingEmbeddings: number;

  /**
   * KB source count for coverage surfaces (first-run guide). `null` means the
   * lookup failed — unknown, never conflated with a confirmed zero.
   */
  kbSourceCount: number | null;

  loading: boolean;
  saving: boolean;
  error: string | null;

  /**
   * One-shot flag: Database tab opens the resume import wizard when true,
   * then acknowledges. Used by Synthesize empty-state / first-run CTAs.
   */
  resumeImportRequested: boolean;

  /**
   * LaTeX source captured before the wizard opens (e.g. a dropped .zip or
   * .tex file). Consumed by the import wizard, then cleared on acknowledge.
   */
  resumeImportSource: string | null;

  /** Open Career; omit tab to restore the last active tab (else `"database"`). */
  openCareer: (tab?: CareerTab) => void;
  closeCareer: () => void;
  setActiveTab: (tab: CareerTab) => void;
  setSelectedBlockId: (id: string | null) => void;
  setSelectedPersonaId: (id: string | null) => void;
  /** Switch to Database and ask it to open the resume import wizard. */
  requestResumeImport: (source?: string) => void;
  acknowledgeResumeImportRequest: () => void;
  /** Clear a pending dropped/picked source after the wizard consumes it. */
  clearResumeImportSource: () => void;

  loadAll: () => Promise<void>;
  refreshMissingBlockEmbeddings: () => Promise<void>;
  /** Re-probe KB source coverage (mount, external-change events, mutations). */
  refreshKbCoverage: () => Promise<void>;
  saveBlock: (block: ExperienceBlock) => Promise<void>;
  removeBlock: (id: string) => Promise<void>;
  savePersona: (persona: Persona) => Promise<void>;
  removePersona: (id: string) => Promise<void>;
  /** Persist multiple draft blocks (import wizard). Never called automatically. */
  commitBlocks: (
    blocks: ExperienceBlock[],
    options?: {
      onProgress?: (progress: {
        current: number;
        total: number;
        label: string;
        phase: "save" | "embed" | "done";
      }) => void;
    },
  ) => Promise<{
    saved: number;
    deferredEmbeddings: number;
    deferredError?: string;
  }>;
}

async function embedBlockGracefully(
  block: ExperienceBlock,
): Promise<{ deferred: boolean; error?: string }> {
  try {
    // Persists ownerKind "block" + per-bullet "bullet" vectors.
    const result = await persistBlockEmbedding(block);
    if (result.deferred) {
      log.warn("Block/bullet embedding deferred", {
        id: block.id,
        error: result.error,
      });
      return { deferred: true, error: result.error };
    }
    return { deferred: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Block/bullet embedding failed; left for backfill", {
      id: block.id,
      error: message,
    });
    return { deferred: true, error: message };
  }
}

export const useCareerStore = create<CareerState>((set, get) => ({
  careerOpen: false,
  activeTab: "database",

  blocks: [],
  personas: [],
  selectedBlockId: null,
  selectedPersonaId: null,

  blocksMissingEmbeddings: 0,
  kbSourceCount: null,

  loading: false,
  saving: false,
  error: null,

  resumeImportRequested: false,
  resumeImportSource: null,

  /**
   * Open Career. With an explicit tab, switch to it; with no arg, restore the
   * last active tab (kept in memory across closeCareer), else `"database"`.
   */
  openCareer: (tab) =>
    set((state) => ({
      careerOpen: true,
      activeTab: tab ?? state.activeTab ?? "database",
      error: null,
    })),
  closeCareer: () =>
    set({
      careerOpen: false,
      selectedBlockId: null,
      selectedPersonaId: null,
      error: null,
      resumeImportRequested: false,
      resumeImportSource: null,
      // Keep activeTab so the next openCareer() restores the last tab.
    }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedBlockId: (id) => set({ selectedBlockId: id }),
  setSelectedPersonaId: (id) => set({ selectedPersonaId: id }),
  requestResumeImport: (source) =>
    set({
      careerOpen: true,
      activeTab: "database",
      resumeImportRequested: true,
      resumeImportSource: source && source.trim().length > 0 ? source : null,
      error: null,
    }),
  acknowledgeResumeImportRequest: () => set({ resumeImportRequested: false }),
  clearResumeImportSource: () => set({ resumeImportSource: null }),

  refreshMissingBlockEmbeddings: async () => {
    try {
      const count = await countBlocksMissingEmbeddings();
      set({ blocksMissingEmbeddings: count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Failed to count blocks missing embeddings", { error: message });
    }
  },

  refreshKbCoverage: async () => {
    try {
      const sources = await listKbSources();
      set({ kbSourceCount: sources.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Failed to refresh KB source coverage", { error: message });
      // Unknown stays distinct from a confirmed zero.
      set({ kbSourceCount: null });
    }
  },

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [blocks, personas] = await Promise.all([
        listBlocks(),
        listPersonas(),
      ]);
      const sorted = [...blocks].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      set({
        blocks: sorted,
        personas,
        loading: false,
        selectedBlockId: get().selectedBlockId ?? sorted[0]?.id ?? null,
        selectedPersonaId: get().selectedPersonaId ?? personas[0]?.id ?? null,
      });
      void get().refreshMissingBlockEmbeddings();
      void get().refreshKbCoverage();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to load career DB", { error: message });
      set({ loading: false, error: message });
    }
  },

  saveBlock: async (block) => {
    set({ saving: true, error: null });
    const next: ExperienceBlock = {
      ...block,
      embeddingText: computeEmbeddingText(block),
      updatedAt: new Date().toISOString(),
    };
    try {
      await upsertBlockApi(next);
      set((state) => {
        const others = state.blocks.filter((b) => b.id !== next.id);
        return {
          blocks: [next, ...others].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          ),
          selectedBlockId: next.id,
          saving: false,
        };
      });
      await embedBlockGracefully(next);
      void get().refreshMissingBlockEmbeddings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save block", { id: next.id, error: message });
      set({ saving: false, error: message });
      throw err;
    }
  },

  removeBlock: async (id) => {
    set({ saving: true, error: null });
    try {
      await deleteBlockApi(id);
      set((state) => {
        const blocks = state.blocks.filter((b) => b.id !== id);
        return {
          blocks,
          selectedBlockId:
            state.selectedBlockId === id
              ? (blocks[0]?.id ?? null)
              : state.selectedBlockId,
          saving: false,
        };
      });
      void get().refreshMissingBlockEmbeddings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to delete block", { id, error: message });
      set({ saving: false, error: message });
      throw err;
    }
  },

  savePersona: async (persona) => {
    set({ saving: true, error: null });
    try {
      await upsertPersonaApi(persona);
      set((state) => {
        const others = state.personas.filter((p) => p.id !== persona.id);
        return {
          personas: [...others, persona].sort((a, b) =>
            a.label.localeCompare(b.label),
          ),
          selectedPersonaId: persona.id,
          saving: false,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to save persona", { id: persona.id, error: message });
      set({ saving: false, error: message });
      throw err;
    }
  },

  removePersona: async (id) => {
    set({ saving: true, error: null });
    try {
      await deletePersonaApi(id);
      set((state) => {
        const personas = state.personas.filter((p) => p.id !== id);
        return {
          personas,
          selectedPersonaId:
            state.selectedPersonaId === id
              ? (personas[0]?.id ?? null)
              : state.selectedPersonaId,
          saving: false,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to delete persona", { id, error: message });
      set({ saving: false, error: message });
      throw err;
    }
  },

  commitBlocks: async (blocks, options) => {
    if (blocks.length === 0) {
      return { saved: 0, deferredEmbeddings: 0 };
    }
    set({ saving: true, error: null });
    try {
      const stamped = blocks.map((block) => ({
        ...block,
        embeddingText: computeEmbeddingText(block),
        updatedAt: new Date().toISOString(),
      }));
      const total = stamped.length;
      for (let i = 0; i < stamped.length; i++) {
        const block = stamped[i]!;
        options?.onProgress?.({
          current: i + 1,
          total,
          label: block.title || block.org || block.id,
          phase: "save",
        });
        await upsertBlockApi(block);
      }
      set((state) => {
        const byId = new Map(state.blocks.map((b) => [b.id, b]));
        for (const block of stamped) byId.set(block.id, block);
        const next = [...byId.values()].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
        return {
          blocks: next,
          selectedBlockId: stamped[0]?.id ?? state.selectedBlockId,
          saving: false,
        };
      });
      let deferredEmbeddings = 0;
      let deferredError: string | undefined;
      for (let i = 0; i < stamped.length; i++) {
        const block = stamped[i]!;
        options?.onProgress?.({
          current: i + 1,
          total,
          label: block.title || block.org || block.id,
          phase: "embed",
        });
        const embed = await embedBlockGracefully(block);
        if (embed.deferred) {
          deferredEmbeddings += 1;
          deferredError ??= embed.error;
        }
      }
      options?.onProgress?.({
        current: total,
        total,
        label: "Done",
        phase: "done",
      });
      void get().refreshMissingBlockEmbeddings();
      return { saved: total, deferredEmbeddings, deferredError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to commit imported blocks", { error: message });
      set({ saving: false, error: message });
      throw err;
    }
  },
}));
