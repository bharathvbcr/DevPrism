import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ResumeOrganizerPanel } from "@/components/workspace/resume-organizer/resume-organizer-panel";
import { useResumeVariantsStore } from "@/stores/resume-variants-store";
import { useDocumentStore } from "@/stores/document-store";
import type { VariantInfo } from "@/lib/tauri/variants";

let mockVariantsToReturn: VariantInfo[] = [];

// Mock Tauri invoke and event listeners
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, _args: any) => {
    if (cmd === "variant_list" || cmd === "list_variants")
      return mockVariantsToReturn;
    if (cmd === "career_list_runs") return [];
    if (cmd === "career_list_personas") return [];
    return null;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const mockVariants: VariantInfo[] = [
  {
    id: "stripe-backend",
    name: "Stripe Backend Lead",
    status: "applied",
    jd: "Requirements: Distributed systems, Go, Kubernetes, payment rail reliability.",
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    path: "/projects/resume/.prism/variants/stripe-backend",
    company: "Stripe",
    role: "Backend Lead",
    seniority: "lead",
    atsScore: 94,
  },
  {
    id: "datadog-sre",
    name: "Datadog Staff SRE",
    status: "interview",
    jd: "Requirements: Latency reduction, eBPF, observability, high scale.",
    createdAt: Date.now() - 172800000,
    updatedAt: Date.now() - 3600000,
    path: "/projects/resume/.prism/variants/datadog-sre",
    company: "Datadog",
    role: "Staff SRE",
    seniority: "senior",
    atsScore: 88,
  },
  {
    id: "meta-ic",
    name: "Meta Infrastructure",
    status: "draft",
    jd: "Requirements: C++, distributed storage, kernel debugging.",
    createdAt: Date.now() - 300000,
    updatedAt: Date.now() - 100000,
    path: "/projects/resume/.prism/variants/meta-ic",
    company: "Meta",
    role: "Infrastructure Engineer",
    seniority: "ic",
    atsScore: 72,
  },
];

describe("ResumeOrganizerPanel Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useDocumentStore.setState({
      projectRoot: "/projects/resume",
      files: [
        {
          id: "main.typ",
          name: "main.typ",
          relativePath: "main.typ",
          absolutePath: "/projects/resume/main.typ",
          content: "= Master Resume Document\n- Experienced Platform Engineer",
          type: "typst",
          isDirty: false,
        },
      ],
      activeFileId: "main.typ",
    });

    mockVariantsToReturn = [];
    useResumeVariantsStore.setState({
      ownerRoot: "/projects/resume",
      activeVariantId: null,
      variants: [],
      selectedVariant: null,
      loading: false,
      switching: false,
    });
  });

  it("renders empty state message verbatim when no variants exist", async () => {
    mockVariantsToReturn = [];
    render(<ResumeOrganizerPanel />);

    // Verbatim match required by E2E test T2-F04-01
    await waitFor(() => {
      expect(
        screen.getByText(
          "No resume variants created yet. Create one from master.",
        ),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Master Resume")).toBeInTheDocument();
    expect(screen.getByText("Canonical")).toBeInTheDocument();
  });

  it("renders variant cards with name, slug, company, role, and ATS score badge", async () => {
    mockVariantsToReturn = [...mockVariants];
    useResumeVariantsStore.setState({
      variants: mockVariants,
      selectedVariant: mockVariants[0],
    });

    render(<ResumeOrganizerPanel />);

    await waitFor(() => {
      expect(screen.getByText("Stripe Backend Lead")).toBeInTheDocument();
    });

    // Master card present
    expect(screen.getByText("Master Resume")).toBeInTheDocument();

    // Variant 1
    expect(screen.getByText("stripe-backend")).toBeInTheDocument();
    expect(screen.getByText("Stripe")).toBeInTheDocument();
    expect(screen.getByText("Backend Lead")).toBeInTheDocument();
    expect(screen.getByText("94% ATS")).toBeInTheDocument();

    // Variant 2
    expect(screen.getByText("Datadog Staff SRE")).toBeInTheDocument();
    expect(screen.getByText("datadog-sre")).toBeInTheDocument();
    expect(screen.getByText("Datadog")).toBeInTheDocument();
    expect(screen.getByText("88% ATS")).toBeInTheDocument();
  });

  it("filters variants based on search query", async () => {
    mockVariantsToReturn = [...mockVariants];
    useResumeVariantsStore.setState({
      variants: mockVariants,
      selectedVariant: mockVariants[0],
    });

    render(<ResumeOrganizerPanel />);

    await waitFor(() => {
      expect(screen.getByText("Stripe Backend Lead")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search variants...");
    fireEvent.change(searchInput, { target: { value: "Datadog" } });

    expect(screen.getByText("Datadog Staff SRE")).toBeInTheDocument();
    expect(screen.queryByText("Stripe Backend Lead")).toBeNull();
    expect(screen.queryByText("Meta Infrastructure")).toBeNull();
  });

  it("calls switchTo when a variant card is clicked", async () => {
    mockVariantsToReturn = [...mockVariants];
    const switchToSpy = vi.fn();
    useResumeVariantsStore.setState({
      variants: mockVariants,
      activeVariantId: null,
      switchTo: switchToSpy,
    });

    render(<ResumeOrganizerPanel />);

    await waitFor(() => {
      expect(screen.getByText("Stripe Backend Lead")).toBeInTheDocument();
    });

    const stripeCard = screen.getByText("Stripe Backend Lead");
    fireEvent.click(stripeCard);

    expect(switchToSpy).toHaveBeenCalledWith("stripe-backend");
  });

  it("switches to canonical master when master card is clicked while a variant is active", async () => {
    mockVariantsToReturn = [...mockVariants];
    useDocumentStore.setState({
      projectRoot: "/projects/resume/.prism/variants/stripe-backend",
    });
    const switchToSpy = vi.fn();
    useResumeVariantsStore.setState({
      ownerRoot: "/projects/resume",
      variants: mockVariants,
      activeVariantId: "stripe-backend",
      switchTo: switchToSpy,
    });

    render(<ResumeOrganizerPanel />);

    await waitFor(() => {
      expect(screen.getByText("Stripe Backend Lead")).toBeInTheDocument();
    });

    const masterCard = screen.getByText("Master Resume");
    fireEvent.click(masterCard);

    expect(switchToSpy).toHaveBeenCalledWith(null);
  });

  it("opens Create Variant dialog when 'New Variant' button is clicked", () => {
    render(<ResumeOrganizerPanel />);

    const newBtn = screen.getByText("New Variant");
    fireEvent.click(newBtn);

    expect(screen.getByText("Create Variant from Master")).toBeInTheDocument();
  });
});
