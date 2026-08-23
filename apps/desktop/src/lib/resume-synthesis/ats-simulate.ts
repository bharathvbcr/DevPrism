/**
 * ATS parse simulation, keyword-density heatmap, and JD metadata extraction.
 *
 * Natively ported into the career pipeline from IgniteCV
 * (github.com/bharathvbcr/IgniteCV) — services `atsService.ts`,
 * `keywordAnalysisService.ts`, and `metadataExtractor.ts` — and hardened.
 * This module is pure: no Tauri, no LLM, no I/O. The Rust counterpart is
 * `src-tauri/src/career_match/ats_sim.rs`; when behaviour changes here,
 * change both sides (see that module's header for the shared fixtures).
 *
 * Defects in the upstream implementation that this port fixes:
 *
 * 1. Dynamic RegExp built from raw JD words (`new RegExp("\\b" + word)`)
 *    threw on `c++`, `(remote)`, `s.r.` and misfired on metacharacters.
 *    Replaced by a manual boundary scanner with the exact edge classes of
 *    `scoring.ts::textCoversSkill` (and its Rust twin `career_match::text`).
 * 2. Global-regex counting consumed trailing edge characters, undercounting
 *    adjacent occurrences ("k8s k8s k8s" counted 2). The scanner advances by
 *    one character instead.
 * 3. ASCII-only `\w` cleanup (`[^\w\s...]`) obliterated accented and
 *    non-Latin letters — "José García 北京" became "Jos  Garc a".
 *    Plain-text coercion now preserves Unicode letters/digits.
 * 4. Section splitting used `line.includes(header)` for short lines, so body
 *    text like "experience working across teams" became a header. Replaced
 *    with an exact-match alias table shared by the splitter AND the parse
 *    simulator (upstream had two diverging header lists).
 * 5. Unbounded inputs (ReDoS / O(n²) dedupe). Every entry point clamps to
 *    `ATS_MAX_INPUT_CHARS` and all scans are linear.
 * 6. Salary ranges were reported inverted when written high-low; requirements
 *    bucketing collapsed everything into must-have whenever a JD had no blank
 *    line between sections. Both fixed.
 */

import {
  RESUME_SECTION_IDS,
  SECTION_ALIASES,
  SECTION_DISPLAY,
  canonicalSectionFromHeader,
  type ResumeSectionId,
} from "@/lib/resume-sections";
import type {
  RenderedBlock,
  ResumeContent,
  SkillGroup,
} from "@/lib/resume-templates/types";

// ---------------------------------------------------------------------------
// Input clamping
// ---------------------------------------------------------------------------

/** Hard cap for any text entering this module (chars). Fail closed. */
export const ATS_MAX_INPUT_CHARS = 400_000;
/** Hard cap on retained lines after clamping. */
export const ATS_MAX_LINES = 20_000;
const MAX_KEYWORD_CHARS = 100;

/** Normalize newlines, strip control/bidi/zero-width characters, clamp size. */
export function clampAtsInput(input: string): string {
  if (!input) return "";
  let text = "";
  // Single linear pass; keep \n and \t, drop every other C0 control plus
  // DEL, bidi overrides, zero-width, and BOM characters.
  const source = input.normalize("NFC");
  const len = Math.min(source.length, ATS_MAX_INPUT_CHARS * 2);
  for (let i = 0; i < len && text.length <= ATS_MAX_INPUT_CHARS; i++) {
    const code = source.charCodeAt(i);
    const keep =
      code === 10 ||
      code === 9 ||
      // Keep CR so the CRLF/CR → LF normalization below actually sees it.
      code === 13 ||
      (code >= 0x20 &&
        code !== 0x7f &&
        // Strip zero-width characters and bidi overrides/isolates: they are
        // invisible in the UI, corrupt ATS text extraction, and can spoof
        // downstream LLM prompts.
        !(code >= 0x200b && code <= 0x200f) &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069));
    if (keep) text += source[i];
  }
  text = text.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length > ATS_MAX_LINES) {
    text = lines.slice(0, ATS_MAX_LINES).join("\n");
  }
  if (text.length > ATS_MAX_INPUT_CHARS) {
    text = text.slice(0, ATS_MAX_INPUT_CHARS);
  }
  return text;
}

// ---------------------------------------------------------------------------
// ATS system rules (faithful to IgniteCV's table)
// ---------------------------------------------------------------------------

export type AtsSystemId =
  | "taleo"
  | "workday"
  | "greenhouse"
  | "lever"
  | "jobvite"
  | "icims"
  | "generic";

export interface AtsFormattingRules {
  removeFormatting: boolean;
  plainTextOnly: boolean;
  keywordDensityTarget: number;
  sectionOrder: readonly string[];
  requiredSections: readonly string[];
}

