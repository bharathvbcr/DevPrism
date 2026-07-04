/** Home-screen flows (project picker) that onboarding can hand off to. */

import { useDocumentStore } from "@/stores/document-store";

import { useSpacesStore } from "@/stores/spaces-store";

export const OPEN_PROJECT_WIZARD_EVENT = "devprism:open-project-wizard";

export type ProjectWizardLaunchMode = "template" | "scratch";

export type SettingsDetailSection =
  | "provider"
  | "environment"
  | "editor"
  | "compilation"
  | "appearance"
  | "ai"
  | "personalization";

export function dispatchOpenProjectWizard(
  mode: ProjectWizardLaunchMode = "template",

  options?: { fromOnboarding?: boolean },
) {
  window.dispatchEvent(
    new CustomEvent(OPEN_PROJECT_WIZARD_EVENT, {
      detail: { mode, fromOnboarding: options?.fromOnboarding ?? false },
    }),
  );
}

/** Navigate home and open Settings, optionally focused on a detail section. */

export function dispatchOpenSettings(section?: SettingsDetailSection) {
  useSpacesStore.getState().setPendingPickerSection("settings");

  if (section) {
    useSpacesStore.getState().setPendingSettingsDetailSection(section);
  }

  useDocumentStore.getState().closeProject();
}
