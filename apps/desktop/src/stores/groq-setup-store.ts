import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { GROQ_DEFAULT_MODEL, GROQ_PROVIDER_BASE } from "@/lib/agent-backend";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";

interface GroqCliStatus {
  installed: boolean;
  binary_path: string | null;
  version: string | null;
  api_key_configured: boolean;
}

type SetupStatus =
  | "checking"
  | "not-installed"
  | "not-authenticated"
  | "ready"
  | "error";

type StepStatus = "pending" | "active" | "complete" | "error";

export interface StepInfo {
  id: string;
  label: string;
  status: StepStatus;
}

interface GroqSetupState {
  status: SetupStatus;
  isInstalling: boolean;
  isVerifyingKey: boolean;
  error: string | null;
  version: string | null;
  apiKeyConfigured: boolean;
  installSteps: StepInfo[];
  installLogs: string[];
  installLogsVisible: boolean;
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  verifyApiKey: (apiKey: string) => Promise<boolean>;
  listModels: (apiKey: string) => Promise<string[]>;
  toggleInstallLogs: () => void;
  _appendInstallLog: (line: string) => void;
  _advanceInstallStep: (stepId: string) => void;
  _failCurrentStep: (error: string) => void;
  _finishInstall: (success: boolean) => void;
}

const INSTALL_STEPS: StepInfo[] = [
  { id: "installing", label: "Installing groq-code-cli", status: "pending" },
  { id: "verifying", label: "Verifying installation", status: "pending" },
  { id: "complete", label: "Ready to use", status: "pending" },
];

const STEP_ORDER = ["installing", "verifying", "complete"];

export const useGroqSetupStore = create<GroqSetupState>((set, get) => ({
  status: "checking",
  isInstalling: false,
  isVerifyingKey: false,
  error: null,
  version: null,
  apiKeyConfigured: false,
  installSteps: INSTALL_STEPS.map((s) => ({ ...s })),
  installLogs: [],
  installLogsVisible: false,

  checkStatus: async () => {
    set({ status: "checking", error: null });
    try {
      const result = await invoke<GroqCliStatus>("check_groq_cli_status");
      set({
        version: result.version,
        apiKeyConfigured: result.api_key_configured,
        status: result.api_key_configured
          ? "ready"
          : result.installed
            ? "not-authenticated"
            : "not-installed",
      });
    } catch (err: unknown) {
      set({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  install: async () => {
    set({
      isInstalling: true,
      error: null,
      installLogs: [],
      installSteps: INSTALL_STEPS.map((s) => ({ ...s })),
    });
    get()._advanceInstallStep("installing");

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<string>("install-output", (event) => {
        get()._appendInstallLog(event.payload);
      });
      await invoke("install_groq_cli");
      get()._advanceInstallStep("verifying");
      await get().checkStatus();
      get()._finishInstall(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      get()._failCurrentStep(message);
      get()._finishInstall(false);
    } finally {
      unlisten?.();
    }
  },

  verifyApiKey: async (apiKey) => {
    set({ isVerifyingKey: true, error: null });
    try {
      await invoke("verify_groq_api_key", {
        apiKey,
        baseUrl: GROQ_PROVIDER_BASE,
      });
      await invoke("verify_openai_compatible_api_key", {
        apiKey,
        baseUrl: GROQ_PROVIDER_BASE,
        model: GROQ_DEFAULT_MODEL,
      });
      await invoke("save_anthropic_api_key", {
        apiKey,
        baseUrl: GROQ_PROVIDER_BASE,
        provider: "openai-compatible",
        model: GROQ_DEFAULT_MODEL,
        credentialLabel: "Groq",
      });
      set({ isVerifyingKey: false });
      await useClaudeSetupStore.getState().listApiCredentials();
      await get().checkStatus();
      return true;
    } catch (err: unknown) {
      set({
        isVerifyingKey: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  listModels: async (apiKey) => {
    return invoke<string[]>("list_groq_models", { apiKey });
  },

  toggleInstallLogs: () =>
    set((s) => ({ installLogsVisible: !s.installLogsVisible })),

  _appendInstallLog: (line) =>
    set((s) => ({ installLogs: [...s.installLogs, line] })),

  _advanceInstallStep: (stepId) =>
    set((s) => {
      const idx = STEP_ORDER.indexOf(stepId);
      return {
        installSteps: s.installSteps.map((step, i) => ({
          ...step,
          status: i < idx ? "complete" : i === idx ? "active" : step.status,
        })),
      };
    }),

  _failCurrentStep: (error) =>
    set((s) => ({
      error,
      installSteps: s.installSteps.map((step) =>
        step.status === "active" ? { ...step, status: "error" as const } : step,
      ),
    })),

  _finishInstall: (success) => {
    if (success) {
      set((s) => ({
        isInstalling: false,
        installSteps: s.installSteps.map((step) => ({
          ...step,
          status: "complete" as const,
        })),
      }));
      void get().checkStatus();
    } else {
      set({ isInstalling: false });
    }
  },
}));

export { GROQ_DEFAULT_MODEL, GROQ_PROVIDER_BASE };