const ATS_RULES: Record<AtsSystemId, AtsFormattingRules> = {
  taleo: {
    removeFormatting: true,
    plainTextOnly: true,
    keywordDensityTarget: 0.02,
    sectionOrder: ["summary", "experience", "education", "skills"],
    requiredSections: ["experience"],
  },
  workday: {
    removeFormatting: true,
    plainTextOnly: true,
    keywordDensityTarget: 0.025,
    sectionOrder: [
      "summary",
      "experience",
      "education",
      "skills",
      "certifications",
    ],
    requiredSections: ["experience", "education"],
  },
  greenhouse: {
    removeFormatting: false,
    plainTextOnly: false,
    keywordDensityTarget: 0.03,
    sectionOrder: ["summary", "experience", "education", "skills"],
    requiredSections: ["experience"],
  },
  lever: {
    removeFormatting: false,
    plainTextOnly: false,
    keywordDensityTarget: 0.025,
    sectionOrder: ["summary", "experience", "education", "skills"],
    requiredSections: ["experience"],
  },
  jobvite: {
    removeFormatting: true,
    plainTextOnly: true,
    keywordDensityTarget: 0.02,
    sectionOrder: ["summary", "experience", "education", "skills"],
    requiredSections: ["experience"],
  },
  icims: {
    removeFormatting: true,
    plainTextOnly: true,
    keywordDensityTarget: 0.03,
    sectionOrder: [
      "summary",
      "experience",
      "education",
      "skills",
      "certifications",
    ],
    requiredSections: ["experience", "education"],
  },
  generic: {
    removeFormatting: true,
    plainTextOnly: true,
    keywordDensityTarget: 0.025,
    sectionOrder: ["summary", "experience", "education", "skills"],
    requiredSections: ["experience"],
  },
};

const ALL_ATS_SYSTEMS: readonly AtsSystemId[] = [
  "taleo",
  "workday",
  "greenhouse",
  "lever",
  "jobvite",
  "icims",
];

export function atsRulesFor(system: AtsSystemId): AtsFormattingRules {
  return ATS_RULES[system] ?? ATS_RULES.generic;
}

/** Detect vendor mentions in a JD; falls back to ["generic"]. */
export function detectAtsSystems(jdText: string): AtsSystemId[] {
  const lower = clampAtsInput(jdText).toLowerCase();
  if (!lower) return ["generic"];
  // Priority order is fixed so callers can rely on systems[0].
  const detected = ALL_ATS_SYSTEMS.filter((system) => lower.includes(system));
  if (lower.includes("oracle") && !detected.includes("taleo")) {
    detected.unshift("taleo");
  }
  return detected.length > 0 ? detected : ["generic"];
}

// ---------------------------------------------------------------------------
// Markdown stripping / plain-text coercion
// ---------------------------------------------------------------------------

