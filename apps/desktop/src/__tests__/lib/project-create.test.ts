import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExists = vi.fn();
const mockJoin = vi.fn((...parts: string[]) => parts.join("/"));
const mockWriteTextFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

vi.mock("@/lib/tauri/fs", () => ({
  exists: (path: string) => mockExists(path),
  join: (...parts: string[]) => mockJoin(...parts),
}));

vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: {
    getState: () => ({
      newSession: vi.fn(),
      setPendingInitialPrompt: vi.fn(),
    }),
  },
}));

import {
  buildInitialGenerationPrompt,
  createTemplateProject,
  ProjectFolderExistsError,
} from "@/lib/project-create";
import type { TemplateDefinition } from "@/lib/template-registry";

function makeTemplate(): TemplateDefinition {
  return {
    id: "article",
    name: "Article",
    description: "A plain article",
    documentClass: "article",
    mainFileName: "main.tex",
    hasBibliography: true,
    packages: [],
    content: "\\documentclass{article}\n\\begin{document}\n\\end{document}",
  } as unknown as TemplateDefinition;
}

describe("createTemplateProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Only the project folder itself exists; every file inside is new.
    mockExists.mockImplementation(
      (path: string) =>
        path.endsWith("/My Paper") || path === "/target/My Paper",
    );
  });

  it("throws ProjectFolderExistsError when the target folder exists", async () => {
    await expect(
      createTemplateProject({
        projectFolder: "/target",
        projectName: "My Paper",
        template: makeTemplate(),
        attachments: [],
        purpose: "",
      }),
    ).rejects.toBeInstanceOf(ProjectFolderExistsError);
  });

  it("writes agent context files, skeleton, and bibliography for a new project", async () => {
    mockExists.mockReturnValue(false);

    const result = await createTemplateProject({
      projectFolder: "/target",
      projectName: "My Paper",
      template: makeTemplate(),
      attachments: [],
      purpose: "A study of tide pools",
    });

    const written = mockWriteTextFile.mock.calls.map((c) => c[0]);
    // Both agent context files must be written — the template-gallery path
    // historically skipped them.
    expect(written).toContain("/target/My Paper/CLAUDE.md");
    expect(written).toContain("/target/My Paper/AGENTS.md");
    expect(written).toContain("/target/My Paper/main.tex");
    expect(written).toContain("/target/My Paper/references.bib");
    expect(result.projectPath).toBe("/target/My Paper");
  });
});

describe("buildInitialGenerationPrompt", () => {
  const template = makeTemplate();

  it("returns null when no purpose was given", () => {
    expect(buildInitialGenerationPrompt(template, "   ", [])).toBeNull();
  });

  it("embeds the purpose and template identity in the prompt", () => {
    const prompt = buildInitialGenerationPrompt(template, "Tide pools", []);
    expect(prompt).toContain("## New Article Project");
    expect(prompt).toContain("`article`");
    expect(prompt).toContain("`main.tex`");
    expect(prompt).toContain("Tide pools");
  });
});
