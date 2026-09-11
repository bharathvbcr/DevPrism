import { aiComplete, canUseAiAssist } from "@/lib/ai-assist";
import {
  extractContactInfo,
  splitResumeIntoSections,
} from "@/lib/resume-synthesis/ats-simulate";
import type { HeaderFields, SkillGroup } from "@/lib/resume-templates";
import type { BlockFact, BlockKind, ExperienceBlock } from "./types";
import {
  BLOCK_KIND_TO_SECTION,
  canonicalizeBlockKind,
  canonicalSectionFromHeader,
  type ResumeSectionId,
} from "../resume-sections";
import {
  createEmptyBlock,
  isSeniorityLevel,
  newBlockFact,
  newBullet,
  newCareerId,
} from "./block-helpers";

/** Hard cap on blocks accepted from a single LLM extract. Fail closed on floods. */
export const EXTRACT_MAX_BLOCKS = 200;
const EXTRACT_MAX_BULLETS = 40;
const EXTRACT_MAX_FACTS = 40;
const EXTRACT_MAX_TEXT = 2000;
const EXTRACT_MAX_TITLE = 200;

function clipText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

const EXTRACT_SYSTEM = `You extract structured resume experience blocks from LaTeX or plain-text resume source.
Return ONLY JSON of the form:
{"blocks":[{
  "kind":"experience"|"project"|"publication"|"education"|"leadership"|"certification"|"award"|"volunteer",
  "title":string,
  "org":string,
  "dateStart":string (YYYY-MM or YYYY),
  "dateEnd":string|null,
  "domains":string[],
  "skills":string[],
  "seniorityLevel":"ic"|"senior"|"lead"|"manager"|"director",
  "location":string (optional, e.g. "Remote" or "New York, NY"),
  "extra":string (optional trailing detail line: GPA, honors, coursework),
  "bullets":string[],
  "facts":string[] (optional)
}]}
Rules:
- Prefer factual content present in the source; do not invent employers or metrics.
- Split distinct roles/projects into separate blocks.
- Bullets are polished resume lines (plain text, no LaTeX commands) — keep a tight set.
- When the source has extra detail that does not fit cleanly as polished bullets (side metrics, tools, ownership notes), put those in facts[] as short raw points. Omit facts when everything fits in bullets.
- Put a GPA / honors / coursework line in "extra", not in bullets.
- For publications, put venue in org, authors/DOI in extra, and a URL when present.
- If unsure of seniority, use "senior".
- Return ONLY JSON — no markdown fences, no commentary.`;

/** Best-effort JSON parse (fences / leading prose), matching ai-assist salvage style. */
export function tryParseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== null) return fenced;
  }
  const arrStart = trimmed.indexOf("[");
  const objStart = trimmed.indexOf("{");
  const idx =
    arrStart >= 0 && (objStart < 0 || arrStart < objStart)
      ? arrStart
      : objStart;
  if (idx >= 0) {
    const sliced = tryParse(trimmed.slice(idx));
    if (sliced !== null) return sliced;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeDate(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 10);
}

