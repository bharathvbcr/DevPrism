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
    }),
    {
      name: "claude-prism-settings",
    },
  ),
);
