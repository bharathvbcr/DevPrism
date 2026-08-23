import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AtsParsePanel } from "@/components/career/synthesize/run-results";
import type {
  MatchReportAtsParse,
  MatchReportKeywordHeatmap,
} from "@/lib/resume-synthesis";

const atsParse: MatchReportAtsParse = {
  system: "workday",
  warnings: [
    "Tables or tabs detected: multi-column layouts often fail to parse correctly in legacy ATS (Taleo, Jobvite).",
  ],
  sections: [
    { name: "summary", detected: true },
    { name: "experience", detected: true },
    { name: "education", detected: false },
  ],
  missingRequiredSections: ["education"],
  contact: { name: true, email: true, phone: false, linkCount: 1 },
  inputChars: 1200,
  plainTextChars: 900,
};

const heatmap: MatchReportKeywordHeatmap = {
  overallDensity: 2.41,
  sections: [
    { name: "Summary", density: 0, heatLevel: 0 },
    { name: "Experience", density: 6.2, heatLevel: 5 },
    { name: "Skills", density: 2.4, heatLevel: 3 },
  ],
  missingCriticalKeywords: ["kafka"],
  overusedKeywords: [],
};

describe("AtsParsePanel", () => {
  it("renders nothing when the run predates ATS summaries", () => {
    const { container } = render(<AtsParsePanel />);
    expect(container).toBeEmptyDOMElement();
    const { container: empty2 } = render(
      <AtsParsePanel atsParse={null} heatmap={null} />,
    );
    expect(empty2).toBeEmptyDOMElement();
  });

  it("shows system, contact gaps, hazards, and heatmap rows", () => {
    render(<AtsParsePanel atsParse={atsParse} heatmap={heatmap} />);
    expect(screen.getByText("ATS parse check")).toBeInTheDocument();
    expect(screen.getByText(/workday/i)).toBeInTheDocument();
    // Phone failed to parse; email/name/links survived.
    expect(screen.getByText(/✗ phone/i)).toBeInTheDocument();
    expect(screen.getByText(/✓ email/i)).toBeInTheDocument();
    // Missing required section banner.
    expect(screen.getByText(/missing section/i)).toBeInTheDocument();
    expect(screen.getByText(/education/i)).toBeInTheDocument();
    // Formatting hazard surfaced verbatim.
    expect(screen.getByText(/tables or tabs/i)).toBeInTheDocument();
    // Critical keyword miss.
    expect(screen.getByText(/kafka/i)).toBeInTheDocument();
    // Heatmap chips with densities.
    expect(screen.getByText(/Experience · 6\.2%/)).toBeInTheDocument();
    expect(screen.getByText(/Skills · 2\.4%/)).toBeInTheDocument();
  });
});
