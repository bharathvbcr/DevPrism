import { useEffect, useMemo, useRef, useState } from "react";
import {
  SearchIcon,
  XIcon,
  SparklesIcon,
  Loader2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { useTemplateStore } from "@/stores/template-store";
import { useSpacesStore } from "@/stores/spaces-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  canUseAiAssist,
  recommendTemplates,
  semanticRankTemplates,
} from "@/lib/ai-assist";
import {
  CATEGORY_LABELS,
  type TemplateCategory,
  type TemplateDefinition,
  getAllTemplates,
  getTemplateById,
} from "@/lib/template-registry";
import {
  inferSpaceKind,
  recommendedTemplateIdsForKind,
} from "@/lib/space-features";
import { TemplateCard } from "./template-card";
import { CategorySidebar } from "./category-sidebar";
import { TemplatePreview } from "./template-preview";

export function TemplateGallery() {
  const searchQuery = useTemplateStore((s) => s.searchQuery);
  const setSearchQuery = useTemplateStore((s) => s.setSearchQuery);
  const selectedCategory = useTemplateStore((s) => s.selectedCategory);
  const filteredTemplates = useTemplateStore((s) => s.filteredTemplates);
  const reset = useTemplateStore((s) => s.reset);
  const activeSpaceId = useSpacesStore((s) => s.activeSpaceId);
  const spaces = useSpacesStore((s) => s.spaces);

  const activeSpace = useMemo(
    () => spaces.find((s) => s.id === activeSpaceId) ?? null,
    [spaces, activeSpaceId],
  );
  const recommendedIds = useMemo(() => {
    const kind = activeSpace ? inferSpaceKind(activeSpace) : "general";
    return new Set(recommendedTemplateIdsForKind(kind));
  }, [activeSpace]);

  // ─── AI template recommendations from a typed goal ───
  const aiTemplateRecommend = useSettingsStore((s) => s.aiTemplateRecommend);
  const [aiGoal, setAiGoal] = useState("");
  const [aiPickIds, setAiPickIds] = useState<string[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const aiDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiRequestIdRef = useRef(0);

  useEffect(() => {
    if (!aiTemplateRecommend || !canUseAiAssist()) {
      setAiPickIds([]);
      setAiLoading(false);
      return;
    }

    const goal = aiGoal.trim();
    if (goal.length < 8) {
      setAiPickIds([]);
      setAiLoading(false);
      return;
    }

    if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current);
    aiDebounceRef.current = setTimeout(() => {
      const id = ++aiRequestIdRef.current;
      setAiLoading(true);
      const templates = getAllTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
      }));
      // Prefer local embedding-based ranking; fall back to the LLM call.
      void semanticRankTemplates(goal, templates)
        .then((ranked) =>
          ranked.length > 0 ? ranked : recommendTemplates(goal, templates),
        )
        .then((ids) => {
          if (id === aiRequestIdRef.current) setAiPickIds(ids);
        })
        .catch(() => {
          // Passive/background AI — fail silently.
          if (id === aiRequestIdRef.current) setAiPickIds([]);
        })
        .finally(() => {
          if (id === aiRequestIdRef.current) setAiLoading(false);
        });
    }, 700);

    return () => {
      if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current);
    };
  }, [aiGoal, aiTemplateRecommend]);

  // Resolve AI-returned ids back to template objects, preserving rank.
  const aiPicks = useMemo(() => {
    if (aiPickIds.length === 0) return [];
    return aiPickIds
      .map((id) => getTemplateById(id))
      .filter((t): t is TemplateDefinition => !!t);
  }, [aiPickIds]);
  const aiPickIdSet = useMemo(() => new Set(aiPicks.map((t) => t.id)), [aiPicks]);

  const aiEnabled = aiTemplateRecommend && canUseAiAssist();
  const showAiPicks = aiPicks.length > 0;

  const searchRef = useRef<HTMLInputElement>(null);

  // Reset store when gallery mounts
  useEffect(() => {
    reset();
  }, [reset]);

  // Focus search on Cmd/Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      // Escape clears search
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        setSearchQuery("");
        searchRef.current?.blur();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSearchQuery]);

  // Group templates by category when showing all
  const showGrouped = !selectedCategory && !searchQuery;
  const recommendedTemplates = useMemo(
    () =>
      activeSpace && recommendedIds.size > 0
        ? filteredTemplates.filter((t) => recommendedIds.has(t.id))
        : [],
    [activeSpace, filteredTemplates, recommendedIds],
  );
  const showRecommended =
    showGrouped && !selectedCategory && recommendedTemplates.length > 0;

  const displayTemplates = useMemo(
    () => sortRecommendedFirst(filteredTemplates, recommendedIds),
    [filteredTemplates, recommendedIds],
  );

  const heading = selectedCategory
    ? CATEGORY_LABELS[selectedCategory]
    : searchQuery
      ? `Results for "${searchQuery}"`
      : "All Templates";

  return (
    <div className="flex h-full flex-col">
      {/* Search bar */}
      <div className="shrink-0 border-border border-b px-4 py-3">
        <div className="relative mx-auto max-w-xl">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            placeholder="Search templates...  ⌘K"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pr-8 pl-9"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>

        {/* AI goal input — describe what you want to write */}
        {aiEnabled && (
          <div className="relative mx-auto mt-2 max-w-xl">
            {aiLoading ? (
              <Loader2Icon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 animate-spin text-primary" />
            ) : (
              <WandSparklesIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-primary" />
            )}
            <Input
              placeholder="Describe what you want to write — AI picks templates"
              value={aiGoal}
              onChange={(e) => setAiGoal(e.target.value)}
              className="pr-8 pl-9"
            />
            {aiGoal && (
              <button
                onClick={() => setAiGoal("")}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main content: sidebar + grid */}
      <div className="flex flex-1 overflow-hidden">
        {/* Category sidebar */}
        <div className="shrink-0 border-border border-r pt-2 pl-3">
          <CategorySidebar />
        </div>

        {/* Template grid */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {showAiPicks && (
            <div className="mb-8">
              <div className="mb-3 flex items-center gap-2">
                <WandSparklesIcon className="size-3.5 text-primary" />
                <h2 className="font-semibold text-sm">AI picks</h2>
                <span className="truncate text-muted-foreground text-xs">
                  for “{aiGoal.trim()}”
                </span>
              </div>
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
                {aiPicks.map((t) => (
                  <TemplateCard key={`ai-${t.id}`} template={t} recommended />
                ))}
              </div>
            </div>
          )}
          {filteredTemplates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <SearchIcon className="mb-3 size-8 text-muted-foreground/40" />
              <p className="font-medium text-muted-foreground text-sm">
                No templates found
              </p>
              <p className="mt-1 text-muted-foreground/70 text-xs">
                Try a different search term or category
              </p>
            </div>
          ) : showGrouped ? (
            <GroupedGrid
              recommendedTemplates={showRecommended ? recommendedTemplates : []}
              activeSpaceName={activeSpace?.name}
              recommendedIds={recommendedIds}
              aiPickIds={aiPickIdSet}
            />
          ) : (
            <>
              <h2 className="mb-4 font-medium text-muted-foreground text-sm">
                {heading}
              </h2>
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
                {displayTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    recommended={
                      recommendedIds.has(t.id) || aiPickIdSet.has(t.id)
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Preview modal — handles template selection + project creation */}
      <TemplatePreview />
    </div>
  );
}

// ─── Grouped Grid (shows categories as sections) ───

function sortRecommendedFirst(
  templates: TemplateDefinition[],
  recommendedIds: Set<string>,
): TemplateDefinition[] {
  if (recommendedIds.size === 0) return templates;
  const recommended: TemplateDefinition[] = [];
  const rest: TemplateDefinition[] = [];
  for (const t of templates) {
    if (recommendedIds.has(t.id)) recommended.push(t);
    else rest.push(t);
  }
  return [...recommended, ...rest];
}

function GroupedGrid({
  recommendedTemplates,
  activeSpaceName,
  recommendedIds,
  aiPickIds,
}: {
  recommendedTemplates: TemplateDefinition[];
  activeSpaceName?: string;
  recommendedIds: Set<string>;
  aiPickIds: Set<string>;
}) {
  const filteredTemplates = useTemplateStore((s) => s.filteredTemplates);

  // Group by category preserving order
  const categories: TemplateCategory[] = [
    "academic",
    "professional",
    "creative",
    "starter",
  ];
  const groups = categories
    .map((cat) => ({
      category: cat,
      templates: filteredTemplates.filter((t) => t.category === cat),
    }))
    .filter((g) => g.templates.length > 0);

  return (
    <div className="space-y-8">
      {recommendedTemplates.length > 0 && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <SparklesIcon className="size-3.5 text-primary" />
            <h2 className="font-semibold text-sm">
              Recommended for {activeSpaceName}
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {recommendedTemplates.map((t) => (
              <TemplateCard key={t.id} template={t} recommended />
            ))}
          </div>
        </div>
      )}
      {groups.map((group) => (
        <div key={group.category}>
          <h2 className="mb-3 font-semibold text-sm">
            {CATEGORY_LABELS[group.category]}
          </h2>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {group.templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                recommended={recommendedIds.has(t.id) || aiPickIds.has(t.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
