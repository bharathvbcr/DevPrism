import { describe, it, expect, beforeEach } from "vitest";
import {
  proposeSelectionReplacement,
  inlineEditChatPrompt,
  canUseDirectInlineTransform,
} from "@/lib/inline-edit";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import {
  useClaudeChatStore,
  CLAUDE_CODE_PROVIDER_ID,
} from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useSettingsStore } from "@/stores/settings-store";

describe("proposeSelectionReplacement", () => {
  beforeEach(() => {
    useProposedChangesStore.setState({ changes: [] });
  });

  it("replaces only the selected span in the proposed change", () => {
    proposeSelectionReplacement(
      {
        filePath: "main.tex",
        absolutePath: "/proj/main.tex",
        content: "Hello world\nSecond line",
        from: 6,
        to: 11,
        selectedText: "world",
        contextLabel: "@main.tex:1:7-1:11",
      },
      "universe",
    );

    const change = useProposedChangesStore.getState().changes[0];
    expect(change.oldContent).toBe("Hello world\nSecond line");
    expect(change.newContent).toBe("Hello universe\nSecond line");
    expect(change.toolName).toBe("Edit");
  });
});

describe("inlineEditChatPrompt", () => {
  it("combines custom instruction with edit guardrails", () => {
    const prompt = inlineEditChatPrompt("edit", "Make this more formal");
    expect(prompt).toContain("Make this more formal");
    expect(prompt).toContain("ONLY the selected span");
  });
});

describe("canUseDirectInlineTransform", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      nativeAgentEnabled: false,
      aiAssistEnabled: true,
    });
    useClaudeChatStore.setState({
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
    });
    useClaudeSetupStore.setState({ openAiCredentials: [] });
  });

  it("is true for a configured OpenAI-compatible provider", () => {
    useClaudeSetupStore.setState({
      openAiCredentials: [
        {
          id: "openrouter",
          label: "OpenRouter",
          base_url: "https://openrouter.ai/api/v1",
          model: "gpt-4o",
        },
      ],
    });
    useClaudeChatStore.setState({
      selectedProviderCredentialId: "openrouter",
    });
    expect(canUseDirectInlineTransform()).toBe(true);
  });

  it("is false when only Claude Code is selected", () => {
    expect(canUseDirectInlineTransform()).toBe(false);
  });
});
