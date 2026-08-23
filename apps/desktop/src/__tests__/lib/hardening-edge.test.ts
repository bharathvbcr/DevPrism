import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOnboardingRepromptDue,
  useSetupFlowStore,
} from "@/stores/setup-flow-store";
import { isSupersededCompile } from "@/lib/latex-compiler";

/**
 * Resilience: every localStorage touchpoint must degrade to in-memory
 * behavior when storage throws (Safari private mode, quota errors, embedded
 * webviews with storage disabled). A thrown storage error must never break
 * the setup flow itself.
 */

describe("resilience: setup-flow store under storage failures", () => {
  beforeEach(() => {
    localStorage.clear();
    useSetupFlowStore.setState({
      onboardingDeferred: false,
      onboardingComplete: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function breakWrites() {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
  }

  it("deferOnboarding still applies in-memory when writes throw", () => {
    breakWrites();
    expect(() => useSetupFlowStore.getState().deferOnboarding()).not.toThrow();
    expect(useSetupFlowStore.getState().onboardingDeferred).toBe(true);
  });

  it("completeOnboarding still applies in-memory when writes throw", () => {
    useSetupFlowStore.getState().deferOnboarding();
    breakWrites();
    expect(() =>
      useSetupFlowStore.getState().completeOnboarding(),
    ).not.toThrow();
    const state = useSetupFlowStore.getState();
    expect(state.onboardingComplete).toBe(true);
    expect(state.onboardingDeferred).toBe(false);
  });

  it("isOnboardingRepromptDue treats unreadable deferral as due", () => {
    useSetupFlowStore.getState().deferOnboarding();
    // Some embedded contexts throw on *access* to localStorage entirely.
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      // Cannot confirm a deferral → default to asking again (safe direction).
      expect(isOnboardingRepromptDue()).toBe(true);
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});

describe("superseded compile recognition", () => {
  it.each([
    ["Compilation superseded by a newer edit — this build was skipped.", true],
    [new Error("Compilation was cancelled"), true],
    ["Compilation failed (Tectonic)\n\nUndefined control sequence", false],
    [new Error("Failed to compile"), false],
    [null, false],
    [42, false],
  ])("classifies %s", (input, expected) => {
    expect(isSupersededCompile(input)).toBe(expected);
  });
});
