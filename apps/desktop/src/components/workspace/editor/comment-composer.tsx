// Modal composer for adding a new comment or suggestion.
// Opened from the SelectionToolbar after the user picks "Comment" or "Suggest".

import { useEffect, useRef, useState } from "react";
import { SparklesIcon, Loader2Icon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { canUseAiAssist, draftCommentSuggestion } from "@/lib/ai-assist";
import { useChatLabels } from "@/lib/chat-labels";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "sonner";
import { showWorkspaceError } from "@/stores/workspace-banner-store";

export interface CommentComposerProps {
  open: boolean;
  mode: "comment" | "suggestion";
  quotedText: string;
  initialReplacement?: string; // pre-fill for suggestion (typically the original)
  onCancel: () => void;
  onSubmit: (data: { comment: string; replacement: string | null }) => void;
}

export function CommentComposer({
  open,
  mode,
  quotedText,
  initialReplacement,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const aiCommentAssist = useSettingsStore((s) => s.aiCommentAssist);
  const chatLabels = useChatLabels();
  const [comment, setComment] = useState("");
  const [replacement, setReplacement] = useState(initialReplacement ?? "");
  const [aiDrafting, setAiDrafting] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  // Tracks whether the user has edited either field; once touched, auto-draft
  // must not overwrite their input.
  const touchedRef = useRef(false);
  // Guards against a stale auto-draft response landing after a re-open.
  const autoDraftIdRef = useRef(0);

  useEffect(() => {
    if (open) {
      setComment("");
      setReplacement(initialReplacement ?? quotedText);
      touchedRef.current = false;
      // Focus the textarea after the dialog has animated in
      const t = setTimeout(() => commentRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [open, initialReplacement, quotedText]);

  // In suggestion mode, auto-draft an AI-improved replacement when the composer
  // opens. Passive/background: fail silently and keep the verbatim prefill.
  // Only applies while the user hasn't touched the fields.
  useEffect(() => {
    if (!open || mode !== "suggestion") return;
    if (!aiCommentAssist || !canUseAiAssist() || !quotedText.trim()) return;

    const id = ++autoDraftIdRef.current;
    setAiDrafting(true);
    void draftCommentSuggestion({ mode: "suggestion", quotedText })
      .then((draft) => {
        if (id !== autoDraftIdRef.current || touchedRef.current) return;
        if (draft.replacement) setReplacement(draft.replacement);
        if (draft.comment) setComment(draft.comment);
      })
      .catch(() => {
        // Silent degrade: keep the verbatim prefill.
      })
      .finally(() => {
        if (id === autoDraftIdRef.current) setAiDrafting(false);
      });
    // quotedText/initialReplacement are reset via the prior effect keyed on the
    // same deps; re-running here when they change is intentional.
  }, [open, mode, aiCommentAssist, quotedText]);

  const trimmedComment = comment.trim();
  const canSubmit =
    mode === "comment"
      ? trimmedComment.length > 0
      : trimmedComment.length > 0 || replacement.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      comment: trimmedComment,
      replacement: mode === "suggestion" ? replacement : null,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter = submit
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Any field edit marks the composer touched and supersedes a pending
  // auto-draft so it can't clobber the user's input.
  const markTouched = () => {
    touchedRef.current = true;
    autoDraftIdRef.current++;
  };

  const handleAiDraft = async () => {
    if (!aiCommentAssist || !canUseAiAssist() || !quotedText.trim()) return;
    // Explicit user action also supersedes any in-flight auto-draft.
    autoDraftIdRef.current++;
    setAiDrafting(true);
    try {
      const draft = await draftCommentSuggestion({ mode, quotedText });
      setComment(draft.comment);
      if (mode === "suggestion" && draft.replacement) {
        setReplacement(draft.replacement);
      }
    } catch (err) {
      showWorkspaceError(
        "AI draft failed",
        err instanceof Error ? err.message : "Could not draft the comment.",
        { dedupeKey: "comment-ai-draft" },
      );
    } finally {
      setAiDrafting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-lg" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>
            {mode === "comment" ? "Add comment" : "Suggest change"}
          </DialogTitle>
          <DialogDescription>
            Anchored to the selected passage. Visible to{" "}
            {chatLabels.commentForAgent} via{" "}
            <code className="rounded bg-muted px-1 text-xs">
              .claudeprism/comments.json
            </code>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <div className="mb-1 text-muted-foreground text-xs">
              Selected text
            </div>
            <div className="max-h-32 overflow-y-auto rounded border border-border bg-muted/40 p-2 font-mono text-xs leading-snug">
              {quotedText.length > 280
                ? `${quotedText.slice(0, 280)}…`
                : quotedText}
            </div>
          </div>

          <div>
            <label
              htmlFor="comment-composer-text"
              className="mb-1 block text-xs"
            >
              {mode === "comment" ? "Comment" : "Why change this"}
            </label>
            <Textarea
              id="comment-composer-text"
              ref={commentRef}
              value={comment}
              onChange={(e) => {
                markTouched();
                setComment(e.target.value);
              }}
              placeholder={
                mode === "comment"
                  ? chatLabels.commentPlaceholder
                  : "Reason for the suggestion (optional if you provide a replacement)…"
              }
              className="min-h-[80px]"
            />
          </div>

          {mode === "suggestion" && (
            <div>
              <label
                htmlFor="comment-composer-repl"
                className="mb-1 block text-xs"
              >
                Proposed replacement
              </label>
              <Textarea
                id="comment-composer-repl"
                value={replacement}
                onChange={(e) => {
                  markTouched();
                  setReplacement(e.target.value);
                }}
                placeholder="The text that should replace the selection…"
                className="min-h-[100px] font-mono text-xs"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {aiCommentAssist && canUseAiAssist() && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={aiDrafting}
              onClick={() => void handleAiDraft()}
            >
              {aiDrafting ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              <span className="ml-1.5">Draft with AI</span>
            </Button>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {mode === "comment" ? "Add comment" : "Add suggestion"}
              <span className="ml-2 text-xs opacity-60">⌘↵</span>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
