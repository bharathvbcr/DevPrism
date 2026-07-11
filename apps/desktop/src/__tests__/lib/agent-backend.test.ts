import { describe, expect, it } from "vitest";
import {
  AGENT_BACKENDS,
  isAgentBackend,
  isNativeApiBackend,
  isNativeBackend,
  isNativeOpenAiCompatBackend,
  migrateNativeAgentEnabled,
} from "@/lib/agent-backend";

describe("agent-backend", () => {
  it("migrates legacy nativeAgentEnabled boolean", () => {
    expect(migrateNativeAgentEnabled(true)).toBe("native-ollama");
    expect(migrateNativeAgentEnabled(false)).toBe("claude-code");
  });

  it("recognizes all backend ids", () => {
    for (const backend of AGENT_BACKENDS) {
      expect(isAgentBackend(backend.id)).toBe(true);
    }
    expect(isAgentBackend("unknown")).toBe(false);
  });

  it("groups native backends", () => {
    expect(isNativeBackend("native-ollama")).toBe(true);
    expect(isNativeBackend("native-api")).toBe(true);
    expect(isNativeBackend("native-groq")).toBe(true);
    expect(isNativeBackend("claude-code")).toBe(false);
    expect(isNativeBackend("cursor-cli")).toBe(false);
  });

  it("treats native-api and native-groq as OpenAI-compat", () => {
    expect(isNativeApiBackend("native-api")).toBe(true);
    expect(isNativeOpenAiCompatBackend("native-api")).toBe(true);
    expect(isNativeOpenAiCompatBackend("native-groq")).toBe(true);
    expect(isNativeOpenAiCompatBackend("native-ollama")).toBe(false);
  });
});
