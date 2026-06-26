/** Shared metadata for tailored-version status, used by the version switcher
 * and the applications overview. Rust stores status as a free-form string; this
 * is the pipeline the UI offers. */
export interface VariantStatusMeta {
  value: string;
  label: string;
  color: string;
}

export const VARIANT_STATUSES: VariantStatusMeta[] = [
  { value: "draft", label: "Draft", color: "#94a3b8" },
  { value: "applied", label: "Applied", color: "#0ea5e9" },
  { value: "interview", label: "Interview", color: "#a855f7" },
  { value: "offer", label: "Offer", color: "#10b981" },
  { value: "rejected", label: "Rejected", color: "#ef4444" },
  { value: "archived", label: "Archived", color: "#64748b" },
];

export function variantStatusMeta(status: string): VariantStatusMeta {
  return (
    VARIANT_STATUSES.find((s) => s.value === status) ?? VARIANT_STATUSES[0]
  );
}

/**
 * Best-effort name for a new version, derived from the pasted target text (a
 * job description, CFP, or program prompt). Returns "" when nothing usable is
 * found — callers use it only as an editable suggestion. Generic on purpose: it
 * keys off an explicit "Company/Organization:" label or a short title line
 * rather than domain-specific parsing.
 */
export function suggestVersionName(target: string): string {
  const text = target.trim();
  if (!text) return "";

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  // The first short, sentence-free line is usually the role/title/venue.
  const titleLine = lines.find(
    (l) => l.length <= 70 && !/[.!?]$/.test(l) && /[a-z]/i.test(l),
  );
  const title = (titleLine ?? lines[0]).slice(0, 60).trim();

  // An explicit org label is the only company signal trustworthy enough to use.
  const orgMatch = text.match(
    /\b(?:company|organi[sz]ation|employer|venue|journal|conference|program|school|university)\s*[:-]\s*([^\n]+)/i,
  );
  const org = orgMatch?.[1]
    ?.trim()
    .replace(/[.,;].*$/, "")
    .slice(0, 40);

  if (org && title && org.toLowerCase() !== title.toLowerCase()) {
    return `${org} — ${title}`.slice(0, 70);
  }
  return org || title;
}

/** Prompt seeded into the chat by "Tailor with AI". References the visible
 * JOB_DESCRIPTION.md so the agent reads it as project context. */
export const TAILOR_PROMPT =
  "Tailor this resume to the role described in JOB_DESCRIPTION.md. Revise the " +
  "relevant sections (summary, experience bullets, and skills) to align with " +
  "the job's requirements and keywords, keeping everything truthful and in my " +
  "existing LaTeX style. List the key changes you made at the end.";
