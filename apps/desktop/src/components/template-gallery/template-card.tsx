import type { TemplateDefinition } from "@/lib/template-registry";
import { useTemplateStore } from "@/stores/template-store";

// ─── Document Thumbnail Layouts ───
// CSS-based miniature document previews showing the structure of each template type.

function ThumbnailPaper({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center px-4 py-3">
      {/* Title */}
      <div className="mb-1.5 h-1.5 w-12 rounded-full" style={{ backgroundColor: color }} />
      {/* Author */}
      <div className="mb-3 h-1 w-8 rounded-full bg-muted-foreground/20" />
      {/* Abstract block */}
      <div className="mb-2 w-full rounded-sm bg-muted-foreground/8 p-1.5">
        <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/15" />
        <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/15" />
        <div className="h-0.5 w-3/4 rounded-full bg-muted-foreground/15" />
      </div>
      {/* Section heading */}
      <div className="mb-1.5 h-1 w-10 self-start rounded-full" style={{ backgroundColor: color, opacity: 0.6 }} />
      {/* Body lines */}
      <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="mb-1 h-0.5 w-11/12 rounded-full bg-muted-foreground/12" />
      <div className="h-0.5 w-4/5 rounded-full bg-muted-foreground/12" />
    </div>
  );
}

function ThumbnailSlides({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 py-2">
      {/* Slide 1 - title slide */}
      <div className="flex w-full flex-1 flex-col items-center justify-center rounded-sm border border-muted-foreground/10 bg-muted-foreground/5 p-1">
        <div className="mb-0.5 h-1 w-10 rounded-full" style={{ backgroundColor: color }} />
        <div className="h-0.5 w-6 rounded-full bg-muted-foreground/20" />
      </div>
      {/* Slide 2 */}
      <div className="flex w-full flex-1 flex-col rounded-sm border border-muted-foreground/10 bg-muted-foreground/5 p-1">
        <div className="mb-0.5 h-0.5 w-6 rounded-full" style={{ backgroundColor: color, opacity: 0.6 }} />
        <div className="mb-0.5 h-0.5 w-full rounded-full bg-muted-foreground/12" />
        <div className="h-0.5 w-3/4 rounded-full bg-muted-foreground/12" />
      </div>
    </div>
  );
}

function ThumbnailPoster({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col px-2 py-2">
      {/* Big title */}
      <div className="mb-1.5 h-2 w-16 self-center rounded-full" style={{ backgroundColor: color }} />
      <div className="mb-2 h-1 w-10 self-center rounded-full bg-muted-foreground/20" />
      {/* Two columns */}
      <div className="flex flex-1 gap-1.5">
        <div className="flex flex-1 flex-col gap-1 rounded-sm bg-muted-foreground/6 p-1">
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-3/4 rounded-full bg-muted-foreground/15" />
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded-sm bg-muted-foreground/6 p-1">
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/15" />
          <div className="h-0.5 w-2/3 rounded-full bg-muted-foreground/15" />
        </div>
      </div>
    </div>
  );
}

function ThumbnailCV({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col px-3 py-2.5">
      {/* Name */}
      <div className="mb-1 h-2 w-14 self-center rounded-full" style={{ backgroundColor: color }} />
      <div className="mb-2 h-0.5 w-16 self-center rounded-full bg-muted-foreground/20" />
      {/* Section divider */}
      <div className="mb-1.5 h-px w-full" style={{ backgroundColor: color, opacity: 0.3 }} />
      <div className="mb-1 h-0.5 w-8 rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
      <div className="mb-0.5 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="mb-2 h-0.5 w-3/4 rounded-full bg-muted-foreground/12" />
      {/* Another section */}
      <div className="mb-1.5 h-px w-full" style={{ backgroundColor: color, opacity: 0.3 }} />
      <div className="mb-1 h-0.5 w-6 rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
      <div className="mb-0.5 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="h-0.5 w-5/6 rounded-full bg-muted-foreground/12" />
    </div>
  );
}

function ThumbnailLetter({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col px-4 py-3">
      {/* Sender address */}
      <div className="mb-0.5 h-0.5 w-10 self-end rounded-full bg-muted-foreground/20" />
      <div className="mb-3 h-0.5 w-8 self-end rounded-full bg-muted-foreground/20" />
      {/* Date */}
      <div className="mb-3 h-0.5 w-6 rounded-full bg-muted-foreground/15" />
      {/* Greeting */}
      <div className="mb-2 h-0.5 w-10 rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
      {/* Body */}
      <div className="mb-0.5 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="mb-0.5 h-0.5 w-full rounded-full bg-muted-foreground/12" />
      <div className="mb-0.5 h-0.5 w-11/12 rounded-full bg-muted-foreground/12" />
      <div className="mb-3 h-0.5 w-3/4 rounded-full bg-muted-foreground/12" />
      {/* Closing */}
      <div className="h-0.5 w-8 rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
    </div>
  );
}

