import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { pullOllamaModel, type OllamaPullProgress } from "@/lib/ollama";

interface OllamaPullState {
  progress: OllamaPullProgress | null;
  pulling: boolean;
  baseUrl: string | null;
  pull: (
    model: string,
    baseUrl: string,
    onComplete?: () => void,
  ) => Promise<void>;
  reset: () => void;
}

let listenerReady = false;

function ensurePullListener(
  set: (partial: Partial<OllamaPullState>) => void,
  _get: () => OllamaPullState,
) {
  if (listenerReady) return;
  listenerReady = true;
  void listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
    set({ progress: event.payload });
    if (event.payload.done) {
      set({ pulling: false });
      if (!event.payload.error) {
        toast.success(`Installed ${event.payload.model}`);
      }
    }
  });
}

export const useOllamaPullStore = create<OllamaPullState>((set, get) => {
  ensurePullListener(set, get);
  return {
    progress: null,
    pulling: false,
    baseUrl: null,
    pull: async (model, baseUrl, onComplete) => {
      if (get().pulling) return;
      set({
        pulling: true,
        baseUrl,
        progress: {
          model,
          status: "Starting…",
          done: false,
        },
      });
      try {
        await pullOllamaModel(model, baseUrl);
        if (!get().progress?.error) {
          onComplete?.();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        set({
          pulling: false,
          progress: {
            model,
            status: "Failed",
            done: true,
            error: message,
          },
        });
      }
    },
    reset: () => set({ progress: null }),
  };
});
