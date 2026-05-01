import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useSettingsStore, type AgentProviderSettings } from "./settings-store";

interface ProviderHealth {
  ok: boolean;
  message: string;
  models: string[];
}

type SetupStatus = "checking" | "ready" | "error";

type StepStatus = "pending" | "active" | "complete" | "error";

export interface StepInfo {
  id: string;
  label: string;
  status: StepStatus;
}

interface DevEngineSetupState {
  status: SetupStatus;
  isInstalling: boolean;
  isLoggingIn: boolean;
  error: string | null;
  version: string | null;
  accountEmail: string | null;
  installSteps: StepInfo[];
  installLogs: string[];
  installLogsVisible: boolean;
  loginSteps: StepInfo[];
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  login: () => Promise<void>;
  toggleInstallLogs: () => void;
  _appendInstallLog: (line: string) => void;
  _advanceInstallStep: (stepId: string) => void;
  _failCurrentStep: (error: string) => void;
  _advanceLoginStep: (stepId: string) => void;
  _failCurrentLoginStep: (error: string) => void;
  _finishInstall: (success: boolean) => void;
  _finishLogin: (success: boolean) => void;
}

async function checkProvider(
  settings: AgentProviderSettings,
  provider: AgentProviderSettings["provider"],
): Promise<{ providerLabel: string; health: ProviderHealth }> {
  if (provider === "gemini-cli") {
    return {
      providerLabel: "Gemini CLI",
      health: await invoke<ProviderHealth>("check_gemini_cli_status"),
    };
  }
  if (provider === "codex-cli") {
    return {
      providerLabel: "Codex CLI",
      health: await invoke<ProviderHealth>("check_codex_cli_status"),
    };
  }
  if (provider === "ollama") {
    return {
      providerLabel: "Ollama",
      health: await invoke<ProviderHealth>("check_ollama_status", {
        baseUrl: settings.ollamaBaseUrl,
        model: settings.ollamaModel,
      }),
    };
  }
  if (provider === "gemini-api") {
    return {
      providerLabel: "Gemini API",
      health: await invoke<ProviderHealth>("check_gemini_api_status", {
        apiKey: settings.geminiApiKey,
      }),
    };
  }
  return {
    providerLabel: "Configured provider",
    health: {
      ok: false,
      message:
        "Select Gemini CLI, Codex CLI, Gemini API, or Ollama in Settings.",
      models: [],
    },
  };
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

export const useDevEngineSetupStore = create<DevEngineSetupState>(
  (set, get) => ({
    status: "checking",
    isInstalling: false,
    isLoggingIn: false,
    error: null,
    version: null,
    accountEmail: null,
    installSteps: [],
    installLogs: [],
    installLogsVisible: false,
    loginSteps: [],

    checkStatus: async () => {
      set({ status: "checking", error: null });
      try {
        await useSettingsStore.getState().loadFromBackend();
        const settings = useSettingsStore.getState().agentProviderSettings;
        const configuredProvider =
          (settings.provider as string) === ["clau", "de"].join("")
            ? "codex-cli"
            : settings.provider;
        const providers = Array.from(
          new Set([
            configuredProvider,
            "codex-cli",
            "gemini-cli",
            "ollama",
            "gemini-api",
          ] as AgentProviderSettings["provider"][]),
        );
        const failures: string[] = [];

        for (const provider of providers) {
          const { providerLabel, health } = await checkProvider(
            settings,
            provider,
          );
          if (health.ok) {
            set({
              status: "ready",
              version: providerLabel,
              accountEmail: firstLine(health.message),
              error: null,
            });
            return;
          }
          failures.push(`${providerLabel}: ${firstLine(health.message)}`);
        }

        set({
          status: "error",
          version: null,
          accountEmail: null,
          error: failures.join("\n"),
        });
      } catch (err: any) {
        set({ status: "error", error: err?.message || String(err) });
      }
    },

    install: async () => {
      set({
        status: "error",
        error:
          "DevPrism uses Codex CLI, Gemini CLI, Gemini API, or Ollama as the primary Dev Engine. Configure one in Settings.",
      });
    },

    login: async () => {
      set({
        status: "error",
        error:
          "Sign in through Codex CLI (`codex login`), Gemini CLI (`gemini auth login`), or start Ollama locally, then retry.",
      });
    },

    toggleInstallLogs: () => {
      set((state) => ({ installLogsVisible: !state.installLogsVisible }));
    },
    _appendInstallLog: (line: string) => {
      set((state) => ({
        installLogs: [...state.installLogs, line].slice(-200),
      }));
    },
    _advanceInstallStep: () => {},
    _failCurrentStep: (error: string) => set({ error }),
    _advanceLoginStep: () => {},
    _failCurrentLoginStep: (error: string) => set({ error }),
    _finishInstall: () => {
      get().checkStatus();
    },
    _finishLogin: () => {
      get().checkStatus();
    },
  }),
);
