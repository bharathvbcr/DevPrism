import { describe, expect, it } from "vitest";
import {
  metricPreservedInText,
  metricsValuesPreserved,
} from "@/lib/resume-synthesis";

describe("metricPreservedInText", () => {
  it("matches exact substring metrics", () => {
    expect(
      metricPreservedInText("18%", "Reduced payment latency by 18% in Go"),
    ).toBe(true);
    expect(
      metricPreservedInText("PostgreSQL", "Migrated database to PostgreSQL"),
    ).toBe(true);
  });

  it("enforces word boundary on bare numbers to prevent false positives", () => {
    // Exact match on isolated number
    expect(
      metricPreservedInText("5", "Led a core team of 5 software engineers"),
    ).toBe(true);
    expect(
      metricPreservedInText("5", "5 squads delivered the feature"),
    ).toBe(true);

    // Number embedded in larger number must NOT match
    expect(
      metricPreservedInText("5", "Scaled to 500,000 requests per second"),
    ).toBe(false);
    expect(
      metricPreservedInText("5", "Managed 15 direct reports"),
    ).toBe(false);
    expect(
      metricPreservedInText("5", "Reduced errors from 50 to 20"),
    ).toBe(false);
  });

  it("handles percentage variations and formatting", () => {
    expect(
      metricPreservedInText("25%", "Improved throughput by 25 percent across services"),
    ).toBe(true);
    expect(
      metricPreservedInText("25%", "Improved throughput by 25 pct"),
    ).toBe(true);
    expect(
      metricPreservedInText("25%", "Improved throughput by 25.0%"),
    ).toBe(true);
    expect(
      metricPreservedInText("25%", "Improved throughput by 25 percentage points"),
    ).toBe(true);
  });

  it("handles currency and magnitude variations (K, M, B)", () => {
    // $1.2M variations
    expect(
      metricPreservedInText("$1.2M", "Generated $1.2 million in annual recurring revenue"),
    ).toBe(true);
    expect(
      metricPreservedInText("$1.2M", "Generated 1.2M USD in ARR"),
    ).toBe(true);
    expect(
      metricPreservedInText("$1.2M", "Generated $1,200,000 in pipeline value"),
    ).toBe(true);
    expect(
      metricPreservedInText("$1.2M", "Generated $1200000 in ARR"),
    ).toBe(true);

    // $100K variations
    expect(
      metricPreservedInText("$100K", "Managed $100,000 infrastructure budget"),
    ).toBe(true);
    expect(
      metricPreservedInText("$100K", "Saved 100k USD per quarter"),
    ).toBe(true);
    expect(
      metricPreservedInText("$100K", "Saved $100 thousand in hosting costs"),
    ).toBe(true);

    // $5B variations
    expect(
      metricPreservedInText("$5B", "Oversaw transactions across a $5 billion portfolio"),
    ).toBe(true);
  });

  it("handles multiplier / scale variations", () => {
    expect(
      metricPreservedInText("5x", "Delivered a 5-fold speedup in query latency"),
    ).toBe(true);
    expect(
      metricPreservedInText("5x", "Made batch processing 5 times faster"),
    ).toBe(true);
    expect(
      metricPreservedInText("5x", "Achieved 5X throughput gain"),
    ).toBe(true);
  });

  it("handles comma-separated numbers and numeric abbreviations", () => {
    expect(
      metricPreservedInText("10,000", "Serving over 10000 concurrent active users"),
    ).toBe(true);
    expect(
      metricPreservedInText("10,000", "Serving over 10k daily active users"),
    ).toBe(true);
  });

  it("handles small number words", () => {
    expect(
      metricPreservedInText("3", "Architected three microservices in Rust"),
    ).toBe(true);
    expect(
      metricPreservedInText("10", "Deployed across ten cloud regions"),
    ).toBe(true);
  });

  it("returns true for empty or whitespace metric", () => {
    expect(metricPreservedInText("", "Any text")).toBe(true);
    expect(metricPreservedInText("   ", "Any text")).toBe(true);
  });
});

describe("metricsValuesPreserved", () => {
  it("verifies all metrics in a list are present and preserved", () => {
    const metrics = [
      { id: "m1", value: "$1.2M" },
      { id: "m2", value: "35%" },
      { id: "m3", value: "4" },
    ];

    expect(
      metricsValuesPreserved(
        metrics,
        "Delivered $1.2 million in cost savings, cutting latency 35 percent across 4 regions.",
      ),
    ).toBe(true);

    // Missing one metric
    expect(
      metricsValuesPreserved(
        metrics,
        "Delivered $1.2 million in cost savings across 4 regions.",
      ),
    ).toBe(false);
  });
});
