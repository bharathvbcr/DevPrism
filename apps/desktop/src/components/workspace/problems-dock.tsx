import React, { useState, useMemo, useEffect } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
  SearchIcon,
  XIcon,
  ChevronDownIcon,
  SparklesIcon,
  FileCodeIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDocumentStore } from "@/stores/document-store";
import { useEditorTabsStore } from "@/stores/editor-tabs-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  getAllTypstDiagnostics,
  typstDiagnosticsRegistry,
  type TypstDiagnostic,
} from "@/lib/typst-diagnostics";

export const PROBLEMS_DOCK_MIN_HEIGHT = 60;
export const PROBLEMS_DOCK_MAX_HEIGHT = 500;
export const PROBLEMS_DOCK_DEFAULT_HEIGHT = 180;

export function clampProblemsDockHeight(height: number): number {
  return Math.min(
    Math.max(height, PROBLEMS_DOCK_MIN_HEIGHT),
    PROBLEMS_DOCK_MAX_HEIGHT,
  );
}

export function renderProblemsCount(list: unknown[]): string {
  if (list.length === 0) return "No problems detected in workspace.";
  return `${list.length} problems`;
}

export interface WorkspaceDiagnostic {
  id?: string | number;
  file: string;
  line: number;
  column?: number;
  message: string;
  severity: "error" | "warning" | "info";
  source?: "typst" | "latex" | "linter";
}

interface ProblemsDockProps {
  isOpen: boolean;
  onToggle: () => void;
  height?: number;
  onHeightChange?: (h: number) => void;
  className?: string;
}