/** Strip common markdown decoration while preserving Unicode text content. */
export function stripMarkdownFormatting(content: string): string {
  let out = clampAtsInput(content);
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2"); // italic (single *)
  out = out.replace(/_([^_\n]+)_/g, "$1"); // underscore emphasis
  out = out.replace(/`([^`\n]*)`/g, "$1"); // inline code
  out = out.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1"); // [label](url)
  out = out.replace(/^#{1,6}[ \t]+/gm, ""); // ATX headings
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

/**
 * Coerce to what a strict plain-text-only parser accepts. Unlike upstream,
 * Unicode letters/digits survive (fix #3) and line structure is preserved
 * (upstream collapsed every newline into one long line).
 */
function coerceToPlainText(text: string): string {
  // Allowed outside letters/digits: conservative ASCII punctuation + common
  // resume punctuation. Everything else becomes a space.
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      for (const ch of line) {
        const isLetterOrDigit = /\p{L}|\p{N}/u.test(ch);
        const isAllowedPunct = "..,;:!?()\\-'\"&/+#@_= ".includes(ch);
        out += isLetterOrDigit || isAllowedPunct ? ch : " ";
      }
      // Collapse horizontal whitespace only; keep line breaks intact.
      return out.replace(/[^\S\n]+/g, " ").trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Format content the way `system` would ingest it. */
export function formatForAts(
  content: string,
  system: AtsSystemId = "generic",
): string {
  const rules = atsRulesFor(system);
  let formatted = clampAtsInput(content);
  if (rules.removeFormatting) {
    formatted = stripMarkdownFormatting(formatted);
  }
  if (rules.plainTextOnly) {
    formatted = coerceToPlainText(formatted);
  }
  return formatted;
}

/** Cheap preview of what the ATS "sees" (same pipeline as formatForAts). */
export function getAtsParsePreview(
  content: string,
  system: AtsSystemId = "generic",
): string {
  return formatForAts(content, system);
}

// ---------------------------------------------------------------------------
// Boundary-aware occurrence counting
// ---------------------------------------------------------------------------

// Edge classes identical to scoring.ts::textCoversSkill and its Rust twin:
//   left edge:  start-of-text or a char NOT in [a-z0-9+#&]
//   right edge: end-of-text   or a char NOT in [a-z0-9+&]
// ('.' is a valid right edge so sentence-final "Kubernetes." matches; '&' is
// never an edge so "R&D" is not evidence of "R". Keep in sync with Rust.)
function isLeftNonEdge(ch: string): boolean {
  return /[a-z0-9+#&]/.test(ch);
}
function isRightNonEdge(ch: string): boolean {
  return /[a-z0-9+&]/.test(ch);
}

/**
 * Count case-insensitive boundary-delimited occurrences of `needle` in
 * `haystack`. Linear scan; regex metacharacters in either argument are inert.
 */
export function countBoundaryHits(haystack: string, needle: string): number {
  const hay = haystack.toLowerCase();
  const ned = needle.trim().toLowerCase();
  if (!hay || !ned || ned.length > MAX_KEYWORD_CHARS) return 0;
  let count = 0;
  let i = hay.indexOf(ned);
  while (i !== -1) {
    const before = i > 0 ? hay[i - 1] : "";
    const afterIdx = i + ned.length;
    const after = afterIdx < hay.length ? hay[afterIdx] : "";
    const leftOk = i === 0 || !isLeftNonEdge(before);
    const rightOk = afterIdx >= hay.length || !isRightNonEdge(after);
    if (leftOk && rightOk) count += 1;
    i = hay.indexOf(ned, i + 1); // advance by 1: never consume edges
    if (i > hay.length) break;
  }
  return count;
}

// ---------------------------------------------------------------------------
// JD keyword extraction (frequency-based, importance-tiered)
// ---------------------------------------------------------------------------

export type KeywordImportance = "high" | "medium" | "low";

export interface JdKeywordHit {
  word: string;
  count: number;
  importance: KeywordImportance;
}

/**
 * Union of both upstream stopword lists plus a few filler words that would
 * otherwise dominate short JDs purely by grammatical role.
 */
export const KEYWORD_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "been",
  "be",
  "have",
  "has",
  "had",
  "will",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "this",
  "that",
  "these",
  "those",
  "your",
  "you",
  "our",
  "their",
  "they",
  "also",
  "using",
  "used",
  "use",
  "who",
  "what",
  "when",
  "where",
  "while",
  "than",
  "then",
  "them",
  "its",
  "it's",
  "into",
  "over",
  "under",
  "about",
  "across",
  "along",
  "among",
  "any",
  "all",
  "each",
  "both",
]);

/** Tokenize keeping Unicode letters/digits and interior hyphens. */
function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter(Boolean);
}

export interface ExtractJdKeywordsOptions {
  /** Max keywords returned (default 30, matching upstream). */
  limit?: number;
}

/**
 * Frequency-ranked JD keywords with importance tiers:
 * rank <10 → high, <20 → medium, else low. Ties break alphabetically so
 * output is deterministic across engines.
 */
export function extractJdKeywords(
  jdText: string,
  options?: ExtractJdKeywordsOptions,
): JdKeywordHit[] {
  const limit = Math.max(1, Math.min(options?.limit ?? 30, 100));
  const tokens = tokenizeWords(clampAtsInput(jdText));
  const freq = new Map<string, number>();
  for (const token of tokens) {
    if (token.length <= 3 || KEYWORD_STOPWORDS.has(token)) continue;
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  const sorted = [...freq.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return sorted.slice(0, limit).map(([word, count], index) => ({
    word,
    count,
    importance:
      index < 10
        ? "high"
        : index < 20
          ? "medium"
          : ("low" as KeywordImportance),
  }));
}

// ---------------------------------------------------------------------------
// Resume section model — one alias table drives splitting AND simulation
// ---------------------------------------------------------------------------

interface SectionDef {
  canonical: ResumeSectionId;
  display: string;
  matchers: readonly string[];
}

/** One table, shared with templates and career blocks (plus ATS-only contact/links). */
const SECTION_DEFS: readonly SectionDef[] = RESUME_SECTION_IDS.filter(
  (id) => id !== "header",
).map((id) => ({
  canonical: id,
  display: SECTION_DISPLAY[id],
  matchers: SECTION_ALIASES[id],
}));

const PREAMBLE_DISPLAY = "Introduction";

/**
 * Classify a line as a section header. Exact match against the alias table
 * after normalizing decoration (`== WORK HISTORY ==`, `1. Education`,
 * `Skills:`), casing, and whitespace. Body lines that merely contain a header
 * word ("experience working across teams") are NOT headers (fix #4).
 */
function headerCanonical(line: string): ResumeSectionId | null {
  return canonicalSectionFromHeader(line);
}

export interface ResumeSection {
  name: string;
  text: string;
}

/**
 * Split free-text resume content into sections using the shared alias table.
 * Text before the first header lands under `Introduction`.
 */
export function splitResumeIntoSections(text: string): ResumeSection[] {
  const clamped = clampAtsInput(text);
  if (!clamped.trim()) return [];
  const sections: ResumeSection[] = [];
  let currentDisplay = PREAMBLE_DISPLAY;
  let currentLines: string[] = [];
  const flush = () => {
    const joined = currentLines.join("\n");
    if (joined.trim()) sections.push({ name: currentDisplay, text: joined });
  };
  for (const line of clamped.split("\n")) {
    const canonical = headerCanonical(line);
    if (canonical) {
      flush();
      currentDisplay =
        SECTION_DEFS.find((d) => d.canonical === canonical)?.display ??
        canonical;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// Keyword heatmap
// ---------------------------------------------------------------------------

export type HeatLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface HeatmapSectionKeyword {
  word: string;
  count: number;
  importance: KeywordImportance;
}

export interface HeatmapSection {
  name: string;
  keywords: HeatmapSectionKeyword[];
  density: number;
  heatLevel: HeatLevel;
}

export interface KeywordHeatmap {
  sections: HeatmapSection[];
  overallDensity: number;
  missingCriticalKeywords: string[];
  overusedKeywords: string[];
}

/** Density bands (fraction of section words that are JD keywords):
 *  0 cold · <1% → 1 · <2% → 2 · <3.5% → 3 (ideal) · <5% → 4 · ≥5% → 5 hot. */
export function heatLevelForDensity(density: number): HeatLevel {
  if (!(density > 0)) return 0;
  if (density < 1) return 1;
  if (density < 2) return 2;
  if (density < 3.5) return 3;
  if (density < 5) return 4;
  return 5;
}

const OVERUSED_THRESHOLD = 10;

/**
 * Per-section keyword density heatmap of `resumeText` against `jdText`.
 * Missing-critical = high-importance JD keywords absent from the resume
 * (boundary-aware — stricter than upstream's substring check).
 */
export function generateKeywordHeatmap(
  resumeText: string,
  jdText: string,
): KeywordHeatmap {
  const resumeClamped = clampAtsInput(resumeText);
  const jdKeywords = extractJdKeywords(jdText);
  const sections = splitResumeIntoSections(resumeClamped);

  const heatmapSections: HeatmapSection[] = sections.map((section) => {
    const sectionLower = section.text.toLowerCase();
    const sectionWords = section.text.split(/\s+/).filter(Boolean).length;
    const matched = jdKeywords
      .map((k) => ({
        word: k.word,
        count: countBoundaryHits(sectionLower, k.word),
        importance: k.importance,
      }))
      .filter((k) => k.count > 0);
    const totalMatches = matched.reduce((sum, k) => sum + k.count, 0);
    const density = sectionWords > 0 ? (totalMatches / sectionWords) * 100 : 0;
    return {
      name: section.name,
      keywords: matched,
      density,
      heatLevel: heatLevelForDensity(density),
    };
  });

  const overallWords = resumeClamped.split(/\s+/).filter(Boolean).length;
  const overallMatches = heatmapSections.reduce(
    (sum, s) => sum + s.keywords.reduce((sub, k) => sub + k.count, 0),
    0,
  );
  const overallDensity =
    overallWords > 0 ? (overallMatches / overallWords) * 100 : 0;

  const resumeLower = resumeClamped.toLowerCase();
  const missingCriticalKeywords = jdKeywords
    .filter((k) => k.importance === "high")
    .filter((k) => countBoundaryHits(resumeLower, k.word) === 0)
    .map((k) => k.word);

  const overusedKeywords = jdKeywords
    .map((k) => ({
      word: k.word,
      count: countBoundaryHits(resumeLower, k.word),
    }))
    .filter((k) => k.count > OVERUSED_THRESHOLD)
    .map((k) => k.word);

  return {
    sections: heatmapSections,
    overallDensity,
    missingCriticalKeywords,
    overusedKeywords,
  };
}

// ---------------------------------------------------------------------------
// ATS parse simulation
// ---------------------------------------------------------------------------

export interface AtsParsedSection {
  name: string;
  detected: boolean;
  /** Characters of body text captured under the header (0 when undetected). */
  contentChars: number;
}

export interface AtsContactInfo {
  name: string | null;
  email: string | null;
  phone: string | null;
  links: string[];
}

export interface AtsParseReport {
  system: AtsSystemId;
  sections: AtsParsedSection[];
  missingRequiredSections: string[];
  contactInfo: AtsContactInfo;
  warnings: string[];
  /** Clamped input length fed to the simulator. */
  inputChars: number;
  /** Length of the plain-text corpus after system coercion. */
  plainTextChars: number;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /https?:\/\/[^\s]+/g;
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const EXTENSION_RE = /^\s*(?:x|ext\.?|extension)\s*(\d{1,6})/i;

function extractPhone(content: string): string | null {
  PHONE_CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHONE_CANDIDATE_RE.exec(content)) !== null) {
    const candidate = match[0].trim();
    const digits = candidate.replace(/\D/g, "");
    // Reject digit garbage (invoice numbers, IDs): real phones are 10–15.
    if (digits.length < 10 || digits.length > 15) continue;
    // Reject candidates glued to alphanumeric context ("ref1234555...").
    const start = match.index;
    const end = start + candidate.length;
    const prev = start > 0 ? content[start - 1] : "";
    const next = end < content.length ? content[end] : "";
    if (/[A-Za-z0-9]/.test(prev) || /[A-Za-z0-9]/.test(next)) continue;
    let phone = candidate;
    const ext = content.slice(end).match(EXTENSION_RE);
    if (ext) phone += ` x${ext[1]}`;
    return phone;
  }
  return null;
}

function extractContactInfo(content: string): AtsContactInfo {
  const emailMatch = EMAIL_RE.exec(content);
  const email =
    emailMatch && emailMatch[0].length <= 320 ? emailMatch[0] : null;
  const links = [...content.matchAll(URL_RE)].map((m) => m[0]).slice(0, 5);
  let name: string | null = null;
  for (const rawLine of content.split("\n").slice(0, 12)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (EMAIL_RE.test(line)) continue;
    if (/https?:\/\//i.test(line)) continue;
    const digits = line.replace(/\D/g, "").length;
    if (digits > 3) continue; // phone line, address, dates
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length > 5 || words.length === 0) continue;
    name = line;
    break;
  }
  return { name, email, phone: extractPhone(content), links };
}

function detectParseSections(content: string): AtsParsedSection[] {
  const lines = content.split("\n");
  const bodies = new Map<string, number>(
    SECTION_DEFS.map((d) => [d.canonical, 0]),
  );
  const detected = new Set<string>();
  let current: string | null = null;
  for (const line of lines) {
    const canonical = headerCanonical(line);
    if (canonical) {
      detected.add(canonical);
      current = canonical;
    } else if (current) {
      bodies.set(current, (bodies.get(current) ?? 0) + line.length);
    }
  }
  return SECTION_DEFS.map((def) => ({
    name: def.canonical,
    detected: detected.has(def.canonical),
    contentChars: bodies.get(def.canonical) ?? 0,
  }));
}

/** Characters outside letters/digits/whitespace/common punctuation. */
function hasExoticSymbols(content: string): boolean {
  for (const ch of content) {
    if (/\s/.test(ch)) continue;
    if (/[\p{L}\p{N}]/u.test(ch)) continue;
    if ("..,;:!?()[]{}'\"-_&/+#@=|%$€£~<>\\\\`*^".includes(ch)) continue;
    return true;
  }
  return false;
}

