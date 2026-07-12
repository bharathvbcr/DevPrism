import { useCallback, useState, type ReactNode } from "react";
import {
  CheckCircle2Icon,
  AlertTriangleIcon,
  XCircleIcon,
  Loader2Icon,
  RefreshCwIcon,
  SettingsIcon,
  DatabaseIcon,
  BookOpenIcon,
  DownloadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { dispatchOpenSettings } from "@/lib/home-flow-events";
import { backfillBlockEmbeddings, backfillKbEmbeddings } from "@/lib/career";
import {
  RECOMMENDED_EMBED_MODEL,
  getOllamaBaseUrl,
  resolveOllamaCredential,
} from "@/lib/ollama";
import {
  pendingEmbedCount,
  type ReadinessLevel,
  type SynthesisReadiness,
} from "@/lib/resume-synthesis/preflight";
import { useCareerStore } from "@/stores/career-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useOllamaPullStore } from "@/stores/ollama-pull-store";
import { useSynthesisStore } from "@/stores/synthesis-store";

function LevelIcon({ level }: { level: ReadinessLevel }) {
  if (level === "ok") {
    return (
      <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
    );
  }
  if (level === "warn") {
    return (
      <AlertTriangleIcon className="size-3.5 text-amber-600 dark:text-amber-400" />
    );
  }
  return <XCircleIcon className="size-3.5 text-destructive" />;
}

function levelBadge(
  level: ReadinessLevel,
): "default" | "secondary" | "destructive" | "outline" {
  if (level === "ok") return "secondary";
  if (level === "warn") return "outline";
  return "destructive";
}

export function AiReadinessCard({
  className,
  onAddKnowledge,
}: {
  className?: string;
  onAddKnowledge?: () => void;
}) {
  const readiness = useSynthesisStore((s) => s.readiness);
  const readinessLoading = useSynthesisStore((s) => s.readinessLoading);
  const refreshReadiness = useSynthesisStore((s) => s.refreshReadiness);
  const setActiveTab = useCareerStore((s) => s.setActiveTab);
  const refreshMissingBlockEmbeddings = useCareerStore(
    (s) => s.refreshMissingBlockEmbeddings,
  );
  const pulling = useOllamaPullStore((s) => s.pulling);
  const pull = useOllamaPullStore((s) => s.pull);
  const [backfilling, setBackfilling] = useState(false);

  const handlePullEmbed = useCallback(async () => {
    try {
      const creds = useClaudeSetupStore.getState().openAiCredentials ?? [];
      const baseUrl = getOllamaBaseUrl(resolveOllamaCredential(creds, null));
      await pull(RECOMMENDED_EMBED_MODEL.id, baseUrl);
      toast.success(`Pulling ${RECOMMENDED_EMBED_MODEL.id}`);
      void refreshReadiness({ forceEmbedProbe: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [pull, refreshReadiness]);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    try {
      const [blocksOut, kbOut] = await Promise.all([
        backfillBlockEmbeddings(),
        backfillKbEmbeddings(),
      ]);
      const deferred = blocksOut.deferred || kbOut.deferred;
      const embedded = blocksOut.embedded + kbOut.embedded;
      if (deferred) {
        toast.warning(
          blocksOut.error ??
            kbOut.error ??
            "Embeddings still unavailable — pull a model or open AI settings.",
        );
      } else if (embedded === 0) {
        toast.success("Nothing pending to embed");
      } else {
        toast.success(`Embedded ${embedded} item(s)`);
      }
      void refreshMissingBlockEmbeddings();
      void refreshReadiness({ forceEmbedProbe: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBackfilling(false);
    }
  }, [refreshMissingBlockEmbeddings, refreshReadiness]);

  // Never blank the card — show a skeleton until the first probe resolves.
  const r: SynthesisReadiness | null = readiness;
  const pending = r ? pendingEmbedCount(r) : 0;
  const showSkeleton = !r;

  return (
    <section
      className={cn(
        "rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5",
        className,
      )}
      aria-label="AI readiness"
      aria-busy={showSkeleton || readinessLoading}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-medium text-xs">AI readiness</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[11px]"
          disabled={readinessLoading}
          onClick={() => void refreshReadiness({ forceEmbedProbe: true })}
        >
          {readinessLoading ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
          Refresh
        </Button>
      </div>

      {showSkeleton ? (
        <div
          className="space-y-2"
          role="status"
          aria-label="Checking AI readiness"
        >
          <p className="text-[11px] text-muted-foreground">
            Checking providers…
          </p>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <ul className="space-y-2">
          <ReadinessRow
            level={r.text.status}
            title="Text generation"
            message={r.text.message}
            badge={
              r.text.available
                ? r.text.streams
                  ? "streams"
                  : "no stream"
                : undefined
            }
          >
            {!r.text.available && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[11px]"
                onClick={() => dispatchOpenSettings("ai")}
              >
                <SettingsIcon className="size-3" />
                Open AI settings
              </Button>
            )}
          </ReadinessRow>

          <ReadinessRow
            level={r.embeddings.status}
            title="Embeddings"
            message={r.embeddings.message}
          >
            {!r.embeddings.available && (
              <>
                {(r.embeddings.issue === "no-model" ||
                  r.embeddings.issue === "unreachable") && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px]"
                    disabled={pulling}
                    onClick={() => void handlePullEmbed()}
                  >
                    <DownloadIcon className="size-3" />
                    Pull {RECOMMENDED_EMBED_MODEL.id}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px]"
                  onClick={() => dispatchOpenSettings("ai")}
                >
                  <SettingsIcon className="size-3" />
                  AI settings
                </Button>
              </>
            )}
          </ReadinessRow>

          <ReadinessRow
            level={r.data.status}
            title="Career data"
            message={r.data.message}
          >
            {r.data.blockCount === 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[11px]"
                onClick={() => setActiveTab("database")}
              >
                <DatabaseIcon className="size-3" />
                Open Database
              </Button>
            )}
            {r.data.kbSourceCount === 0 && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px]"
                  onClick={() => setActiveTab("knowledge")}
                >
                  <BookOpenIcon className="size-3" />
                  Open Knowledge
                </Button>
                {onAddKnowledge && (
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    className="h-7 gap-1 text-[11px]"
                    onClick={onAddKnowledge}
                  >
                    Add knowledge
                  </Button>
                )}
              </>
            )}
            {pending > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[11px]"
                disabled={backfilling || !r.embeddings.available}
                onClick={() => void handleBackfill()}
              >
                {backfilling ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : null}
                Embed {pending} pending
              </Button>
            )}
          </ReadinessRow>
        </ul>
      )}
    </section>
  );
}

function ReadinessRow({
  level,
  title,
  message,
  badge,
  children,
}: {
  level: ReadinessLevel;
  title: string;
  message: string;
  badge?: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border/40 bg-background/60 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <LevelIcon level={level} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-[12px] leading-snug">
              {title}
            </span>
            <Badge variant={levelBadge(level)} className="text-[10px]">
              {level === "ok"
                ? "ready"
                : level === "warn"
                  ? "degraded"
                  : "blocked"}
            </Badge>
            {badge ? (
              <Badge variant="outline" className="text-[10px]">
                {badge}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
            {message}
          </p>
        </div>
      </div>
      {children ? (
        <div className="ml-5 flex flex-wrap gap-1.5">{children}</div>
      ) : null}
    </li>
  );
}
