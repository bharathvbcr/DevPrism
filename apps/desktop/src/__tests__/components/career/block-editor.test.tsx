import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createEmptyBlock,
  createEmptyPersona,
  type ExperienceBlock,
} from "@/lib/career";

vi.mock("@/lib/career", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/career")>();
  return {
    ...actual,
    listKbChunks: vi.fn(async () => []),
  };
});

import { BlockEditor } from "@/components/career/block-editor";

describe("BlockEditor save flow", () => {
  const persona = createEmptyPersona({ id: "ai", label: "AI / ML" });
  const block = createEmptyBlock({
    id: "exp_test",
    title: "Original title",
    org: "Acme",
    personas: ["ai"],
    skills: [{ name: "  python  ", level: 4, years: 3 }],
    bullets: [
      {
        id: "blt_1",
        canonical: "Built pipelines",
        variants: { ai: "  Shipped ML pipelines  ", empty: "   " },
        metrics: [{ value: "40%", kind: "metric" }],
        evidenceRefs: [],
        locked: false,
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a cleaned block via onSave", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_block: ExperienceBlock) => {});

    render(
      <BlockEditor
        block={block}
        personas={[persona]}
        saving={false}
        onSave={onSave}
      />,
    );

    const title = screen.getByPlaceholderText("Senior ML Engineer");
    await user.clear(title);
    await user.type(title, "Staff ML Engineer");

    await user.click(screen.getByRole("button", { name: /save block/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledOnce();
    });

    const saved = onSave.mock.calls[0]![0]!;
    expect(saved.title).toBe("Staff ML Engineer");
    expect(saved.org).toBe("Acme");
    expect(saved.skills).toEqual([{ name: "python", level: 4, years: 3 }]);
    expect(saved.bullets[0]!.variants).toEqual({
      ai: "Shipped ML pipelines",
    });
  });

  it("disables save while saving", () => {
    render(
      <BlockEditor
        block={block}
        personas={[persona]}
        saving
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });

  it("disables save when title is cleared", async () => {
    const user = userEvent.setup();
    render(
      <BlockEditor
        block={block}
        personas={[persona]}
        saving={false}
        onSave={vi.fn()}
      />,
    );

    await user.clear(screen.getByPlaceholderText("Senior ML Engineer"));
    expect(screen.getByRole("button", { name: /save block/i })).toBeDisabled();
  });

  it("shows a failure note instead of an empty KB when chunk lookup fails", async () => {
    const { listKbChunks } = await import("@/lib/career");
    vi.mocked(listKbChunks).mockRejectedValueOnce(new Error("db unavailable"));

    render(
      <BlockEditor
        block={block}
        personas={[persona]}
        saving={false}
        onSave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't load the knowledge-base chunk list/),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/No knowledge-base chunks yet/i)).toBeNull();
  });
});
