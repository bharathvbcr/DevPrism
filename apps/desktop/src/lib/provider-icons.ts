import anthropicIcon from "@/assets/providers/anthropic.svg";
import cursorIcon from "@/assets/providers/cursor.svg";
import deepseekIcon from "@/assets/providers/deepseek.svg";
import geminiIcon from "@/assets/providers/gemini-color.svg";
import groqIcon from "@/assets/providers/groq.svg";
import moonshotIcon from "@/assets/providers/moonshot.svg";
import ollamaIcon from "@/assets/providers/ollama.svg";
import openaiIcon from "@/assets/providers/openai.svg";
import openrouterIcon from "@/assets/providers/openrouter.svg";
import qwenIcon from "@/assets/providers/qwen.svg";
import zhipuIcon from "@/assets/providers/zhipu-color.svg";
import type { AgentBackend } from "@/lib/agent-backend";

interface ProviderIconInput {
  label?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  id?: string | null;
}

function providerHaystack(input: ProviderIconInput) {
  return [input.id, input.label, input.baseUrl, input.model]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isGenericOpenAiLabel(label?: string | null) {
  const normalized = label?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "custom openai api" ||
    normalized === "openai-compatible provider"
  );
}

export function getProviderDisplayName(input: ProviderIconInput): string {
  const haystack = providerHaystack(input);

  if (
    haystack.includes("ollama") ||
    haystack.includes("localhost:11434") ||
    haystack.includes("127.0.0.1:11434")
  ) {
    return "Ollama";
  }

  if (
    haystack.includes("qwen") ||
    haystack.includes("dashscope") ||
    haystack.includes("aliyuncs")
  ) {
    return "Qwen";
  }

  if (haystack.includes("deepseek")) {
    return "DeepSeek";
  }

  if (
    haystack.includes("glm") ||
    haystack.includes("zhipu") ||
    haystack.includes("bigmodel") ||
    haystack.includes("open.bigmodel.cn")
  ) {
    return "GLM";
  }

  if (
    haystack.includes("gemini") ||
    haystack.includes("aiplatform") ||
    haystack.includes("googleapis") ||
    haystack.includes("generativelanguage")
  ) {
    return "Gemini";
  }

  if (
    haystack.includes("moonshot") ||
    haystack.includes("kimi") ||
    haystack.includes("api.moonshot.cn")
  ) {
    return "Moonshot / Kimi";
  }

  if (haystack.includes("groq") || haystack.includes("api.groq.com")) {
    return "Groq";
  }

  if (haystack.includes("cursor")) {
    return "Cursor";
  }

  if (
    haystack.includes("anthropic") ||
    haystack.includes("claude") ||
    haystack.includes("sk-ant")
  ) {
    return "Anthropic";
  }

  if (haystack.includes("openrouter")) {
    return "OpenRouter";
  }

  if (haystack.includes("openai") || haystack.includes("api.openai.com")) {
    return "OpenAI";
  }

  if (!isGenericOpenAiLabel(input.label)) {
    return input.label!.trim();
  }

  return "Provider";
}

export function getProviderIconSrc(input: ProviderIconInput): string | null {
  const haystack = providerHaystack(input);

  if (
    haystack.includes("ollama") ||
    haystack.includes("localhost:11434") ||
    haystack.includes("127.0.0.1:11434")
  ) {
    return ollamaIcon;
  }

  if (
    haystack.includes("qwen") ||
    haystack.includes("dashscope") ||
    haystack.includes("aliyuncs")
  ) {
    return qwenIcon;
  }

  if (haystack.includes("deepseek")) {
    return deepseekIcon;
  }

  if (
    haystack.includes("glm") ||
    haystack.includes("zhipu") ||
    haystack.includes("bigmodel") ||
    haystack.includes("open.bigmodel.cn")
  ) {
    return zhipuIcon;
  }

  if (
    haystack.includes("gemini") ||
    haystack.includes("aiplatform") ||
    haystack.includes("googleapis") ||
    haystack.includes("generativelanguage")
  ) {
    return geminiIcon;
  }

  if (
    haystack.includes("moonshot") ||
    haystack.includes("kimi") ||
    haystack.includes("api.moonshot.cn")
  ) {
    return moonshotIcon;
  }

  if (haystack.includes("groq") || haystack.includes("api.groq.com")) {
    return groqIcon;
  }

  if (haystack.includes("cursor")) {
    return cursorIcon;
  }

  if (
    haystack.includes("anthropic") ||
    haystack.includes("claude") ||
    haystack.includes("sk-ant")
  ) {
    return anthropicIcon;
  }

  if (haystack.includes("openrouter")) {
    return openrouterIcon;
  }

  if (haystack.includes("openai") || haystack.includes("api.openai.com")) {
    return openaiIcon;
  }

  return null;
}

/** Icon for an agent backend row in the composer Agent switcher. */
export function getBackendIconSrc(backend: AgentBackend): string | null {
  switch (backend) {
    case "native-ollama":
      return getProviderIconSrc({ label: "Ollama" });
    case "native-groq":
      return getProviderIconSrc({ label: "Groq" });
    case "native-api":
      return getProviderIconSrc({ label: "OpenAI" });
    case "claude-code":
      return getProviderIconSrc({ label: "Anthropic" });
    case "cursor-cli":
      return getProviderIconSrc({ label: "Cursor" });
  }
}
