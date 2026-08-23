import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FileSearchIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listKbChunks, type KbChunkRow, type KbSourceRow } from "@/lib/career";
import {
  chunkHeadingLabel,
  matchesChunkFilter,
  sortKbChunksForDisplay,
  stripHeadingPrefix,
} from "@/lib/career/kb-source-view";

/** Hard cap on initially rendered chunk cards; guards pathological sources. */
const INITIAL_RENDER_LIMIT = 300;

function sourceDisplayName(source: KbSourceRow): string {
  return source.title || source.uri || source.id;
}

/**
 * Inspect what a KB ingest actually stored: every chunk in document order
 * (backend returns them in random UUID order), its heading path, text, and
 * per-chunk embedding status.
 */
export function KbSourceViewerDialog({
  source,
  open,
  onOpenChange,
}: {
  source: KbSourceRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [chunks, setChunks] = useState<KbChunkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_LIMIT);

  const sourceId = source?.id ?? null;
  const sourceName = source ? sourceDisplayName(source) : "";

  // Monotonic load token: only the newest request may commit state, so a slow
  // response for a previously viewed source can never overwrite the current one.
  const loadTokenRef = useRef(0);

  const load = useCallback(async (id: string) => {
    const token = ++loadTokenRef.current;
    setChunks(null);
    setError(null);
    try {
      const rows = await listKbChunks(id, false);
      if (loadTokenRef.current !== token) return;
      setChunks(Array.isArray(rows) ? rows : []);
    } catch (err) {
      if (loadTokenRef.current !== token) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!open || !sourceId) return;
    setQuery("");
    setExpanded(new Set());
    setRenderLimit(INITIAL_RENDER_LIMIT);
    void load(sourceId);
  }, [open, sourceId, load]);

  const sorted = useMemo(() => sortKbChunksForDisplay(chunks ?? []), [chunks]);

  const filtered = useMemo(
    () => sorted.filter((c) => matchesChunkFilter(c, query)),
    [sorted, query],
  );

  const embeddedCount = sorted.filter((c) => c.hasEmbedding).length;
  const missingCount = sorted.length - embeddedCount;

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{sourceName}</DialogTitle>
          <DialogDescription className="text-xs">
            Stored knowledge chunks for this source, in document order.
          </DialogDescription>
        </DialogHeader>

        {source && (
          <div aria-live="polite" className="contents">
            {chunks == null && !error && (
              <div
                role="status"
                aria-label="Loading chunks"
                className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm"
              >
                <Loader2Icon className="size-4 animate-spin" />
                Loading chunks…
              </div>
            )}

            {error != null && (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-destructive text-sm">{error}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void load(source.id)}
                >
                  <RefreshCwIcon className="size-3.5" />
                  Retry
                </Button>
              </div>
            )}

            {chunks != null && chunks.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <FileSearchIcon className="size-6 text-muted-foreground/40" />
                <p className="text-muted-foreground text-sm">
                  This source has no stored chunks.
                </p>
              </div>
            )}

            {chunks != null && chunks.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Filter chunks…"
                      aria-label="Filter chunks"
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <Badge variant="secondary" className="text-[10px]">
                      {filtered.length === sorted.length
                        ? `${sorted.length} chunks`
                        : `${filtered.length} of ${sorted.length}`}
                    </Badge>
                    <Badge variant="success" className="text-[10px]">
                      {embeddedCount} embedded
                    </Badge>
                    {missingCount > 0 && (
                      <Badge variant="destructive" className="text-[10px]">
                        {missingCount} missing embeds
                      </Badge>
                    )}
                  </div>
                </div>

                {filtered.length === 0 ? (
                  <p className="py-6 text-center text-muted-foreground text-xs">
                    No chunks match “{query.trim()}”.
                  </p>
                ) : (
                  <ScrollArea className="min-h-0 flex-1 rounded-md border border-border/60">
                    <ul className="divide-y divide-border/40">
                      {filtered.slice(0, renderLimit).map((chunk) => {
                        const label = chunkHeadingLabel(chunk.meta);
                        const body = stripHeadingPrefix(chunk.text, label);
                        const isOpen = expanded.has(chunk.id);
                        return (
                          <li key={chunk.id} className="px-3 py-2">
                            <button
                              type="button"
                              className="flex w-full items-start gap-2 rounded text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                              aria-expanded={isOpen}
                              onClick={() => toggle(chunk.id)}
                            >
                              {isOpen ? (
                                <ChevronUpIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 flex-1">
                                {label && (
                                  <span className="block truncate font-medium text-[11px] text-primary/80">
                                    {label}
                                  </span>
                                )}
                                {!isOpen && (
                                  <span className="mt-0.5 line-clamp-2 block text-muted-foreground text-xs leading-relaxed">
                                    {body}
                                  </span>
                                )}
                              </span>
                              <span className="flex shrink-0 items-center gap-1">
                                {chunk.hasEmbedding ? (
                                  <Badge
                                    variant="success"
                                    className="text-[9px]"
                                  >
                                    embedded
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="destructive"
                                    className="text-[9px]"
                                  >
                                    no embed
                                  </Badge>
                                )}
                                <Badge
                                  variant="outline"
                                  className="text-[9px]"
                                  title={`${chunk.text.length} characters`}
                                >
                                  {(chunk.text.length / 1024).toFixed(1)}k
                                </Badge>
                              </span>
                            </button>
                            {isOpen && (
                              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                                {body}
                              </pre>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {filtered.length > renderLimit && (
                      <div className="flex justify-center border-border/40 border-t p-2">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setRenderLimit((n) => n + INITIAL_RENDER_LIMIT)
                          }
                        >
                          Show{" "}
                          {Math.min(
                            INITIAL_RENDER_LIMIT,
                            filtered.length - renderLimit,
                          )}{" "}
                          more of {filtered.length}
                        </Button>
                      </div>
                    )}
                  </ScrollArea>
                )}
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