/** Validate/normalize LLM JSON into draft ExperienceBlock[] (new ids, never persisted). */
export function parseExtractedBlocks(raw: string): ExperienceBlock[] {
  const parsed = tryParseJsonLoose(raw);
  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.blocks)) items = obj.blocks;
    else {
      const nested = Object.values(obj).find(Array.isArray);
      if (nested) items = nested as unknown[];
    }
  }

  const out: ExperienceBlock[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title =
      typeof row.title === "string"
        ? row.title.trim()
        : typeof row.role === "string"
          ? row.role.trim()
          : "";
    const org =
      typeof row.org === "string"
        ? row.org.trim()
        : typeof row.organization === "string"
          ? row.organization.trim()
          : typeof row.company === "string"
            ? row.company.trim()
            : "";
    if (!title && !org) continue;
    if (out.length >= EXTRACT_MAX_BLOCKS) break;

    const bulletTexts = asStringArray(row.bullets)
      .slice(0, EXTRACT_MAX_BULLETS)
      .map((t) => clipText(t, EXTRACT_MAX_TEXT));
    const factTexts = asStringArray(row.facts)
      .slice(0, EXTRACT_MAX_FACTS)
      .map((t) => clipText(t, EXTRACT_MAX_TEXT));
    const facts: BlockFact[] = factTexts.map((text) =>
      newBlockFact(text, { source: "import" }),
    );
    const skills = asStringArray(row.skills).map((name) => ({
      name,
      level: 3 as const,
    }));
    const domains = asStringArray(row.domains);
    const dateStart =
      normalizeDate(row.dateStart) ||
      normalizeDate(row.start) ||
      (row.dateRange &&
      typeof row.dateRange === "object" &&
      row.dateRange !== null
        ? normalizeDate((row.dateRange as Record<string, unknown>).start)
        : "");
    const dateEndRaw =
      row.dateEnd === null
        ? null
        : normalizeDate(row.dateEnd) ||
          normalizeDate(row.end) ||
          (row.dateRange &&
          typeof row.dateRange === "object" &&
          row.dateRange !== null
            ? (() => {
                const end = (row.dateRange as Record<string, unknown>).end;
                return end === null ? null : normalizeDate(end) || null;
              })()
            : null);

    const rawKind = row.kind;
    const omittedKind =
      rawKind === undefined || rawKind === null || rawKind === "";
    const kind = omittedKind ? "experience" : canonicalizeBlockKind(rawKind);
    if (!kind) continue;

    out.push(
      createEmptyBlock({
        id: newCareerId("exp"),
        kind,
        title: clipText(title || "Untitled", EXTRACT_MAX_TITLE),
        org: clipText(org, EXTRACT_MAX_TITLE),
        dateRange: {
          start: dateStart,
          end: dateEndRaw === "" ? null : dateEndRaw,
        },
        domains,
        skills,
        seniorityLevel: isSeniorityLevel(row.seniorityLevel)
          ? row.seniorityLevel
          : "senior",
        location: optionalText(row.location),
        extra: optionalText(row.extra),
        bullets:
          bulletTexts.length > 0
            ? bulletTexts.map((t) => newBullet(t))
            : [newBullet()],
        facts,
        personas: [],
      }),
    );
  }
  return out;
}

/** Trimmed string when present and non-empty, else undefined. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export type ExtractVia = "llm" | "deterministic" | "hybrid";

export interface ExtractedResume {
  blocks: ExperienceBlock[];
  header: Partial<HeaderFields>;
  summary: string | null;
  skillGroups: SkillGroup[];
  via: ExtractVia;
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

const MAX_BRACE_DEPTH = 32;
const MAX_ARG_CHARS = 8000;
const LATEX_ENTRY_COMMANDS = new Set([
  "resumeSubheading",
  "resumeProfessionalExperience",
  "resumeAcademicProject",
]);

function looksLikeLatexResume(text: string): boolean {
  return /\\(?:documentclass|section\*?|resumeItem|resumeSubheading|resumeProfessionalExperience|begin\{document\})/.test(
    text,
  );
}

function stripLatexComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) break;
        out += line[i];
      }
      return out;
    })
    .join("\n");
}

function extractBalanced(
  src: string,
  start: number,
): { arg: string; end: number } | null {
  if (src[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      if (depth > MAX_BRACE_DEPTH) return null;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const arg = src.slice(start + 1, i);
        if (arg.length > MAX_ARG_CHARS) return null;
        return { arg, end: i + 1 };
      }
    }
  }
  return null;
}

function takeBraceArgs(
  src: string,
  start: number,
  count: number,
): { args: string[]; end: number } | null {
  const args: string[] = [];
  let i = start;
  for (let n = 0; n < count; n++) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    const taken = extractBalanced(src, i);
    if (!taken) return null;
    args.push(taken.arg);
    i = taken.end;
  }
  return { args, end: i };
}

function unwrapOneCommand(src: string, name: string): string {
  const re = new RegExp(`\\\\${name}\\*?\\s*\\{`, "g");
  let rebuilt = "";
  let last = 0;
  let found = false;
  let match = re.exec(src);
  while (match) {
    const braceAt = match.index + match[0].length - 1;
    const taken = extractBalanced(src, braceAt);
    if (!taken) break;
    rebuilt += src.slice(last, match.index) + taken.arg;
    last = taken.end;
    found = true;
    re.lastIndex = taken.end;
    match = re.exec(src);
  }
  if (!found) return src;
  return rebuilt + src.slice(last);
}

function unwrapNamedGroups(src: string, names: readonly string[]): string {
  let out = src;
  for (let guard = 0; guard < 8; guard++) {
    const before = out;
    for (const name of names) {
      out = unwrapOneCommand(out, name);
    }
    if (out === before) break;
  }
  return out;
}

export function latexToPlain(input: string): string {
  let s = input
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\\\\/g, " ");
  for (let g = 0; g < 8; g++) {
    const next = s
      .replace(/\\href\{([^{}]*)\}\{([^{}]*)\}/g, "$2")
      .replace(
        /\\(?:textbf|textit|emph|texttt|textsc|textmd|textsf|textnormal|underline)\{([^{}]*)\}/g,
        "$1",
      )
      .replace(/\\(?:Huge|small|scshape|centering|noindent)\s*/g, "")
      .replace(/\\(?:vspace|hspace)\*?\{[^{}]*\}/g, "")
      .replace(/\\[a-zA-Z@]+\*?/g, (m) => m.slice(1))
      .replace(/[{}$]/g, "")
      .replace(/~/g, " ");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim();
}

