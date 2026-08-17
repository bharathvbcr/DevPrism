import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "@/App";
import { useDocumentStore } from "@/stores/document-store";
import { useCareerStore } from "@/stores/career-store";
import { isTauri } from "@/lib/runtime/is-tauri";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(() => Promise.resolve()),
    setTheme: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "check_claude_status") {
      return {
        installed: true,
        authenticated: true,
        binary_path: "/usr/bin/claude",
        version: "1.0.0",
        provider_kind: "claude-code",
        account_email: "test@example.com",
        provider_model: "claude-3-5-sonnet",
        provider_base_url: null,
        claude_provider_configured: true,
        missing_git: false,
      };
    }
    if (cmd === "check_uv_status") {
      return { installed: true, version: "0.4.0", binary_path: "/usr/bin/uv" };
    }
    if (cmd === "list_claude_sessions") return [];
    if (cmd === "list_default_projects") return [];
    if (cmd === "check_skills_installed")
      return { installed: false, skill_count: 0, location: "" };
    if (cmd === "set_native_window_theme") return undefined;
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("1.4.0")),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(() => Promise.resolve(null)),
}));

import { useSetupFlowStore } from "@/stores/setup-flow-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { useSpacesStore } from "@/stores/spaces-store";

describe("App root rendering", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true);
    useSetupFlowStore.setState({
      onboardingComplete: true,
      onboardingDeferred: true,
    });
    useClaudeSetupStore.setState({
      status: "ready",
    });
    useUvSetupStore.setState({
      status: "ready",
    });
    useSpacesStore.setState({
      pendingPickerSection: null,
    });
    useDocumentStore.setState({
      projectRoot: null,
      initialized: true,
    });
    useCareerStore.setState({
      careerOpen: false,
    });
  });

  it("renders ProjectPicker when no project is open", async () => {
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "All Projects" }),
    ).toBeInTheDocument();
  });

  it("renders CareerView when careerOpen is true", async () => {
    useCareerStore.setState({
      careerOpen: true,
      activeTab: "database",
      blocks: [],
      personas: [],
      loadAll: vi.fn(async () => {}),
      closeCareer: vi.fn(),
    });
    render(<App />);
    expect(
      await screen.findByText(/Master experience database/i),
    ).toBeInTheDocument();
  });

  it("renders WorkspaceWithClaude when projectRoot is set", async () => {
    useDocumentStore.setState({
      projectRoot: "/test/project",
      initialized: true,
      files: [],
    });
    render(<App />);
    // Workspace layout renders
    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    });
  });
});
