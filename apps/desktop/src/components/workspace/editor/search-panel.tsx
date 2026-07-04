import { useEffect, useRef, useState } from "react";
import {
  XIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  SparklesIcon,
  Loader2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canUseAiAssist, expandSearchTerms } from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";
import { RECOMMENDED_EMBED_MODEL } from "@/lib/ollama";
import { cn } from "@/lib/utils";
import { useEmbeddingReady } from "@/hooks/use-embedding-ready";

interface SearchPanelProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onClose: () => void;
  onFindNext: (options?: { focusEditor?: boolean }) => void;
  onFindPrevious: (options?: { focusEditor?: boolean }) => void;
  matchCount: number;
  currentMatch: number;
}

export function SearchPanel({
  searchQuery,
  onSearchQueryChange,
  onClose,
  onFindNext,
  onFindPrevious,
  matchCount,
  currentMatch,
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const aiSemanticSearch = useSettingsStore((s) => s.aiSemanticSearch);
  const embedding = useEmbeddingReady();
  const [relatedTerms, setRelatedTerms] = useState<string[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  // Track the last query we expanded so we don't re-fire for the same 0-result.
  const lastExpandedRef = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Natural-language fallback: when a settled search yields 0 matches, offer
  // AI-suggested related terms. Passive/background — fails silently.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const query = searchQuery.trim();
    const noResults = query.length > 0 && matchCount === 0;

    // Clear suggestions whenever there ARE matches, the box is empty, or the
    // feature is unavailable — never interfere with literal search.
    if (!noResults || !aiSemanticSearch || !canUseAiAssist()) {
      lastExpandedRef.current = null;
      requestIdRef.current++;
      if (relatedTerms.length > 0) setRelatedTerms([]);
      if (relatedLoading) setRelatedLoading(false);
      return;
    }

    // Already expanded (or expanding) this exact query — leave chips in place.
    if (lastExpandedRef.current === query) return;

    debounceRef.current = setTimeout(() => {
      lastExpandedRef.current = query;
      const id = ++requestIdRef.current;
      setRelatedLoading(true);
      void expandSearchTerms(query)
        .then((terms) => {
          if (id !== requestIdRef.current) return;
          // Drop echoes of the original query; keep it compact.
          const next = terms
            .filter(
              (t) => t.trim() && t.trim().toLowerCase() !== query.toLowerCase(),
            )
            .slice(0, 6);
          setRelatedTerms(next);
        })
        .catch(() => {
          if (id === requestIdRef.current) setRelatedTerms([]);
        })
        .finally(() => {
          if (id === requestIdRef.current) setRelatedLoading(false);
        });
    }, 600);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, matchCount, aiSemanticSearch]);

  const keepInputFocused = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (matchCount === 0) return;
      if (e.shiftKey) {
        onFindPrevious({ focusEditor: false });
      } else {
        onFindNext({ focusEditor: false });
      }
      keepInputFocused();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const showRelated =
    aiSemanticSearch &&
    searchQuery.trim().length > 0 &&
    matchCount === 0 &&
    (relatedLoading || relatedTerms.length > 0);

  return (
    <div className="flex h-9 items-center gap-2 border-border border-b bg-background px-2">
      <Input
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        aria-label="Search in file"
        className="h-7 w-56 border-border bg-muted/40 text-foreground text-sm placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onFindPrevious()}
          disabled={!searchQuery || matchCount === 0}
          aria-label="Previous match (Shift+Enter)"
          title="Previous match (Shift+Enter)"
        >
          <ChevronUpIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onFindNext()}
          disabled={!searchQuery || matchCount === 0}
          aria-label="Next match (Enter)"
          title="Next match (Enter)"
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      </div>
      {searchQuery && (
        <span
          className="text-muted-foreground text-xs"
          aria-live="polite"
          aria-atomic="true"
        >
          {matchCount === 0 ? "No results" : `${currentMatch} of ${matchCount}`}
        </span>
      )}
      {embedding.enabled &&
        !embedding.ready &&
        !embedding.loading &&
        searchQuery.trim().length > 0 &&
        matchCount === 0 && (
          <span
            className="max-w-[10rem] truncate text-[10px] text-amber-700 dark:text-amber-300"
            title={`Install ${RECOMMENDED_EMBED_MODEL.id} in Settings for semantic suggestions`}
          >
            No embed model
          </span>
        )}
      {showRelated && (
        <div
          className="flex min-w-0 items-center gap-1 overflow-hidden"
          role="status"
          aria-live="polite"
        >
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
            {relatedLoading ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <SparklesIcon className="size-3" />
            )}
            {relatedLoading ? "Related" : "Try"}
          </span>
          {relatedTerms.map((term) => (
            <button
              key={term}
              type="button"
              title={`Search for "${term}"`}
              onClick={() => {
                onSearchQueryChange(term);
                keepInputFocused();
              }}
              className={cn(
                "shrink-0 rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] transition-colors",
                "text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {term}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon"
        className="size-6 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onClose}
        aria-label="Close search (Esc)"
        title="Close search (Esc)"
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}
