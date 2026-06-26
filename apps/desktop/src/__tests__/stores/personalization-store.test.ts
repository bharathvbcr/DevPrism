import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { usePersonalizationStore } from "@/stores/personalization-store";
import { buildPersonalizationContext } from "@/stores/personalization-store";
import { canUseAiAssist, aiComplete } from "@/lib/ai-assist";

vi.mock("@/lib/ai-assist", () => ({
  canUseAiAssist: vi.fn(() => false),
  aiComplete: vi.fn(() => Promise.resolve("{}")),
}));

describe("usePersonalizationStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset store state
    usePersonalizationStore.setState({
      personalizationEnabled: true,
      autoExtractEnabled: true,
      profile: {
        name: "",
        role: "",
        affiliation: "",
        writingStyle: "",
        researchInterests: [],
        customInstructions: "",
      },
      favoriteDocumentClasses: {},
      recentTopics: [],
      lastAnalyzedFile: null,
      lastAnalyzedContentHash: null,
    });
  });

  it("should have correct initial state", () => {
    const state = usePersonalizationStore.getState();
    expect(state.personalizationEnabled).toBe(true);
    expect(state.autoExtractEnabled).toBe(true);
    expect(state.profile).toEqual({
      name: "",
      role: "",
      affiliation: "",
      writingStyle: "",
      researchInterests: [],
      customInstructions: "",
    });
    expect(state.favoriteDocumentClasses).toEqual({});
  });

  it("should toggle personalizationEnabled and call set_personalization_enabled invoke", () => {
    const store = usePersonalizationStore.getState();
    store.setPersonalizationEnabled(false);
    
    expect(usePersonalizationStore.getState().personalizationEnabled).toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_personalization_enabled", { enabled: false });
  });

  it("should toggle autoExtractEnabled", () => {
    const store = usePersonalizationStore.getState();
    store.setAutoExtractEnabled(false);
    expect(usePersonalizationStore.getState().autoExtractEnabled).toBe(false);
  });

  it("should update profile fields", () => {
    const store = usePersonalizationStore.getState();
    store.updateProfile({ name: "Alice", role: "Researcher" });
    
    expect(usePersonalizationStore.getState().profile).toEqual({
      name: "Alice",
      role: "Researcher",
      affiliation: "",
      writingStyle: "",
      researchInterests: [],
      customInstructions: "",
    });
  });

  it("should add and remove research interests", () => {
    const store = usePersonalizationStore.getState();
    
    // Add new interest
    store.addResearchInterest("Quantum Computing");
    expect(usePersonalizationStore.getState().profile.researchInterests).toEqual(["Quantum Computing"]);
    
    // Add duplicate (should be ignored)
    store.addResearchInterest("Quantum Computing");
    expect(usePersonalizationStore.getState().profile.researchInterests).toEqual(["Quantum Computing"]);

    // Add empty/trimmed (should be ignored)
    store.addResearchInterest("   ");
    expect(usePersonalizationStore.getState().profile.researchInterests).toEqual(["Quantum Computing"]);
    
    // Add another
    store.addResearchInterest("Machine Learning");
    expect(usePersonalizationStore.getState().profile.researchInterests).toEqual(["Quantum Computing", "Machine Learning"]);

    // Remove interest
    store.removeResearchInterest("Quantum Computing");
    expect(usePersonalizationStore.getState().profile.researchInterests).toEqual(["Machine Learning"]);
  });

  it("should increment document class usage", () => {
    const store = usePersonalizationStore.getState();
    
    store.incrementDocumentClass("IEEEtran");
    expect(usePersonalizationStore.getState().favoriteDocumentClasses).toEqual({
      "ieeetran": 1,
    });

    store.incrementDocumentClass("ieeetran ");
    expect(usePersonalizationStore.getState().favoriteDocumentClasses).toEqual({
      "ieeetran": 2,
    });

    store.incrementDocumentClass("article");
    expect(usePersonalizationStore.getState().favoriteDocumentClasses).toEqual({
      "ieeetran": 2,
      "article": 1,
    });
  });

  it("should reset profile and call clear_personalization_profile invoke", () => {
    const store = usePersonalizationStore.getState();
    
    store.updateProfile({ name: "Alice", affiliation: "MIT" });
    store.incrementDocumentClass("article");
    store.addResearchInterest("Math");
    
    store.resetProfile();
    
    const state = usePersonalizationStore.getState();
    expect(state.profile.name).toBe("");
    expect(state.profile.affiliation).toBe("");
    expect(state.profile.researchInterests).toEqual([]);
    expect(state.favoriteDocumentClasses).toEqual({});
    expect(invoke).toHaveBeenCalledWith("clear_personalization_profile");
  });

  describe("analyzeLaTeXContent", () => {
    it("should extract details from basic LaTeX structures", () => {
      const content = `
        \\documentclass{article}
        \\title{A New Approach to Quantum Computing and Deep Learning}
        \\author{John Doe}
        \\institute{MIT}
        \\begin{document}
        hello world
        \\end{document}
      `;
      
      const store = usePersonalizationStore.getState();
      store.analyzeLaTeXContent("main.tex", content);
      
      const state = usePersonalizationStore.getState();
      expect(state.profile.name).toBe("John Doe");
      expect(state.profile.affiliation).toBe("MIT");
      expect(state.profile.researchInterests).toContain("Quantum Computing");
      expect(state.profile.researchInterests).toContain("Deep Learning");
      expect(state.favoriteDocumentClasses["article"]).toBe(1);
      expect(state.lastAnalyzedFile).toBe("main.tex");
    });

    it("should skip if autoExtractEnabled is false", () => {
      const content = `
        \\documentclass{article}
        \\author{John Doe}
      `;
      
      const store = usePersonalizationStore.getState();
      store.setAutoExtractEnabled(false);
      store.analyzeLaTeXContent("main.tex", content);
      
      const state = usePersonalizationStore.getState();
      expect(state.profile.name).toBe("");
      expect(state.favoriteDocumentClasses["article"]).toBeUndefined();
    });

    it("should skip if already analyzed and content hash has not changed", () => {
      const content = `
        \\documentclass{book}
        \\author{Bob}
      `;
      
      const store = usePersonalizationStore.getState();
      store.analyzeLaTeXContent("main.tex", content);
      
      expect(usePersonalizationStore.getState().profile.name).toBe("Bob");
      
      // Update name to something else manually
      store.updateProfile({ name: "ManualOverride" });
      
      // Run analyze again on same file & content - should be skipped
      store.analyzeLaTeXContent("main.tex", content);
      expect(usePersonalizationStore.getState().profile.name).toBe("ManualOverride");

      // Change content, should run again
      store.analyzeLaTeXContent("main.tex", content + "\n% change");
      // Since manual override was set, it won't overwrite name (profile.name is already set)
      // but it will increment document class again
      expect(usePersonalizationStore.getState().favoriteDocumentClasses["book"]).toBe(2);
    });
  });

  describe("analyzeChatConversation", () => {
    it("should extract details using basic regex patterns from chat log", async () => {
      const messages = [
        {
          id: "1",
          type: "user" as const,
          message: {
            content: [
              {
                type: "text" as const,
                text: "Hello, my name is Alice and I am a phd student from Stanford.",
              },
            ],
          },
        },
      ];
      
      const store = usePersonalizationStore.getState();
      await store.analyzeChatConversation(messages);
      
      const state = usePersonalizationStore.getState();
      expect(state.profile.name).toBe("Alice");
      expect(state.profile.role).toBe("phd student");
      expect(state.profile.affiliation).toBe("Stanford");
    });

    it("should skip if autoExtractEnabled is false", async () => {
      const messages = [
        {
          id: "1",
          type: "user" as const,
          message: {
            content: [{ type: "text" as const, text: "Hello, my name is Alice." }],
          },
        },
      ];
      
      const store = usePersonalizationStore.getState();
      store.setAutoExtractEnabled(false);
      await store.analyzeChatConversation(messages);
      
      expect(usePersonalizationStore.getState().profile.name).toBe("");
    });
  });

  describe("buildPersonalizationContext", () => {
    it("should return empty string if personalization is disabled", () => {
      const store = usePersonalizationStore.getState();
      store.setPersonalizationEnabled(false);
      store.updateProfile({ name: "Bob" });
      
      expect(buildPersonalizationContext()).toBe("");
    });

    it("should format active profile fields into instructions block", () => {
      const store = usePersonalizationStore.getState();
      store.updateProfile({
        name: "Alice",
        role: "Professor",
        affiliation: "Harvard",
        writingStyle: "Sleek and concise",
        customInstructions: "Prefer active voice.",
      });
      store.addResearchInterest("Astrobiology");
      store.incrementDocumentClass("IEEEtran");
      
      const context = buildPersonalizationContext();
      
      expect(context).toContain("## USER PROFILE (Local on-device personalization)");
      expect(context).toContain("- Name: Alice");
      expect(context).toContain("- Role: Professor");
      expect(context).toContain("- Affiliation: Harvard");
      expect(context).toContain("- Writing Style: Sleek and concise");
      expect(context).toContain("- Research Interests: Astrobiology");
      expect(context).toContain("- Instructions: Prefer active voice.");
      expect(context).toContain("- Preferred document classes: ieeetran");
    });
  });

  describe("triggerAiRefinement", () => {
    it("should run AI assist extraction and update store when enabled", async () => {
      vi.mocked(canUseAiAssist).mockReturnValue(true);
      vi.mocked(aiComplete).mockResolvedValue(JSON.stringify({
        name: "Charlie",
        role: "Postdoc",
        affiliation: "Caltech",
        writingStyle: "Technical, direct",
        researchInterests: ["Cosmology", "String Theory"],
      }));

      const store = usePersonalizationStore.getState();
      await store.triggerAiRefinement("some document text", "LaTeX document");

      const state = usePersonalizationStore.getState();
      expect(state.profile.name).toBe("Charlie");
      expect(state.profile.role).toBe("Postdoc");
      expect(state.profile.affiliation).toBe("Caltech");
      expect(state.profile.writingStyle).toBe("Technical, direct");
      expect(state.profile.researchInterests).toContain("Cosmology");
      expect(state.profile.researchInterests).toContain("String Theory");
    });

    it("should handle partial updates and invalid JSON safely", async () => {
      vi.mocked(canUseAiAssist).mockReturnValue(true);
      
      // Return invalid JSON - should handle gracefully without throwing
      vi.mocked(aiComplete).mockResolvedValue("invalid json string");
      
      const store = usePersonalizationStore.getState();
      await expect(store.triggerAiRefinement("some text", "context")).resolves.not.toThrow();
    });
  });
});
