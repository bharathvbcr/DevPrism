// Sidebar panel listing per-passage comments + suggestions.
//
// Handles cross-component custom events dispatched by the CodeMirror
// hover popover and click handler:
//   - comments:focus-in-panel  → scroll to comment, briefly highlight
//   - comments:edit-request    → enter inline edit mode for the comment
//   - comments:reply-request   → focus the reply textarea for the comment
//   - comments:resolve-request → status = "resolved"
//   - comments:reject-request  → status = "rejected"
//   - comments:reopen-request  → status = "open"
//   - comments:apply-request   → apply the proposed replacement (re-dispatches
//                                comments:apply-suggestion for the editor)

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquareIcon,
  LightbulbIcon,
  CheckIcon,
  TrashIcon,
  RefreshCwIcon,
  CornerDownRightIcon,
  ChevronRightIcon,
  PencilIcon,
  XIcon,
  SearchIcon,
  ArrowUpDownIcon,
  SparklesIcon,
  WandSparklesIcon,
  Loader2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { showWorkspaceError } from "@/stores/workspace-banner-store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { displayAgentAuthor, useChatLabels } from "@/lib/chat-labels";
import { useDocumentStore } from "@/stores/document-store";
import { useCommentsStore } from "@/stores/comments-store";
import { useSettingsStore } from "@/stores/settings-store";
import { canUseAiAssist, draftCommentReply } from "@/lib/ai-assist";
import { assessSuggestion } from "@/lib/ai-extras";
import {
  runInlineEdit,
  inlineEditSuccessMessage,
  type InlineEditSelection,
} from "@/lib/inline-edit";
import { readTexFileContent } from "@/lib/tauri/fs";
import type { Comment, CommentStatus, Reply } from "@/lib/tauri/comments";