function parseOneDate(token: string): string {
  const t = token.trim();
  if (!t || /^(present|current|now|today)$/i.test(t)) return "";
  const iso = t.match(/^(\d{4})(?:[-/](\d{1,2}))?$/);
  if (iso) {
    return iso[2] ? `${iso[1]}-${iso[2].padStart(2, "0")}` : iso[1];
  }
  const my = t.match(
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{4})$/i,
  );
  if (my) {
    const key = my[1].slice(0, 3).toLowerCase();
    const mm = MONTHS[key];
    return mm ? `${my[2]}-${mm}` : my[2];
  }
  const year = t.match(/(\d{4})/);
  return year ? year[1] : "";
}

function parseDateRange(text: string): { start: string; end: string | null } {
  const parts = text.split(/\s*(?:--|—|–|\bto\b|\buntil\b)\s*/i);
  if (parts.length >= 2) {
    const start = parseOneDate(parts[0]);
    const endRaw = parts[parts.length - 1];
    const end = /present|current|now/i.test(endRaw)
      ? null
      : parseOneDate(endRaw) || null;
    return { start, end };
  }
  const start = parseOneDate(text);
  return { start, end: start ? start : null };
}

function blockKindForSection(id: ResumeSectionId): BlockKind | null {
  for (const [kind, section] of Object.entries(BLOCK_KIND_TO_SECTION)) {
    if (section === id) return kind as BlockKind;
  }
  return null;
}

function pushBlock(
  out: ExperienceBlock[],
  kind: BlockKind,
  title: string,
  org: string,
  dates: { start: string; end: string | null },
  bullets: string[],
  extra?: { location?: string; url?: string },
): void {
  if (out.length >= EXTRACT_MAX_BLOCKS) return;
  const titleText = clipText(
    latexToPlain(title) || "Untitled",
    EXTRACT_MAX_TITLE,
  );
  const orgText = clipText(latexToPlain(org), EXTRACT_MAX_TITLE);
  if (!titleText && !orgText) return;
  const bulletTexts = bullets
    .map((b) => latexToPlain(b))
    .filter(Boolean)
    .slice(0, EXTRACT_MAX_BULLETS)
    .map((t) => clipText(t, EXTRACT_MAX_TEXT));
  out.push(
    createEmptyBlock({
      id: newCareerId("exp"),
      kind,
      title: titleText || "Untitled",
      org: clipText(orgText, EXTRACT_MAX_TITLE),
      dateRange: dates,
      location: extra?.location ? latexToPlain(extra.location) : undefined,
      url: extra?.url,
      bullets:
        bulletTexts.length > 0
          ? bulletTexts.map((t) => newBullet(t))
          : [newBullet()],
      facts: [],
      personas: [],
    }),
  );
}

function extractHrefUrl(raw: string): string | undefined {
  const match = raw.match(/\\href\{(https?:[^}]+)\}/i);
  return match?.[1];
}