/**
 * Simulate how an applicant tracking system parses `content`: which sections
 * it detects, whether required sections exist for `system`, what contact info
 * survives, and which formatting hazards may corrupt parsing.
 */
export function simulateAtsParsing(
  content: string,
  system: AtsSystemId = "generic",
): AtsParseReport {
  const rules = atsRulesFor(system);
  const clamped = clampAtsInput(content);
  const plain = formatForAts(clamped, system);
  const sections = detectParseSections(clamped);
  const warnings: string[] = [];

  if (clamped.includes("|") || clamped.includes("\t")) {
    warnings.push(
      "Tables or tabs detected: multi-column layouts often fail to parse correctly in legacy ATS (Taleo, Jobvite).",
    );
  }
  if (hasExoticSymbols(clamped)) {
    warnings.push(
      "Special characters or icons detected: they may be replaced by substitution characters in text-only parsers.",
    );
  }
  if (clamped.split("\n").some((line) => line.length > 120)) {
    warnings.push(
      "Very long lines detected: some older parsers truncate long lines.",
    );
  }

  const detectedNames = new Set(
    sections.filter((s) => s.detected).map((s) => s.name),
  );
  const missingRequiredSections = rules.requiredSections
    .filter((required) => !detectedNames.has(required))
    .sort();

  return {
    system,
    sections,
    missingRequiredSections,
    contactInfo: extractContactInfo(clamped),
    warnings,
    inputChars: clamped.length,
    plainTextChars: plain.length,
  };
}

