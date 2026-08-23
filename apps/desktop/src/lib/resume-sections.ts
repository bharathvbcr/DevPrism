/**
 * Canonical resume section taxonomy.
 *
 * Single owner for printable section ids, career block kinds, ATS header
 * aliases, and display titles. Career types, Typst templates, ATS parse
 * simulation, and selection all import from here so a new section cannot
 * exist in one layer and vanish in another.
 *
 * Extra ATS-only ids (`contact`, `links`) are detectable headers that map
 * onto the header/contact parse — they are not persona-orderable slots.
 */

export const BLOCK_KINDS = [
  "experience",
  "project",
  "publication",
  "education",
  "leadership",
  "certification",
  "award",
  "volunteer",
] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

export const RESUME_SECTION_IDS = [
  "header",
  "summary",
  "skills",
  "experience",
  "projects",
  "education",
  "publications",
  "leadership",
  "certifications",
  "awards",
  "languages",
  "volunteer",
  "contact",
  "links",
] as const;

export type ResumeSectionId = (typeof RESUME_SECTION_IDS)[number];

/** Slots a persona may order. Header is always first; contact/links are ATS-only. */
export const PERSONA_SECTION_IDS = [
  "summary",
  "skills",
  "experience",
  "projects",
  "education",
  "publications",
  "leadership",
  "certifications",
  "awards",
  "volunteer",
] as const;

export type PersonaSectionId = (typeof PERSONA_SECTION_IDS)[number];

export const DEFAULT_SECTION_ORDER: readonly PersonaSectionId[] = [
  "summary",
  "skills",
  "experience",
  "projects",
  "education",
  "publications",
  "leadership",
  "certifications",
  "awards",
  "volunteer",
];

/** Two-column left rail. Every other printable section falls through to the right. */
export const TWO_COLUMN_LEFT_SECTIONS: ReadonlySet<PersonaSectionId> = new Set([
  "skills",
  "education",
  "leadership",
  "certifications",
  "awards",
]);

export const BLOCK_KIND_TO_SECTION: Record<BlockKind, PersonaSectionId> = {
  experience: "experience",
  project: "projects",
  publication: "publications",
  education: "education",
  leadership: "leadership",
  certification: "certifications",
  award: "awards",
  volunteer: "volunteer",
};

export const BLOCK_KIND_LABELS: Record<BlockKind, string> = {
  experience: "Experience",
  project: "Project",
  publication: "Publication",
  education: "Education",
  leadership: "Leadership",
  certification: "Certification",
  award: "Award",
  volunteer: "Volunteer",
};

export const SECTION_DISPLAY: Record<ResumeSectionId, string> = {
  header: "Header",
  summary: "Summary",
  skills: "Skills",
  experience: "Experience",
  projects: "Projects",
  education: "Education",
  publications: "Publications",
  leadership: "Leadership",
  certifications: "Certifications",
  awards: "Awards",
  languages: "Languages",
  volunteer: "Volunteer",
  contact: "Contact",
  links: "Links",
};

/**
 * Exact-match aliases after decoration stripping. Body lines that merely
 * contain these words are NOT headers — callers must use
 * `canonicalSectionFromHeader`, never `includes`.
 */
export const SECTION_ALIASES: Record<ResumeSectionId, readonly string[]> = {
  header: ["header"],
  summary: [
    "summary",
    "professional summary",
    "summary of qualifications",
    "objective",
    "career objective",
    "profile",
    "professional profile",
    "about",
    "about me",
  ],
  experience: [
    "experience",
    "work experience",
    "professional experience",
    "relevant experience",
    "employment",
    "employment history",
    "work history",
    "career history",
  ],
  education: [
    "education",
    "academic background",
    "academic history",
    "academics",
    "degrees",
    "education & training",
  ],
  skills: [
    "skills",
    "technical skills",
    "core skills",
    "key skills",
    "competencies",
    "core competencies",
    "expertise",
    "areas of expertise",
    "technologies",
    "tech stack",
    "tools",
  ],
  projects: [
    "projects",
    "selected projects",
    "personal projects",
    "key projects",
  ],
  publications: [
    "publications",
    "selected publications",
    "papers",
    "research",
    "research papers",
    "academic publications",
  ],
  leadership: [
    "leadership",
    "leadership experience",
    "positions of responsibility",
    "activities",
    "extra curricular activities",
    "extracurricular activities",
    "co curricular activities",
  ],
  certifications: [
    "certifications",
    "certificates",
    "licenses",
    "licenses & certifications",
    "licenses and certifications",
    "professional certifications",
  ],
  awards: [
    "awards",
    "honors",
    "honours",
    "achievements",
    "accomplishments",
    "honors and awards",
    "honours and awards",
    "awards and honors",
    "awards and honours",
    "honors & awards",
    "awards & honors",
  ],
  languages: ["languages", "spoken languages"],
  volunteer: [
    "volunteer",
    "volunteer experience",
    "volunteering",
    "community service",
    "community involvement",
  ],
  contact: ["contact", "contact information", "contact info"],
  links: ["links", "portfolio", "profiles"],
};

