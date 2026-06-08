import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  HistoryIcon,
  PlusIcon,
  CheckIcon,
  Loader2Icon,
  Trash2Icon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("session-selector");

interface ClaudeSessionInfo {
  session_id: string;
  title: string;
  last_modified: number;
}

function formatRelativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const delta = now - unixSeconds;

  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`;

  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function SessionSelector() {
  const [sessions, setSessions] = useState<ClaudeSessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClaudeSessionInfo | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const sessionId = useClaudeChatStore((s) => s.sessionId);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const newSession = useClaudeChatStore((s) => s.newSession);
  const resumeSession = useClaudeChatStore((s) => s.resumeSession);
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  const loadSessions = useCallback(async () => {
    if (!projectRoot) return;
    setIsLoading(true);
    log.debug(`loading sessions for projectRoot: ${projectRoot}`);
    try {
      const result = await invoke<ClaudeSessionInfo[]>("list_claude_sessions", {
        projectPath: projectRoot,
      });
      log.debug("loaded sessions", { count: result.length });
      setSessions(result);
    } catch (err) {
      log.error("Failed to load sessions", { error: String(err) });
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectRoot]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        loadSessions();
      }
    },
    [loadSessions],
  );

  const handleSelectSession = useCallback(
    (sid: string) => {
      if (isStreaming) return;
      if (sid === sessionId) return;
      log.debug(`selecting session: ${sid}`);
      resumeSession(sid);
    },
    [isStreaming, sessionId, resumeSession],
  );

  const handleDeleteSession = useCallback(
    async (sid: string) => {
      if (isStreaming || deletingId || !projectRoot) return;

      setDeleteError(null);
      setDeletingId(sid);
      try {
        await invoke("delete_claude_session", {
          projectPath: projectRoot,
          sessionId: sid,
        });
        setSessions((prev) => prev.filter((item) => item.session_id !== sid));
        if (sid === sessionId) {
          newSession();
        }
        setDeleteTarget((current) =>
          current?.session_id === sid ? null : current,
        );
      } catch (err) {
        log.error("Failed to delete session", {
          sessionId: sid,
          error: String(err),
        });
        setDeleteError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingId((current) => (current === sid ? null : current));
      }
    },
    [deletingId, isStreaming, newSession, projectRoot, sessionId],
  );

  const handleNewChat = useCallback(() => {
    if (isStreaming) return;
    newSession();
  }, [isStreaming, newSession]);

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Session history"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <HistoryIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          side="bottom"
          className="max-h-80 w-72 overflow-y-auto"
        >
          <DropdownMenuLabel>Sessions</DropdownMenuLabel>

          <DropdownMenuItem onSelect={handleNewChat} disabled={isStreaming}>
            <PlusIcon className="size-4" />
            <span>New Chat</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-4 text-center text-muted-foreground text-sm">
              No previous sessions
            </div>
          ) : (
            sessions.map((session) => (
              <DropdownMenuItem
                key={session.session_id}
                onSelect={() => handleSelectSession(session.session_id)}
                disabled={isStreaming || deletingId === session.session_id}
                className="group flex items-start gap-2"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{session.title}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatRelativeTime(session.last_modified)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {session.session_id === sessionId && (
                    <CheckIcon className="size-4 text-primary" />
                  )}
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Delete ${session.title}`}
                    title="Delete session"
                    disabled={isStreaming || deletingId === session.session_id}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDeleteError(null);
                      setDeleteTarget(session);
                    }}
                  >
                    {deletingId === session.session_id ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                  </button>
                </div>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deletingId) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Chat</DialogTitle>
            <DialogDescription>
              Delete "{deleteTarget?.title || "this session"}" from this
              project?
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (deletingId) return;
                setDeleteTarget(null);
                setDeleteError(null);
              }}
              disabled={!!deletingId}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  void handleDeleteSession(deleteTarget.session_id);
                }
              }}
              disabled={!deleteTarget || !!deletingId}
            >
              {deletingId ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
