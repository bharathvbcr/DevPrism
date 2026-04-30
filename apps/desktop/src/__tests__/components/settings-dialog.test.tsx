import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "@/components/settings-dialog";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";

function clickByText(text: string) {
  const element = Array.from(document.body.querySelectorAll("button")).find(
    (node) => node.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
  expect(element).toBeTruthy();
  act(() => element!.click());
}

function setInputValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SettingsDialog knowledgebase and skills controls", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useDocumentStore.setState({ projectRoot: "/project" });
    useProjectStore.setState({ linkedProjects: [], recentProjects: [] });
    useSettingsStore.setState({
      personalBio: "",
      resumeProfile: "",
      manualExperience: "",
      evidenceEntries: "",
      redactSecrets: true,
      safeMode: true,
      agentProviderSettings: {
        provider: "gemini-api",
        model: "gemini-1.5-pro",
        backendMode: "api",
        geminiApiKey: "",
        geminiCliModel: "gemini-1.5-pro",
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "llama3",
      },
    });
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_personal_bio") return "";
      if (command === "get_redact_secrets") return true;
      if (command === "get_safe_mode") return true;
      if (command === "get_agent_provider_settings") {
        return useSettingsStore.getState().agentProviderSettings;
      }
      if (command === "get_resume_knowledge_settings") {
        return {
          resumeProfile: "",
          manualExperience: "",
          evidenceEntries: "",
        };
      }
      if (command === "list_authorized_paths") return [];
      if (command === "slash_commands_list") return [];
      if (command === "list_project_summaries") return [];
      if (command === "list_linked_projects") return [];
      return null;
    });
    await act(async () => {
      root.render(<SettingsDialog open={true} onClose={() => {}} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("exports and imports the knowledgebase through backend commands", async () => {
    vi.mocked(save).mockResolvedValue("C:/tmp/devcouncil-knowledgebase.json");
    vi.mocked(open).mockResolvedValue("C:/tmp/devcouncil-knowledgebase.json");

    clickByText("Knowledgebase");
    await act(async () => {});

    clickByText("Export");
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("export_knowledgebase", {
      path: "C:/tmp/devcouncil-knowledgebase.json",
    });

    clickByText("Import");
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("import_knowledgebase", {
      path: "C:/tmp/devcouncil-knowledgebase.json",
    });
  });

  it("saves a manual skill from the Skills tab", async () => {
    clickByText("Skills");
    await act(async () => {});

    const nameInput = document.body.querySelector(
      'input[placeholder="Skill name"]',
    ) as HTMLInputElement;
    const descriptionInput = document.body.querySelector(
      'input[placeholder="Description"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(nameInput, "Review Skill");
      setInputValue(descriptionInput, "Review code");
      const textarea = document.body.querySelector("textarea")!;
      setInputValue(textarea, "# Review\nCheck risks.");
    });

    clickByText("Save Manual Skill");
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith(
      "manual_skill_save",
      expect.objectContaining({
        scope: "global",
        name: "Review Skill",
        content: "# Review\nCheck risks.",
      }),
    );
  });
});
