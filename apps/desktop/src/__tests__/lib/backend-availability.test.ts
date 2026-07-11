import { describe, expect, it } from "vitest";
import {
  deriveBackendAvailability,
  type BackendAvailabilityInput,
} from "@/lib/backend-availability";

function baseInput(
  overrides: Partial<BackendAvailabilityInput> = {},
): BackendAvailabilityInput {
  return {
    claudeStatus: "not-installed",
    claudeProviderConfigured: false,
    cursorStatus: "not-installed",
    ollamaConnected: false,
    ollamaChatModels: 0,
    ollamaLoading: false,
    groqApiKeyConfigured: false,
    openAiCredentials: [],
    ...overrides,
  };
}

describe("deriveBackendAvailability", () => {
  it("marks all backends needs-setup when nothing is configured", () => {
    const result = deriveBackendAvailability(baseInput());
    expect(result["claude-code"]).toBe("needs-setup");
    expect(result["cursor-cli"]).toBe("needs-setup");
    expect(result["native-ollama"]).toBe("needs-setup");
    expect(result["native-groq"]).toBe("needs-setup");
    expect(result["native-api"]).toBe("needs-setup");
  });

  it("treats Claude as ready when status is ready or provider configured", () => {
    expect(
      deriveBackendAvailability(baseInput({ claudeStatus: "ready" }))[
        "claude-code"
      ],
    ).toBe("ready");
    expect(
      deriveBackendAvailability(baseInput({ claudeProviderConfigured: true }))[
        "claude-code"
      ],
    ).toBe("ready");
  });

  it("reports checking while Claude or Cursor status is checking", () => {
    expect(
      deriveBackendAvailability(baseInput({ claudeStatus: "checking" }))[
        "claude-code"
      ],
    ).toBe("checking");
    expect(
      deriveBackendAvailability(baseInput({ cursorStatus: "checking" }))[
        "cursor-cli"
      ],
    ).toBe("checking");
  });

  it("marks Cursor ready only when status is ready", () => {
    expect(
      deriveBackendAvailability(baseInput({ cursorStatus: "ready" }))[
        "cursor-cli"
      ],
    ).toBe("ready");
    expect(
      deriveBackendAvailability(
        baseInput({ cursorStatus: "not-authenticated" }),
      )["cursor-cli"],
    ).toBe("needs-setup");
  });

  it("requires Ollama connected with at least one chat model", () => {
    expect(
      deriveBackendAvailability(
        baseInput({ ollamaConnected: true, ollamaChatModels: 0 }),
      )["native-ollama"],
    ).toBe("needs-setup");
    expect(
      deriveBackendAvailability(
        baseInput({ ollamaConnected: true, ollamaChatModels: 2 }),
      )["native-ollama"],
    ).toBe("ready");
    expect(
      deriveBackendAvailability(
        baseInput({
          ollamaConnected: null,
          ollamaLoading: true,
          ollamaChatModels: 0,
        }),
      )["native-ollama"],
    ).toBe("checking");
  });

  it("marks Groq ready when API key is configured", () => {
    expect(
      deriveBackendAvailability(baseInput({ groqApiKeyConfigured: true }))[
        "native-groq"
      ],
    ).toBe("ready");
  });

  it("marks native-api ready only for non-local credentials", () => {
    expect(
      deriveBackendAvailability(
        baseInput({
          openAiCredentials: [{ base_url: "http://localhost:11434/v1" }],
        }),
      )["native-api"],
    ).toBe("needs-setup");
    expect(
      deriveBackendAvailability(
        baseInput({
          openAiCredentials: [
            { base_url: "https://openrouter.ai/api/v1" },
            { base_url: "http://127.0.0.1:11434/v1" },
          ],
        }),
      )["native-api"],
    ).toBe("ready");
  });
});
