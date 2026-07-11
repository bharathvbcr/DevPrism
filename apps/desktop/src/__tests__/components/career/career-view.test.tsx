import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isTauri } from "@/lib/runtime/is-tauri";
import { useCareerStore } from "@/stores/career-store";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@/components/career/career-database-tab", () => ({
  CareerDatabaseTab: () => <div data-testid="tab-database">Database panel</div>,
}));

vi.mock("@/components/career/career-knowledge-tab", () => ({
  CareerKnowledgeTab: () => (
    <div data-testid="tab-knowledge">Knowledge panel</div>
  ),
}));

vi.mock("@/components/career/career-synthesize-tab", () => ({
  CareerSynthesizeTab: () => (
    <div data-testid="tab-synthesize">Synthesize panel</div>
  ),
}));

import { CareerView } from "@/components/career/career-view";

describe("CareerView", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true);
    useCareerStore.setState({
      careerOpen: true,
      activeTab: "database",
      blocks: [],
      personas: [],
      selectedBlockId: null,
      selectedPersonaId: null,
      blocksMissingEmbeddings: 0,
      loading: false,
      saving: false,
      error: null,
      loadAll: vi.fn(async () => {}),
      closeCareer: vi.fn(),
      setActiveTab: useCareerStore.getState().setActiveTab,
    });
  });

  it("shows the desktop gate when not running in Tauri", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    render(<CareerView />);

    expect(screen.getByText("Desktop required")).toBeInTheDocument();
    expect(
      screen.getByText(/only available in the DevPrism desktop app/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /database/i })).toBeNull();
  });

  it("renders career tabs in the desktop app", () => {
    render(<CareerView />);

    expect(screen.getByText("Master experience database")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /database/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /knowledge/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /synthesize/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("tab-database")).toBeInTheDocument();
  });

  it("switches tabs when a tab trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<CareerView />);

    await user.click(screen.getByRole("tab", { name: /knowledge/i }));
    expect(useCareerStore.getState().activeTab).toBe("knowledge");
    expect(screen.getByTestId("tab-knowledge")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /synthesize/i }));
    expect(useCareerStore.getState().activeTab).toBe("synthesize");
    expect(screen.getByTestId("tab-synthesize")).toBeInTheDocument();
  });

  it("calls closeCareer when Projects is clicked", async () => {
    const user = userEvent.setup();
    const closeCareer = vi.fn();
    useCareerStore.setState({ closeCareer });

    render(<CareerView />);
    await user.click(screen.getByRole("button", { name: /projects/i }));
    expect(closeCareer).toHaveBeenCalledOnce();
  });
});
