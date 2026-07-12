import { BookOpenIcon, Loader2Icon, SparklesIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { templateDisplayName } from "@/lib/resume-synthesis";
import type { ResumeMasterOption } from "@/lib/resume-synthesis";
import type { Persona } from "@/lib/career/types";
import type { ResumeTemplate } from "@/lib/resume-templates/types";

export const CREATE_NEW_MASTER = "__create_new__";

export interface SynthesizeFormProps {
  jdText: string;
  onJdTextChange: (value: string) => void;
  personaId: string;
  onPersonaIdChange: (value: string) => void;
  templateId: string;
  onTemplateIdChange: (value: string) => void;
  masterPath: string;
  onMasterPathChange: (value: string) => void;
  versionName: string;
  onVersionNameChange: (value: string) => void;
  onVersionNameTouched: () => void;
  personas: Persona[];
  templates: ResumeTemplate[];
  masters: ResumeMasterOption[];
  header: {
    fullName: string;
    email: string;
    phone: string;
    cityRegion: string;
    linkedinUrl?: string;
    githubUrl?: string;
    portfolioUrl?: string;
  };
  onHeaderChange: (patch: Partial<SynthesizeFormProps["header"]>) => void;
  running: boolean;
  canRun: boolean;
  /** When embeddings are down — button label / degraded affordance. */
  embeddingsDown?: boolean;
  onRun: () => void;
  onCancel: () => void;
  showClear: boolean;
  onClear: () => void;
  /** Optional "Add knowledge" quick-add (kb-integration). */
  onAddKnowledge?: () => void;
}

export function SynthesizeForm({
  jdText,
  onJdTextChange,
  personaId,
  onPersonaIdChange,
  templateId,
  onTemplateIdChange,
  masterPath,
  onMasterPathChange,
  versionName,
  onVersionNameChange,
  onVersionNameTouched,
  personas,
  templates,
  masters,
  header,
  onHeaderChange,
  running,
  canRun,
  embeddingsDown = false,
  onRun,
  onCancel,
  showClear,
  onClear,
  onAddKnowledge,
}: SynthesizeFormProps) {
  return (
    <>
      <section className="space-y-2">
        <Label htmlFor="synth-jd">Job description</Label>
        <Textarea
          id="synth-jd"
          value={jdText}
          onChange={(e) => onJdTextChange(e.target.value)}
          placeholder="Paste the full job description here…"
          className="min-h-[160px] resize-y font-mono text-xs leading-relaxed"
          disabled={running}
        />
        <p className="text-[11px] text-muted-foreground">
          {jdText.trim().length < 40
            ? `Need at least 40 characters (${jdText.trim().length}/40)`
            : `${jdText.trim().length} characters`}
        </p>
      </section>

      <ContactHeaderEditor
        header={header}
        onChange={onHeaderChange}
        disabled={running}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="space-y-2">
          <Label>Persona</Label>
          <Select
            value={personaId || undefined}
            onValueChange={onPersonaIdChange}
            disabled={running || personas.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select persona" />
            </SelectTrigger>
            <SelectContent>
              {personas.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {personas.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              Create a persona in the Database tab.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <Label>Template</Label>
          <Select
            value={templateId}
            onValueChange={onTemplateIdChange}
            disabled={running}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {templateDisplayName(t.id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="space-y-2">
          <Label>Save as</Label>
          <Select
            value={masterPath}
            onValueChange={onMasterPathChange}
            disabled={running}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Destination" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CREATE_NEW_MASTER}>
                New resume project…
              </SelectItem>
              {masters.map((m) => (
                <SelectItem key={m.path} value={m.path}>
                  {m.isOpen ? `${m.name} (open)` : m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {masterPath === CREATE_NEW_MASTER
              ? "Creates a folder with resume.tex under your last project location."
              : "Creates a tailored variant under the master — master stays untouched."}
          </p>
        </section>

        <section className="space-y-2">
          <Label htmlFor="synth-version-name">Version name</Label>
          <Input
            id="synth-version-name"
            value={versionName}
            onChange={(e) => {
              onVersionNameTouched();
              onVersionNameChange(e.target.value);
            }}
            placeholder="e.g. Acme — Senior ML Eng"
            disabled={running}
          />
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onRun} disabled={!canRun} className="gap-1.5">
          {running ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <SparklesIcon className="size-3.5" />
          )}
          {running
            ? "Synthesizing…"
            : embeddingsDown
              ? "Run in degraded mode"
              : "Run synthesis"}
        </Button>
        {onAddKnowledge && !running && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onAddKnowledge}
          >
            <BookOpenIcon className="size-3.5" />
            Add knowledge
          </Button>
        )}
        {running && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onCancel}
          >
            <XIcon className="size-3.5" />
            Cancel
          </Button>
        )}
        {showClear && !running && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear result
          </Button>
        )}
      </div>
    </>
  );
}

function ContactHeaderEditor({
  header,
  onChange,
  disabled,
}: {
  header: SynthesizeFormProps["header"];
  onChange: (patch: Partial<SynthesizeFormProps["header"]>) => void;
  disabled?: boolean;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div>
        <h2 className="font-medium text-sm">Contact header</h2>
        <p className="text-muted-foreground text-xs">
          Shown at the top of the generated resume. Saved in local settings.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="synth-full-name">Full name</Label>
          <Input
            id="synth-full-name"
            value={header.fullName}
            onChange={(e) => onChange({ fullName: e.target.value })}
            placeholder="Ada Lovelace"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-email">Email</Label>
          <Input
            id="synth-email"
            type="email"
            value={header.email}
            onChange={(e) => onChange({ email: e.target.value })}
            placeholder="ada@example.com"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-phone">Phone</Label>
          <Input
            id="synth-phone"
            value={header.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder="+1 555 0100"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="synth-city">City / region</Label>
          <Input
            id="synth-city"
            value={header.cityRegion}
            onChange={(e) => onChange({ cityRegion: e.target.value })}
            placeholder="San Francisco, CA"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-linkedin">LinkedIn URL</Label>
          <Input
            id="synth-linkedin"
            value={header.linkedinUrl ?? ""}
            onChange={(e) => onChange({ linkedinUrl: e.target.value })}
            placeholder="https://linkedin.com/in/…"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="synth-github">GitHub URL</Label>
          <Input
            id="synth-github"
            value={header.githubUrl ?? ""}
            onChange={(e) => onChange({ githubUrl: e.target.value })}
            placeholder="https://github.com/…"
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="synth-portfolio">Portfolio URL</Label>
          <Input
            id="synth-portfolio"
            value={header.portfolioUrl ?? ""}
            onChange={(e) => onChange({ portfolioUrl: e.target.value })}
            placeholder="https://…"
            disabled={disabled}
          />
        </div>
      </div>
    </section>
  );
}
