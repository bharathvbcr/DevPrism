import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";
export type AgentProvider = "gemini-api" | "gemini-cli" | "ollama" | "claude";

export interface AgentProviderSettings {
  provider: AgentProvider;
  model: string;
  backendMode: "api" | "cli" | "local" | "claude";
  geminiApiKey?: string | null;
  geminiCliModel?: string | null;
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
  provider: "gemini-api",
  model: "gemini-1.5-pro",
  backendMode: "api",
  geminiApiKey: "",
  geminiCliModel: "gemini-1.5-pro",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "llama3",
};

function normalizeProviderSettings(
  settings: Partial<AgentProviderSettings> | null | undefined,
): AgentProviderSettings {
  const merged = { ...defaultProviderSettings, ...(settings ?? {}) };
  if (merged.provider === "claude") {
    return {
      ...merged,
      provider: "gemini-cli",
      backendMode: "cli",
      model: merged.geminiCliModel ?? defaultProviderSettings.model,
    };
  }
  return merged;
}

if (typeof localStorage !== "undefined") {
  const legacyStorageKey = ["dev", "prism-settings"].join("");
  const legacy = localStorage.getItem(legacyStorageKey);
  if (legacy && !localStorage.getItem("devcouncil-settings")) {
    localStorage.setItem("devcouncil-settings", legacy);
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
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
      name: "devcouncil-settings",
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        localStorage.removeItem(["dev", "prism-settings"].join(""));
      },
    },
  ),
);