function extractLatexBlocks(src: string): ExperienceBlock[] {
  const stripped = stripLatexComments(src);
  const expanded = unwrapNamedGroups(stripped, ["cvonly", "resonly"]);
  const cleaned = expanded
    .replace(/\\resume(?:Item|SubHeading)List(?:Start|End)/g, "\n")
    .replace(/\\resumeSubHeadingList(?:Start|End)/g, "\n");

  const out: ExperienceBlock[] = [];
  let kind: BlockKind = "experience";
  let current: {
    kind: BlockKind;
    title: string;
    org: string;
    dates: { start: string; end: string | null };
    location?: string;
    url?: string;
    bullets: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    pushBlock(
      out,
      current.kind,
      current.title,
      current.org,
      current.dates,
      current.bullets,
      {
        location: current.location,
        url: current.url,
      },
    );
    current = null;
  };

  let i = 0;
  while (i < cleaned.length && out.length < EXTRACT_MAX_BLOCKS) {
    if (cleaned[i] !== "\\") {
      i += 1;
      continue;
    }
    const cmdMatch = cleaned.slice(i).match(/^\\([a-zA-Z@]+)\*?/);
    if (!cmdMatch) {
      i += 1;
      continue;
    }
    const command = cmdMatch[1];
    const pos = i + cmdMatch[0].length;
    if (command === "section") {
      const taken = takeBraceArgs(cleaned, pos, 1);
      if (taken) {
        flush();
        const title = latexToPlain(taken.args[0] ?? "");
        const section = canonicalSectionFromHeader(title);
        const mapped = section ? blockKindForSection(section) : null;
        if (mapped) kind = mapped;
        i = taken.end;
        continue;
      }
    } else if (LATEX_ENTRY_COMMANDS.has(command)) {
      const argCount =
        command === "resumeSubheading"
          ? 4
          : command === "resumeAcademicProject"
            ? 2
            : 3;
      const taken = takeBraceArgs(cleaned, pos, argCount);
      if (taken) {
        flush();
        const args = taken.args.map((a) => a.trim());
        if (command === "resumeSubheading") {
          current = {
            kind,
            title: args[0] ?? "",
            org: args[2] ?? "",
            dates: parseDateRange(latexToPlain(args[1] ?? "")),
            location: args[3] ? latexToPlain(args[3]) : undefined,
            url: extractHrefUrl(args[2] ?? "") ?? extractHrefUrl(args[0] ?? ""),
            bullets: [],
          };
        } else if (command === "resumeAcademicProject") {
          current = {
            kind: kind === "experience" ? "project" : kind,
            title: args[0] ?? "",
            org: "",
            dates: parseDateRange(latexToPlain(args[1] ?? "")),
            url:
              extractHrefUrl(args[1] ?? "") ??
              (/^https?:\/\//i.test(latexToPlain(args[1] ?? ""))
                ? latexToPlain(args[1] ?? "")
                : undefined),
            bullets: [],
          };
        } else {
          current = {
            kind,
            title: args[0] ?? "",
            org: args[1] ?? "",
            dates: parseDateRange(latexToPlain(args[2] ?? "")),
            url: extractHrefUrl(args[1] ?? ""),
            bullets: [],
          };
        }
        i = taken.end;
        continue;
      }
    } else if (command === "resumeItem" || command === "item") {
      const taken = takeBraceArgs(cleaned, pos, 1);
      if (taken) {
        if (current) current.bullets.push(taken.args[0] ?? "");
        i = taken.end;
        continue;
      }
    }
    i = pos;
  }
  flush();
  return out;
}

function parseSkillItems(text: string): string[] {
  return text
    .split(/[,;|\n]/)
    .map((s) => latexToPlain(s))
    .map((s) => s.replace(/^[-*•]\s*/, "").trim())
    .filter((s) => s.length > 1 && s.length <= 80)
    .slice(0, 40);
}

