import anthropicIcon from "@/assets/providers/anthropic.svg";
import deepseekIcon from "@/assets/providers/deepseek.svg";
import geminiIcon from "@/assets/providers/gemini-color.svg";
import qwenIcon from "@/assets/providers/qwen.svg";
import zhipuIcon from "@/assets/providers/zhipu-color.svg";

interface ProviderIconInput {
  label?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  id?: string | null;
}

export function getProviderIconSrc(input: ProviderIconInput): string | null {
  const haystack = [
    input.id,
    input.label,
    input.baseUrl,
    input.model,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

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
    haystack.includes("googleapis") ||
    haystack.includes("generativelanguage")
  ) {
    return geminiIcon;
  }

  if (
    haystack.includes("anthropic") ||
    haystack.includes("claude") ||
    haystack.includes("sk-ant")
  ) {
    return anthropicIcon;
  }

  return null;
}
