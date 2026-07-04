import { create } from "zustand";

const DEFERRED_KEY = "devprism.env-onboarding-deferred";
const COMPLETE_KEY = "devprism.env-onboarding-complete";

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
  onboardingDeferred: sessionStorage.getItem(DEFERRED_KEY) === "1",
  onboardingComplete: sessionStorage.getItem(COMPLETE_KEY) === "1",

  setWizardActive: (active) => set({ wizardActive: active }),

  setLaunchedFromOnboarding: (active) =>
    set({ launchedFromOnboarding: active }),

  deferOnboarding: () => {
    sessionStorage.setItem(DEFERRED_KEY, "1");
    sessionStorage.removeItem("devprism.setup-banner-dismissed");
    set({ onboardingDeferred: true });
  },

  completeOnboarding: () => {
    sessionStorage.setItem(COMPLETE_KEY, "1");
    sessionStorage.removeItem(DEFERRED_KEY);
    set({ onboardingComplete: true, onboardingDeferred: false });
  },

  hydrateFromSession: () =>
    set({
      onboardingDeferred: sessionStorage.getItem(DEFERRED_KEY) === "1",
      onboardingComplete: sessionStorage.getItem(COMPLETE_KEY) === "1",
    }),
}));