export function CommentsHeader() {
  const openCount = useCommentsStore(
    (s) => s.comments.filter((c) => c.status === "open").length,
  );
  const refresh = useCommentsStore((s) => s.refresh);
  return (
    <div className="flex w-full items-center justify-between px-3 text-muted-foreground text-xs">
      <div className="flex items-center gap-1.5 uppercase tracking-wider">
        <MessageSquareIcon className="size-3" />
        <span>Comments</span>
        {openCount > 0 && (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
            {openCount}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => {
          refresh().catch(() => {});
        }}
        title="Refresh"
        aria-label="Refresh comments"
      >
        <RefreshCwIcon className="size-3" />
      </Button>
    </div>
  );
}

const STATUS_FILTERS: { id: CommentStatus | "all"; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
];

type SortKey = "position" | "recent" | "oldest";

export function CommentsPanel() {
  const comments = useCommentsStore((s) => s.comments);
  const [statusFilter, setStatusFilter] = useState<CommentStatus | "all">(
    "open",
  );
  const [currentFileOnly, setCurrentFileOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("position");

  const activeFilePath = useDocumentStore(
    (s) => s.files.find((f) => f.id === s.activeFileId)?.relativePath ?? null,
  );

  const filtered = useMemo(() => {
    let out = comments;
    if (statusFilter !== "all")
      out = out.filter((c) => c.status === statusFilter);
    if (currentFileOnly && activeFilePath)
      out = out.filter((c) => c.file_path === activeFilePath);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((c) => {
        if (c.comment.toLowerCase().includes(q)) return true;
        if (c.anchor.quoted_text.toLowerCase().includes(q)) return true;
        if (c.author.toLowerCase().includes(q)) return true;
        if (c.proposed_replacement?.toLowerCase().includes(q)) return true;
        if (c.replies.some((r) => r.body.toLowerCase().includes(q)))
          return true;
        return false;
      });
    }
    const sorted = [...out];
    if (sort === "position") {
      sorted.sort((a, b) => {
        if (a.file_path !== b.file_path)
          return a.file_path.localeCompare(b.file_path);
        return a.anchor.char_start - b.anchor.char_start;
      });
    } else if (sort === "recent") {
      sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    } else {
      sorted.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    }
    return sorted;
  }, [comments, statusFilter, currentFileOnly, activeFilePath, search, sort]);

  // Cross-component event: focus + scroll to a comment in the panel.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail;
      if (!detail?.id) return;
      setFocusedId(detail.id);
      const t = setTimeout(() => setFocusedId(null), 1800);
      return () => clearTimeout(t);
    };
    window.addEventListener(
      "comments:focus-in-panel",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "comments:focus-in-panel",
        handler as EventListener,
      );
  }, []);

  // Cross-component event: cursor sits inside a comment anchor → mark active.
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string | null }>).detail;
      setActiveId(detail?.id ?? null);
    };
    window.addEventListener("comments:active-set", handler as EventListener);
    return () =>
      window.removeEventListener(
        "comments:active-set",
        handler as EventListener,
      );
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-sidebar-border border-b px-2 py-1">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setStatusFilter(f.id)}
            aria-pressed={statusFilter === f.id}
            className={cn(
              "rounded px-1.5 py-0.5 font-medium text-xs uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              statusFilter === f.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50",
            )}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={() => setCurrentFileOnly((v) => !v)}
          title="Toggle filter: only comments on the current file"
          aria-pressed={currentFileOnly}
          className={cn(
            "ml-auto rounded px-1.5 py-0.5 font-medium text-xs uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            currentFileOnly
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/50",
          )}
        >
          this file
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-sidebar-border border-b px-2 py-1">
        <div className="relative flex-1">
          <SearchIcon className="absolute top-1.5 left-1.5 size-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search comments..."
            className="h-6 pl-6 text-[11px]"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute top-1.5 right-1.5 text-muted-foreground hover:text-foreground"
              title="Clear"
              aria-label="Clear search"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
        <button
          onClick={() =>
            setSort((s) =>
              s === "position"
                ? "recent"
                : s === "recent"
                  ? "oldest"
                  : "position",
            )
          }
          className="flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground text-xs uppercase tracking-wide hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          title={`Sort: ${sort} (click to cycle)`}
          aria-label={`Sort by ${sort}`}
        >
          <ArrowUpDownIcon className="size-2.5" />
          {sort === "position" ? "pos" : sort === "recent" ? "new" : "old"}
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-muted-foreground text-xs">
            No {statusFilter === "all" ? "" : statusFilter} comments
            {currentFileOnly ? " on this file" : ""}.
            <br />
            <span className="text-[10px]">
              Highlight text in the editor, click Comment or Suggest.
            </span>
          </div>
        ) : (
          <ul className="space-y-1.5 p-1.5">
            {filtered.map((c) => (
              <li key={c.id}>
                <CommentRow
                  comment={c}
                  isFocused={focusedId === c.id}
                  isActive={activeId === c.id}
                />
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

interface CommentRowProps {
  comment: Comment;
  isFocused: boolean;
  isActive: boolean;
}

function CommentRow({ comment, isFocused, isActive }: CommentRowProps) {
  const updateComment = useCommentsStore((s) => s.updateComment);
  const reply = useCommentsStore((s) => s.reply);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const files = useDocumentStore((s) => s.files);
  const activeFilePath = useDocumentStore(
    (s) => s.files.find((f) => f.id === s.activeFileId)?.relativePath ?? null,
  );

  const [expanded, setExpanded] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [editingComment, setEditingComment] = useState(false);
  const [commentDraft, setCommentDraft] = useState(comment.comment);
  const [suggestionDraft, setSuggestionDraft] = useState(
    comment.proposed_replacement ?? "",
  );
  const [editingReplyIdx, setEditingReplyIdx] = useState<number | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [draftingReply, setDraftingReply] = useState(false);
  const [addressing, setAddressing] = useState(false);
  // AI quality verdict for a human-authored suggestion, fetched lazily once per
  // comment id. null = not yet/unavailable; "" while pending is avoided.
  const [verdict, setVerdict] = useState<string | null>(null);

  const rowRef = useRef<HTMLDivElement>(null);
  const replyAreaRef = useRef<HTMLTextAreaElement>(null);
  const draftReqRef = useRef(0);
  const verdictReqRef = useRef(0);

  const isSuggestion = comment.type === "suggestion";
  const isOpen = comment.status === "open";

  // AI comment-assist gating (master toggle + provider availability via helper).
  const aiCommentAssist = useSettingsStore((s) => s.aiCommentAssist);
  const aiEnabled = aiCommentAssist && canUseAiAssist();

  // "Address with AI" needs a resolvable span on the commented passage.
  const hasResolvableRange =
    comment.anchor.char_end > comment.anchor.char_start;

  // Lazily assess a human-authored suggestion's quality before the user applies
  // it. Passive/background AI: fires once per comment (keyed by id + the two
  // inputs), is cancellation-safe via requestId, and fails silently.
  const original = comment.anchor.quoted_text;
  const replacement = comment.proposed_replacement ?? "";
  useEffect(() => {
    if (
      !aiEnabled ||
      !isSuggestion ||
      !isOpen ||
      !replacement.trim() ||
      !original.trim()
    ) {
      setVerdict(null);
      return;
    }
    const id = ++verdictReqRef.current;
    setVerdict(null);
    assessSuggestion({ original, replacement })
      .then((text) => {
        if (id !== verdictReqRef.current) return;
        const trimmed = text.trim();
        if (trimmed) setVerdict(trimmed);
      })
      .catch(() => {
        // Background assist degrades silently.
      });
    return () => {
      // Invalidate any in-flight request when inputs change/unmount.
      verdictReqRef.current++;
    };
    // comment.id is implied by the keyed inputs; re-run when gating flips too.
  }, [comment.id, aiEnabled, isSuggestion, isOpen, original, replacement]);

  // Reset draft when the underlying comment changes (e.g. external edit)
  useEffect(() => {
    if (!editingComment) {
      setCommentDraft(comment.comment);
      setSuggestionDraft(comment.proposed_replacement ?? "");
    }
  }, [comment.comment, comment.proposed_replacement, editingComment]);

  // Scroll into view + pulse when focused
  useEffect(() => {
    if (isFocused && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isFocused]);

  const isClaude = comment.author === "claude";
  const palette = (() => {
    if (comment.status === "resolved" || comment.status === "applied")
      return "border-l-emerald-500/60";
    if (comment.status === "rejected") return "border-l-zinc-500/40";
    if (comment.status === "orphaned") return "border-l-pink-500/60";
    if (isSuggestion)
      return isClaude ? "border-l-indigo-500/70" : "border-l-sky-500/70";
    return isClaude ? "border-l-violet-500/70" : "border-l-amber-500/70";
  })();

  const switchToCommentFile = (): boolean => {
    if (comment.file_path === activeFilePath) return true;
    const target = files.find((f) => f.relativePath === comment.file_path);
    if (!target) return false;
    setActiveFile(target.id);
    return true;
  };

  const focusInEditor = () => {
    if (!switchToCommentFile()) return;
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("comments:jump", {
          detail: {
            from: comment.anchor.char_start,
            to: comment.anchor.char_end,
          },
        }),
      );
    }, 60);
  };

  const applySuggestion = () => {
    if (!isSuggestion || !comment.proposed_replacement) return;
    if (!switchToCommentFile()) return;
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("comments:apply-suggestion", {
          detail: {
            from: comment.anchor.char_start,
            to: comment.anchor.char_end,
            replacement: comment.proposed_replacement,
          },
        }),
      );
      updateComment(comment.id, { status: "applied" }).catch(() => {});
    }, 60);
  };

  const startEdit = () => {
    setEditingComment(true);
    setExpanded(true);
  };

  const saveEdit = async () => {
    const patch: Parameters<typeof updateComment>[1] = {
      comment: commentDraft.trim(),
    };
    if (isSuggestion) {
      patch.proposed_replacement = suggestionDraft;
    }
    try {
      await updateComment(comment.id, patch);
    } finally {
      setEditingComment(false);
    }
  };

  const cancelEdit = () => {
    setCommentDraft(comment.comment);
    setSuggestionDraft(comment.proposed_replacement ?? "");
    setEditingComment(false);
  };

  const handleReplySubmit = () => {
    const body = replyText.trim();
    if (!body) return;
    reply(comment.id, body).catch(() => {});
    setReplyText("");
  };

  const handleReplyAndResolve = async () => {
    const body = replyText.trim();
    if (!body) return;
    try {
      await reply(comment.id, body);
      await updateComment(comment.id, { status: "resolved" });
    } finally {
      setReplyText("");
    }
  };

  // Draft a reply via AI and fill the reply textarea. User-triggered → toast on
  // error. Cancellation-safe: stale requests are ignored via requestId guard.
  const handleDraftReply = async () => {
    if (!aiEnabled || draftingReply) return;
    const id = ++draftReqRef.current;
    setDraftingReply(true);
    try {
      const draft = await draftCommentReply({
        commentText: comment.comment,
        quotedText: comment.anchor.quoted_text || undefined,
      });
      if (id !== draftReqRef.current) return;
      const text = draft.trim();
      if (text) {
        setReplyText(text);
        setExpanded(true);
        setTimeout(() => replyAreaRef.current?.focus(), 50);
      }
    } catch (err) {
      if (id !== draftReqRef.current) return;
      showWorkspaceError(
        "Reply draft failed",
        err instanceof Error ? err.message : "Could not draft a reply.",
        { dedupeKey: "comment-reply-draft" },
      );
    } finally {
      if (id === draftReqRef.current) setDraftingReply(false);
    }
  };

  // Rewrite the commented span to address the feedback via the proposed-changes
  // flow. Builds an InlineEditSelection from the comment's file + range + the
  // current file content (loaded on demand, mirroring the document store).
  const handleAddressWithAi = async () => {
    if (!aiEnabled || addressing || !hasResolvableRange) return;
    const instruction = comment.comment.trim();
    if (!instruction) return;
    const target = files.find((f) => f.relativePath === comment.file_path);
    if (!target) {
      showWorkspaceError(
        "Comment not found",
        "The commented file is not open in this project.",
        { dedupeKey: "comment-missing-file" },
      );
      return;
    }
    setAddressing(true);
    try {
      const content =
        target.content ?? (await readTexFileContent(target.absolutePath));
      const from = comment.anchor.char_start;
      const to = comment.anchor.char_end;
      const selectedText = content.slice(from, to);
      if (!selectedText.trim()) {
        showWorkspaceError(
          "Comment anchor missing",
          "The commented passage could not be located in the file.",
          { dedupeKey: "comment-missing-anchor" },
        );
        return;
      }
      const selection: InlineEditSelection = {
        filePath: target.relativePath,
        absolutePath: target.absolutePath,
        content,
        from,
        to,
        selectedText,
        contextLabel: `@${target.relativePath}`,
      };
      const mode = await runInlineEdit({
        action: "edit",
        selection,
        customInstruction: instruction,
      });
      if (mode === "applied") {
        toast.success(inlineEditSuccessMessage("edit"));
      }
    } catch (err) {
      showWorkspaceError(
        "Could not address comment",
        err instanceof Error
          ? err.message
          : "The AI edit could not be applied.",
        { dedupeKey: "comment-address-ai" },
      );
    } finally {
      setAddressing(false);
    }
  };

  const startReplyEdit = (idx: number, r: Reply) => {
    setEditingReplyIdx(idx);
    setReplyDraft(r.body);
  };

  const saveReplyEdit = async () => {
    if (editingReplyIdx === null) return;
    const idx = editingReplyIdx;
    const trimmed = replyDraft.trim();
    if (!trimmed) {
      setEditingReplyIdx(null);
      return;
    }
    const nextReplies = comment.replies.map((r, i) =>
      i === idx ? { ...r, body: trimmed } : r,
    );
    try {
      await updateComment(comment.id, {
        replies: nextReplies,
      } as Parameters<typeof updateComment>[1]);
    } finally {
      setEditingReplyIdx(null);
    }
  };

  // === Listen for cross-component action requests targeting this comment ===
  useEffect(() => {
    const matchesMe = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      return id === comment.id;
    };

    const onEdit = (e: Event) => {
      if (!matchesMe(e)) return;
      startEdit();
    };
    const onReplyReq = (e: Event) => {
      if (!matchesMe(e)) return;
      setExpanded(true);
      setTimeout(() => replyAreaRef.current?.focus(), 50);
    };
    const onResolve = (e: Event) => {
      if (!matchesMe(e)) return;
      updateComment(comment.id, { status: "resolved" }).catch(() => {});
    };
    const onReject = (e: Event) => {
      if (!matchesMe(e)) return;
      updateComment(comment.id, { status: "rejected" }).catch(() => {});
    };
    const onReopen = (e: Event) => {
      if (!matchesMe(e)) return;
      updateComment(comment.id, { status: "open" }).catch(() => {});
    };
    const onApply = (e: Event) => {
      if (!matchesMe(e)) return;
      applySuggestion();
    };

    window.addEventListener("comments:edit-request", onEdit as EventListener);
    window.addEventListener(
      "comments:reply-request",
      onReplyReq as EventListener,
    );
    window.addEventListener(
      "comments:resolve-request",
      onResolve as EventListener,
    );
    window.addEventListener(
      "comments:reject-request",
      onReject as EventListener,
    );
    window.addEventListener(
      "comments:reopen-request",
      onReopen as EventListener,
    );
    window.addEventListener("comments:apply-request", onApply as EventListener);
    return () => {
      window.removeEventListener(
        "comments:edit-request",
        onEdit as EventListener,
      );
      window.removeEventListener(
        "comments:reply-request",
        onReplyReq as EventListener,
      );
      window.removeEventListener(
        "comments:resolve-request",
        onResolve as EventListener,
      );
      window.removeEventListener(
        "comments:reject-request",
        onReject as EventListener,
      );
      window.removeEventListener(
        "comments:reopen-request",
        onReopen as EventListener,
      );
      window.removeEventListener(
        "comments:apply-request",
        onApply as EventListener,
      );
    };
    // applySuggestion captures isSuggestion + replacement from `comment` closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comment.id, comment.proposed_replacement, comment.replies]);

  return (
    <div
      ref={rowRef}
      className={cn(
        "rounded border-l-2 bg-sidebar-accent/30 px-2 py-1.5 text-xs transition-all",
        palette,
        isActive && !isFocused && "bg-sidebar-accent/70",
        isFocused &&
          "bg-amber-50/30 ring-2 ring-amber-400/70 dark:bg-amber-900/15",
      )}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 text-left"
        title={expanded ? "Collapse" : "Expand"}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
        {isSuggestion ? (
          <LightbulbIcon
            className={cn(
              "size-3 shrink-0",
              isClaude ? "text-indigo-500" : "text-sky-500",
            )}
          />
        ) : (
          <MessageSquareIcon
            className={cn(
              "size-3 shrink-0",
              isClaude ? "text-violet-500" : "text-amber-500",
            )}
          />
        )}
        <AuthorChip author={comment.author} />
        <span className="truncate font-medium">
          <AgentAuthorName author={comment.author} />
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {timeAgo(comment.updated_at)}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 space-y-1.5">
          <button
            onClick={focusInEditor}
            className="block w-full truncate text-left text-[10px] text-muted-foreground italic hover:underline"
            title="Jump to passage"
          >
            "{comment.anchor.quoted_text.slice(0, 80)}
            {comment.anchor.quoted_text.length > 80 ? "..." : ""}"
          </button>

          {editingComment ? (
            <div className="space-y-1">
              <Textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                className="min-h-[60px] text-[11px]"
                autoFocus
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    saveEdit();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              />
              {isSuggestion && (
                <Textarea
                  value={suggestionDraft}
                  onChange={(e) => setSuggestionDraft(e.target.value)}
                  className="min-h-[60px] font-mono text-[10px]"
                  placeholder="Proposed replacement"
                />
              )}
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 px-2 text-[10px]"
                  onClick={saveEdit}
                  disabled={!commentDraft.trim()}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={cancelEdit}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              {comment.comment && (
                <div className="whitespace-pre-wrap break-words">
                  {comment.comment}
                </div>
              )}

              {isSuggestion && comment.proposed_replacement && (
                <div className="rounded border border-sky-500/30 bg-sky-500/5 p-1.5">
                  <div className="mb-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                    proposed
                  </div>
                  <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
                    {comment.proposed_replacement}
                  </div>
                </div>
              )}
            </>
          )}

          {comment.replies.length > 0 && (
            <ul className="space-y-1 border-sidebar-border border-l pl-2">
              {comment.replies.map((r, i) => (
                <li key={i} className="group">
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <CornerDownRightIcon className="size-2.5" />
                    <AuthorChip author={r.author} small />
                    <span className="font-medium">
                      <AgentAuthorName author={r.author} />
                    </span>
                    <span>·</span>
                    <span>{timeAgo(r.ts)}</span>
                    {editingReplyIdx !== i && (
                      <button
                        onClick={() => startReplyEdit(i, r)}
                        className="ml-auto p-1 opacity-60 transition-opacity group-hover:opacity-100"
                        title="Edit reply"
                        aria-label="Edit reply"
                      >
                        <PencilIcon className="size-2.5" />
                      </button>
                    )}
                  </div>
                  {editingReplyIdx === i ? (
                    <div className="space-y-1 pl-3">
                      <Textarea
                        value={replyDraft}
                        onChange={(e) => setReplyDraft(e.target.value)}
                        className="min-h-[40px] text-[11px]"
                        autoFocus
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            saveReplyEdit();
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingReplyIdx(null);
                          }
                        }}
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-5 px-1.5 text-[10px]"
                          onClick={saveReplyEdit}
                          disabled={!replyDraft.trim()}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1.5 text-[10px]"
                          onClick={() => setEditingReplyIdx(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words pl-3">
                      {r.body}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isOpen && !editingComment && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              {isSuggestion && comment.proposed_replacement && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={applySuggestion}
                  title="Apply the proposed replacement"
                >
                  <CheckIcon className="mr-1 size-3" />
                  Apply
                </Button>
              )}
              {isSuggestion && comment.proposed_replacement && verdict && (
                <span
                  className="inline-flex w-full items-start gap-1 text-[10px] text-muted-foreground italic"
                  title="AI assessment of this suggestion"
                >
                  <SparklesIcon className="mt-px size-2.5 shrink-0" />
                  <span className="not-italic">{verdict}</span>
                </span>
              )}
              {aiEnabled && hasResolvableRange && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={handleAddressWithAi}
                  disabled={addressing}
                  title="Rewrite the commented passage to address this feedback"
                >
                  {addressing ? (
                    <Loader2Icon className="mr-1 size-3 animate-spin" />
                  ) : (
                    <WandSparklesIcon className="mr-1 size-3" />
                  )}
                  Address with AI
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px]"
                onClick={startEdit}
                title="Edit comment text"
              >
                <PencilIcon className="mr-1 size-3" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px]"
                onClick={() =>
                  updateComment(comment.id, { status: "resolved" }).catch(
                    () => {},
                  )
                }
                title="Mark as resolved"
              >
                Resolve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px]"
                onClick={() =>
                  updateComment(comment.id, { status: "rejected" }).catch(
                    () => {},
                  )
                }
                title="Reject and hide"
                aria-label="Reject comment"
              >
                <TrashIcon className="size-3" />
              </Button>
            </div>
          )}
          {!isOpen && !editingComment && (
            <div className="flex items-center gap-1 pt-0.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px]"
                onClick={() =>
                  updateComment(comment.id, { status: "open" }).catch(() => {})
                }
              >
                Reopen
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[10px]"
                onClick={startEdit}
              >
                <PencilIcon className="mr-1 size-3" />
                Edit
              </Button>
            </div>
          )}

          {isOpen && !editingComment && (
            <div className="space-y-1 pt-1">
              <Textarea
                ref={replyAreaRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Reply..."
                className="min-h-[28px] resize-none px-1.5 py-1 text-[11px]"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    if (e.shiftKey) {
                      handleReplyAndResolve();
                    } else {
                      handleReplySubmit();
                    }
                  }
                }}
              />
              {!replyText.trim() && (
                <p className="text-[10px] text-muted-foreground">
                  ⌘↵ to reply · ⌘⇧↵ to reply &amp; resolve
                </p>
              )}
              <div className="flex items-center gap-1">
                {replyText.trim() && (
                  <>
                    <Button
                      size="sm"
                      variant="default"
                      className="h-6 px-2 text-[10px]"
                      onClick={handleReplySubmit}
                      title="Reply (Cmd+Enter)"
                    >
                      Reply
                      <span className="ml-1 opacity-60">⌘↵</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={handleReplyAndResolve}
                      title="Reply and mark resolved (Cmd+Shift+Enter)"
                    >
                      Reply &amp; Resolve
                    </Button>
                  </>
                )}
                {aiEnabled && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-1.5 text-[10px] text-muted-foreground"
                    onClick={handleDraftReply}
                    disabled={draftingReply}
                    title="Draft a reply with AI"
                  >
                    {draftingReply ? (
                      <Loader2Icon className="mr-1 size-3 animate-spin" />
                    ) : (
                      <SparklesIcon className="mr-1 size-3" />
                    )}
                    Draft reply
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentAuthorName({ author }: { author: string }) {
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  return displayAgentAuthor(author, nativeAgentEnabled);
}

function AuthorChip({
  author,
  small = false,
}: {
  author: string;
  small?: boolean;
}) {
  const chatLabels = useChatLabels();
  const nativeAgentEnabled = useSettingsStore((s) => s.nativeAgentEnabled);
  const isAgent = author === "claude";
  const initial = isAgent
    ? chatLabels.agentAuthorInitial
    : (author.charAt(0) || "?").toUpperCase();
  const displayName = displayAgentAuthor(author, nativeAgentEnabled);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white",
        small ? "size-3 text-[7px]" : "size-3.5 text-[8px]",
        isAgent ? "bg-violet-600" : "bg-amber-600",
      )}
      title={displayName}
    >
      {initial}
    </span>
  );
}

function timeAgo(iso: string): string {
  try {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const delta = Date.now() - then;
    const s = Math.floor(delta / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  } catch {
    return "";
  }
}
