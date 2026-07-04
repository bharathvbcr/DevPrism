import { useCallback, useEffect, useRef, useState } from "react";
import {
  SparklesIcon,
  Loader2Icon,
  WifiOffIcon,
  WifiIcon,
  FileTextIcon,
  PlusIcon,
  AlertTriangleIcon,
  HammerIcon,
  CheckCircle2Icon,
  BookOpenIcon,
  SettingsIcon,
  RefreshCwIcon,
  LightbulbIcon,
  TargetIcon,
  CopyIcon,
} from "lucide-react";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import {
  useScholarLMStore,
  WISDEV_STAGE_EVENT,
  type Hypothesis,
  type ResearchReport,
  type StageEvent,
  type WisdevStatus,
} from "@/stores/scholarlm-store";
import { useDocumentStore } from "@/stores/document-store";
import { useEditorViewModeStore } from "@/stores/editor-view-mode-store";
import { MarkdownRenderer } from "@/components/claude-chat/markdown-renderer";
import { createFileOnDisk, getUniqueTargetName } from "@/lib/tauri/fs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("scholarlm-panel");

type Mode = "research" | "manuscript";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "manuscript"
  );
}

// ─── Header (mirrors ZoteroHeader / BibliographyHeader) ───

export function ScholarLMHeader() {
  const offline = useScholarLMStore((s) => s.offline);
  const setOffline = useScholarLMStore((s) => s.setOffline);
  return (
    <div className="flex w-full items-center justify-between px-3">
      <div className="flex items-center gap-1.5 font-medium text-xs">
        <SparklesIcon className="size-3.5 text-primary" />
        <span>ScholarLM Research</span>
      </div>
      <button
        type="button"
        aria-pressed={offline}
        aria-label="Toggle offline mode"
        onClick={() => setOffline(!offline)}
        title={
          offline
            ? "Offline mode: fully local, no search providers"
            : "Online mode: uses configured search/LLM providers"
        }
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
          offline
            ? "bg-muted text-muted-foreground"
            : "bg-primary/15 text-primary",
        )}
      >
        {offline ? (
          <WifiOffIcon className="size-3" />
        ) : (
          <WifiIcon className="size-3" />
        )}
        {offline ? "Offline" : "Online"}
      </button>
    </div>
  );
}

// ─── Panel ───

