import { useProjectStore } from "@/stores/project-store";

import { useSetupFlowStore } from "@/stores/setup-flow-store";

import { dispatchOpenProjectWizard } from "@/lib/home-flow-events";

import { InlineBanner } from "@/components/ui/inline-banner";

import { useClaudeSetupStore } from "@/stores/claude-setup-store";

import { useUvSetupStore } from "@/stores/uv-setup-store";

import { useSettingsStore } from "@/stores/settings-store";

import { useEffect, useMemo, useState } from "react";

const DISMISS_KEY = "devprism.setup-banner-dismissed";

export function SetupReminderBanner({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);

  const onboardingDeferred = useSetupFlowStore((s) => s.onboardingDeferred);

  const onboardingComplete = useSetupFlowStore((s) => s.onboardingComplete);

  const wizardActive = useSetupFlowStore((s) => s.wizardActive);

  const hasProjects = useProjectStore((s) => s.recentProjects.length > 0);

  const claudeStatus = useClaudeSetupStore((s) => s.status);

  const uvStatus = useUvSetupStore((s) => s.status);

  const checkClaude = useClaudeSetupStore((s) => s.checkStatus);

  const checkUv = useUvSetupStore((s) => s.checkStatus);

  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(DISMISS_KEY) === "1",
  );

  useEffect(() => {
    void checkClaude();

    void checkUv();
  }, [checkClaude, checkUv]);

  const setupHint = useMemo(() => {
    if (nativeAgentEnabled) {
      if (uvStatus === "not-installed") {
        return {
          title: "Install Python (uv) for scientific workflows",

          message:
            "LaTeX editing works now. Install uv from Settings to unlock Python-based skills and tools.",
        };
      }

      if (uvStatus === "checking") return null;

      return null;
    }

    const missing: string[] = [];

    if (claudeStatus !== "ready" && claudeStatus !== "checking") {
      missing.push("AI provider");
    }

    if (uvStatus !== "ready" && uvStatus !== "checking") {
      missing.push("Python (uv)");
    }

    if (missing.length === 0) return null;

    return {
      title: "Finish environment setup",

      message: `Configure ${missing.join(" and ")} in Settings to unlock the full AI writing experience.`,
    };
  }, [claudeStatus, nativeAgentEnabled, uvStatus]);

  if (dismissed || onboardingComplete || wizardActive) {
    return null;
  }

  if (onboardingDeferred && !hasProjects) {
    return (
      <InlineBanner
        kind="info"
        title="Create your first project"
        message="You skipped environment setup. Create a project to start writing, or open Settings to finish setup when you're ready."
        actionLabel="New project"
        onAction={() => dispatchOpenProjectWizard("template")}
        secondaryActionLabel="Open Settings"
        onSecondaryAction={onOpenSettings}
        onDismiss={() => {
          sessionStorage.setItem(DISMISS_KEY, "1");

          setDismissed(true);
        }}
        className="rounded-none border-x-0 border-t-0"
      />
    );
  }

  if (onboardingDeferred || !setupHint) {
    return null;
  }

  return (
    <InlineBanner
      kind="info"
      title={setupHint.title}
      message={setupHint.message}
      actionLabel="Open Settings"
      onAction={onOpenSettings}
      onDismiss={() => {
        sessionStorage.setItem(DISMISS_KEY, "1");

        setDismissed(true);
      }}
      className="rounded-none border-x-0 border-t-0"
    />
  );
}
