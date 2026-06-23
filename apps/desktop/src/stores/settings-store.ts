import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";

interface SettingsState {
  compilerBackend: CompilerBackend;
  setCompilerBackend: (backend: CompilerBackend) => void;
  vimMode: boolean;
  setVimMode: (enabled: boolean) => void;
  /**
   * Use DevPrism's built-in native agent (talks directly to a local Ollama
   * model — no Claude Code CLI required) instead of the CLI-based backend.
   */
  nativeAgentEnabled: boolean;
  setNativeAgentEnabled: (enabled: boolean) => void;
  /** Ollama context window (num_ctx) for the native agent. */
  nativeNumCtx: number;
  setNativeNumCtx: (n: number) => void;
  /** Ollama sampling temperature for the native agent. */
  nativeTemperature: number;
  setNativeTemperature: (t: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
      vimMode: false,
      setVimMode: (enabled) => set({ vimMode: enabled }),
      nativeAgentEnabled: false,
      setNativeAgentEnabled: (enabled) => set({ nativeAgentEnabled: enabled }),
      nativeNumCtx: 8192,
      setNativeNumCtx: (n) =>
        set({
          nativeNumCtx: Math.min(131072, Math.max(512, Math.round(n) || 8192)),
        }),
      nativeTemperature: 0.4,
      setNativeTemperature: (t) =>
        set({ nativeTemperature: Math.min(2, Math.max(0, t)) }),
    }),
    {
      name: "claude-prism-settings",
    },
  ),
);
