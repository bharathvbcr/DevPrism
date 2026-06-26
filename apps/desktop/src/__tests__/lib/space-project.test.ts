import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSpacesStore } from "@/stores/spaces-store";
import {
  assignNewProjectToActiveSpace,
  setupNewProjectInSpace,
  formatNewProjectSetupToast,
  activeSpaceForSetup,
} from "@/lib/space-project";

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("@/lib/tauri/fs", () => ({
  join: vi.fn(async (a: string, b: string) => `${a}/${b}`),
}));

vi.mock("@/lib/tauri/skills", () => ({
  listInstalledSkills: vi.fn(),
  installBundledSkills: vi.fn(),
}));

vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: {
    getState: () => ({
      selectedProviderCredentialId: null,
      setSelectedProviderModel: vi.fn(),
    }),
  },
}));

import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { listInstalledSkills, installBundledSkills } from "@/lib/tauri/skills";

describe("assignNewProjectToActiveSpace", () => {
  beforeEach(() => {
    useSpacesStore.setState({
      spaces: [
        {
          id: "space-1",
          name: "Job Apps",
          kind: "resume",
          color: "#6366f1",
          icon: "briefcase",
          description: "",
          defaultModel: "",
        },
      ],
      projectSpace: {},
      activeSpaceId: "space-1",
    });
  });

  it("assigns when a space is active and project is unassigned", () => {
    const name = assignNewProjectToActiveSpace("/tmp/new-resume");
    expect(name).toBe("Job Apps");
    expect(useSpacesStore.getState().projectSpace["/tmp/new-resume"]).toBe(
      "space-1",
    );
  });

  it("skips when no space is active", () => {
    useSpacesStore.setState({ activeSpaceId: null });
    expect(assignNewProjectToActiveSpace("/tmp/other")).toBeNull();
  });

  it("skips when project already belongs to a space", () => {
    useSpacesStore.setState({
      projectSpace: { "/tmp/existing": "space-1" },
    });
    expect(assignNewProjectToActiveSpace("/tmp/existing")).toBeNull();
  });
});

describe("activeSpaceForSetup", () => {
  it("returns the active space when filtered", () => {
    useSpacesStore.setState({
      spaces: [
        {
          id: "s1",
          name: "Papers",
          kind: "manuscript",
          color: "#000",
          icon: null,
          description: "",
          defaultModel: "",
        },
      ],
      activeSpaceId: "s1",
    });
    expect(activeSpaceForSetup()?.name).toBe("Papers");
  });
});

describe("setupNewProjectInSpace", () => {
  beforeEach(() => {
    vi.mocked(exists).mockReset();
    vi.mocked(readTextFile).mockReset();
    vi.mocked(writeTextFile).mockReset();
    vi.mocked(listInstalledSkills).mockReset();
    vi.mocked(installBundledSkills).mockReset();

    useSpacesStore.setState({
      spaces: [
        {
          id: "space-resume",
          name: "Job Apps",
          kind: "resume",
          color: "#6366f1",
          icon: "briefcase",
          description: "",
          defaultModel: "",
        },
      ],
      projectSpace: {},
      activeSpaceId: "space-resume",
    });
  });

  it("assigns space, scaffolds master, and installs missing skills", async () => {
    vi.mocked(exists).mockResolvedValue(false);
    vi.mocked(listInstalledSkills).mockResolvedValue([]);
    vi.mocked(installBundledSkills).mockResolvedValue([
      {
        id: "1",
        name: "Resume",
        domain: "",
        description: "",
        folder: "resume-cv",
      },
    ]);
    vi.mocked(writeTextFile).mockResolvedValue();

    const result = await setupNewProjectInSpace("/tmp/new");

    expect(result.spaceName).toBe("Job Apps");
    expect(result.masterFile).toBe("RESUME.md");
    expect(result.skillsInstalled).toBe(1);
    expect(writeTextFile).toHaveBeenCalledWith(
      "/tmp/new/RESUME.md",
      expect.stringContaining("# Resume master profile"),
    );
    expect(installBundledSkills).toHaveBeenCalledWith("/tmp/new", [
      "resume-cv",
      "latex-toolkit",
    ]);
  });

  it("skips skill install when all bundled skills are already present", async () => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(listInstalledSkills).mockResolvedValue([
      {
        id: "1",
        name: "Resume",
        domain: "",
        description: "",
        folder: "resume-cv",
      },
      {
        id: "2",
        name: "LaTeX",
        domain: "",
        description: "",
        folder: "latex-toolkit",
      },
    ]);

    const result = await setupNewProjectInSpace("/tmp/existing", {
      scaffoldMaster: false,
    });

    expect(result.skillsInstalled).toBe(0);
    expect(installBundledSkills).not.toHaveBeenCalled();
  });

  it("applies compile profile when mainTexPath is provided", async () => {
    vi.mocked(exists).mockImplementation(async (path) =>
      String(path).endsWith("main.tex"),
    );
    vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
    vi.mocked(listInstalledSkills).mockResolvedValue([]);
    vi.mocked(installBundledSkills).mockResolvedValue([]);
    vi.mocked(writeTextFile).mockResolvedValue();

    await setupNewProjectInSpace("/tmp/new", {
      mainTexPath: "/tmp/new/main.tex",
      scaffoldMaster: false,
      installSkills: false,
    });

    expect(writeTextFile).toHaveBeenCalledWith(
      "/tmp/new/main.tex",
      expect.stringContaining("moderncv"),
    );
  });
});

describe("formatNewProjectSetupToast", () => {
  it("returns label only when nothing was set up", () => {
    expect(
      formatNewProjectSetupToast(
        { spaceName: null, skillsInstalled: 0, masterFile: null },
        "Project created",
      ),
    ).toBe("Project created");
  });

  it("joins setup details", () => {
    expect(
      formatNewProjectSetupToast(
        {
          spaceName: "Job Apps",
          skillsInstalled: 2,
          masterFile: "RESUME.md",
        },
        "Project created",
      ),
    ).toBe(
      "Project created — added to Job Apps · installed 2 skills · created RESUME.md",
    );
  });
});
