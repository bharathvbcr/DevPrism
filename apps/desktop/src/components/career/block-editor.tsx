import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BookOpenIcon,
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  LockIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { canUseAiAssist } from "@/lib/ai-assist";
import {
  BLOCK_KINDS,
  BLOCK_KIND_LABELS,
  SENIORITY_LEVELS,
  clampSkillLevel,
  distillFactsFromNotes,
  formatCommaList,
  listKbChunks,
  newBlockFact,
  newBullet,
  newSkillTag,
  parseCommaList,
  type BlockFact,
  type BlockKind,
  type Bullet,
  type ExperienceBlock,
  type KbChunkRow,
  type Persona,
  type SeniorityLevel,
  type SkillTag,
} from "@/lib/career";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("block-editor");

const SKILL_LEVELS = [1, 2, 3, 4, 5] as const;

function chunkLabel(chunk: KbChunkRow): string {
  const meta = chunk.meta as { sourceTitle?: string; headingPath?: string[] };
  const title =
    typeof meta?.sourceTitle === "string" && meta.sourceTitle.trim()
      ? meta.sourceTitle.trim()
      : chunk.sourceId;
  const path = Array.isArray(meta?.headingPath)
    ? meta.headingPath.filter(Boolean).join(" › ")
    : "";
  const preview = chunk.text.replace(/\s+/g, " ").trim().slice(0, 80);
  if (path) return `${title} · ${path}`;
  return preview ? `${title} — ${preview}` : title;
}