export const ProblemsDock: React.FC<ProblemsDockProps> = ({
  isOpen,
  onToggle,
  height = PROBLEMS_DOCK_DEFAULT_HEIGHT,
  onHeightChange: _onHeightChange,
  className,
}) => {
  const [filter, setFilter] = useState<"all" | "error" | "warning">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 100;

  const [typstDiags, setTypstDiags] = useState<TypstDiagnostic[]>([]);
  const compileError = useDocumentStore((s) => s.compileError);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);

  useEffect(() => {
    setTypstDiags(getAllTypstDiagnostics());
    return typstDiagnosticsRegistry.subscribe(() => {
      setTypstDiags(getAllTypstDiagnostics());
    });
  }, []);

  useEffect(() => {
    setPage(1);
  }, [filter, search]);

  const allDiagnostics = useMemo<WorkspaceDiagnostic[]>(() => {
    const list: WorkspaceDiagnostic[] = [];

    // Typst compiler diagnostics
    typstDiags.forEach((d, idx) => {
      list.push({
        id: `typst_${idx}_${d.file}_${d.line}`,
        file: d.file || activeFileId || "document.typ",
        line: d.line ?? 1,
        column: d.column ?? 1,
        message:
          d.message + (d.hints?.length ? ` (${d.hints.join("; ")})` : ""),
        severity: d.severity,
        source: "typst",
      });
    });

    // LaTeX / general compile error
    if (compileError && list.length === 0) {
      list.push({
        id: "compile_err",
        file: activeFileId || "main.tex",
        line: 1,
        column: 1,
        message: compileError,
        severity: "error",
        source: "latex",
      });
    }

    return list;
  }, [typstDiags, compileError, activeFileId]);

  const filteredDiagnostics = useMemo(() => {
    return allDiagnostics.filter((d) => {
      if (filter !== "all" && d.severity !== filter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          d.message.toLowerCase().includes(q) ||
          d.file.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [allDiagnostics, filter, search]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredDiagnostics.length / pageSize),
  );
  const currentPage = Math.min(page, totalPages);
  const pagedDiagnostics = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredDiagnostics.slice(start, start + pageSize);
  }, [filteredDiagnostics, currentPage, pageSize]);

  const errorCount = allDiagnostics.filter(
    (d) => d.severity === "error",
  ).length;
  const warningCount = allDiagnostics.filter(
    (d) => d.severity === "warning",
  ).length;

  const handleRowClick = (diag: WorkspaceDiagnostic) => {
    // 1. Open tab & activate file
    const docFile = files.find(
      (f) => f.relativePath === diag.file || f.id === diag.file,
    );
    const targetPath = docFile ? docFile.relativePath : diag.file;
    const targetId = docFile ? docFile.id : diag.file;

    useEditorTabsStore.getState().openTab({ path: targetPath });
    useDocumentStore.getState().setActiveFile(targetId);

    // 2. Approximate position jump based on line
    if (docFile?.content) {
      const lines = docFile.content.split("\n");
      let offset = 0;
      for (let i = 0; i < Math.min(diag.line - 1, lines.length); i++) {
        offset += lines[i].length + 1;
      }
      offset += Math.max(0, (diag.column ?? 1) - 1);
      useDocumentStore.getState().requestJumpToPosition(offset);
    }
  };

  const handleFixWithAI = () => {
    if (filteredDiagnostics.length === 0) return;
    const summary = filteredDiagnostics
      .slice(0, 5)
      .map((d) => `[${d.file}:${d.line}] ${d.message}`)
      .join("\n");
    useClaudeChatStore
      .getState()
      .sendPrompt(
        `Please fix the following problems in the workspace:\n\n${summary}`,
      );
  };

  if (!isOpen) return null;

  return (
    <div
      role="region"
      aria-label="Problems Dock"
      data-testid="problems-dock"
      style={{ height: `${clampProblemsDockHeight(height)}px` }}
      className={cn(
        "relative flex w-full shrink-0 select-none flex-col overflow-hidden border-border border-t bg-background transition-all",
        className,
      )}
    >
      {/* Dock Header */}
      <div className="flex h-8 shrink-0 items-center justify-between border-border border-b bg-muted/40 px-3 text-xs">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <AlertCircleIcon className="size-3.5 text-red-500" />
            <span>Problems</span>
            <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground">
              {allDiagnostics.length}
            </span>
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                filter === "all"
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setFilter("error")}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                filter === "error"
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="size-1.5 rounded-full bg-red-500" />
              Errors ({errorCount})
            </button>
            <button
              type="button"
              onClick={() => setFilter("warning")}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                filter === "warning"
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="size-1.5 rounded-full bg-amber-500" />
              Warnings ({warningCount})
            </button>
          </div>
        </div>

        {/* Search & Actions */}
        <div className="flex items-center gap-2">
          <div className="relative flex items-center">
            <SearchIcon className="pointer-events-none absolute left-2 size-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter problems..."
              className="h-6 w-36 bg-background/80 pl-6 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>

          {allDiagnostics.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleFixWithAI}
              className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              title="Fix problems with AI assistant"
            >
              <SparklesIcon className="size-3 text-amber-500" />
              <span>Fix with AI</span>
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className="size-6 p-0 text-muted-foreground hover:text-foreground"
            title="Close Problems Dock"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Dock Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {filteredDiagnostics.length === 0 ? (
          <div className="flex h-full min-h-[50px] items-center justify-center p-4 text-muted-foreground text-xs">
            No problems detected in workspace.
          </div>
        ) : (
          <div className="divide-y divide-border/40 font-mono text-xs">
            {pagedDiagnostics.map((diag, idx) => (
              <div
                key={diag.id ?? idx}
                onClick={() => handleRowClick(diag)}
                className="flex cursor-pointer items-start gap-2.5 px-3 py-1.5 transition-colors hover:bg-muted/50"
              >
                <div className="mt-0.5 shrink-0">
                  {diag.severity === "error" ? (
                    <AlertCircleIcon className="size-3.5 text-red-500" />
                  ) : diag.severity === "warning" ? (
                    <AlertTriangleIcon className="size-3.5 text-amber-500" />
                  ) : (
                    <InfoIcon className="size-3.5 text-blue-500" />
                  )}
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span
                    className="truncate text-foreground"
                    title={diag.message}
                  >
                    {diag.message}
                  </span>
                  <div className="flex shrink-0 items-center gap-1 font-sans text-[11px] text-muted-foreground">
                    <FileCodeIcon className="size-3" />
                    <span>{diag.file}</span>
                    <span>
                      [{diag.line}:{diag.column ?? 1}]
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bounded Pagination if > 100 items */}
      {totalPages > 1 && (
        <div className="flex h-7 shrink-0 items-center justify-between border-border border-t bg-muted/20 px-3 text-[11px] text-muted-foreground">
          <span>
            Showing {(currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, filteredDiagnostics.length)} of{" "}
            {filteredDiagnostics.length}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-5 px-1.5 text-[11px]"
            >
              Previous
            </Button>
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="h-5 px-1.5 text-[11px]"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