function splitEntries(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTitleOrgFromLine(
  line: string,
  kind: BlockKind,
): {
  title: string;
  org: string;
  dates: { start: string; end: string | null };
} {
  const pipes = line
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  const dateSeg = pipes.find((p) => /\d{4}|present/i.test(p));
  const dates = parseDateRange(dateSeg ?? line);
  const rest = pipes.filter((p) => p !== dateSeg);
  if (rest.length >= 2) {
    if (kind === "certification" || kind === "award") {
      return { title: rest[0], org: rest[1], dates };
    }
    return { org: rest[0], title: rest[1], dates };
  }
  if (rest.length === 1) {
    const at = rest[0].match(/^(.+?)\s+at\s+(.+)$/i);
    if (at) return { title: at[1], org: at[2], dates };
    return { title: rest[0], org: "", dates };
  }
  const at = line.match(/^(.+?)\s+at\s+(.+)$/i);
  if (at) return { title: at[1], org: at[2], dates };
  return { title: latexToPlain(line), org: "", dates };
}

function parsePlainBlocks(
  sectionId: ResumeSectionId,
  text: string,
): ExperienceBlock[] {
  const kind = blockKindForSection(sectionId);
  if (!kind) return [];
  const out: ExperienceBlock[] = [];
  for (const entry of splitEntries(text)) {
    const lines = entry
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const bullets = lines
      .filter((l) => /^[-*•]/.test(l))
      .map((l) => l.replace(/^[-*•]\s*/, ""));
    const headerLine = lines.find((l) => !/^[-*•]/.test(l)) ?? lines[0];
    const parsed = parseTitleOrgFromLine(headerLine, kind);
    const extraLines = lines.filter(
      (l) => l !== headerLine && !/^[-*•]/.test(l),
    );
    pushBlock(out, kind, parsed.title, parsed.org, parsed.dates, bullets);
    if (extraLines.length > 0 && out.length > 0) {
      const last = out[out.length - 1];
      last.extra = clipText(
        extraLines.map(latexToPlain).join("; "),
        EXTRACT_MAX_TEXT,
      );
    }
  }
  return out;
}

function headerFromContact(
  info: ReturnType<typeof extractContactInfo>,
): Partial<HeaderFields> {
  const header: Partial<HeaderFields> = {};
  if (info.name) header.fullName = info.name;
  if (info.email) header.email = info.email;
  if (info.phone) header.phone = info.phone;
  for (const link of info.links) {
    const lower = link.toLowerCase();
    if (lower.includes("linkedin.com") && !header.linkedinUrl) {
      header.linkedinUrl = link.replace(/[),.;]+$/, "");
    } else if (lower.includes("github.com") && !header.githubUrl) {
      header.githubUrl = link.replace(/[),.;]+$/, "");
    } else if (!header.portfolioUrl) {
      header.portfolioUrl = link.replace(/[),.;]+$/, "");
    }
  }
  return header;
}

function cityFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (EMAIL_CITY_GUARD.test(trimmed) || /https?:\/\//i.test(trimmed)) {
    return null;
  }
  if (/^[\p{L} .'-]+,\s*[\p{L}.]{2,}(?:\s+\d{5}(?:-\d{4})?)?$/u.test(trimmed)) {
    return trimmed;
  }
  return null;
}

const EMAIL_CITY_GUARD = /@/;

function headerFromSource(text: string): Partial<HeaderFields> {
  const fromRaw = headerFromContact(extractContactInfo(text));
  const cleanedHead = text
    .split("\n")
    .slice(0, 24)
    .map((line) => latexToPlain(line))
    .join("\n");
  const fromHead = headerFromContact(extractContactInfo(cleanedHead));
  let header = mergePartialHeader(fromHead, fromRaw);
  if (!header.cityRegion) {
    for (const raw of text.split("\n").slice(0, 16)) {
      const city = cityFromLine(latexToPlain(raw));
      if (city) {
        header = { ...header, cityRegion: city };
        break;
      }
    }
  }
  return header;
}

function mergePartialHeader(
  a: Partial<HeaderFields>,
  b: Partial<HeaderFields>,
): Partial<HeaderFields> {
  return mergeResumeHeader(
    {
      fullName: a.fullName ?? "",
      cityRegion: a.cityRegion ?? "",
      email: a.email ?? "",
      phone: a.phone ?? "",
      linkedinUrl: a.linkedinUrl,
      githubUrl: a.githubUrl,
      portfolioUrl: a.portfolioUrl,
      linkedinLabel: a.linkedinLabel,
      githubLabel: a.githubLabel,
      portfolioLabel: a.portfolioLabel,
    },
    b,
  );
}

/** Fill empty header fields only — never overwrite a user-entered value. */
export function mergeResumeHeader(
  existing: HeaderFields,
  extracted: Partial<HeaderFields>,
): HeaderFields {
  const fill = (
    prev: string | undefined,
    next: string | undefined,
  ): string | undefined => {
    if (typeof prev === "string" && prev.trim()) return prev;
    if (typeof next === "string" && next.trim()) return next.trim();
    return prev;
  };
  return {
    fullName: fill(existing.fullName, extracted.fullName) ?? "",
    cityRegion: fill(existing.cityRegion, extracted.cityRegion) ?? "",
    email: fill(existing.email, extracted.email) ?? "",
    phone: fill(existing.phone, extracted.phone) ?? "",
    linkedinUrl: fill(existing.linkedinUrl, extracted.linkedinUrl),
    linkedinLabel: fill(existing.linkedinLabel, extracted.linkedinLabel),
    githubUrl: fill(existing.githubUrl, extracted.githubUrl),
    githubLabel: fill(existing.githubLabel, extracted.githubLabel),
    portfolioUrl: fill(existing.portfolioUrl, extracted.portfolioUrl),
    portfolioLabel: fill(existing.portfolioLabel, extracted.portfolioLabel),
  };
}

