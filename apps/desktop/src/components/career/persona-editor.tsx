import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SECTION_KINDS,
  SECTION_DISPLAY,
  formatCommaList,
  parseCommaList,
  type Persona,
  type SectionKind,
} from "@/lib/career";
import { listResumeTemplates } from "@/lib/resume-templates";
import { templateDisplayName } from "@/lib/resume-synthesis";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PersonaEditor({
  persona,
  saving,
  onSave,
}: {
  persona: Persona;
  saving: boolean;
  onSave: (persona: Persona) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Persona>(persona);
  const [weightsRaw, setWeightsRaw] = useState(() =>
    formatSkillWeights(persona.skillWeights),
  );

  const update = <K extends keyof Persona>(key: K, value: Persona[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSection = (section: SectionKind, on: boolean) => {
    if (on) {
      if (draft.sectionOrder.includes(section)) return;
      update("sectionOrder", [...draft.sectionOrder, section]);
    } else {
      update(
        "sectionOrder",
        draft.sectionOrder.filter((s) => s !== section),
      );
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const skillWeights = parseSkillWeights(weightsRaw);
        void onSave({ ...draft, skillWeights });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ID">
          <Input value={draft.id} disabled readOnly />
        </Field>
        <Field label="Label">
          <Input
            value={draft.label}
            onChange={(e) => update("label", e.target.value)}
            placeholder="AI / ML"
            required
          />
        </Field>
        <Field label="Default template">
          <Select
            value={draft.defaultTemplateId}
            onValueChange={(v) => update("defaultTemplateId", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select template" />
            </SelectTrigger>
            <SelectContent>
              {listResumeTemplates().map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {templateDisplayName(t.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Tone directive">
        <Textarea
          value={draft.toneDirective}
          onChange={(e) => update("toneDirective", e.target.value)}
          placeholder="Emphasize technical depth and measurable outcomes…"
          rows={3}
        />
      </Field>

      <Field label="Skill weights (skill:weight, comma-separated)">
        <Input
          value={weightsRaw}
          onChange={(e) => setWeightsRaw(e.target.value)}
          placeholder="python:1.2, mlops:1.3"
        />
      </Field>

      <div className="space-y-2">
        <Label>Section order</Label>
        <p className="text-[11px] text-muted-foreground">
          Order is a sort key, not a filter. Sections with content still print
          if unchecked, inserted at their default relative position.
        </p>
        <div className="flex flex-wrap gap-3">
          {SECTION_KINDS.map((section) => (
            <label key={section} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.sectionOrder.includes(section)}
                onCheckedChange={(v) => toggleSection(section, v === true)}
              />
              {SECTION_DISPLAY[section]}
            </label>
          ))}
        </div>
        {draft.sectionOrder.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Order: {draft.sectionOrder.join(" → ")}
          </p>
        )}
        <Field label="Reorder (comma-separated section ids)">
          <Input
            value={formatCommaList(draft.sectionOrder)}
            onChange={(e) => {
              const next = parseCommaList(e.target.value).filter(
                (s): s is SectionKind =>
                  (SECTION_KINDS as string[]).includes(s),
              );
              update("sectionOrder", next);
            }}
          />
        </Field>
      </div>

      <div className="flex justify-end pt-2">
        <Button
          type="submit"
          disabled={saving || !draft.id.trim() || !draft.label.trim()}
        >
          {saving ? "Saving…" : "Save persona"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function formatSkillWeights(weights: Record<string, number>): string {
  return Object.entries(weights)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

function parseSkillWeights(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of parseCommaList(raw)) {
    const [key, val] = part.split(":");
    if (!key?.trim()) continue;
    const n = Number(val);
    out[key.trim()] = Number.isFinite(n) ? n : 1;
  }
  return out;
}
