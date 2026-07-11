import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface CursorCliStatus {
  installed: boolean;
  authenticated: boolean;
  binary_path: string | null;
  version: string | null;
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

interface CursorSetupState {
  status: SetupStatus;
  isInstalling: boolean;
  isLoggingIn: boolean;
  isSavingApiKey: boolean;
  error: string | null;
  version: string | null;
  installSteps: StepInfo[];
  installLogs: string[];
  installLogsVisible: boolean;
  checkStatus: () => Promise<void>;
  install: () => Promise<void>;
  login: () => Promise<void>;
  saveApiKey: (apiKey: string) => Promise<boolean>;
  toggleInstallLogs: () => void;
  _appendInstallLog: (line: string) => void;
  _advanceInstallStep: (stepId: string) => void;
  _failCurrentStep: (error: string) => void;
  _finishInstall: (success: boolean) => void;
}

const INSTALL_STEPS: StepInfo[] = [
  { id: "installing", label: "Installing Cursor CLI", status: "pending" },
  { id: "verifying", label: "Verifying installation", status: "pending" },
  { id: "complete", label: "Ready to use", status: "pending" },
];

const STEP_ORDER = ["installing", "verifying", "complete"];

export const useCursorSetupStore = create<CursorSetupState>((set, get) => ({
  status: "checking",
  isInstalling: false,
  isLoggingIn: false,
  isSavingApiKey: false,
  error: null,
  version: null,
  installSteps: INSTALL_STEPS.map((s) => ({ ...s })),
  installLogs: [],
  installLogsVisible: false,

  checkStatus: async () => {
    set({ status: "checking", error: null });
    try {
      const result = await invoke<CursorCliStatus>("check_cursor_cli_status");
      set({
        version: result.version,
        status: result.authenticated
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
      await invoke("install_cursor_cli");
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

  login: async () => {
    set({ isLoggingIn: true, error: null });
    try {
      await invoke("login_cursor_cli");
      await get().checkStatus();
      set({ isLoggingIn: false });
    } catch (err: unknown) {
      set({
        isLoggingIn: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  saveApiKey: async (apiKey) => {
    set({ isSavingApiKey: true, error: null });
    try {
      await invoke("save_cursor_api_key", { apiKey });
      await get().checkStatus();
      set({ isSavingApiKey: false });
      return true;
    } catch (err: unknown) {
      set({
        isSavingApiKey: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
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