// ---------------------------------------------------------------------------
// JD metadata extraction
// ---------------------------------------------------------------------------

export type ExperienceLevel = "entry" | "mid" | "senior" | "lead" | "executive";

export interface SalaryRange {
  min: number;
  max: number;
  currency: string;
}

export interface JdRequirements {
  mustHave: string[];
  preferred: string[];
  bonusSkills: string[];
}

export interface JdMetadata {
  jobTitle: string | null;
  company: string | null;
  location: string | null;
  postedDate: string | null;
  salaryRange: SalaryRange | null;
  salarySummary: string | null;
  benefits: string[];
  cultureKeywords: string[];
  experienceLevel: ExperienceLevel | null;
  requirements: JdRequirements;
}

const TITLE_PATTERNS: readonly RegExp[] = [
  /(?:position|role|title|job):\s*([^\n]+)/i,
  /(?:looking for|seeking|hiring)\s+(?:an?\s+)?([a-z\s]+(?:engineer|developer|manager|analyst|specialist|director|lead|senior|junior))/i,
  /^([a-z\s]+(?:engineer|developer|manager|analyst|specialist|director|lead|senior|junior))/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const value = match[1].trim();
      if (value) return value;
    }
  }
  return null;
}

function extractJobTitle(text: string): string | null {
  const title = firstMatch(text, TITLE_PATTERNS);
  if (!title) return null;
  // Truncate run-on captures at a clause boundary (≤ 8 words / 80 chars).
  const clause =
    title.split(/\s+(?:who|which|that|with|to\b)[\s,]/i)[0] ?? title;
  const words = clause.split(/\s+/).slice(0, 8).join(" ");
  return words.slice(0, 80).trim() || null;
}

