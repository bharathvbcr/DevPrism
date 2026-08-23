import { beforeEach, describe, expect, it } from "vitest";
import {
  isOnboardingRepromptDue,
  ONBOARDING_REPROMPT_AFTER_MS,
  useSetupFlowStore,
} from "@/stores/setup-flow-store";

describe("setup-flow-store persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useSetupFlowStore.setState({
      onboardingDeferred: false,
      onboardingComplete: false,
    });
  });

  it("deferOnboarding survives a simulated app restart", () => {
    useSetupFlowStore.getState().deferOnboarding();
    expect(localStorage.getItem("devprism.env-onboarding-deferred")).toBe("1");

    // Simulate restart: rehydrate from durable storage.
    useSetupFlowStore.getState().hydrateFromSession();
    expect(useSetupFlowStore.getState().onboardingDeferred).toBe(true);
  });

  it("completeOnboarding is durable and clears the deferral", () => {
    useSetupFlowStore.getState().deferOnboarding();
    useSetupFlowStore.getState().completeOnboarding();

    expect(localStorage.getItem("devprism.env-onboarding-deferred")).toBeNull();
    expect(localStorage.getItem("devprism.env-onboarding-complete")).toBe("1");

    useSetupFlowStore.getState().hydrateFromSession();
    const state = useSetupFlowStore.getState();
    expect(state.onboardingComplete).toBe(true);
    expect(state.onboardingDeferred).toBe(false);
  });

  it("a fresh deferral suppresses the re-prompt", () => {
    expect(isOnboardingRepromptDue()).toBe(true); // never deferred
    useSetupFlowStore.getState().deferOnboarding();
    expect(isOnboardingRepromptDue()).toBe(false);
  });

  it("the re-prompt comes due after the deferral window", () => {
    useSetupFlowStore.getState().deferOnboarding();
    // Age the deferral past the window.
    const at = Number(
      localStorage.getItem("devprism.env-onboarding-deferred-at"),
    );
    localStorage.setItem(
      "devprism.env-onboarding-deferred-at",
      String(at - ONBOARDING_REPROMPT_AFTER_MS - 1000),
    );
    expect(isOnboardingRepromptDue()).toBe(true);
  });
});