function ThumbnailBook({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-4 py-3">
      {/* Title page feel */}
      <div className="mb-6 h-px w-8" style={{ backgroundColor: color, opacity: 0.4 }} />
      <div className="mb-1.5 h-2 w-14 rounded-full" style={{ backgroundColor: color }} />
      <div className="mb-4 h-1 w-8 rounded-full bg-muted-foreground/20" />
      <div className="h-px w-8" style={{ backgroundColor: color, opacity: 0.4 }} />
    </div>
  );
}

function ThumbnailBlank(_props: { color: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="text-muted-foreground/20 text-xs font-medium">Empty</div>
    </div>
  );
}

function ThumbnailReport({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col px-3 py-2.5">
      {/* Title */}
      <div className="mb-1 h-1.5 w-14 self-center rounded-full" style={{ backgroundColor: color }} />
      <div className="mb-2.5 h-0.5 w-8 self-center rounded-full bg-muted-foreground/20" />
      {/* TOC-like entries */}
      <div className="mb-1 h-0.5 w-4 rounded-full" style={{ backgroundColor: color, opacity: 0.4 }} />
      <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/10" />
      <div className="mb-1.5 h-0.5 w-4 rounded-full" style={{ backgroundColor: color, opacity: 0.4 }} />
      <div className="mb-1 h-0.5 w-full rounded-full bg-muted-foreground/10" />
      <div className="mb-1 h-0.5 w-4 rounded-full" style={{ backgroundColor: color, opacity: 0.4 }} />
      <div className="h-0.5 w-full rounded-full bg-muted-foreground/10" />
    </div>
  );
}

function ThumbnailNewsletter({ color }: { color: string }) {
  return (
    <div className="flex h-full w-full flex-col px-2 py-2">
      {/* Header bar */}
      <div className="mb-2 flex h-3 w-full items-center justify-center rounded-sm" style={{ backgroundColor: color, opacity: 0.15 }}>
        <div className="h-1 w-10 rounded-full" style={{ backgroundColor: color }} />
      </div>
      {/* Two columns */}
      <div className="flex flex-1 gap-1">
        <div className="flex flex-1 flex-col gap-0.5 p-1">
          <div className="h-0.5 w-5 rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/12" />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/12" />
          <div className="h-0.5 w-2/3 rounded-full bg-muted-foreground/12" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5 p-1">
          <div className="h-0.5 w-5 rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/12" />
          <div className="h-0.5 w-full rounded-full bg-muted-foreground/12" />
          <div className="h-0.5 w-3/4 rounded-full bg-muted-foreground/12" />
        </div>
      </div>
    </div>
  );
}

const THUMBNAIL_MAP: Record<string, React.FC<{ color: string }>> = {
  "paper-standard": ThumbnailPaper,
  "paper-ieee": ThumbnailPaper,
  "paper-acm": ThumbnailPaper,
  "thesis-standard": ThumbnailReport,
  "presentation-beamer": ThumbnailSlides,
  "poster-academic": ThumbnailPoster,
  "cv-modern": ThumbnailCV,
  "letter-formal": ThumbnailLetter,
  "report-technical": ThumbnailReport,
  "book-standard": ThumbnailBook,
  "newsletter": ThumbnailNewsletter,
  "blank": ThumbnailBlank,
};

function getSubcategoryThumbnail(sub: string): React.FC<{ color: string }> {
  const map: Record<string, React.FC<{ color: string }>> = {
    papers: ThumbnailPaper,
    theses: ThumbnailReport,
    presentations: ThumbnailSlides,
    posters: ThumbnailPoster,
    cv: ThumbnailCV,
    letters: ThumbnailLetter,
    reports: ThumbnailReport,
    books: ThumbnailBook,
    newsletters: ThumbnailNewsletter,
    blank: ThumbnailBlank,
  };
  return map[sub] || ThumbnailPaper;
}

// ─── Template Card ───

interface TemplateCardProps {
  template: TemplateDefinition;
  onSelect: (id: string) => void;
}

export function TemplateCard({ template, onSelect }: TemplateCardProps) {
  const openPreview = useTemplateStore((s) => s.openPreview);
  const Thumbnail = THUMBNAIL_MAP[template.id] || getSubcategoryThumbnail(template.subcategory);

  return (
    <div className="group flex flex-col">
      {/* Thumbnail area — document-shaped preview */}
      <button
        onClick={() => onSelect(template.id)}
        className="relative aspect-[3/4] w-full overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 hover:border-foreground/20 hover:shadow-md group-hover:scale-[1.02]"
      >
        <Thumbnail color={template.accentColor} />
        {/* Hover overlay with preview button */}
        <div className="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openPreview(template.id);
            }}
            className="mb-3 rounded-lg bg-white/90 px-3 py-1.5 text-xs font-medium text-gray-900 shadow-sm backdrop-blur-sm transition-transform hover:bg-white"
          >
            Preview
          </button>
        </div>
      </button>
      {/* Info below thumbnail */}
      <div className="mt-2 px-0.5">
        <div className="font-medium text-sm leading-tight">{template.name}</div>
        <div className="mt-0.5 text-muted-foreground text-xs leading-snug line-clamp-2">
          {template.description}
        </div>
      </div>
    </div>
  );
}
