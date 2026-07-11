import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyBlock, type ExperienceBlock } from "@/lib/career";

const commitBlocks = vi.fn(async (_blocks: ExperienceBlock[]) => {});
const extractBlocksFromResume = vi.fn();

vi.mock("@/stores/career-store", () => ({
  useCareerStore: (
    selector: (s: {
      commitBlocks: typeof commitBlocks;
      saving: boolean;
    }) => unknown,
  ) => selector({ commitBlocks, saving: false }),
}));

vi.mock("@/lib/career", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/career")>();
  return {
    ...actual,
    extractBlocksFromResume: (...args: unknown[]) =>
      extractBlocksFromResume(...args),
  };
});

vi.mock("@/lib/ai-assist", () => ({
  canUseAiAssist: () => true,
}));

vi.mock("@/lib/platform-dialog", () => ({
  pickProjectFiles: vi.fn(async () => null),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ResumeImportWizard } from "@/components/career/resume-import-wizard";
import { PublicationImportWizard } from "@/components/career/publication-import-wizard";
import { toast } from "sonner";

const SAMPLE_BIB = `@article{smith2024,
  title = {A Great Paper},
  author = {Smith, Jane},
  year = {2024},
  journal = {Nature},
}
`;

describe("ResumeImportWizard commit path", () => {
  const draft = createEmptyBlock({
    id: "exp_import_1",
    title: "Imported Role",
    org: "Acme",
    bullets: [
      {
        id: "blt_1",
        canonical: "Did important work",
        variants: {},
        metrics: [],
        evidenceRefs: [],
        locked: false,
      },
    ],
  });

  beforeEach(() => {
    commitBlocks.mockClear();
    extractBlocksFromResume.mockReset();
    extractBlocksFromResume.mockResolvedValue([draft]);
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("extracts drafts then commits selected blocks", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<ResumeImportWizard open onOpenChange={onOpenChange} />);

    const source = "x".repeat(50);
    fireEvent.change(screen.getByPlaceholderText(/documentclass\{article\}/i), {
      target: { value: source },
    });
    await user.click(screen.getByRole("button", { name: /extract drafts/i }));

    await waitFor(() => {
      expect(screen.getByText("Imported Role")).toBeInTheDocument();
    });
    expect(extractBlocksFromResume).toHaveBeenCalledWith(source);

    await user.click(screen.getByRole("button", { name: /save 1 block/i }));

    await waitFor(() => {
      expect(commitBlocks).toHaveBeenCalledOnce();
    });
    expect(commitBlocks.mock.calls[0]![0]).toEqual([draft]);
    expect(toast.success).toHaveBeenCalledWith("Saved 1 block");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("PublicationImportWizard commit path", () => {
  beforeEach(() => {
    commitBlocks.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("parses BibTeX and commits publication blocks", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<PublicationImportWizard open onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByPlaceholderText(/@article\{smith2024/i), {
      target: { value: SAMPLE_BIB },
    });

    await user.click(screen.getByRole("button", { name: /preview entries/i }));

    await waitFor(() => {
      expect(screen.getByText("A Great Paper")).toBeInTheDocument();
    });
    expect(screen.getByText(/1 entr/i)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /save 1 publication/i }),
    );

    await waitFor(() => {
      expect(commitBlocks).toHaveBeenCalledOnce();
    });

    const committed = commitBlocks.mock.calls[0]![0]!;
    expect(committed).toHaveLength(1);
    expect(committed[0]!.kind).toBe("publication");
    expect(committed[0]!.title).toBe("A Great Paper");
    expect(toast.success).toHaveBeenCalledWith("Saved 1 publication");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
