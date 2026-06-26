import { useEffect, useMemo, useRef, useState } from "react";
import { SparklesIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { useDocumentStore } from "@/stores/document-store";
import { resolvePreviewCompileRoot } from "@/lib/compile-root-preference";
import { useSettingsStore } from "@/stores/settings-store";
import { useSpaceFeatures } from "@/hooks/use-space-features";
import { resolveDocumentGoal } from "@/lib/document-goals";
import type { DocumentGoal } from "@/lib/document-goals";
import {
  analyzeSelectionBullets,
  findEnclosingBulletList,
} from "@/lib/resume-bullets";
import {
  analyzeBulletQuality,
  bulletQualityGrade,
  bulletQualityInsights,
  bulletQualityScore,
} from "@/lib/resume-bullet-suggestions";
import {
  aiParseLimits,
  canUseAiAssist,
  tightenToLimit,
} from "@/lib/ai-assist";
import { proposeSelectionReplacement } from "@/lib/inline-edit";
import { cn } from "@/lib/utils";

// A thin status bar pinned to the bottom of the text editor showing live
// document statistics: word/character counts, structural counts (sections,
// citations), and the cursor's line:column. When text is selected, the word
// and character figures reflect the selection instead of the whole document.

/** Approximate prose word count for LaTeX source. */
export function countWords(text: string): number {
  if (!text) return 0;
  const stripped = text
    // Drop full-line and trailing comments (ignore escaped \%).
    .replace(/(^|[^\\])%.*$/gm, "$1")
    // Remove command tokens (\section, \textbf*, …) but keep their arguments.
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    // Remove escaped symbols (\{ \} \% \& \_ \$ …).
    .replace(/\\[^a-zA-Z]/g, " ")
    // Strip structural punctuation that never forms a prose word.
    .replace(/[{}$&~^_#]/g, " ");
  const matches = stripped.match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function EditorStatusBar({ content }: { content: string }) {
  const [tightening, setTightening] = useState(false);
  const aiAssistEnabled = useSettingsStore((s) => s.aiAssistEnabled);
  const activeFile = useDocumentStore((s) =>
    s.files.find((f) => f.id === s.activeFileId),
  );
  const cursorPosition = useDocumentStore((s) => s.cursorPosition);
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const activeFileName = useDocumentStore((s) => {
    const f = s.files.find((file) => file.id === s.activeFileId);
    return f?.name;
  });
  const jobDescription = useDocumentStore((s) => {
    const f = s.files.find(
      (file) =>
        file.name.toLowerCase() === "job_description.md" ||
        file.relativePath?.toLowerCase().endsWith("/job_description.md"),
    );
    return f?.content ?? null;
  });
  const pdfRevision = useDocumentStore((s) => s.pdfRevision);
  const compiledPageCount = useDocumentStore((s) => {
    const rootId = resolvePreviewCompileRoot(
      s.projectRoot,
      s.activeFileId,
      s.files,
    );
    return s.compiledPageCounts.get(rootId) ?? null;
  });

  const { kind: spaceKind, config } = useSpaceFeatures();
  const spaceLabel = config.label;

  const documentGoal = useMemo(
    () =>
      resolveDocumentGoal(spaceKind, jobDescription, {
        activeFileName,
      }),
    [spaceKind, jobDescription, activeFileName],
  );

  // AI fallback: when the regex parser yields no numeric limit but target text
  // exists, ask the model to parse phrasings the regex misses ("one to two
  // pages", spelled-out numbers, …). Memoized per distinct target text so we
  // call at most once per JD; failures degrade silently (passive AI).
  const aiLimitCache = useRef(
    new Map<string, { wordLimit?: number; charLimit?: number }>(),
  );
  const [aiLimits, setAiLimits] = useState<{
    wordLimit?: number;
    charLimit?: number;
  } | null>(null);

  const goalHasNumericLimit =
    documentGoal?.wordLimit != null || documentGoal?.charLimit != null;
  const targetText = jobDescription?.trim() ?? "";

  useEffect(() => {
    // Only fall back when the regex found nothing numeric and we have text.
    if (goalHasNumericLimit || !targetText || !canUseAiAssist()) {
      setAiLimits(null);
      return;
    }

    const cached = aiLimitCache.current.get(targetText);
    if (cached) {
      setAiLimits(cached.wordLimit || cached.charLimit ? cached : null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const parsed = await aiParseLimits(targetText);
        if (cancelled) return;
        aiLimitCache.current.set(targetText, parsed);
        setAiLimits(parsed.wordLimit || parsed.charLimit ? parsed : null);
      } catch {
        // Passive/background AI: never surface errors.
        if (!cancelled) setAiLimits(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [goalHasNumericLimit, targetText]);

  // Effective goal drives the limit readout and Tighten affordance: prefer the
  // regex-resolved goal, otherwise the AI-detected numeric limit.
  const effectiveGoal = useMemo<DocumentGoal | null>(() => {
    if (goalHasNumericLimit) return documentGoal;
    if (aiLimits && (aiLimits.wordLimit || aiLimits.charLimit)) {
      return {
        label: "Target limit (AI)",
        wordLimit: aiLimits.wordLimit,
        charLimit: aiLimits.charLimit,
      };
    }
    return documentGoal;
  }, [documentGoal, goalHasNumericLimit, aiLimits]);

  const hasSelection =
    !!selectionRange && selectionRange.start !== selectionRange.end;

  const cursorBulletBlock = useMemo(() => {
    if (hasSelection || spaceKind !== "resume") return null;
    return findEnclosingBulletList(content, cursorPosition);
  }, [hasSelection, spaceKind, content, cursorPosition]);

  const cursorBulletInsights = useMemo(() => {
    if (!cursorBulletBlock) return { lines: [] as string[], score: null as number | null };
    const bulletText = content.slice(
      cursorBulletBlock.start,
      cursorBulletBlock.end,
    );
    const quality = analyzeBulletQuality(bulletText);
    const score = bulletQualityScore(quality);
    const lines = bulletQualityInsights(quality, {
      bulletText,
      itemCount: cursorBulletBlock.itemCount,
      compiledPageCount:
        compiledPageCount != null && compiledPageCount > 0
          ? compiledPageCount
          : null,
      hasJobDescription: (jobDescription?.trim().length ?? 0) > 0,
    }).slice(0, 2);
    return { lines, score };
  }, [cursorBulletBlock, content, compiledPageCount, jobDescription]);

  const stats = useMemo(() => {
    const totalWords = countWords(content);
    const totalChars = content.length;
    const sections = (content.match(/\\(?:sub)*section\*?\s*[{[]/g) || [])
      .length;
    const citations = (
      content.match(/\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*)*\{/g) || []
    ).length;
    return { totalWords, totalChars, sections, citations };
  }, [content]);

  const selectionStats = useMemo(() => {
    if (!hasSelection || !selectionRange) return null;
    const start = Math.min(selectionRange.start, selectionRange.end);
    const end = Math.max(selectionRange.start, selectionRange.end);
    const text = content.slice(start, end);
    const bulletStats = analyzeSelectionBullets(content, start, end);
    return {
      words: countWords(text),
      chars: end - start,
      bullets: bulletStats.selectedCount,
      blockBullets: bulletStats.block?.itemCount ?? null,
    };
  }, [hasSelection, selectionRange, content]);

  const cursorLineCol = useMemo(() => {
    const upto = content.slice(0, Math.min(cursorPosition, content.length));
    const line = (upto.match(/\n/g) || []).length + 1;
    const col = cursorPosition - upto.lastIndexOf("\n");
    return { line, col };
  }, [cursorPosition, content]);

  const limitStatus = useMemo(() => {
    if (!effectiveGoal) return null;
    const words = selectionStats?.words ?? stats.totalWords;
    const chars = selectionStats?.chars ?? stats.totalChars;
    if (effectiveGoal.wordLimit) {
      const ratio = words / effectiveGoal.wordLimit;
      return {
        text: `${formatNumber(words)} / ${formatNumber(effectiveGoal.wordLimit)} words`,
        over: words > effectiveGoal.wordLimit,
        warn: ratio >= 0.9 && words <= effectiveGoal.wordLimit,
      };
    }
    if (effectiveGoal.charLimit) {
      return {
        text: `${formatNumber(chars)} / ${formatNumber(effectiveGoal.charLimit)} chars`,
        over: chars > effectiveGoal.charLimit,
        warn:
          chars >= effectiveGoal.charLimit * 0.9 &&
          chars <= effectiveGoal.charLimit,
      };
    }
    if (effectiveGoal.pageHint) {
      const pages = compiledPageCount;
      if (pages != null && pages > 0 && spaceKind === "resume") {
        return {
          text: `${pages} ${pages === 1 ? "page" : "pages"} (target: ${effectiveGoal.pageHint})`,
          over: pages > 1,
          warn: pages === 1,
        };
      }
      return { text: effectiveGoal.pageHint, over: false, warn: false };
    }
    return null;
  }, [
    effectiveGoal,
    selectionStats,
    stats,
    compiledPageCount,
    spaceKind,
    pdfRevision,
  ]);

  const handleTightenWithAi = async () => {
    if (!activeFile?.absolutePath || !effectiveGoal || tightening) return;
    const start = selectionRange
      ? Math.min(selectionRange.start, selectionRange.end)
      : 0;
    const end = selectionRange
      ? Math.max(selectionRange.start, selectionRange.end)
      : content.length;
    const spanText = content.slice(start, end);
    if (!spanText.trim()) return;

    setTightening(true);
    try {
      const tightened = await tightenToLimit(spanText, {
        wordLimit: effectiveGoal.wordLimit,
        charLimit: effectiveGoal.charLimit,
      });
      proposeSelectionReplacement(
        {
          filePath: activeFile.relativePath,
          absolutePath: activeFile.absolutePath,
          content,
          from: start,
          to: end,
          selectedText: spanText,
          contextLabel: `@${activeFile.relativePath}`,
        },
        tightened,
      );
      toast.success("Tightened text ready — review the change");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Tighten failed");
    } finally {
      setTightening(false);
    }
  };

  const showTighten =
    aiAssistEnabled &&
    canUseAiAssist() &&
    limitStatus?.over &&
    (effectiveGoal?.wordLimit != null || effectiveGoal?.charLimit != null);

  return (
    <div className="flex h-6 shrink-0 select-none items-center gap-3 border-border border-t bg-muted/30 px-3 text-[11px] text-muted-foreground tabular-nums">
      {spaceKind !== "general" && (
        <span className="hidden font-medium text-foreground/80 md:inline">
          {spaceLabel}
        </span>
      )}
      {selectionStats ? (
        <span className="font-medium text-foreground">
          Selected: {formatNumber(selectionStats.words)}{" "}
          {selectionStats.words === 1 ? "word" : "words"} ·{" "}
          {formatNumber(selectionStats.chars)} chars
          {spaceKind === "resume" && selectionStats.bullets > 0 && (
            <>
              {" "}
              · {selectionStats.bullets}
              {selectionStats.blockBullets != null &&
              selectionStats.blockBullets > selectionStats.bullets
                ? `/${selectionStats.blockBullets}`
                : ""}{" "}
              {selectionStats.bullets === 1 ? "bullet" : "bullets"}
            </>
          )}
        </span>
      ) : (
        <span>
          {formatNumber(stats.totalWords)}{" "}
          {stats.totalWords === 1 ? "word" : "words"}
        </span>
      )}
      {!selectionStats && <span>{formatNumber(stats.totalChars)} chars</span>}
      {limitStatus && (
        <span
          className={cn(
            limitStatus.over && "font-medium text-destructive",
            limitStatus.warn &&
              !limitStatus.over &&
              "text-amber-600 dark:text-amber-400",
          )}
          title={effectiveGoal?.label}
        >
          {limitStatus.text}
        </span>
      )}
      {showTighten && (
        <button
          type="button"
          onClick={() => void handleTightenWithAi()}
          disabled={tightening}
          className="flex items-center gap-1 rounded-full border border-destructive/30 px-2 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10"
          title="Shorten with AI to fit the limit"
        >
          {tightening ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <SparklesIcon className="size-3" />
          )}
          Tighten
        </button>
      )}
      {!selectionStats &&
        cursorBulletBlock &&
        cursorBulletBlock.itemCount > 0 && (
          <span className="hidden text-amber-700 sm:inline dark:text-amber-400">
            {cursorBulletBlock.itemCount}{" "}
            {cursorBulletBlock.itemCount === 1 ? "bullet" : "bullets"} in role
            {cursorBulletInsights.score != null && (
              <>
                {" "}
                · {cursorBulletInsights.score}{" "}
                {bulletQualityGrade(cursorBulletInsights.score).toLowerCase()}
              </>
            )}
            {cursorBulletInsights.lines.length > 0
              ? ` — ${cursorBulletInsights.lines[0].toLowerCase()}`
              : " — Alt+Shift+B to adjust"}
          </span>
        )}
      <span className="hidden sm:inline">
        {stats.sections} {stats.sections === 1 ? "section" : "sections"}
      </span>
      <span className="hidden sm:inline">
        {stats.citations} {stats.citations === 1 ? "citation" : "citations"}
      </span>
      {compiledPageCount != null && compiledPageCount > 0 && !limitStatus && (
        <span className="hidden md:inline">
          {compiledPageCount} {compiledPageCount === 1 ? "page" : "pages"}{" "}
          compiled
        </span>
      )}
      <span className="ml-auto">
        Ln {cursorLineCol.line}, Col {cursorLineCol.col}
      </span>
    </div>
  );
}
