import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BugIcon, CopyIcon, TrashIcon, CheckIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useLogStore, type LogLevel } from "@/lib/debug/log-store";
import { generateBugReport } from "@/lib/debug/bug-report";

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-blue-500",
  warn: "text-yellow-500",
  error: "text-red-500",
};

interface SystemInfo {
  os: string;
  os_version: string;
  arch: string;
  app_version: string;
}

type Tab = "logs" | "system" | "visibility";

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("logs");
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [search, setSearch] = useState("");
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [visibilityCount, setVisibilityCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const entries = useLogStore((s) => s.entries);
  const clearLogs = useLogStore((s) => s.clear);

  // Toggle via keyboard shortcut
  useEffect(() => {
    const handleToggle = () => setOpen((v) => !v);
    window.addEventListener("toggle-debug-panel", handleToggle);
    return () => window.removeEventListener("toggle-debug-panel", handleToggle);
  }, []);

  // Track visibility restore events
  useEffect(() => {
    const handler = () => setVisibilityCount((c) => c + 1);
    window.addEventListener("app-visibility-restored", handler);
    return () => window.removeEventListener("app-visibility-restored", handler);
  }, []);

  // Fetch system info when panel opens
  useEffect(() => {
    if (open && !systemInfo) {
      invoke<SystemInfo>("get_system_info").then(setSystemInfo).catch(() => {});
    }
  }, [open, systemInfo]);

  // Auto-scroll logs
  useEffect(() => {
    if (tab === "logs") {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length, tab]);

  // Filter logs
  const filteredEntries = entries.filter((e) => {
    if (levelFilter !== "all" && e.level !== levelFilter) return false;
    if (sourceFilter && e.source !== sourceFilter) return false;
    if (search) {
      const haystack = `${e.source} ${e.message}`.toLowerCase();
      if (!haystack.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  // Unique sources for filter dropdown
  const sources = [...new Set(entries.map((e) => e.source))].sort();

  const handleCopyReport = useCallback(async () => {
    const report = await generateBugReport();
    await navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[480px] flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BugIcon className="size-4" />
            Debug Panel
          </SheetTitle>
          <SheetDescription>
            Diagnostics and logging for troubleshooting
          </SheetDescription>
        </SheetHeader>

        {/* Tab bar */}
        <div className="flex gap-1 border-b px-4">
          {(["logs", "system", "visibility"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium capitalize border-b-2 transition-colors ${
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-hidden px-4">
          {tab === "logs" && (
            <div className="flex h-full flex-col gap-2">
              {/* Filters */}
              <div className="flex gap-2">
                <select
                  value={levelFilter}
                  onChange={(e) => setLevelFilter(e.target.value as LogLevel | "all")}
                  className="rounded border bg-background px-2 py-1 text-xs"
                >
                  <option value="all">All levels</option>
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </select>
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="rounded border bg-background px-2 py-1 text-xs"
                >
                  <option value="">All sources</option>
                  {sources.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Search..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 rounded border bg-background px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={clearLogs}
                  title="Clear logs"
                  className="rounded border p-1 text-muted-foreground hover:text-foreground"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>

              {/* Log entries */}
              <div className="flex-1 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]">
                {filteredEntries.length === 0 && (
                  <p className="text-muted-foreground text-center py-4">No log entries</p>
                )}
                {filteredEntries.map((entry, i) => (
                  <div key={i} className="flex gap-2 py-0.5 hover:bg-muted/50">
                    <span className="text-muted-foreground shrink-0">{formatTime(entry.timestamp)}</span>
                    <span className={`shrink-0 w-10 uppercase font-semibold ${LEVEL_COLORS[entry.level]}`}>
                      {entry.level}
                    </span>
                    <span className="text-muted-foreground shrink-0">[{entry.source}]</span>
                    <span className="text-foreground break-all">{entry.message}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>

              <p className="text-[10px] text-muted-foreground">
                {entries.length} entries ({filteredEntries.length} shown)
              </p>
            </div>
          )}

          {tab === "system" && (
            <div className="space-y-3 py-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">System Information</h3>
              {systemInfo ? (
                <div className="space-y-1 text-sm">
                  <Row label="OS" value={systemInfo.os} />
                  <Row label="OS Version" value={systemInfo.os_version} />
                  <Row label="Architecture" value={systemInfo.arch} />
                  <Row label="App Version" value={systemInfo.app_version} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Loading...</p>
              )}

              <h3 className="text-xs font-semibold uppercase text-muted-foreground pt-4">Browser / WebView</h3>
              <div className="space-y-1 text-sm">
                <Row label="User Agent" value={navigator.userAgent} />
                <Row label="Device Pixel Ratio" value={String(window.devicePixelRatio)} />
                <Row label="GPU Renderer" value={getGpuRenderer()} />
              </div>
            </div>
          )}

          {tab === "visibility" && (
            <div className="space-y-3 py-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Visibility State</h3>
              <div className="space-y-1 text-sm">
                <Row
                  label="Current State"
                  value={document.visibilityState}
                  valueClass={document.visibilityState === "visible" ? "text-green-500" : "text-yellow-500"}
                />
                <Row label="Window Focused" value={document.hasFocus() ? "Yes" : "No"} />
                <Row label="Restore Events" value={String(visibilityCount)} />
              </div>

              <h3 className="text-xs font-semibold uppercase text-muted-foreground pt-4">Recent Visibility Logs</h3>
              <div className="overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px] max-h-48">
                {entries
                  .filter((e) => e.source === "app" && e.message.includes("Visibility"))
                  .slice(-10)
                  .map((entry, i) => (
                    <div key={i} className="py-0.5">
                      <span className="text-muted-foreground">{formatTime(entry.timestamp)}</span>{" "}
                      <span>{entry.message}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-4 py-3">
          <button
            type="button"
            onClick={handleCopyReport}
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {copied ? "Copied!" : "Copy Bug Report"}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0 w-32">{label}:</span>
      <span className={`break-all ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}

function getGpuRenderer(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (gl && gl instanceof WebGLRenderingContext) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) {
        return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
      }
    }
  } catch {
    // ignore
  }
  return "Unknown";
}