export function BlockEditor({
  block,
  personas,
  saving,
  onSave,
}: {
  block: ExperienceBlock;
  personas: Persona[];
  saving: boolean;
  onSave: (block: ExperienceBlock) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<ExperienceBlock>(() => ({
    ...block,
    facts: block.facts ?? [],
  }));
  const [kbChunks, setKbChunks] = useState<KbChunkRow[]>([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbLoadFailed, setKbLoadFailed] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [factPreview, setFactPreview] = useState<BlockFact[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setKbLoading(true);
    setKbLoadFailed(false);
    void listKbChunks()
      .then((rows) => {
        if (!cancelled) setKbChunks(rows);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Failed to load KB chunks for evidence picker", {
          error: message,
        });
        if (!cancelled) setKbLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setKbLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chunkById = useMemo(() => {
    const map = new Map<string, KbChunkRow>();
    for (const row of kbChunks) map.set(row.id, row);
    return map;
  }, [kbChunks]);

  const update = <K extends keyof ExperienceBlock>(
    key: K,
    value: ExperienceBlock[K],
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateBullet = (bulletId: string, patch: Partial<Bullet>) => {
    setDraft((prev) => ({
      ...prev,
      bullets: prev.bullets.map((b) =>
        b.id === bulletId ? { ...b, ...patch } : b,
      ),
    }));
  };

  const updateSkill = (index: number, patch: Partial<SkillTag>) => {
    setDraft((prev) => ({
      ...prev,
      skills: prev.skills.map((skill, i) =>
        i === index ? { ...skill, ...patch } : skill,
      ),
    }));
  };

  const updateFact = (factId: string, patch: Partial<BlockFact>) => {
    setDraft((prev) => ({
      ...prev,
      facts: (prev.facts ?? []).map((f) =>
        f.id === factId ? { ...f, ...patch } : f,
      ),
    }));
  };

  const handleDistillNotes = async () => {
    const notes = (draft.notes ?? "").trim();
    if (!notes) {
      toast.error("Paste raw notes in the scratchpad first.");
      return;
    }
    if (!canUseAiAssist()) {
      toast.error("Enable an AI provider in Settings to distill notes.");
      return;
    }
    setDistilling(true);
    setFactPreview(null);
    try {
      const facts = await distillFactsFromNotes(notes);
      setFactPreview(facts);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDistilling(false);
    }
  };

  const applyFactPreview = () => {
    if (!factPreview?.length) return;
    setDraft((prev) => ({
      ...prev,
      facts: [...(prev.facts ?? []), ...factPreview],
    }));
    setFactPreview(null);
    toast.success(`Added ${factPreview.length} fact(s) to draft`);
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const cleaned: ExperienceBlock = {
          ...draft,
          skills: draft.skills
            .map((s) => ({
              name: s.name.trim(),
              level: clampSkillLevel(s.level),
              ...(s.years != null && Number.isFinite(s.years) && s.years > 0
                ? { years: s.years }
                : {}),
            }))
            .filter((s) => s.name.length > 0),
          bullets: draft.bullets.map((b) => {
            const variants: Bullet["variants"] = {};
            for (const [personaId, text] of Object.entries(b.variants)) {
              const trimmed = text?.trim();
              if (trimmed) variants[personaId] = trimmed;
            }
            return { ...b, variants };
          }),
          facts: (draft.facts ?? [])
            .map((f) => ({
              ...f,
              text: f.text.trim(),
              skills: f.skills.map((s) => s.trim()).filter(Boolean),
              metrics: f.metrics
                .map((m) => ({
                  value: m.value.trim(),
                  kind: m.kind.trim() || "metric",
                }))
                .filter((m) => m.value.length > 0),
            }))
            .filter((f) => f.text.length > 0),
          notes: draft.notes?.trim() ? draft.notes.trim() : undefined,
          location: blankToUndefined(draft.location),
          url: blankToUndefined(draft.url),
          urlLabel: blankToUndefined(draft.urlLabel),
          extra: blankToUndefined(draft.extra),
        };
        void onSave(cleaned);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          <Input
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="Senior ML Engineer"
            required
          />
        </Field>
        <Field label="Organization">
          <Input
            value={draft.org}
            onChange={(e) => update("org", e.target.value)}
            placeholder="Acme Labs"
          />
        </Field>
        <Field label="Location">
          <Input
            value={draft.location ?? ""}
            onChange={(e) => update("location", e.target.value)}
            placeholder="Remote · New York, NY"
          />
        </Field>
        <Field label="Link (optional)">
          <Input
            value={draft.url ?? ""}
            onChange={(e) => update("url", e.target.value)}
            placeholder="https://acme.example"
          />
        </Field>
        <Field label="Kind">
          <Select
            value={draft.kind}
            onValueChange={(v) => update("kind", v as BlockKind)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BLOCK_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {BLOCK_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Seniority">
          <Select
            value={draft.seniorityLevel}
            onValueChange={(v) => update("seniorityLevel", v as SeniorityLevel)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SENIORITY_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Start (YYYY-MM)">
          <Input
            value={draft.dateRange.start}
            onChange={(e) =>
              update("dateRange", {
                ...draft.dateRange,
                start: e.target.value,
              })
            }
            placeholder="2021-03"
          />
        </Field>
        <Field label="End (blank = present)">
          <Input
            value={draft.dateRange.end ?? ""}
            onChange={(e) =>
              update("dateRange", {
                ...draft.dateRange,
                end: e.target.value.trim() ? e.target.value : null,
              })
            }
            placeholder="2024-06"
          />
        </Field>
      </div>

      <Field label="Domains (comma-separated)">
        <Input
          value={formatCommaList(draft.domains)}
          onChange={(e) => update("domains", parseCommaList(e.target.value))}
          placeholder="mlops, genomics"
        />
      </Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Skills</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => update("skills", [...draft.skills, newSkillTag()])}
          >
            <PlusIcon className="size-3.5" />
            Add skill
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Level 1–5 and optional years of experience feed scoring and skill
          vectors.
        </p>
        {draft.skills.length === 0 ? (
          <p className="text-muted-foreground text-xs">No skills yet.</p>
        ) : (
          <div className="space-y-2">
            {draft.skills.map((skill, index) => (
              <div
                key={`skill-${index}`}
                className="grid grid-cols-[1fr_5.5rem_5rem_auto] items-end gap-2"
              >
                <Field label={index === 0 ? "Name" : undefined}>
                  <Input
                    value={skill.name}
                    onChange={(e) =>
                      updateSkill(index, { name: e.target.value })
                    }
                    placeholder="python"
                  />
                </Field>
                <Field label={index === 0 ? "Level" : undefined}>
                  <Select
                    value={String(skill.level)}
                    onValueChange={(v) =>
                      updateSkill(index, {
                        level: clampSkillLevel(Number(v)),
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SKILL_LEVELS.map((level) => (
                        <SelectItem key={level} value={String(level)}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={index === 0 ? "Years" : undefined}>
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={skill.years ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (!raw) {
                        updateSkill(index, { years: undefined });
                        return;
                      }
                      const n = Number(raw);
                      updateSkill(index, {
                        years: Number.isFinite(n) ? n : undefined,
                      });
                    }}
                    placeholder="—"
                  />
                </Field>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="mb-0.5 size-8 text-destructive"
                  onClick={() =>
                    update(
                      "skills",
                      draft.skills.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>Personas</Label>
        <div className="flex flex-wrap gap-3">
          {personas.length === 0 ? (
            <p className="text-muted-foreground text-xs">No personas loaded.</p>
          ) : (
            personas.map((persona) => {
              const checked = draft.personas.includes(persona.id);
              return (
                <label
                  key={persona.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      const on = v === true;
                      update(
                        "personas",
                        on
                          ? [...draft.personas, persona.id]
                          : draft.personas.filter((id) => id !== persona.id),
                      );
                    }}
                  />
                  {persona.label}
                </label>
              );
            })
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Bullets</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => update("bullets", [...draft.bullets, newBullet()])}
          >
            <PlusIcon className="size-3.5" />
            Add bullet
          </Button>
        </div>
        <div className="space-y-3">
          {draft.bullets.map((bullet, index) => (
            <div
              key={bullet.id}
              className="space-y-3 rounded-md border border-border/50 bg-muted/20 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                  Bullet {index + 1}
                </span>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={bullet.locked}
                      onCheckedChange={(v) => {
                        updateBullet(bullet.id, { locked: v === true });
                      }}
                    />
                    <LockIcon className="size-3" />
                    Locked
                  </label>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-destructive"
                    disabled={draft.bullets.length <= 1}
                    onClick={() =>
                      update(
                        "bullets",
                        draft.bullets.filter((b) => b.id !== bullet.id),
                      )
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <Textarea
                value={bullet.canonical}
                onChange={(e) => {
                  updateBullet(bullet.id, { canonical: e.target.value });
                }}
                placeholder="Canonical bullet (factual source of truth)"
                rows={2}
              />
              <Input
                value={bullet.metrics.map((m) => m.value).join(", ")}
                onChange={(e) => {
                  const metrics = parseCommaList(e.target.value).map(
                    (value) => ({ value, kind: "metric" }),
                  );
                  updateBullet(bullet.id, { metrics });
                }}
                placeholder="Metrics to preserve (e.g. 40%, 2M users)"
              />

              {personas.length > 0 && (
                <div className="space-y-2 border-border/40 border-t pt-2">
                  <Label className="text-muted-foreground text-xs">
                    Persona variants
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Optional rewrites used when synthesizing for that persona.
                  </p>
                  <div className="space-y-2">
                    {personas.map((persona) => (
                      <Field key={persona.id} label={persona.label}>
                        <Textarea
                          value={bullet.variants[persona.id] ?? ""}
                          onChange={(e) => {
                            const next = { ...bullet.variants };
                            const value = e.target.value;
                            if (value.trim()) next[persona.id] = value;
                            else delete next[persona.id];
                            updateBullet(bullet.id, { variants: next });
                          }}
                          placeholder={`Variant for ${persona.label}…`}
                          rows={2}
                        />
                      </Field>
                    ))}
                  </div>
                </div>
              )}

              <EvidenceRefsEditor
                selectedIds={bullet.evidenceRefs}
                chunks={kbChunks}
                chunkById={chunkById}
                loading={kbLoading}
                loadFailed={kbLoadFailed}
                onChange={(evidenceRefs) =>
                  updateBullet(bullet.id, { evidenceRefs })
                }
              />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-border/50 bg-muted/10 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label>Knowledge / raw points</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Fact pool for synthesis — dump raw details here; AI distills them
              into tailored bullets per JD.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 gap-1"
            onClick={() =>
              update("facts", [...(draft.facts ?? []), newBlockFact()])
            }
          >
            <PlusIcon className="size-3.5" />
            Add fact
          </Button>
        </div>

        <Field label="Extra line (GPA, honors, coursework)">
          <Input
            value={draft.extra ?? ""}
            onChange={(e) => update("extra", e.target.value)}
            placeholder="GPA 3.9/4.0 · Dean's List"
          />
        </Field>
        <Field label="Notes scratchpad">
          <Textarea
            value={draft.notes ?? ""}
            onChange={(e) => update("notes", e.target.value)}
            placeholder="Paste raw notes, metrics, ownership details…"
            rows={3}
            className="font-mono text-xs"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="gap-1.5"
            disabled={distilling || !(draft.notes ?? "").trim()}
            onClick={() => void handleDistillNotes()}
          >
            {distilling ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            Distill with AI
          </Button>
          {!canUseAiAssist() ? (
            <span className="text-[11px] text-muted-foreground">
              AI provider required in Settings.
            </span>
          ) : null}
        </div>

        {factPreview && factPreview.length > 0 ? (
          <div className="space-y-2 rounded-md border border-border/60 bg-background/80 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-xs">
                Preview · {factPreview.length} fact
                {factPreview.length === 1 ? "" : "s"}
              </span>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={() => setFactPreview(null)}
                >
                  Discard
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={applyFactPreview}
                >
                  Apply to draft
                </Button>
              </div>
            </div>
            <ul className="space-y-1.5">
              {factPreview.map((fact) => (
                <li
                  key={fact.id}
                  className="rounded border border-border/40 px-2 py-1.5 text-xs"
                >
                  <p className="leading-snug">{fact.text}</p>
                  {(fact.skills.length > 0 || fact.metrics.length > 0) && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {fact.skills.length > 0
                        ? `skills: ${fact.skills.join(", ")}`
                        : ""}
                      {fact.skills.length > 0 && fact.metrics.length > 0
                        ? " · "
                        : ""}
                      {fact.metrics.length > 0
                        ? `metrics: ${fact.metrics.map((m) => m.value).join(", ")}`
                        : ""}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {(draft.facts ?? []).length === 0 ? (
          <p className="text-muted-foreground text-xs">No facts yet.</p>
        ) : (
          <div className="space-y-2">
            {(draft.facts ?? []).map((fact, index) => (
              <div
                key={fact.id}
                className="space-y-2 rounded-md border border-border/40 bg-background/60 p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Fact {index + 1}
                    {fact.source !== "manual" ? ` · ${fact.source}` : ""}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-destructive"
                    onClick={() =>
                      update(
                        "facts",
                        (draft.facts ?? []).filter((f) => f.id !== fact.id),
                      )
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
                <Textarea
                  value={fact.text}
                  onChange={(e) =>
                    updateFact(fact.id, { text: e.target.value })
                  }
                  placeholder="Raw detail point…"
                  rows={2}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={formatCommaList(fact.skills)}
                    onChange={(e) =>
                      updateFact(fact.id, {
                        skills: parseCommaList(e.target.value),
                      })
                    }
                    placeholder="Skills (e.g. python, k8s)"
                  />
                  <Input
                    value={fact.metrics.map((m) => m.value).join(", ")}
                    onChange={(e) =>
                      updateFact(fact.id, {
                        metrics: parseCommaList(e.target.value).map(
                          (value) => ({ value, kind: "metric" }),
                        ),
                      })
                    }
                    placeholder="Metrics (e.g. 40%, 2M users)"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={saving || !draft.title.trim()}>
          {saving ? "Saving…" : "Save block"}
        </Button>
      </div>
    </form>
  );
}

function EvidenceRefsEditor({
  selectedIds,
  chunks,
  chunkById,
  loading,
  loadFailed,
  onChange,
}: {
  selectedIds: string[];
  chunks: KbChunkRow[];
  chunkById: Map<string, KbChunkRow>;
  loading: boolean;
  /** The chunk lookup itself failed — must not render as "no chunks yet". */
  loadFailed?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chunks.slice(0, 80);
    return chunks
      .filter((c) => {
        const label = chunkLabel(c).toLowerCase();
        return label.includes(q) || c.id.toLowerCase().includes(q);
      })
      .slice(0, 80);
  }, [chunks, query]);

  const toggle = (id: string, on: boolean) => {
    if (on) {
      if (selectedIds.includes(id)) return;
      onChange([...selectedIds, id]);
    } else {
      onChange(selectedIds.filter((x) => x !== id));
    }
  };

  return (
    <div className="space-y-2 border-border/40 border-t pt-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-muted-foreground text-xs">Evidence (KB)</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={loading}
            >
              <BookOpenIcon className="size-3.5" />
              {loading ? "Loading…" : "Add chunk"}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chunks…"
              className="mb-2 h-8"
            />
            {loadFailed ? (
              <p className="px-1 py-3 text-amber-600 text-xs dark:text-amber-400">
                Chunk list unavailable — reopen this block to retry.
              </p>
            ) : chunks.length === 0 ? (
              <p className="px-1 py-3 text-muted-foreground text-xs">
                No knowledge-base chunks yet. Ingest sources in the Knowledge
                tab.
              </p>
            ) : (
              <ScrollArea className="h-56">
                <div className="space-y-1 pr-2">
                  {filtered.map((chunk) => {
                    const checked = selectedIds.includes(chunk.id);
                    return (
                      <label
                        key={chunk.id}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-muted/60"
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          onCheckedChange={(v) => toggle(chunk.id, v === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-xs leading-snug">
                            {chunkLabel(chunk)}
                          </span>
                          <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                            {chunk.id}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {loadFailed && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          Couldn't load the knowledge-base chunk list — reopen this block to
          retry.
        </p>
      )}
      {selectedIds.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Link KB chunks that ground this claim.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id) => {
            const chunk = chunkById.get(id);
            const label = chunk ? chunkLabel(chunk) : id;
            return (
              <Badge
                key={id}
                variant="secondary"
                className="max-w-full gap-1 py-0.5 font-normal"
              >
                <span className="truncate" title={label}>
                  {label}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-sm opacity-70 hover:opacity-100"
                  aria-label={`Remove evidence ${id}`}
                  onClick={() => toggle(id, false)}
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Blank/whitespace-only optional input becomes `undefined`, never `""`. */
function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function Field({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {label ? <Label>{label}</Label> : null}
      {children}
    </div>
  );
}