export function ScholarLMPanel() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);

  const check = useScholarLMStore((s) => s.check);
  const build = useScholarLMStore((s) => s.build);
  const research = useScholarLMStore((s) => s.research);
  const docgen = useScholarLMStore((s) => s.docgen);

  const repoPath = useScholarLMStore((s) => s.repoPath);
  const setRepoPath = useScholarLMStore((s) => s.setRepoPath);
  const binaryPath = useScholarLMStore((s) => s.binaryPath);
  const setBinaryPath = useScholarLMStore((s) => s.setBinaryPath);
  const maxIterations = useScholarLMStore((s) => s.maxIterations);
  const setMaxIterations = useScholarLMStore((s) => s.setMaxIterations);

  const [mode, setMode] = useState<Mode>("research");
  const [showConfig, setShowConfig] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WisdevStatus | null>(null);
  const [busy, setBusy] = useState<null | "check" | "build" | "run">(null);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [manuscript, setManuscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageEvent[]>([]);

  const runCheck = useCallback(async () => {
    setBusy("check");
    try {
      const s = await check();
      setStatus(s);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [check]);

  // Detect the runtime once when the panel first mounts.
  const checkedRef = useRef(false);
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    void runCheck();
  }, [runCheck]);

  const handleBuild = useCallback(async () => {
    setBusy("build");
    setError(null);
    toast.info("Building the WisDev runtime… this can take a minute.");
    try {
      const path = await build();
      toast.success("WisDev runtime built.");
      log.info("wisdev built", { path });
      await runCheck();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setBusy(null);
    }
  }, [build, runCheck]);

  const handleRun = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setBusy("run");
    setError(null);
    setReport(null);
    setManuscript(null);
    setStages([]);

    let unlisten: (() => void) | undefined;
    try {
      if (mode === "research") {
        // Stream loop progress while the research runs.
        unlisten = await listen<StageEvent>(WISDEV_STAGE_EVENT, (event) => {
          setStages((prev) => [...prev, event.payload]);
        });
        const r = await research(q);
        setReport(r);
      } else {
        const tex = await docgen(q, "latex");
        setManuscript(tex);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      unlisten?.();
      setBusy(null);
    }
  }, [query, mode, research, docgen]);

  const handleInsertReport = useCallback(() => {
    if (!report) return;
    insertAtCursor(`\n${report.final_answer}\n`);
    toast.success("Report inserted at cursor.");
  }, [report, insertAtCursor]);

  const handleSaveManuscript = useCallback(async () => {
    if (!manuscript || !projectRoot) {
      setError("Open a project before saving a manuscript.");
      return;
    }
    try {
      const name = await getUniqueTargetName(
        projectRoot,
        `${slugify(query)}.tex`,
      );
      await createFileOnDisk(projectRoot, name, manuscript);
      await refreshFiles();
      setActiveFile(name);
      // ScholarDoc manuscripts open in the rich (Word-like) editor.
      useEditorViewModeStore.getState().setMode("rich");
      toast.success(`Created ${name}`, {
        description:
          "Opened in the rich editor — switch to Source for LaTeX, or compile for the PDF preview.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }, [manuscript, projectRoot, query, refreshFiles, setActiveFile]);

  const runtimeUnavailable = status !== null && !status.available;
  const canBuild = status?.go_available && !status.dist_binary;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Mode toggle */}
      <div className="flex shrink-0 items-center gap-1 border-sidebar-border border-b p-2">
        <ModeTab
          active={mode === "research"}
          onClick={() => setMode("research")}
          icon={<SparklesIcon className="size-3.5" />}
          label="Research"
        />
        <ModeTab
          active={mode === "manuscript"}
          onClick={() => setMode("manuscript")}
          icon={<BookOpenIcon className="size-3.5" />}
          label="ScholarDoc"
        />
        <button
          type="button"
          onClick={() => setShowConfig((v) => !v)}
          title="Runtime settings"
          aria-label="Runtime settings"
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
            showConfig
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </div>

      {/* Runtime settings */}
      {showConfig && (
        <div className="shrink-0 space-y-2 border-sidebar-border border-b bg-muted/20 p-2 text-xs">
          <ConfigField
            label="WisDev ARC repo path"
            value={repoPath}
            onChange={setRepoPath}
            placeholder="/path/to/scholarlm/wisdev-arc"
          />
          <ConfigField
            label="Binary path (optional)"
            value={binaryPath}
            onChange={setBinaryPath}
            placeholder="Leave empty to auto-detect / build"
          />
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Max iterations</span>
            <input
              type="number"
              min={0}
              max={20}
              value={maxIterations || ""}
              onChange={(e) => setMaxIterations(Number(e.target.value))}
              placeholder="auto"
              className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <div className="flex items-center gap-2 pt-0.5">
            <Button
              onClick={runCheck}
              disabled={busy !== null}
              size="sm"
              variant="outline"
              className="h-7 flex-1"
            >
              {busy === "check" ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              Re-check runtime
            </Button>
          </div>
          {status && (
            <p
              className={cn(
                "text-[10px]",
                status.available ? "text-success" : "text-warning",
              )}
            >
              {status.available ? "● " : "○ "}
              {status.mode === "binary"
                ? "Ready (binary)"
                : status.mode === "go"
                  ? "Ready (go run)"
                  : "Unavailable"}
              {" · "}
              {status.detail}
            </p>
          )}
        </div>
      )}

      {/* Query input */}
      <div className="shrink-0 space-y-2 p-2">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleRun();
            }
          }}
          rows={3}
          placeholder={
            mode === "research"
              ? "Ask a research question…\ne.g. What evidence supports RAG for scientific literature?"
              : "Manuscript topic…\ne.g. Retrieval-augmented generation for scientific literature"
          }
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-ring"
        />
        <Button
          onClick={handleRun}
          disabled={busy !== null || !query.trim() || runtimeUnavailable}
          size="sm"
          className="w-full"
        >
          {busy === "run" ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" />
              {mode === "research" ? "Researching…" : "Drafting…"}
            </>
          ) : (
            <>
              <SparklesIcon className="size-3.5" />
              {mode === "research" ? "Run research" : "Generate manuscript"}
            </>
          )}
        </Button>
        <p className="text-[10px] text-muted-foreground">
          ⌘/Ctrl + Enter to run · powered by WisDev ARC
        </p>
      </div>

      {/* Runtime status / build prompt */}
      {runtimeUnavailable && (
        <div className="mx-2 mb-2 shrink-0 rounded-md border border-warning/40 bg-warning/15 p-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-warning">
            <AlertTriangleIcon className="size-3.5" />
            WisDev runtime unavailable
          </div>
          <p className="mt-1 text-muted-foreground">{status?.detail}</p>
          {canBuild && (
            <Button
              onClick={handleBuild}
              disabled={busy !== null}
              size="sm"
              variant="outline"
              className="mt-2 w-full"
            >
              {busy === "build" ? (
                <>
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Building…
                </>
              ) : (
                <>
                  <HammerIcon className="size-3.5" />
                  Build runtime
                </>
              )}
            </Button>
          )}
        </div>
      )}

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive text-xs">
            <pre className="whitespace-pre-wrap font-mono">{error}</pre>
          </div>
        )}

        {/* Live progress while a research run streams. */}
        {busy === "run" && mode === "research" && (
          <div className="mb-2 rounded-md border border-primary/30 bg-primary/5 p-2">
            <div className="flex items-center gap-1.5 font-medium text-primary text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              {stages.length > 0
                ? stages[stages.length - 1].message
                : "Starting research loop…"}
            </div>
            {stages.length > 0 && <StageList stages={stages} live />}
          </div>
        )}

        {report && stages.length > 0 && (
          <details className="mb-2 rounded-md border border-border bg-card/40 p-2 text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground">
              Research trace ({stages.length} steps)
            </summary>
            <StageList stages={stages} />
          </details>
        )}

        {report && (
          <div className="space-y-2">
            <ReportMeta report={report} />
            <div className="flex gap-1.5">
              <Button
                onClick={handleInsertReport}
                size="sm"
                variant="outline"
                className="flex-1"
              >
                <PlusIcon className="size-3.5" />
                Insert into document
              </Button>
            </div>
            <div className="rounded-md border border-border bg-card/40 p-2.5">
              <MarkdownRenderer content={report.final_answer} />
            </div>
            {report.hypotheses.length > 0 && (
              <div className="rounded-md border border-border bg-card/40 p-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
                  <LightbulbIcon className="size-3.5 text-warning" />
                  Hypotheses ({report.hypotheses.length})
                </div>
                <ul className="space-y-1.5">
                  {report.hypotheses.map((h, i) => (
                    <HypothesisRow key={h.id || i} hypothesis={h} />
                  ))}
                </ul>
              </div>
            )}
            {report.gaps.missing_aspects.length > 0 && (
              <details className="rounded-md border border-border bg-card/40 p-2 text-xs">
                <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-muted-foreground">
                  <TargetIcon className="size-3.5 text-warning" />
                  Coverage gaps ({report.gaps.missing_aspects.length})
                </summary>
                {report.gaps.reasoning && (
                  <p className="mt-1.5 text-muted-foreground">
                    {report.gaps.reasoning}
                  </p>
                )}
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                  {report.gaps.missing_aspects.map((g, i) => (
                    <li key={i} className="break-words">
                      • {g}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {report.executed_queries.length > 0 && (
              <details className="rounded-md border border-border bg-card/40 p-2 text-xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  {report.executed_queries.length} executed queries
                </summary>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                  {report.executed_queries.map((q, i) => (
                    <li key={i} className="break-words">
                      • {q}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {manuscript && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-success text-xs">
              <CheckCircle2Icon className="size-3.5" />
              ScholarDoc manuscript ready ({manuscript.length.toLocaleString()}{" "}
              chars)
            </div>
            <Button onClick={handleSaveManuscript} size="sm" className="w-full">
              <FileTextIcon className="size-3.5" />
              Save as .tex &amp; open
            </Button>
            <details className="rounded-md border border-border bg-muted/40">
              <summary className="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-muted-foreground text-xs">
                <span className="font-medium">Preview LaTeX</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async (e) => {
                    e.preventDefault();
                    await navigator.clipboard.writeText(manuscript);
                    toast.success("Copied LaTeX");
                  }}
                >
                  <CopyIcon className="size-3.5" />
                  Copy LaTeX
                </Button>
              </summary>
              <pre className="max-h-[50vh] overflow-auto border-border border-t p-2.5 font-mono text-[11px] leading-relaxed">
                {manuscript}
              </pre>
            </details>
          </div>
        )}

        {!report && !manuscript && !error && !runtimeUnavailable && (
          <div className="flex flex-col items-center gap-1 px-3 py-8 text-center text-muted-foreground text-xs">
            <SparklesIcon className="size-5 opacity-50" />
            <span>
              {mode === "research"
                ? "Autonomous, evidence-grounded research."
                : "ScholarDoc: generate a structured LaTeX manuscript."}
            </span>
            <span className="opacity-70">
              Results render with full LaTeX math support.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-xs transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function StageList({
  stages,
  live = false,
}: {
  stages: StageEvent[];
  live?: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [live, stages.length]);
  return (
    <div className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
      {stages.map((s, i) => (
        <div
          key={i}
          className={cn(
            "flex items-start gap-1.5 text-[11px] leading-snug",
            s.degraded ? "text-warning" : "text-muted-foreground",
          )}
        >
          <span className="shrink-0 pt-px">{s.degraded ? "⚠" : "✓"}</span>
          <span className="min-w-0 break-words">
            <span className="text-foreground/70">[{s.stage}]</span> {s.message}
          </span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function ConfigField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-0.5">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-border bg-background px-1.5 py-1 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring"
      />
    </label>
  );
}

function HypothesisRow({ hypothesis }: { hypothesis: Hypothesis }) {
  const pct = Math.round(
    Math.max(0, Math.min(1, hypothesis.confidence_score)) * 100,
  );
  return (
    <li className="space-y-1">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 break-words text-foreground text-xs">
          {hypothesis.claim || "(untitled hypothesis)"}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {pct}%
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              pct >= 66
                ? "bg-success"
                : pct >= 33
                  ? "bg-warning"
                  : "bg-destructive",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        {hypothesis.status && (
          <span className="shrink-0 text-[9px] text-muted-foreground uppercase tracking-wide">
            {hypothesis.status}
          </span>
        )}
      </div>
    </li>
  );
}

function ReportMeta({ report }: { report: ResearchReport }) {
  const chips: { label: string; value: string; tone?: "ok" | "warn" }[] = [
    {
      label: "iterations",
      value: `${report.iterations}/${report.requested_iterations || report.iterations}`,
    },
    {
      label: "papers",
      value: String(report.papers_found),
      tone: report.papers_found > 0 ? "ok" : "warn",
    },
    {
      label: "synthesis",
      value: report.synthesis_mode || "—",
    },
    {
      label: report.converged ? "converged" : "stopped",
      value: report.stop_reason || "—",
      tone: report.converged ? "ok" : "warn",
    },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px]",
            c.tone === "ok"
              ? "bg-success/15 text-success"
              : c.tone === "warn"
                ? "bg-warning/15 text-warning"
                : "bg-muted text-muted-foreground",
          )}
          title={c.label}
        >
          {c.tone === "ok" ? (
            <CheckCircle2Icon className="mr-0.5 inline size-2.5" />
          ) : c.tone === "warn" ? (
            <AlertTriangleIcon className="mr-0.5 inline size-2.5" />
          ) : null}
          {c.label}: {c.value}
        </span>
      ))}
    </div>
  );
}
