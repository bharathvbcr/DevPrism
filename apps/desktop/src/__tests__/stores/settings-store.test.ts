import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";

describe("useSettingsStore provider and knowledge settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      personalBio: "",
      resumeProfile: "",
      manualExperience: "",
      evidenceEntries: "",
      redactSecrets: true,
      safeMode: true,
      agentProviderSettings: {
        provider: "gemini-cli",
        model: "gemini-1.5-pro",
        backendMode: "cli",
        geminiApiKey: "",
        geminiCliModel: "gemini-1.5-pro",
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "llama3",
      },
    });
  });

  it("persists provider changes through the backend settings command", async () => {
    await useSettingsStore.getState().setAgentProviderSettings({
      provider: "ollama",
      backendMode: "local",
      model: "qwen2.5-coder",
      ollamaModel: "qwen2.5-coder",
    });

    expect(invoke).toHaveBeenCalledWith(
      "set_agent_provider_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          provider: "ollama",
          backendMode: "local",
          model: "qwen2.5-coder",
          ollamaModel: "qwen2.5-coder",
        }),
      }),
    );
  });

  it("loads provider, resume knowledge, and security settings from backend", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_personal_bio") return "Builder";
      if (command === "get_redact_secrets") return false;
      if (command === "get_safe_mode") return true;
      if (command === "get_agent_provider_settings") {
        return {
          provider: "gemini-cli",
          model: "gemini-2.5-pro",
          backendMode: "cli",
          geminiApiKey: "",
          geminiCliModel: "gemini-2.5-flash",
          ollamaBaseUrl: "http://localhost:11434",
          ollamaModel: "llama3",
        };
      }
      if (command === "get_resume_knowledge_settings") {
        return {
          resumeProfile: "Staff role",
          manualExperience: "Built systems",
          evidenceEntries: "Evidence",
        };
      }
      return null;
    });

    await useSettingsStore.getState().loadFromBackend();

    expect(useSettingsStore.getState().personalBio).toBe("Builder");
    expect(useSettingsStore.getState().redactSecrets).toBe(false);
    expect(useSettingsStore.getState().resumeProfile).toBe("Staff role");
    expect(useSettingsStore.getState().agentProviderSettings.provider).toBe(
      "gemini-cli",
    );
  });

  it("maps legacy provider settings to Codex CLI on load", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_personal_bio") return "";
      if (command === "get_redact_secrets") return true;
      if (command === "get_safe_mode") return true;
      if (command === "get_agent_provider_settings") {
        return {
          provider: ["clau", "de"].join(""),
          model: "legacy-model",
          backendMode: "cli",
          geminiApiKey: "",
          geminiCliModel: "gemini-1.5-pro",
          codexCliModel: "gpt-5.2",
          ollamaBaseUrl: "http://localhost:11434",
          ollamaModel: "llama3",
        };
      }
      if (command === "get_resume_knowledge_settings") {
        return {
          resumeProfile: "",
          manualExperience: "",
          evidenceEntries: "",
        };
      }
      return null;
    });

    await useSettingsStore.getState().loadFromBackend();

    expect(useSettingsStore.getState().agentProviderSettings).toMatchObject({
      provider: "codex-cli",
      backendMode: "cli",
      model: "gpt-5.2",
    });
  });
});
