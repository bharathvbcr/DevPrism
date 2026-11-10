/**
 * Tests the production scorer in fuzzy-search.ts.
 * Run: bunx vitest run src/lib/fuzzy-search.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  SCORE_MATCH_CONSECUTIVE,
  fuzzyScore,
  levenshtein,
  scoreCommand,
  typoScore,
} from "./fuzzy-search";

interface FakeCmd {
  name: string;
  full_command: string;
  description: string | null;
}

const COMMANDS: FakeCmd[] = [
  {
    name: "biorxiv-database",
    full_command: "/biorxiv-database",
    description: "Efficient database search tool for bioRxiv preprint server.",
  },
  {
    name: "biopython",
    full_command: "/biopython",
    description: "Comprehensive molecular biology toolkit.",
  },
  {
    name: "bioservices",
    full_command: "/bioservices",
    description: "Unified Python interface to 40+ bioinformatics services.",
  },
  {
    name: "cbioportal-database",
    full_command: "/cbioportal-database",
    description: "Query cBioPortal for cancer genomics data.",
  },
  {
    name: "scikit-bio",
    full_command: "/scikit-bio",
    description: "Biological data toolkit.",
  },
  {
    name: "scvi-tools",
    full_command: "/scvi-tools",
    description: "Deep generative models for single-cell omics.",
  },
  {
    name: "vaex",
    full_command: "/vaex",
    description: "Large tabular datasets.",
  },
  {
    name: "deepchem",
    full_command: "/deepchem",
    description: "Molecular ML with diverse featurizers.",
  },
  {
    name: "market-research-reports",
    full_command: "/market-research-reports",
    description: "Market research reports.",
  },
  {
    name: "matlab",
    full_command: "/matlab",
    description: "MATLAB and GNU Octave.",
  },
  {
    name: "scanpy",
    full_command: "/scanpy",
    description: "scRNA-seq analysis.",
  },
  {
    name: "phylogenetics",
    full_command: "/phylogenetics",
    description: "Phylogenetic trees.",
  },
  {
    name: "perplexity-search",
    full_command: "/perplexity-search",
    description: "AI-powered web searches.",
  },
  {
    name: "latchbio-integration",
    full_command: "/latchbio-integration",
    description: "Latch platform for bioinformatics.",
  },
];

function search(q: string): { name: string; score: number }[] {
  const results: { name: string; score: number }[] = [];
  for (const cmd of COMMANDS) {
    const score = scoreCommand(cmd, q);
    if (score > -Infinity) {
      results.push({ name: cmd.full_command, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

describe("fuzzyScore", () => {
  it("locks the consecutive-match weight at 1", () => {
    expect(SCORE_MATCH_CONSECUTIVE).toBe(1);
    expect(fuzzyScore("a", "a")).toBe(1);
  });

  it("exact prefix match scores high", () => {
    expect(fuzzyScore("bio", "biopython")).toBeGreaterThan(0);
  });

  it("subsequence match works", () => {
    expect(fuzzyScore("bpy", "biopython")).toBeGreaterThan(-Infinity);
  });

  it("non-matching returns -Infinity", () => {
    expect(fuzzyScore("xyz", "biopython")).toBe(-Infinity);
  });

  it("extra char in query fails subsequence", () => {
    // bioarxiv has 'a' that doesn't exist in biorxiv in order
    expect(fuzzyScore("bioarxiv", "biorxiv-database")).toBe(-Infinity);
  });
});

describe("levenshtein", () => {
  it("identical strings = 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });
  it("one insertion = 1", () => {
    expect(levenshtein("bioarxiv", "biorxiv")).toBe(1);
  });
  it("one substitution = 1", () => {
    expect(levenshtein("scanpy", "scnpy")).toBe(1);
  });
});

describe("typoScore", () => {
  it("bioarxiv matches biorxiv-database", () => {
    const score = typoScore("bioarxiv", "biorxiv-database");
    console.log("typoScore('bioarxiv', 'biorxiv-database') =", score);
    expect(score).toBeGreaterThan(-Infinity);
  });

  it("bioarxiv does NOT match cbioportal-database", () => {
    const score = typoScore("bioarxiv", "cbioportal-database");
    console.log("typoScore('bioarxiv', 'cbioportal-database') =", score);
    expect(score).toBe(-Infinity);
  });

  it("scnpy matches scanpy", () => {
    expect(typoScore("scnpy", "scanpy")).toBeGreaterThan(-Infinity);
  });
});

describe("scoreCommand", () => {
  it("bioarxiv should match biorxiv-database via typo", () => {
    const cmd = COMMANDS.find((c) => c.name === "biorxiv-database")!;
    const score = scoreCommand(cmd, "bioarxiv");
    console.log("scoreCommand(biorxiv-database, 'bioarxiv') =", score);
    expect(score).toBeGreaterThan(-Infinity);
  });
});

describe("search ranking", () => {
  it("'bioarxiv' should have biorxiv-database as top result", () => {
    const results = search("bioarxiv");
    console.log("search('bioarxiv'):", results.slice(0, 5));
    expect(results[0].name).toBe("/biorxiv-database");
  });

  it("'bioarxiv' should NOT match cbioportal-database", () => {
    const results = search("bioarxiv");
    const hasCbio = results.some((r) => r.name === "/cbioportal-database");
    expect(hasCbio).toBe(false);
  });

  it("'bio' should have biopython and biorxiv-database near top", () => {
    const results = search("bio");
    console.log("search('bio'):", results.slice(0, 5));
    const bioNames = results.slice(0, 5).map((r) => r.name);
    expect(bioNames).toContain("/biopython");
    expect(bioNames).toContain("/biorxiv-database");
  });

  it("'bpy' subsequence should match biopython", () => {
    const results = search("bpy");
    console.log("search('bpy'):", results.slice(0, 5));
    expect(results.some((r) => r.name === "/biopython")).toBe(true);
  });

  it("'scanpy' exact should be top result", () => {
    const results = search("scanpy");
    expect(results[0].name).toBe("/scanpy");
  });

  it("'matlab' exact should be top result", () => {
    const results = search("matlab");
    expect(results[0].name).toBe("/matlab");
  });
});