/** Fill empty summary only — never overwrite a user-entered value. */
export function mergeResumeSummary(
  existing: string,
  extracted: string | null | undefined,
): string {
  if (typeof existing === "string" && existing.trim()) return existing;
  const next = (extracted ?? "").trim();
  return next ? clipText(next, EXTRACT_MAX_TEXT) : "";
}

function applySkillsToBlocks(blocks: ExperienceBlock[], names: string[]): void {
  if (names.length === 0) return;
  const tags = names.slice(0, 40).map((name) => ({ name, level: 3 as const }));
  for (const block of blocks) {
    if (block.skills.length === 0) {
      block.skills = tags.map((t) => ({ ...t }));
    }
  }
}

/**
 * Deterministic (no LLM) extract of IgniteCV/Jake/plain-text resumes into
 * career blocks, contact header, summary, and skill groups.
 */
export function extractResumeDeterministic(source: string): ExtractedResume {
  const text = source.trim();
  const latexBlocks = looksLikeLatexResume(text)
    ? extractLatexBlocks(text)
    : [];
  const sections = splitResumeIntoSections(text);
  const blocks: ExperienceBlock[] = [...latexBlocks];
  const skillGroups: SkillGroup[] = [];
  let summary: string | null = null;
  const header: Partial<HeaderFields> = headerFromSource(text);

  for (const section of sections) {
    const id = canonicalSectionFromHeader(section.name);
    if (!id || id === "header" || id === "contact" || id === "links") continue;
    if (id === "summary") {
      const s = latexToPlain(section.text);
      if (s) summary = clipText(s, EXTRACT_MAX_TEXT);
      continue;
    }
    if (id === "skills" || id === "languages") {
      const items = parseSkillItems(section.text);
      if (items.length > 0) {
        skillGroups.push({
          label: id === "languages" ? "Languages" : "Skills",
          items: items.join(", "),
        });
      }
      continue;
    }
    if (latexBlocks.length > 0 && blockKindForSection(id)) continue;
    blocks.push(...parsePlainBlocks(id, section.text));
  }

  const skillNames = skillGroups
    .filter((g) => !/language/i.test(g.label))
    .flatMap((g) =>
      g.items
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  applySkillsToBlocks(blocks, skillNames);

  const capped = blocks.slice(0, EXTRACT_MAX_BLOCKS);
  return {
    blocks: capped,
    header,
    summary,
    skillGroups,
    via: "deterministic",
  };
}

/**
 * Extract a resume into career blocks. Uses the LLM when available, always
 * runs the deterministic parser for header/skills/summary, and falls back
 * to deterministic blocks when AI is off or returns nothing.
 */
export async function extractResumeFromSource(
  source: string,
): Promise<ExtractedResume> {
  const text = source.trim();
  if (text.length < 40) {
    throw new Error("Paste more resume content (at least a few lines).");
  }
  const deterministic = extractResumeDeterministic(text);
  if (!canUseAiAssist()) {
    if (deterministic.blocks.length === 0) {
      throw new Error(
        "Could not extract any experience blocks. Paste a sectioned resume or enable AI assist.",
      );
    }
    return deterministic;
  }
  try {
    const raw = await aiComplete({
      system: EXTRACT_SYSTEM,
      prompt: text.slice(0, 24_000),
      temperature: 0.1,
      format: "json",
    });
    const llmBlocks = parseExtractedBlocks(raw);
    if (llmBlocks.length === 0) {
      if (deterministic.blocks.length === 0) {
        throw new Error(
          "Could not extract any experience blocks. Try a cleaner resume excerpt.",
        );
      }
      return deterministic;
    }
    applySkillsToBlocks(
      llmBlocks,
      deterministic.skillGroups
        .filter((g) => !/language/i.test(g.label))
        .flatMap((g) =>
          g.items
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
    );
    return {
      blocks: llmBlocks,
      header: deterministic.header,
      summary: deterministic.summary,
      skillGroups: deterministic.skillGroups,
      via: "hybrid",
    };
  } catch (err) {
    if (deterministic.blocks.length > 0) return deterministic;
    throw err instanceof Error
      ? err
      : new Error("Could not extract any experience blocks.");
  }
}

/** LLM extraction → draft blocks. Caller must review; never auto-commits. */
export async function extractBlocksFromResume(
  source: string,
): Promise<ExperienceBlock[]> {
  return (await extractResumeFromSource(source)).blocks;
}
