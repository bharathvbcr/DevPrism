import { describe, expect, it } from "vitest";
import {
  atsScoreFromReport,
  blockRewriteLabel,
  coalesceRunEventsForPersistence,
  coverageHeatLevel,
  extractRewriteStreamPreview,
  extractStoredCompileMeta,
  extractStoredRunTex,
  formatRewriteBlockDetail,
  formatStageMs,
  initBlockProgress,
  listStageTimings,
  parseStoredMatchReport,
} from "@/lib/resume-synthesis/synthesis-ux";
import type {
  MatchReport,
  MustHaveCoverage,
  RunEvent,
} from "@/lib/resume-synthesis/types";

function coverage(
  skill: string,
  selectionHits: MustHaveCoverage["selectionHits"],
  rewriteHits: MustHaveCoverage["rewriteHits"] = [],
): MustHaveCoverage {
  return {
    skill,
    status:
      selectionHits.length > 0 || rewriteHits.length > 0
        ? "covered"
        : "uncovered",
    selectionHits,
    rewriteHits,
  };
}

describe("synthesis-ux helpers", () => {
  it("coverageHeatLevel prefers selection over rewrite", () => {
    expect(coverageHeatLevel(coverage("Python", [{ blockId: "a" }], []))).toBe(
      "selection",
    );
    expect(
      coverageHeatLevel(
        coverage("K8s", [], [{ blockId: "a", bulletId: "b1" }]),
      ),
    ).toBe("rewrite");
    expect(coverageHeatLevel(coverage("Rust", [], []))).toBe("uncovered");
  });

  it("formats rewrite detail and block labels", () => {
    expect(formatRewriteBlockDetail("Acme Corp", 2, 5)).toBe(
      "Rewriting: Acme Corp — 2/5",
    );
    expect(blockRewriteLabel("Acme", "Engineer")).toBe("Acme");
    expect(blockRewriteLabel("", "Engineer")).toBe("Engineer");
  });

  it("extracts text fields from partial rewrite JSON", () => {
    const raw =
      '{"bullets":[{"id":"b1","text":"Shipped Python APIs"},{"id":"b2","text":"Cut latency 40%"}]}';
    expect(extractRewriteStreamPreview(raw)).toContain("Shipped Python APIs");
    expect(extractRewriteStreamPreview(raw)).toContain("Cut latency 40%");
    // Incomplete second string still yields the first completed text field.
    const partial =
      '{"bullets":[{"id":"b1","text":"Shipped Python APIs"},{"id":"b2","text":"Cut lat';
    expect(extractRewriteStreamPreview(partial)).toBe("Shipped Python APIs");
  });

  it("lists and formats stage timings", () => {
    const rows = listStageTimings({
      analyzing: 120,
      scoring: 1500,
      rewriting: 12_000,
    });
    expect(rows.map((r) => r.id)).toEqual([
      "analyzing",
      "scoring",
      "rewriting",
    ]);
    expect(formatStageMs(120)).toBe("120 ms");
    expect(formatStageMs(1500)).toBe("1.5 s");
  });

  it("parses stored match reports and ATS score", () => {
    const report = {
      profile: {
        roleTitle: "ML Eng",
        seniority: "senior",
        mustHaveSkills: [],
        niceToHaveSkills: [],
        domains: [],
        atsKeywords: [],
        toneSignals: [],
        responsibilitiesText: "",
        qualificationsText: "",
      },
      scored: [],
      selectedBlockIds: ["a"],
      notices: [],
      semanticMatchingDisabled: false,
      critique: {
        atsCoveragePct: 77.4,
        verdicts: [],
        programmaticFlags: [],
      },
      repairs: [],
    } satisfies MatchReport;
    expect(parseStoredMatchReport(report)?.profile.roleTitle).toBe("ML Eng");
    expect(parseStoredMatchReport({ foo: 1 })).toBeNull();
    expect(atsScoreFromReport(report)).toBe(77);
  });

  it("extracts stored tex and strips it from MatchReport parse", () => {
    const payload = {
      profile: {
        roleTitle: "ML Eng",
        seniority: "senior",
        mustHaveSkills: [],
        niceToHaveSkills: [],
        domains: [],
        atsKeywords: [],
        toneSignals: [],
        responsibilitiesText: "",
        qualificationsText: "",
      },
      scored: [],
      selectedBlockIds: ["a"],
      notices: [],
      semanticMatchingDisabled: false,
      critique: null,
      repairs: [],
      tex: "\\documentclass{article}\\begin{document}hi\\end{document}",
    };
    expect(extractStoredRunTex(payload)).toContain("documentclass");
    const parsed = parseStoredMatchReport(payload);
    expect(parsed?.profile.roleTitle).toBe("ML Eng");
    expect((parsed as { tex?: string } | null)?.tex).toBeUndefined();
    expect(extractStoredRunTex({ report: payload })).toContain("documentclass");
    expect(extractStoredRunTex({ profile: {} })).toBeNull();
  });

  it("initBlockProgress marks all pending", () => {
    const rows = initBlockProgress([
      { blockId: "a", label: "A" },
      { blockId: "b", label: "B" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      index: 1,
      total: 2,
      status: "pending",
    });
  });

  it("coalesceRunEventsForPersistence keeps one stream preview per block", () => {
    const events: RunEvent[] = [
      { type: "stage-start", stage: "rewriting", at: 1 },
      {
        type: "block-rewrite-stream",
        blockId: "a",
        preview: "tok1",
        at: 2,
      },
      {
        type: "block-rewrite-stream",
        blockId: "a",
        preview: "tok1 tok2 final",
        at: 3,
      },
      {
        type: "block-rewrite-done",
        blockId: "a",
        at: 4,
        fallbackCount: 0,
        bulletCount: 2,
      },
      { type: "error", message: "boom", at: 5 },
    ];
    const out = coalesceRunEventsForPersistence(events);
    const streams = out.filter((e) => e.type === "block-rewrite-stream");
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      blockId: "a",
      preview: "tok1 tok2 final",
    });
    expect(out.some((e) => e.type === "error")).toBe(true);
    expect(out.map((e) => e.type)).toEqual([
      "stage-start",
      "block-rewrite-done",
      "block-rewrite-stream",
      "error",
    ]);
  });

  it("extractStoredCompileMeta reads compileOk from payload", () => {
    expect(
      extractStoredCompileMeta({
        compileOk: false,
        compileSummary: "needs review",
      }),
    ).toEqual({ compileOk: false, compileSummary: "needs review" });
    expect(
      extractStoredCompileMeta({
        report: { compileOk: true },
      }),
    ).toEqual({ compileOk: true, compileSummary: "Compile verified" });
    expect(extractStoredCompileMeta({ profile: {} })).toBeNull();
  });
});
