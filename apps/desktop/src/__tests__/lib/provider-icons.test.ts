import { describe, expect, it } from "vitest";
import { getProviderDisplayName } from "@/lib/provider-icons";

describe("getProviderDisplayName", () => {
  it("derives provider names from old custom labels", () => {
    expect(
      getProviderDisplayName({
        label: "Custom OpenAI API",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.7-plus",
      }),
    ).toBe("Qwen");

    expect(
      getProviderDisplayName({
        label: "Custom OpenAI API",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-5.1",
      }),
    ).toBe("GLM");
  });

  it("keeps meaningful provider labels for unknown endpoints", () => {
    expect(
      getProviderDisplayName({
        label: "Acme AI",
        baseUrl: "https://models.example.test/v1",
        model: "acme-large",
      }),
    ).toBe("Acme AI");
  });
});
