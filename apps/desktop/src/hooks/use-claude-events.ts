import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
} from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { readTexFileContent } from "@/lib/tauri/fs";
import { compileLatex } from "@/lib/latex-compiler";

/**
 * Hook that manages Tauri event listeners for Claude CLI streaming output.
 *
 * Follows the dual-listener pattern from opcode:
 * 1. Start with generic `claude-output` listener to catch the first `system:init` message
 * 2. Extract session_id from init → switch to `claude-output:{sessionId}` listeners
 * 3. On `claude-complete` → clean up listeners
 */
export function useClaudeEvents() {
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const listenersRef = useRef<UnlistenFn[]>([]);
  const sessionSpecificListenersRef = useRef<UnlistenFn[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isStreaming) return;

    currentSessionIdRef.current = null;

    // Track tool_use messages for matching with tool_results
    const pendingToolUses = new Map<
      string,
      { name: string; input: any }
    >();

    // Track whether any LaTeX-related files were modified during this session
    let hasTexChanges = false;

    // Register a proposed change instead of immediately reloading the file
    async function registerProposedChange(
      filePath: string,
      toolUseId: string,
      toolName: string
    ) {
      console.log("[proposed-change] registerProposedChange called:", { filePath, toolUseId, toolName });
      const docState = useDocumentStore.getState();
      const projectRoot = docState.projectRoot;
      // Normalize path: Claude may report absolute or relative
      let relativePath = filePath;
      if (projectRoot && filePath.startsWith(projectRoot)) {
        relativePath = filePath.slice(projectRoot.length).replace(/^\//, "");
      }
      console.log("[proposed-change] normalized:", { relativePath, projectRoot, fileCount: docState.files.length });
      const file = docState.files.find(
        (f) => f.relativePath === relativePath || f.absolutePath === filePath
      );
      if (!file) {
        console.warn("[proposed-change] file not found in store, paths:", docState.files.map(f => f.relativePath));
        return;
      }

      // oldContent: use the document store's content (the pre-edit baseline).
      // addChange() will automatically preserve the original baseline if there's
      // already a pending change for this file (stacked edits).
      const oldContent = file.content ?? "";

      try {
        const newContent = await readTexFileContent(file.absolutePath);
        console.log("[proposed-change] content comparison:", {
          oldLen: oldContent.length,
          newLen: newContent.length,
          same: oldContent === newContent,
        });
        if (oldContent !== newContent) {
          // addChange handles merging: if a change already exists for this file,
          // it keeps the original oldContent and updates newContent + id atomically
          useProposedChangesStore.getState().addChange({
            id: toolUseId,
            filePath: file.relativePath,
            absolutePath: file.absolutePath,
            oldContent,
            newContent,
            toolName,
          });
          console.log("[proposed-change] added/merged change for:", file.relativePath);
        } else {
          console.log("[proposed-change] content identical, skipping");
        }
      } catch (err) {
        console.error("[proposed-change] readTexFileContent failed:", err);
      }
    }

    function handleStreamMessage(payload: string) {
      let msg: ClaudeStreamMessage;
      try {
        msg = JSON.parse(payload);
      } catch {
        return;
      }

      console.log(
        `[claude-stream] type=${msg.type} subtype=${msg.subtype ?? ""} ` +
        `contentTypes=[${msg.message?.content?.map((b) => b.type).join(",") ?? "none"}] ` +
        `texts=[${msg.message?.content?.filter((b) => b.type === "text").map((b) => `"${(b.text ?? "").slice(0, 50)}"`).join(",") ?? ""}] ` +
        `result=${msg.result ? `"${msg.result.slice(0, 80)}"` : "none"}`
      );

      const chatStore = useClaudeChatStore.getState();

      // Extract session_id from system:init
      if (
        msg.type === "system" &&
        msg.subtype === "init" &&
        msg.session_id
      ) {
        currentSessionIdRef.current = msg.session_id;
        chatStore._setSessionId(msg.session_id);
        // Attach session-specific listeners
        attachSessionListeners(msg.session_id);
      }

      // Track tool_use blocks for file change detection
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            console.log("[claude-events] tracked tool_use:", { id: block.id, name: block.name, input_keys: block.input ? Object.keys(block.input) : [] });
            pendingToolUses.set(block.id, {
              name: block.name,
              input: block.input,
            });
          }
        }
      }

      // Detect file modifications from tool_results → register as proposed changes
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const toolUse = pendingToolUses.get(block.tool_use_id);
            console.log("[claude-events] tool_result:", {
              tool_use_id: block.tool_use_id,
              is_error: block.is_error,
              toolUse: toolUse ? { name: toolUse.name, file_path: toolUse.input?.file_path } : "NOT_FOUND",
            });
            if (
              toolUse &&
              !block.is_error &&
              (toolUse.name === "Write" ||
                toolUse.name === "write" ||
                toolUse.name === "Edit" ||
                toolUse.name === "edit" ||
                toolUse.name === "MultiEdit" ||
                toolUse.name === "multiedit")
            ) {
              const filePath =
                toolUse.input?.file_path || toolUse.input?.path;
              if (filePath) {
                registerProposedChange(filePath, block.tool_use_id!, toolUse.name);
                // Track if any LaTeX-related files were modified
                if (/\.(tex|bib|sty|cls|dtx)$/i.test(filePath)) {
                  hasTexChanges = true;
                }
              } else {
                console.warn("[claude-events] no file_path in tool input:", toolUse.input);
              }
            }
          }
        }
      }

      // Skip duplicate user messages we already added locally
      if (
        msg.type === "user" &&
        msg.message?.content?.length === 1 &&
        msg.message.content[0].type === "text"
      ) {
        // This is Claude echoing back the user prompt — skip it
        return;
      }

      chatStore._appendMessage(msg);
    }

    async function handleComplete(payload: boolean) {
      useClaudeChatStore.getState()._setStreaming(false);
      // Refresh file tree to pick up any files created/deleted during the session
      const docStore = useDocumentStore.getState();
      await docStore.refreshFiles();

      // Auto-recompile if any LaTeX-related files were modified
      if (hasTexChanges && docStore.projectRoot) {
        const { projectRoot, files } = useDocumentStore.getState();
        if (projectRoot) {
          const mainFile = files.find(
            (f) => f.name === "document.tex" || f.name === "main.tex",
          );
          const mainFileName = mainFile?.relativePath || "document.tex";
          useDocumentStore.getState().setIsCompiling(true);
          try {
            const pdfData = await compileLatex(projectRoot, mainFileName);
            useDocumentStore.getState().setPdfData(pdfData);
          } catch (err) {
            useDocumentStore.getState().setCompileError(
              err instanceof Error ? err.message : "Compilation failed",
            );
          } finally {
            useDocumentStore.getState().setIsCompiling(false);
          }
        }
      }

      cleanupAll();
    }

    function handleError(payload: string) {
      // Stderr lines — could be warnings, not necessarily errors
      console.warn("[claude-stderr]", payload);
    }

    async function attachSessionListeners(sessionId: string) {
      // Add session-specific listeners
      const unlistenOutput = await listen<string>(
        `claude-output:${sessionId}`,
        (event) => {
          // Session-specific messages are handled here
          // Generic listener may have already processed the init message,
          // but subsequent messages come through both — we only process once.
          // Since we set up session listeners after init, the generic listener
          // handles the first few messages and session-specific handles the rest.
        }
      );
      const unlistenComplete = await listen<boolean>(
        `claude-complete:${sessionId}`,
        (event) => handleComplete(event.payload)
      );
      const unlistenError = await listen<string>(
        `claude-error:${sessionId}`,
        (event) => handleError(event.payload)
      );

      sessionSpecificListenersRef.current.push(
        unlistenOutput,
        unlistenComplete,
        unlistenError
      );
    }

    function cleanupAll() {
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
      for (const unlisten of sessionSpecificListenersRef.current) {
        unlisten();
      }
      sessionSpecificListenersRef.current = [];
    }

    // Set up generic listeners
    let cancelled = false;
    (async () => {
      const unlistenOutput = await listen<string>(
        "claude-output",
        (event) => {
          if (!cancelled) handleStreamMessage(event.payload);
        }
      );
      const unlistenComplete = await listen<boolean>(
        "claude-complete",
        (event) => {
          if (!cancelled) handleComplete(event.payload);
        }
      );
      const unlistenError = await listen<string>(
        "claude-error",
        (event) => {
          if (!cancelled) handleError(event.payload);
        }
      );

      if (cancelled) {
        unlistenOutput();
        unlistenComplete();
        unlistenError();
        return;
      }

      listenersRef.current.push(
        unlistenOutput,
        unlistenComplete,
        unlistenError
      );
    })();

    return () => {
      cancelled = true;
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
      for (const unlisten of sessionSpecificListenersRef.current) {
        unlisten();
      }
      sessionSpecificListenersRef.current = [];
    };
  }, [isStreaming]);
}
