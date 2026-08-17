/**
 * Emits Typst documents rendered by the TypeScript templates into
 * `src-tauri/tests/fixtures/typst/`, where a Rust test compiles them with the
 * real engine (`engine::tests::rendered_fixtures_compile`).
 *
 * This is the only check that proves the two halves of the swap agree: the TS
 * renderer's idea of valid Typst and the Rust compiler's idea of valid Typst.
 * A pure-TS test can assert structure but never that the document compiles.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderTypstTemplate,
  TYPST_ATS_SINGLE_TEMPLATE,
  TYPST_ATS_TWO_COLUMN_TEMPLATE,
  type ResumeContent,
  type ResumeTemplate,
} from "@/lib/resume-templates";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(
  HERE,
  "..",
  "..",
  "..",
  "src-tauri",
  "tests",
  "fixtures",
  "typst",
);

/** Payloads that would be catastrophic if they ever reached Typst code mode. */
const HOSTILE = [
  '#read("/etc/passwd")',
  '#eval("1+1", mode: "code")',
  '#import "@preview/evil:1.0.0": *',
  '" + read("/etc/passwd") + "',
  '*/ #read("/x") /*',
  '// nope\n#read("/x")',
  '```typ #read("/x") ```',
  "* _ ` $ @ < > = - + / [ ] { } # ~ ^ &",
  "\n= INJECTED HEADING\n",
  "#show heading: it => [pwned]",
  "#set page(width: 100000pt)",
  "<label> @ref",
  "$ x^2 / sum_(i=1)^n $",
  "\\\\\\\\ \\u{41} \\",
  "ends with a backslash \\",
  'quote " inside',
  "🚀 építész 中文 عربي हिन्दी",
  "é̂̃x",
  "a​b﻿c­d",
  "abc‮drowssap‬def",
];

function baseContent(): ResumeContent {
  return {
    header: {
      fullName: "Ada Lovelace",
      cityRegion: "London, UK",
      email: "ada@example.com",
      phone: "+44 20 7946 0958",
      linkedinUrl: "https://linkedin.com/in/ada_lovelace",
      linkedinLabel: "LinkedIn",
      githubUrl: "https://github.com/org/my_repo",
    },
    summary: "Engineer who cut costs by **40%** & shipped #1 product.",
    skills: [
      { label: "Languages", items: "Rust, TypeScript, C++, C#" },
      { label: "Infra", items: "Kubernetes, Terraform, AWS" },
    ],
    experience: [
      {
        id: "exp_1",
        title: "Senior Engineer",
        org: "Acme Corp",
        location: "Remote",
        dateRange: "Jan 2022 -- Present",
        url: "https://acme.example",
        bullets: [
          "Cut p99 latency by **40%** across 100% of the fleet.",
          "Owned the $2M migration & the C# rewrite.",
        ],
        extra: "Promoted twice",
      },
    ],
    education: [
      {
        id: "edu_1",
        title: "BSc Mathematics",
        org: "University",
        dateRange: "2016 -- 2020",
        bullets: [],
      },
    ],
    leadership: [
      {
        id: "lead_1",
        title: "Mentor",
        org: "OSS",
        dateRange: "2021 -- 2023",
        bullets: ["Mentored 12 engineers."],
      },
    ],
  };
}

function hostileContent(payload: string): ResumeContent {
  return {
    header: {
      fullName: payload,
      cityRegion: payload,
      email: payload,
      phone: payload,
      portfolioUrl: "javascript:alert(1)",
      portfolioLabel: payload,
    },
    summary: payload,
    skills: [{ label: payload, items: payload }],
    experience: [
      {
        id: "exp_1",
        title: payload,
        org: payload,
        location: payload,
        dateRange: payload,
        url: payload,
        bullets: [payload, `prefix ${payload} suffix`],
        extra: payload,
      },
    ],
  };
}

function emit(
  name: string,
  template: ResumeTemplate,
  content: ResumeContent,
): void {
  const { source } = renderTypstTemplate(template, content);
  writeFileSync(join(FIXTURE_DIR, `${name}.typ`), source, "utf8");
}

describe("typst fixture emission", () => {
  it("writes rendered documents for the Rust engine test to compile", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    // Only clear the fixtures this file owns — `typst-fuzz.test.ts` writes
    // `fuzz-*.typ` into the same directory and vitest file order is not fixed.
    for (const f of readdirSync(FIXTURE_DIR)) {
      if (f.endsWith(".typ") && !f.startsWith("fuzz-")) {
        unlinkSync(join(FIXTURE_DIR, f));
      }
    }

    emit("baseline-single", TYPST_ATS_SINGLE_TEMPLATE, baseContent());
    // Exercises location / org link / GPA-extra, which had no data path at all
    // until draftsToContent was fixed.
    emit("full-fields", TYPST_ATS_SINGLE_TEMPLATE, {
      ...baseContent(),
      education: [
        {
          id: "edu_1",
          title: "BSc Mathematics",
          org: "University of Cambridge",
          location: "Cambridge, UK",
          url: "https://cam.ac.uk",
          dateRange: "2016 -- 2020",
          bullets: [],
          extra: "GPA 3.9/4.0 · Dean's List all terms",
        },
      ],
    });
    emit("baseline-two-column", TYPST_ATS_TWO_COLUMN_TEMPLATE, baseContent());

    const emptyContent: ResumeContent = {
      header: { fullName: "", cityRegion: "", email: "", phone: "" },
      experience: [],
    };
    emit("empty", TYPST_ATS_SINGLE_TEMPLATE, emptyContent);
    // Both columns empty renders `two-col({}, {})` — an edge case the
    // content-bearing two-column fixtures never reach.
    emit("empty-two-column", TYPST_ATS_TWO_COLUMN_TEMPLATE, emptyContent);
    // Only a sidebar section: the right-hand code block is empty.
    emit("sidebar-only-two-column", TYPST_ATS_TWO_COLUMN_TEMPLATE, {
      ...emptyContent,
      skills: [{ label: "Languages", items: "Rust" }],
    });

    HOSTILE.forEach((payload, i) => {
      const id = String(i).padStart(2, "0");
      emit(`hostile-${id}`, TYPST_ATS_SINGLE_TEMPLATE, hostileContent(payload));
      emit(
        `hostile-${id}-two-column`,
        TYPST_ATS_TWO_COLUMN_TEMPLATE,
        hostileContent(payload),
      );
    });

    const written = readdirSync(FIXTURE_DIR).filter(
      (f) => f.endsWith(".typ") && !f.startsWith("fuzz-"),
    );
    expect(written.length).toBe(6 + HOSTILE.length * 2);
  });
});
