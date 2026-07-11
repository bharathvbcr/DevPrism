import { create } from "zustand";
import {
  countBlocksMissingEmbeddings,
  deleteBlock as deleteBlockApi,
  deletePersona as deletePersonaApi,
  listBlocks,
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

  loading: boolean;
  saving: boolean;
  error: string | null;

  openCareer: (tab?: CareerTab) => void;
  closeCareer: () => void;
  setActiveTab: (tab: CareerTab) => void;
  setSelectedBlockId: (id: string | null) => void;
  setSelectedPersonaId: (id: string | null) => void;

  loadAll: () => Promise<void>;
  refreshMissingBlockEmbeddings: () => Promise<void>;
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
  ) => Promise<void>;
}

async function embedBlockGracefully(block: ExperienceBlock): Promise<void> {
  try {
    // Persists ownerKind "block" + per-bullet "bullet" vectors.
    const result = await persistBlockEmbedding(block);
    if (result.deferred) {
      log.warn("Block/bullet embedding deferred", {
        id: block.id,
        error: result.error,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Block/bullet embedding failed; left for backfill", {
      id: block.id,
      error: message,
    });
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

  loading: false,
  saving: false,
  error: null,

  openCareer: (tab = "database") =>
    set({ careerOpen: true, activeTab: tab, error: null }),
  closeCareer: () =>
    set({
      careerOpen: false,
      selectedBlockId: null,
      selectedPersonaId: null,
      error: null,
    }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedBlockId: (id) => set({ selectedBlockId: id }),
  setSelectedPersonaId: (id) => set({ selectedPersonaId: id }),

  refreshMissingBlockEmbeddings: async () => {
    try {
      const count = await countBlocksMissingEmbeddings();
      set({ blocksMissingEmbeddings: count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Failed to count blocks missing embeddings", { error: message });
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
    if (blocks.length === 0) return;
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
      for (let i = 0; i < stamped.length; i++) {
        const block = stamped[i]!;
        options?.onProgress?.({
          current: i + 1,
          total,
          label: block.title || block.org || block.id,
          phase: "embed",
        });
        await embedBlockGracefully(block);
      }
      options?.onProgress?.({
        current: total,
        total,
        label: "Done",
        phase: "done",
      });
      void get().refreshMissingBlockEmbeddings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to commit imported blocks", { error: message });
      set({ saving: false, error: message });
      throw err;
    }
  },
}));
