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

async function waitForBodyText(text: string) {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
    if (document.body.textContent?.includes(text)) return;
  }
  expect(document.body.textContent).toContain(text);
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
    vi.mocked(save).mockResolvedValue("C:/tmp/devprism-knowledgebase.json");
    vi.mocked(open).mockResolvedValue("C:/tmp/devprism-knowledgebase.json");

    clickByText("Knowledgebase");
    await act(async () => {});

    clickByText("Export");
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("export_knowledgebase", {
      path: "C:/tmp/devprism-knowledgebase.json",
    });

    clickByText("Import");
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("import_knowledgebase", {
      path: "C:/tmp/devprism-knowledgebase.json",
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

  it("only lists manually managed skills in the Skills tab", async () => {
    act(() => root.unmount());
    root = createRoot(host);
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "slash_commands_list") {
        return [
          {
            id: "skill-manual-review",
            name: "manual-review",
            scope: "skill",
            full_command: "/manual-review",
            description: "Manual review helper",
            content: "# Manual",
            is_manual_skill: true,
          },
          {
            id: "skill-installed-science",
            name: "installed-science",
            scope: "skill",
            full_command: "/installed-science",
            description: "Installed scientific pack",
            content: "# Installed",
            is_manual_skill: false,
          },
        ];
      }
      if (command === "list_authorized_paths") return [];
      if (command === "list_project_summaries") return [];
      if (command === "list_linked_projects") return [];
      return null;
    });

    await act(async () => {
      root.render(
        <SettingsDialog open={true} onClose={() => {}} initialTab="skills" />,
      );
    });
    await act(async () => {});

    expect(document.body.textContent).toContain("/manual-review");
    expect(document.body.textContent).not.toContain("/installed-science");
  });

  it("keeps installed skills hidden after saving a manual skill", async () => {
    act(() => root.unmount());
    root = createRoot(host);
    let listCount = 0;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "manual_skill_save") return null;
      if (command === "slash_commands_list") {
        listCount += 1;
        return listCount === 1
          ? []
          : [
              {
                id: "skill-saved-review",
                name: "saved-review",
                scope: "skill",
                full_command: "/saved-review",
                description: "Saved helper",
                content: "# Saved",
                is_manual_skill: true,
              },
              {
                id: "skill-installed-science",
                name: "installed-science",
                scope: "skill",
                full_command: "/installed-science",
                description: "Installed scientific pack",
                content: "# Installed",
                is_manual_skill: false,
              },
            ];
      }
      if (command === "list_authorized_paths") return [];
      if (command === "list_project_summaries") return [];
      if (command === "list_linked_projects") return [];
      return null;
    });

    await act(async () => {
      root.render(
        <SettingsDialog open={true} onClose={() => {}} initialTab="skills" />,
      );
    });
    await act(async () => {});

    const nameInput = document.body.querySelector(
      'input[placeholder="Skill name"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(nameInput, "Saved Review");
      const textarea = document.body.querySelector("textarea")!;
      setInputValue(textarea, "# Saved\nCheck risks.");
    });
    clickByText("Save Manual Skill");
    await waitForBodyText("/saved-review");

    expect(document.body.textContent).toContain("/saved-review");
    expect(document.body.textContent).not.toContain("/installed-science");
  });

  it("opens directly to the requested settings tab", async () => {
    await act(async () => {
      root.render(
        <SettingsDialog
          open={true}
          onClose={() => {}}
          initialTab="knowledge"
        />,
      );
    });

    expect(document.body.textContent).toContain("Knowledgebase portability");
    expect(document.body.textContent).toContain("Link Project");
    expect(document.body.textContent).not.toContain("Active provider");
  });

  it("does not reset to the launch tab when settings refresh", async () => {
    await act(async () => {
      root.render(
        <SettingsDialog
          open={true}
          onClose={() => {}}
          initialTab="knowledge"
        />,
      );
    });

    clickByText("Skills");
    await act(async () => {
      root.render(
        <SettingsDialog
          open={true}
          onClose={() => {}}
          initialTab="knowledge"
        />,
      );
      useSettingsStore.setState({ resumeProfile: "Updated target" });
    });

    expect(document.body.textContent).toContain("Save Manual Skill");
    expect(document.body.textContent).not.toContain(
      "Knowledgebase portability",
    );
  });
});
