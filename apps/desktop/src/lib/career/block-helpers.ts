import {
  BLOCK_KINDS as CANONICAL_BLOCK_KINDS,
  BLOCK_KIND_LABELS,
  PERSONA_SECTION_IDS,
  SECTION_DISPLAY,
  isBlockKind as isCanonicalBlockKind,
} from "../resume-sections";
import type {
  BlockFact,
  BlockKind,
  Bullet,
  ExperienceBlock,
  Persona,
  SectionKind,
  SeniorityLevel,
  SkillTag,
} from "./types";

const BLOCK_KINDS: BlockKind[] = [...CANONICAL_BLOCK_KINDS];

const SENIORITY_LEVELS: SeniorityLevel[] = [
  "ic",
  "senior",
  "lead",
  "manager",
  "director",
];

const SECTION_KINDS: SectionKind[] = [...PERSONA_SECTION_IDS];

export function isBlockKind(value: unknown): value is BlockKind {
  return isCanonicalBlockKind(value);
}

export function isSeniorityLevel(value: unknown): value is SeniorityLevel {
  return (
    typeof value === "string" && (SENIORITY_LEVELS as string[]).includes(value)
  );
}

export function newCareerId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

export function newBullet(canonical = ""): Bullet {
  return {
    id: newCareerId("blt"),
    canonical,
    variants: {},
    metrics: [],
    evidenceRefs: [],
    locked: false,
  };
}

export function newBlockFact(
  text = "",
  overrides: Partial<BlockFact> = {},
): BlockFact {
  return {
    id: newCareerId("fct"),
    text,
    skills: [],
    metrics: [],
    source: "manual",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createEmptyBlock(
  overrides: Partial<ExperienceBlock> = {},
): ExperienceBlock {
  return {
    id: newCareerId("exp"),
    kind: "experience",
    title: "",
    org: "",
    dateRange: { start: "", end: null },
    personas: [],
    domains: [],
    skills: [],
    seniorityLevel: "senior",
    bullets: [newBullet()],
    facts: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Built-in persona ids seeded by Rust (`INSERT OR IGNORE`). Not deletable. */
export const SEEDED_PERSONA_IDS = [
  "ai",
  "life-sciences",
  "management",
] as const;

export function isSeededPersonaId(id: string): boolean {
  return (SEEDED_PERSONA_IDS as readonly string[]).includes(id);
}

export function createEmptyPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: newCareerId("persona"),
    label: "New persona",
    skillWeights: {},
    defaultTemplateId: "typst-ats-single-column",
    sectionOrder: [
      "summary",
      "experience",
      "projects",
      "skills",
      "education",
      "publications",
      "leadership",
      "certifications",
      "awards",
      "volunteer",
    ],
    toneDirective: "",
    ...overrides,
  };
}

/** Dense-text used for embeddings: title + org + domains + bullets + facts. */
export function computeEmbeddingText(block: ExperienceBlock): string {
  const parts = [
    block.title,
    block.org,
    ...block.domains,
    ...block.skills.map((s) => s.name),
    ...block.bullets.map((b) => b.canonical),
    ...(block.facts ?? []).map((f) => f.text),
  ];
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
}

export function parseCommaList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatCommaList(items: string[]): string {
  return items.join(", ");
}

export function newSkillTag(name = ""): SkillTag {
  return { name, level: 3 };
}

export function clampSkillLevel(value: number): SkillTag["level"] {
  const n = Math.round(value);
  if (n <= 1) return 1;
  if (n >= 5) return 5;
  return n as SkillTag["level"];
}

export function parseSkillsList(raw: string): SkillTag[] {
  return parseCommaList(raw).map((name) => newSkillTag(name));
}

export {
  BLOCK_KINDS,
  SENIORITY_LEVELS,
  SECTION_KINDS,
  BLOCK_KIND_LABELS,
  SECTION_DISPLAY,
};
