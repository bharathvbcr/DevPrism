/**
 * Stage 1 — JD analysis: one LLM call → JDProfile JSON.
 */

import type { SeniorityLevel } from "@/lib/career/types";
import { llmJson } from "./llm-json";
import type { JDProfile } from "./types";

const SENIORITY: SeniorityLevel[] = [
  "ic",
  "senior",
  "lead",
  "manager",
  "director",
];

/** Non-trivial JDs longer than this must yield skills/keywords. */
export const JD_NONTRIVIAL_MIN_CHARS = 200;

const JD_SYSTEM = `You analyze job descriptions for resume targeting.
Return ONLY a JSON object with this exact shape:
{
  "roleTitle": string,
  "seniority": "ic"|"senior"|"lead"|"manager"|"director",
  "mustHaveSkills": string[],
  "niceToHaveSkills": string[],
  "domains": string[],
  "atsKeywords": string[],
  "toneSignals": string[],
  "responsibilitiesText": string,
  "qualificationsText": string
}
Rules:
- mustHaveSkills: hard requirements (tools, languages, years, certifications).
- niceToHaveSkills: preferred / bonus skills.
- domains: industry or problem domains (e.g. genomics, fintech).
- atsKeywords: short ATS-friendly keyword phrases from the JD (skills + role nouns).
- toneSignals: adjectives describing desired tone (e.g. "collaborative", "metrics-driven").
- responsibilitiesText: 2–6 sentence extract of core responsibilities (plain text).
- qualificationsText: 2–6 sentence extract of qualifications / requirements (plain text).
- Infer seniority from titles (Staff/Principal → lead, Senior → senior, Manager/Director → manager/director, else ic).
- For substantive job descriptions, mustHaveSkills and atsKeywords MUST be non-empty.
- Output ONLY JSON — no markdown fences, no commentary.`;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeSeniority(value: unknown): SeniorityLevel | string {
  if (typeof value !== "string") return "senior";
  const v = value.trim().toLowerCase();
  if ((SENIORITY as string[]).includes(v)) return v as SeniorityLevel;
  if (/director|vp|head of/i.test(v)) return "director";
  if (/manager|mgmt/i.test(v)) return "manager";
  if (/lead|staff|principal/i.test(v)) return "lead";
  if (/senior|sr\b/i.test(v)) return "senior";
  if (/junior|entry|associate|ic\b/i.test(v)) return "ic";
  return "senior";
}

/** Hand validator + normalizer for JDProfile. */
export function isJDProfile(value: unknown): value is JDProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o.roleTitle === "string" || typeof o.role === "string";
}

export function normalizeJDProfile(value: unknown, jdText: string): JDProfile {
  const o =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const roleTitle =
    (typeof o.roleTitle === "string" && o.roleTitle.trim()) ||
    (typeof o.role === "string" && o.role.trim()) ||
    "Role";
  const responsibilitiesText =
    (typeof o.responsibilitiesText === "string" &&
      o.responsibilitiesText.trim()) ||
    jdText.slice(0, 1200);
  const qualificationsText =
    (typeof o.qualificationsText === "string" && o.qualificationsText.trim()) ||
    jdText.slice(0, 1200);

  return {
    roleTitle,
    seniority: normalizeSeniority(o.seniority),
    mustHaveSkills: asStringArray(o.mustHaveSkills),
    niceToHaveSkills: asStringArray(o.niceToHaveSkills),
    domains: asStringArray(o.domains),
    atsKeywords: asStringArray(o.atsKeywords),
    toneSignals: asStringArray(o.toneSignals),
    responsibilitiesText,
    qualificationsText,
  };
}

export function validateJDProfile(value: unknown): value is JDProfile {
  if (!isJDProfile(value)) return false;
  // Accept and normalize later — validator only needs a parseable object.
  return true;
}

export function isExtractionEmpty(profile: JDProfile): boolean {
  return (
    profile.mustHaveSkills.length === 0 && profile.atsKeywords.length === 0
  );
}

export interface AnalyzeJobDescriptionResult {
  profile: JDProfile;
  /** Degradation / quality notices for the MatchReport. */
  notices: string[];
  /** True when a non-trivial JD still yielded empty skills + keywords. */
  extractionEmpty: boolean;
}

export async function analyzeJobDescription(
  jdText: string,
  options?: {
    llmJson?: typeof llmJson;
  },
): Promise<AnalyzeJobDescriptionResult> {
  const text = jdText.trim();
  if (!text) {
    return {
      profile: {
        roleTitle: "Role",
        seniority: "senior",
        mustHaveSkills: [],
        niceToHaveSkills: [],
        domains: [],
        atsKeywords: [],
        toneSignals: [],
        responsibilitiesText: "",
        qualificationsText: "",
      },
      notices: [],
      extractionEmpty: false,
    };
  }

  const call = options?.llmJson ?? llmJson;
  const runOnce = async (extraInstruction?: string) => {
    const raw = await call<JDProfile>({
      system: JD_SYSTEM,
      prompt: [extraInstruction, `Job description:\n${text.slice(0, 12000)}`]
        .filter(Boolean)
        .join("\n\n"),
      temperature: 0.1,
      validate: validateJDProfile,
      label: "jd-analysis",
    });
    return normalizeJDProfile(raw, text);
  };

  let profile = await runOnce();
  const notices: string[] = [];
  let extractionEmpty = false;

  if (text.length > JD_NONTRIVIAL_MIN_CHARS && isExtractionEmpty(profile)) {
    // Reprompt once requiring non-empty skills/keywords.
    try {
      profile = await runOnce(
        "IMPORTANT: The previous extraction left mustHaveSkills and atsKeywords empty. Re-extract carefully — both arrays MUST contain concrete skills/keywords from this job description.",
      );
    } catch {
      // keep first profile
    }
    if (isExtractionEmpty(profile)) {
      extractionEmpty = true;
      notices.push(
        "JD extraction returned no must-have skills or ATS keywords after retry — scoring will be degraded.",
      );
    }
  }

  return { profile, notices, extractionEmpty };
}

/** Build facet strings for multi-vector embedding. */
export function facetsOf(
  jdText: string,
  profile: JDProfile,
): { full: string; responsibilities: string; qualifications: string } {
  return {
    full: jdText.trim().slice(0, 8000),
    responsibilities: profile.responsibilitiesText.slice(0, 4000),
    qualifications: profile.qualificationsText.slice(0, 4000),
  };
}