// biome-ignore lint/complexity/useRegexLiterals: avoid control character regex literal warning
const BIDI_AND_CONTROLS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]",
  "g",
);

/**
 * Fold a candidate header to the alias-table key: strip bidi/zero-width,
 * decoration, numbering, fold `&`/`-`, drop diacritics, lowercase.
 * Length is measured on the folded key so padding cannot evade the cap.
 */
function foldHeaderKey(line: string): string | null {
  if (typeof line !== "string" || !line) return null;
  let s = line.normalize("NFKC").replace(BIDI_AND_CONTROLS, "");
  s = s.trim();
  if (!s) return null;
  s = s.replace(/^[#>*•·\-–—+=_\s]+/, "");
  s = s.replace(/^\d{1,2}\s*[.)]\s*/, "");
  s = s.replace(/[\s:#*=_~\-–—+=•·|]+$/, "");
  s = s.replace(/\s*&\s*/g, " and ");
  s = s.replace(/[-–—]/g, " ");
  s = s.normalize("NFKD").replace(/\p{M}/gu, "");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  if (!s || s.length > 48) return null;
  return s;
}

const HEADER_LOOKUP: ReadonlyMap<string, ResumeSectionId> = (() => {
  const map = new Map<string, ResumeSectionId>();
  for (const id of RESUME_SECTION_IDS) {
    for (const alias of SECTION_ALIASES[id]) {
      const key = foldHeaderKey(alias);
      if (!key) continue;
      const prev = map.get(key);
      if (prev && prev !== id) {
        throw new Error(
          `folded section alias collision: "${key}" is ${prev} and ${id}`,
        );
      }
      map.set(key, id);
    }
  }
  return map;
})();

const KNOWN_SECTION_IDS = new Set<string>(RESUME_SECTION_IDS);

/**
 * LLM/import synonyms for `BlockKind`. Keys are already lowercased and
 * whitespace-collapsed. Canonical kinds are matched first and are not listed.
 */
const BLOCK_KIND_ALIASES: Record<string, BlockKind> = {
  work: "experience",
  employment: "experience",
  "work experience": "experience",
  projects: "project",
  publications: "publication",
  papers: "publication",
  paper: "publication",
  academic: "education",
  academics: "education",
  "positions of responsibility": "leadership",
  certifications: "certification",
  certificate: "certification",
  certificates: "certification",
  license: "certification",
  licenses: "certification",
  awards: "award",
  honor: "award",
  honors: "award",
  honours: "award",
  volunteering: "volunteer",
  "volunteer experience": "volunteer",
};

/** True when `value` is a career block kind. */
export function isBlockKind(value: unknown): value is BlockKind {
  return (
    typeof value === "string" &&
    (BLOCK_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Map an LLM/import kind string onto a canonical `BlockKind`.
 * Unknown / non-string values return null so callers can fail closed.
 */
export function canonicalizeBlockKind(value: unknown): BlockKind | null {
  if (typeof value !== "string") return null;
  const n = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!n || n.length > 64) return null;
  if (isBlockKind(n)) return n;
  return BLOCK_KIND_ALIASES[n] ?? null;
}

export function isResumeSectionId(value: unknown): value is ResumeSectionId {
  return typeof value === "string" && KNOWN_SECTION_IDS.has(value);
}

export function isPersonaSectionId(value: unknown): value is PersonaSectionId {
  return (
    typeof value === "string" &&
    (PERSONA_SECTION_IDS as readonly string[]).includes(value)
  );
}

export function sectionForBlockKind(kind: BlockKind): PersonaSectionId {
  return BLOCK_KIND_TO_SECTION[kind] ?? "experience";
}

/**
 * Normalize a candidate header line (decoration, numbering, colon) and look
 * it up in the alias table. Returns null for body copy.
 */
export function canonicalSectionFromHeader(
  line: string,
): ResumeSectionId | null {
  const key = foldHeaderKey(line);
  if (!key) return null;
  return HEADER_LOOKUP.get(key) ?? null;
}

export function displayNameForSection(id: ResumeSectionId): string {
  return SECTION_DISPLAY[id];
}

/**
 * Persona order is a sort key, not a filter. Summary is pinned first when
 * present. Contentful sections the persona omitted are inserted at their
 * default relative positions rather than dropped.
 */
export function resolveSectionOrder(
  requested: readonly string[] | undefined,
  hasContent: (id: PersonaSectionId) => boolean,
): PersonaSectionId[] {
  const persona = (requested ?? []).filter(isPersonaSectionId);
  const personaSet = new Set(persona);
  const result: PersonaSectionId[] = [];
  const seen = new Set<PersonaSectionId>();

  const take = (id: PersonaSectionId) => {
    if (seen.has(id)) return;
    result.push(id);
    seen.add(id);
  };

  if (hasContent("summary") || personaSet.has("summary")) {
    take("summary");
  }

  for (const id of persona) {
    if (id === "summary") continue;
    if (hasContent(id) || id === "skills" || personaSet.has(id)) take(id);
  }

  for (const id of DEFAULT_SECTION_ORDER) {
    if (hasContent(id)) take(id);
  }
  return result;
}
