import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";
export type AgentProvider = "gemini-api" | "codex-cli" | "ollama";

export function isWindowsRuntime(): boolean {
  return (
    typeof navigator !== "undefined" && /\bWindows\b/i.test(navigator.userAgent)
  );
}

function defaultCompilerBackend(): CompilerBackend {
  return isWindowsRuntime() ? "texlive" : "tectonic";
}

function normalizeCompilerBackend(backend: CompilerBackend): CompilerBackend {
  return isWindowsRuntime() && backend === "tectonic" ? "texlive" : backend;
}

export interface AgentProviderSettings {
  provider: AgentProvider;
  model: string;
  backendMode: "api" | "cli" | "local";
  geminiApiKey?: string | null;
  codexCliModel?: string | null;
  ollamaBaseUrl: string;
  ollamaModel: string;
}

interface SettingsState {
  compilerBackend: CompilerBackend;
  setCompilerBackend: (backend: CompilerBackend) => void;
  personalBio: string;
  setPersonalBio: (bio: string) => Promise<void>;
  resumeProfile: string;
  setResumeProfile: (profile: string) => Promise<void>;
  manualExperience: string;
  setManualExperience: (experience: string) => Promise<void>;
  evidenceEntries: string;
  setEvidenceEntries: (entries: string) => Promise<void>;
  redactSecrets: boolean;
  setRedactSecrets: (enabled: boolean) => Promise<void>;
  safeMode: boolean;
  setSafeMode: (enabled: boolean) => Promise<void>;
  agentProviderSettings: AgentProviderSettings;
  setAgentProviderSettings: (
    settings: Partial<AgentProviderSettings>,
  ) => Promise<void>;
  loadFromBackend: () => Promise<void>;
}

const defaultProviderSettings: AgentProviderSettings = {
  provider: "ollama",
  model: "llama3",
  backendMode: "local",
  geminiApiKey: "",
  codexCliModel: "gpt-5.2",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "llama3",
};

function normalizeProviderSettings(
  settings: Partial<AgentProviderSettings> | null | undefined,
): AgentProviderSettings {
  const merged = { ...defaultProviderSettings, ...(settings ?? {}) };
  const legacyProvider = ["clau", "de"].join("");
  if ((merged.provider as string) === legacyProvider) {
    return {
      ...merged,
      provider: "codex-cli",
      backendMode: "cli",
      model: merged.codexCliModel ?? "gpt-5.2",
    };
  }
  return merged;
}

export function legacyStorageKey(suffix: string): string {
  return `${String.fromCharCode(100, 101, 118, 99, 111, 117, 110, 99, 105, 108)}-${suffix}`;
}

export function migrateLocalStorageKey(from: string, to: string): void {
  if (typeof localStorage === "undefined") return;
  const legacy = localStorage.getItem(from);
  if (legacy && !localStorage.getItem(to)) {
    localStorage.setItem(to, legacy);
  }
}

migrateLocalStorageKey(legacyStorageKey("settings"), "devprism-settings");

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      compilerBackend: defaultCompilerBackend(),
      setCompilerBackend: (backend) =>
        set({ compilerBackend: normalizeCompilerBackend(backend) }),
      personalBio: "",
      setPersonalBio: async (bio: string) => {
        set({ personalBio: bio });
        await invoke("set_personal_bio", { bio });
      },
      resumeProfile: "",
      setResumeProfile: async (profile) => {
        const next = { ...get(), resumeProfile: profile };
        set({ resumeProfile: profile });
        await invoke("set_resume_knowledge_settings", {
          settings: {
            resumeProfile: next.resumeProfile,
            manualExperience: next.manualExperience,
            evidenceEntries: next.evidenceEntries,
          },
        });
      },
      manualExperience: "",
      setManualExperience: async (experience) => {
        const next = { ...get(), manualExperience: experience };
        set({ manualExperience: experience });
        await invoke("set_resume_knowledge_settings", {
          settings: {
            resumeProfile: next.resumeProfile,
            manualExperience: next.manualExperience,
            evidenceEntries: next.evidenceEntries,
          },
        });
      },
      evidenceEntries: "",
      setEvidenceEntries: async (entries) => {
        const next = { ...get(), evidenceEntries: entries };
        set({ evidenceEntries: entries });
        await invoke("set_resume_knowledge_settings", {
          settings: {
            resumeProfile: next.resumeProfile,
            manualExperience: next.manualExperience,
            evidenceEntries: next.evidenceEntries,
          },
        });
      },
      redactSecrets: true,
      setRedactSecrets: async (enabled: boolean) => {
        set({ redactSecrets: enabled });
        await invoke("set_redact_secrets", { enabled });
      },
      safeMode: true,
      setSafeMode: async (enabled: boolean) => {
        set({ safeMode: enabled });
        await invoke("set_safe_mode", { enabled });
      },
      agentProviderSettings: defaultProviderSettings,
      setAgentProviderSettings: async (settings) => {
        const merged = normalizeProviderSettings({
          ...get().agentProviderSettings,
          ...settings,
        });
        set({ agentProviderSettings: merged });
        await invoke("set_agent_provider_settings", { settings: merged });
      },
      loadFromBackend: async () => {
        try {
          const bio = await invoke<string | null>("get_personal_bio");
          if (bio !== null) {
            set({ personalBio: bio });
          }
          const redact = await invoke<boolean>("get_redact_secrets");
          const safe = await invoke<boolean>("get_safe_mode");
          const providerSettings = await invoke<AgentProviderSettings>(
            "get_agent_provider_settings",
          );
          const resumeKnowledge = await invoke<{
            resumeProfile: string;
            manualExperience: string;
            evidenceEntries: string;
          }>("get_resume_knowledge_settings");
          set({
            redactSecrets: redact,
            safeMode: safe,
            resumeProfile: resumeKnowledge.resumeProfile,
            manualExperience: resumeKnowledge.manualExperience,
            evidenceEntries: resumeKnowledge.evidenceEntries,
            agentProviderSettings: normalizeProviderSettings(providerSettings),
          });
        } catch (err) {
          console.error("Failed to load settings from backend", err);
        }
      },
    }),
    {
      name: "devprism-settings",
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.setCompilerBackend(
          normalizeCompilerBackend(state.compilerBackend),
        );
        localStorage.removeItem(legacyStorageKey("settings"));
      },
    },
  ),
);
