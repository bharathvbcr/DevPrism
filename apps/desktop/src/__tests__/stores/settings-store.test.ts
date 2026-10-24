import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";

describe("useSettingsStore", () => {
  beforeEach(() => {
    // Reset to defaults between tests (persist middleware shares one instance).
    useSettingsStore.setState({
      compilerBackend: "tectonic",
      autoCompile: false,
      pdfDarkMode: false,
      vimMode: false,
      compileRootByProject: {},
    });
  });

  describe("autoCompile", () => {
    it("defaults to off", () => {
      expect(useSettingsStore.getState().autoCompile).toBe(false);
    });

    it("can be toggled on and off", () => {
      useSettingsStore.getState().setAutoCompile(true);
      expect(useSettingsStore.getState().autoCompile).toBe(true);
      useSettingsStore.getState().setAutoCompile(false);
      expect(useSettingsStore.getState().autoCompile).toBe(false);
    });
  });

  describe("embedModel / embedBaseUrl", () => {
    it("default to null (auto-pick on the chat Ollama base)", () => {
      useSettingsStore.setState({ embedModel: null, embedBaseUrl: null });
      const s = useSettingsStore.getState();
      expect(s.embedModel).toBeNull();
      expect(s.embedBaseUrl).toBeNull();
    });

    it("trim the model name and treat blank as unset", () => {
      const s = useSettingsStore.getState();
      s.setEmbedModel("  embeddinggemma-2-tessl ");
      expect(useSettingsStore.getState().embedModel).toBe(
        "embeddinggemma-2-tessl",
      );
      s.setEmbedModel("   ");
      expect(useSettingsStore.getState().embedModel).toBeNull();
    });

    it("keep only http(s) server URLs, without a trailing slash", () => {
      const s = useSettingsStore.getState();
      s.setEmbedBaseUrl(" http://127.0.0.1:11435/ ");
      expect(useSettingsStore.getState().embedBaseUrl).toBe(
        "http://127.0.0.1:11435",
      );
      s.setEmbedBaseUrl("127.0.0.1:11435");
      expect(useSettingsStore.getState().embedBaseUrl).toBeNull();
      s.setEmbedBaseUrl(null);
      expect(useSettingsStore.getState().embedBaseUrl).toBeNull();
    });
  });

  describe("pdfDarkMode", () => {
    it("defaults to off", () => {
      expect(useSettingsStore.getState().pdfDarkMode).toBe(false);
    });

    it("can be toggled on and off", () => {
      useSettingsStore.getState().setPdfDarkMode(true);
      expect(useSettingsStore.getState().pdfDarkMode).toBe(true);
      useSettingsStore.getState().setPdfDarkMode(false);
      expect(useSettingsStore.getState().pdfDarkMode).toBe(false);
    });
  });

  describe("compilerBackend", () => {
    it("defaults to tectonic", () => {
      expect(useSettingsStore.getState().compilerBackend).toBe("tectonic");
    });

    it("can switch to texlive", () => {
      useSettingsStore.getState().setCompilerBackend("texlive");
      expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
    });
  });

  describe("compileRootByProject", () => {
    it("persists a compile root per project path", () => {
      useSettingsStore.getState().setCompileRootForProject("/proj", "main.tex");
      expect(useSettingsStore.getState().compileRootByProject["/proj"]).toBe(
        "main.tex",
      );
    });

    it("clears a project override when rootId is null", () => {
      useSettingsStore.getState().setCompileRootForProject("/proj", "main.tex");
      useSettingsStore.getState().setCompileRootForProject("/proj", null);
      expect(
        useSettingsStore.getState().compileRootByProject["/proj"],
      ).toBeUndefined();
    });
  });
});