function extractCompany(text: string): string | null {
  // Prefer "<ProperNoun> is/seeks/looking" over the labeled-line capture,
  // which upstream truncated badly ("ExampleCorp is seeking..." verbatim).
  const verbMatch =
    /(?:about\s+)?([A-Z][A-Za-z0-9.&']*(?:\s+[A-Z][A-Za-z0-9.&']+)*),?\s+(?:is|seeks|looking)/.exec(
      text,
    );
  if (verbMatch?.[1]) return verbMatch[1].trim().slice(0, 80);
  const labeled = /(?:at|company|organization|employer):\s*([^\n]+)/i.exec(
    text,
  );
  if (labeled?.[1]) {
    const value = labeled[1].trim();
    // Keep only the leading proper-noun-ish phrase.
    const cut = value.search(/\s+(?:is|seeks|looking|we're|we are)\b/i);
    const name = (cut > 0 ? value.slice(0, cut) : value)
      .split(/\s+/)
      .slice(0, 6)
      .join(" ");
    return name.slice(0, 80).trim() || null;
  }
  return null;
}

const US_STATES = [
  "CA",
  "NY",
  "TX",
  "FL",
  "IL",
  "PA",
  "OH",
  "GA",
  "NC",
  "MI",
  "NJ",
  "VA",
  "WA",
  "AZ",
  "MA",
  "TN",
  "IN",
  "MO",
  "MD",
  "WI",
  "CO",
  "MN",
  "SC",
  "AL",
  "LA",
  "KY",
  "OR",
  "OK",
  "CT",
  "IA",
  "AR",
  "UT",
  "NV",
  "MS",
  "KS",
  "NM",
  "NE",
  "WV",
  "ID",
  "HI",
  "NH",
  "ME",
  "RI",
  "MT",
  "DE",
  "SD",
  "ND",
  "AK",
  "VT",
  "WY",
  "DC",
];

function extractLocation(text: string): string | null {
  const labeled = /(?:location|based in|office in):\s*([^\n]+)/i.exec(text);
  if (labeled?.[1]) {
    const value = labeled[1].trim().split(/\s{2,}/)[0];
    if (value) return value.slice(0, 80);
  }
  const statePattern = `(?:in|at)\\s+([A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+)*),?\\s+(${US_STATES.join("|")})\\b`;
  const stateMatch = new RegExp(statePattern).exec(text);
  if (stateMatch?.[1]) {
    return `${stateMatch[1]}, ${stateMatch[2]}`.slice(0, 80);
  }
  if (countBoundaryHits(text, "remote") > 0) return "Remote";
  if (countBoundaryHits(text, "hybrid") > 0) return "Hybrid";
  return null;
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").toLowerCase();
  const num = Number.parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return cleaned.endsWith("k") ? num * 1000 : num;
}

function extractSalaryRange(text: string): SalaryRange | null {
  const patterns: readonly RegExp[] = [
    /([$£€])\s*(\d{1,3}(?:,\d{3})*(?:k)?)\s*[-–—]\s*(?:[$£€])?\s*(\d{1,3}(?:,\d{3})*(?:k)?)/i,
    /(?:salary|compensation|pay)\s*:\s*([$£€])?\s*(\d{1,3}(?:,\d{3})*(?:k)?)\s*[-–—]\s*(?:[$£€])?\s*(\d{1,3}(?:,\d{3})*(?:k)?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const currency = match[1] ?? "$";
    const groups = match.slice(2).filter(Boolean);
    const min = parseMoney(groups[0]);
    const maxRaw = groups[groups.length - 1];
    const max = groups.length > 1 ? parseMoney(maxRaw) : min;
    if (min == null || max == null) continue;
    // Fix #6: never report an inverted range.
    if (max < min) continue;
    return { min, max, currency };
  }
  return null;
}

const BENEFITS_LEXICON: readonly string[] = [
  "401(k)",
  "401k",
  "pension",
  "equity",
  "stock options",
  "unlimited pto",
  "vacation",
  "health insurance",
  "dental",
  "vision",
  "remote",
  "hybrid",
  "flex hours",
  "gym",
  "stipend",
];

function extractBenefits(text: string): string[] {
  const lower = text.toLowerCase();
  return BENEFITS_LEXICON.filter((benefit) => {
    if (benefit.includes("(") || benefit.includes(" ")) {
      return lower.includes(benefit);
    }
    return countBoundaryHits(lower, benefit) > 0;
  });
}

const CULTURE_LEXICON: readonly string[] = [
  "fast-paced",
  "collaborative",
  "innovative",
  "ownership",
  "growth mindset",
  "customer-centric",
  "agile",
  "startup",
  "diverse",
  "inclusive",
  "remote-first",
  "data-driven",
];

function extractCultureKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return CULTURE_LEXICON.filter((keyword) => lower.includes(keyword));
}

const REQUIREMENT_BUCKETS: ReadonlyArray<{
  bucket: keyof JdRequirements;
  matchers: readonly string[];
}> = [
  {
    bucket: "mustHave",
    matchers: [
      "requirements",
      "required",
      "must have",
      "must-have",
      "qualification",
      "qualifications",
      "you will need",
      "basic qualifications",
    ],
  },
  {
    bucket: "preferred",
    matchers: [
      "preferred",
      "nice to have",
      "nice-to-have",
      "desired",
      "preferred qualifications",
      "plus points",
    ],
  },
  {
    bucket: "bonusSkills",
    matchers: ["bonus", "plus", "bonus points", "good to have"],
  },
];

const MAX_REQUIREMENTS_PER_BUCKET = 50;

/**
 * Bucket bullet lines by the most recent requirement-heading seen above them.
 * Line-level state machine (upstream split only on blank lines, collapsing
 * everything into mustHave whenever a JD had no blank lines — fix #6b).
 */
function extractRequirements(text: string): JdRequirements {
  const result: JdRequirements = {
    mustHave: [],
    preferred: [],
    bonusSkills: [],
  };
  let current: keyof JdRequirements | null = null;
  for (const rawLine of clampAtsInput(text).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const stripped = line
      .replace(/^[#>*•·\-–—+=_\s]+/, "")
      .replace(/^\d{1,2}\s*[.)]\s*/, "")
      .replace(/[:\s]+$/, "")
      .toLowerCase();
    const bucket = REQUIREMENT_BUCKETS.find((entry) =>
      entry.matchers.some(
        (matcher) => stripped === matcher || stripped.startsWith(`${matcher} `),
      ),
    );
    if (bucket) {
      current = bucket.bucket;
      continue;
    }
    const isBullet = /^[•\-*–—+]|^\d{1,2}[.)]\s/.test(line);
    if (!current || !isBullet) continue;
    const target = result[current];
    if (target.length >= MAX_REQUIREMENTS_PER_BUCKET) continue;
    target.push(line.replace(/^[•\-*–—+]\s*/, "").trim());
  }
  return result;
}

const EXPERIENCE_LEVEL_LADDER: ReadonlyArray<{
  level: ExperienceLevel;
  signals: readonly string[];
}> = [
  {
    level: "executive",
    signals: ["executive", "vp", "vice president", "director", "head of"],
  },
  { level: "lead", signals: ["lead", "principal", "staff"] },
  { level: "senior", signals: ["senior", "sr."] },
  { level: "mid", signals: ["mid-level", "intermediate"] },
  {
    level: "entry",
    signals: [
      "junior",
      "jr.",
      "entry level",
      "entry-level",
      "graduate",
      "intern",
    ],
  },
];

function categorizeExperienceLevel(text: string): ExperienceLevel | null {
  const lower = text.toLowerCase();
  for (const step of EXPERIENCE_LEVEL_LADDER) {
    for (const signal of step.signals) {
      if (signal.includes(".")) {
        if (lower.includes(signal)) return step.level;
      } else if (countBoundaryHits(lower, signal) > 0) {
        return step.level;
      }
    }
  }
  return null;
}

function extractPostedDate(text: string): string | null {
  const patterns: readonly RegExp[] = [
    /(?:posted|published|date)\s*:\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:posted|published)\s+on\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function formatSalarySummary(range: SalaryRange): string {
  const fmt = (value: number) => value.toLocaleString("en-US");
  return `${range.currency}${fmt(range.min)} - ${range.currency}${fmt(range.max)}`;
}

/**
 * Deterministic metadata extraction from a job description. Heuristics only —
 * callers should treat every field as nullable evidence, not truth.
 */
export function analyzeJdMetadata(jdText: string): JdMetadata {
  const clamped = clampAtsInput(jdText);
  const salaryRange = extractSalaryRange(clamped);
  return {
    jobTitle: extractJobTitle(clamped),
    company: extractCompany(clamped),
    location: extractLocation(clamped),
    postedDate: extractPostedDate(clamped),
    salaryRange,
    salarySummary: salaryRange ? formatSalarySummary(salaryRange) : null,
    benefits: extractBenefits(clamped),
    cultureKeywords: extractCultureKeywords(clamped),
    experienceLevel: categorizeExperienceLevel(clamped),
    requirements: extractRequirements(clamped),
  };
}

// ---------------------------------------------------------------------------
// Synthesized-content flattening (pipeline integration)
// ---------------------------------------------------------------------------

function appendBlock(
  lines: string[],
  block: {
    title: string;
    org: string;
    location?: string;
    dateRange: string;
    urlLabel?: string;
    bullets: string[];
  },
): void {
  const head = [block.title, block.org].filter(Boolean).join(", ");
  const meta = [block.location, block.dateRange]
    .filter((part) => part?.trim())
    .join(" · ");
  lines.push(meta ? `${head} — ${meta}` : head);
  if (block.urlLabel?.trim()) lines.push(block.urlLabel.trim());
  for (const bullet of block.bullets) {
    if (bullet.trim()) lines.push(bullet.trim());
  }
}

function appendSkillGroups(
  lines: string[],
  skills: SkillGroup[] | undefined,
): void {
  for (const group of skills ?? []) {
    const items = typeof group.items === "string" ? group.items.trim() : "";
    if (!items) continue;
    lines.push(group.label?.trim() ? `${group.label.trim()}: ${items}` : items);
  }
}

/**
 * Flatten synthesized `ResumeContent` to the plain text an ATS would see
 * from the printed document. Mirrors what templates print: header contact
 * fields, summary, section titles, entries, bullets, and skill groups.
 */
export function renderedContentPlainText(content: ResumeContent): string {
  const lines: string[] = [];
  const header = content.header ?? {
    fullName: "",
    cityRegion: "",
    email: "",
    phone: "",
  };
  for (const field of [
    header.fullName,
    header.cityRegion,
    header.email,
    header.phone,
    header.linkedinUrl,
    header.githubUrl,
    header.portfolioUrl,
  ]) {
    if (field?.trim()) lines.push(field.trim());
  }
  if (content.summary?.trim()) {
    lines.push("SUMMARY", content.summary.trim());
  }
  if (content.skills?.length) {
    lines.push("SKILLS");
    appendSkillGroups(lines, content.skills);
  }
  const sectionSources: Array<[string, RenderedBlock[] | undefined]> = [
    ["EXPERIENCE", content.experience],
    ["PROJECTS", content.projects],
    ["EDUCATION", content.education],
    ["PUBLICATIONS", content.publications],
    ["LEADERSHIP", content.leadership],
    ["CERTIFICATIONS", content.certifications],
    ["AWARDS", content.awards],
    ["VOLUNTEER", content.volunteer],
  ];
  for (const [heading, blocks] of sectionSources) {
    if (!blocks?.length) continue;
    lines.push(heading);
    for (const block of blocks) appendBlock(lines, block);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MatchReport summary shapes (persisted on MatchReport — keep compact)
// ---------------------------------------------------------------------------

export interface MatchReportAtsParseSection {
  name: string;
  detected: boolean;
}

export interface MatchReportAtsParse {
  system: AtsSystemId;
  warnings: string[];
  sections: MatchReportAtsParseSection[];
  missingRequiredSections: string[];
  contact: { name: boolean; email: boolean; phone: boolean; linkCount: number };
  inputChars: number;
  plainTextChars: number;
}

export interface MatchReportKeywordHeatmap {
  overallDensity: number;
  sections: Array<{
    name: string;
    density: number;
    heatLevel: HeatLevel;
  }>;
  missingCriticalKeywords: string[];
  overusedKeywords: string[];
}

export function summarizeAtsParse(report: AtsParseReport): MatchReportAtsParse {
  return {
    system: report.system,
    warnings: report.warnings,
    sections: report.sections.map((s) => ({
      name: s.name,
      detected: s.detected,
    })),
    missingRequiredSections: report.missingRequiredSections,
    contact: {
      name: Boolean(report.contactInfo.name),
      email: Boolean(report.contactInfo.email),
      phone: Boolean(report.contactInfo.phone),
      linkCount: report.contactInfo.links.length,
    },
    inputChars: report.inputChars,
    plainTextChars: report.plainTextChars,
  };
}

export function summarizeKeywordHeatmap(
  heatmap: KeywordHeatmap,
): MatchReportKeywordHeatmap {
  return {
    overallDensity: Math.round(heatmap.overallDensity * 100) / 100,
    sections: heatmap.sections.map((s) => ({
      name: s.name,
      density: Math.round(s.density * 100) / 100,
      heatLevel: s.heatLevel,
    })),
    missingCriticalKeywords: heatmap.missingCriticalKeywords,
    overusedKeywords: heatmap.overusedKeywords,
  };
}
