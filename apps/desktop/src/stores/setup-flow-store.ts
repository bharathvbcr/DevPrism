import { create } from "zustand";

const DEFERRED_KEY = "devprism.env-onboarding-deferred";
const DEFERRED_AT_KEY = "devprism.env-onboarding-deferred-at";
const COMPLETE_KEY = "devprism.env-onboarding-complete";

/**
 * How long "Set up later" suppresses the environment-setup dialog.
 *
 * Deferral used to live in sessionStorage, so it was forgotten on every
 * launch and the full-screen dialog re-served itself each start until the
 * user either finished setup or created a project. Durable storage plus this
 * re-prompt window gives a sane nag cadence instead.
 */
export const ONBOARDING_REPROMPT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function deferredAt(): number {
  try {
    const raw = localStorage.getItem(DEFERRED_AT_KEY);
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** True when enough time has passed since the last deferral to ask again. */
export function isOnboardingRepromptDue(): boolean {
  if (!readFlag(DEFERRED_KEY)) return true;
  return Date.now() - deferredAt() > ONBOARDING_REPROMPT_AFTER_MS;
}

interface SetupFlowState {
  /** True while project wizard / template creation flow is active. */
  wizardActive: boolean;
  setWizardActive: (active: boolean) => void;
  /** True when the wizard was opened from environment onboarding. */
  launchedFromOnboarding: boolean;
  setLaunchedFromOnboarding: (active: boolean) => void;
  onboardingDeferred: boolean;
  onboardingComplete: boolean;
  deferOnboarding: () => void;
  completeOnboarding: () => void;
  hydrateFromSession: () => void;
}

export const useSetupFlowStore = create<SetupFlowState>((set) => ({
  wizardActive: false,
  launchedFromOnboarding: false,
  // Durable across launches (localStorage): a user's "done"/"later" choice
  // must survive restarts.
  onboardingDeferred: readFlag(DEFERRED_KEY),
  onboardingComplete: readFlag(COMPLETE_KEY),

  setWizardActive: (active) => set({ wizardActive: active }),

  setLaunchedFromOnboarding: (active) =>
    set({ launchedFromOnboarding: active }),

  deferOnboarding: () => {
    try {
      localStorage.setItem(DEFERRED_KEY, "1");
      localStorage.setItem(DEFERRED_AT_KEY, String(Date.now()));
      localStorage.removeItem("devprism.setup-banner-dismissed");
      localStorage.removeItem("devprism.setup-banner-dismissed-at");
    } catch {
      /* storage unavailable — in-memory state still applies for this run */
    }
    set({ onboardingDeferred: true });
  },

  completeOnboarding: () => {
    try {
      localStorage.setItem(COMPLETE_KEY, "1");
      localStorage.removeItem(DEFERRED_KEY);
      localStorage.removeItem(DEFERRED_AT_KEY);
    } catch {
      /* storage unavailable */
    }
    set({ onboardingComplete: true, onboardingDeferred: false });
  },

  hydrateFromSession: () =>
    set({
      onboardingDeferred: readFlag(DEFERRED_KEY),
      onboardingComplete: readFlag(COMPLETE_KEY),
    }),
}));
