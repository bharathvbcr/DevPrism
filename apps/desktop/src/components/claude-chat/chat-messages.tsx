import { type FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircleIcon, BotIcon, UserIcon } from "lucide-react";
import { useClaudeChatStore, type ClaudeStreamMessage, type ContentBlock } from "@/stores/claude-chat-store";
import { MarkdownRenderer } from "./markdown-renderer";
import { ToolWidget } from "./tool-widgets";

const THINKING_MESSAGES = [
  "Thinking",
  "Analyzing your document",
  "Reviewing the structure",
  "Processing your request",
  "Almost there",
  "Working on it",
  "Diving into the details",
  "Crafting a response",
  "Examining the code",
];

type TypewriterPhase = "typing" | "pausing" | "deleting";

function useTypewriter(
  words: string[],
  active: boolean,
  { typeSpeed = 60, deleteSpeed = 30, pauseDelay = 1800 } = {},
) {
  const [text, setText] = useState("");
  const [wordIndex, setWordIndex] = useState(0);
  const [phase, setPhase] = useState<TypewriterPhase>("typing");

  // Reset when deactivated
  useEffect(() => {
    if (!active) {
      setText("");
      setWordIndex(0);
      setPhase("typing");
    }
  }, [active]);

  const tick = useCallback(() => {
    const current = words[wordIndex];

    if (phase === "typing") {
      if (text.length < current.length) {
        setText(current.slice(0, text.length + 1));
      } else {
        setPhase("pausing");
      }
    } else if (phase === "pausing") {
      setPhase("deleting");
    } else if (phase === "deleting") {
      if (text.length > 0) {
        setText(current.slice(0, text.length - 1));
      } else {
        setWordIndex((prev) => (prev + 1) % words.length);
        setPhase("typing");
      }
    }
  }, [text, wordIndex, phase, words]);

  useEffect(() => {
    if (!active) return;

    const delay =
      phase === "typing" ? typeSpeed : phase === "deleting" ? deleteSpeed : pauseDelay;

    const timeout = setTimeout(tick, delay);
    return () => clearTimeout(timeout);
  }, [active, tick, phase, typeSpeed, deleteSpeed, pauseDelay]);

  return { text, phase };
}

export const ChatMessages: FC = () => {
  const messages = useClaudeChatStore((s) => s.messages);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const viewportRef = useRef<HTMLDivElement>(null);
  const { text: thinkingText, phase: thinkingPhase } = useTypewriter(THINKING_MESSAGES, isStreaming);

  // Build a map of tool_use_id → tool_result for inline display
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ContentBlock>();
    for (const msg of messages) {
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            map.set(block.tool_use_id, block);
          }
        }
      }
    }
    return map;
  }, [messages]);

  // Filter displayable messages
  const displayMessages = useMemo(() => {
    // Collect all assistant text for dedup against result
    const assistantTexts = new Set<string>();
    for (const msg of messages) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            assistantTexts.add(block.text.trim());
          }
        }
      }
    }

    return messages.filter((msg) => {
      // Skip system:init
      if (msg.type === "system" && msg.subtype === "init") return false;
      // Skip non-displayable event types (rate_limit_event, etc.)
      if (msg.type !== "user" && msg.type !== "assistant" && msg.type !== "result") return false;
      // Skip user messages that only contain tool_results
      if (msg.type === "user" && msg.message?.content) {
        const hasOnlyToolResults = msg.message.content.every(
          (b) => b.type === "tool_result"
        );
        if (hasOnlyToolResults) return false;
      }
      // Skip result message if its text duplicates an assistant message
      if (msg.type === "result" && msg.result) {
        if (assistantTexts.has(msg.result.trim())) return false;
      }
      return true;
    });
  }, [messages]);

  // Auto-scroll to bottom on new messages or message updates
  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [displayMessages]);

  return (
    <div
      ref={viewportRef}
      className="absolute inset-0 overflow-y-auto scroll-smooth px-4 py-2"
    >
      {displayMessages.length === 0 && !isStreaming && (
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Ask Claude about your LaTeX document...
        </div>
      )}

      {displayMessages.map((msg, idx) => (
        <MessageBubble
          key={idx}
          message={msg}
          toolResultMap={toolResultMap}
        />
      ))}

      {isStreaming && (
        <div className="flex items-center gap-1.5 px-1 py-1.5 text-muted-foreground">
          <div className="flex gap-0.5">
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: "0ms" }} />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: "150ms" }} />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-sm">
            {thinkingText}
            <span
              className={`ml-px inline-block h-[1em] w-0.5 translate-y-px bg-muted-foreground/70 ${
                thinkingPhase === "pausing" ? "animate-pulse" : ""
              }`}
            />
          </span>
        </div>
      )}
    </div>
  );
};

// ─── Message Bubble ───

const MessageBubble: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
}> = ({ message, toolResultMap }) => {
  console.log(
    `[chat-msg] type=${message.type} subtype=${message.subtype ?? ""} ` +
    `contentTypes=[${message.message?.content?.map((b) => b.type).join(",") ?? "none"}] ` +
    `result=${message.result ? `"${message.result.slice(0, 60)}"` : "none"}`
  );

  if (message.type === "user") {
    return <UserMessage message={message} />;
  }
  if (message.type === "assistant") {
    return <AssistantMessage message={message} toolResultMap={toolResultMap} />;
  }
  if (message.type === "result") {
    return <ResultMessage message={message} />;
  }
  return null;
};

// ─── User Message ───

const UserMessage: FC<{ message: ClaudeStreamMessage }> = ({ message }) => {
  const textContent = message.message?.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!textContent) return null;

  // Parse leading @file:line:col or ~@file:line context reference
  const contextMatch = textContent.match(/^(~?@[^\n]+)\n([\s\S]*)$/);
  const contextLabel = contextMatch?.[1] ?? null;
  const bodyText = contextMatch ? contextMatch[2] : textContent;

  // Parse error block patterns for styled rendering:
  // Lint single: "[Lint error in FILE:LINE]\n[Error: MSG]\n\nPrompt"
  // Lint multi:  "[Lint errors in FILE]\n- FILE:LINE — MSG\n...\n\nPrompt"
  // Compile:     "[Compilation errors]\n- error1\n- error2\n...\n\nPrompt"
  const lintSingleMatch = bodyText.match(
    /^\[Lint error in ([^\]]+)\]\n\[Error: ([^\]]+)\]\n\n([\s\S]*)$/
  );
  const lintMultiMatch = bodyText.match(
    /^\[Lint errors in ([^\]]+)\]\n((?:- .+\n?)+)\n([\s\S]*)$/
  );
  const compileErrorMatch = bodyText.match(
    /^\[Compilation errors\]\n((?:- .+\n?)+)\n([\s\S]*)$/
  );

  // Shared error block renderer
  const renderErrorBlock = (
    title: string,
    errors: { message: string; location?: string }[],
    prompt: string,
  ) => (
    <div className="flex w-full flex-col items-end py-1.5">
      <div className="max-w-[85%] rounded-xl bg-muted px-3 py-2 text-foreground text-sm">
        <div className="mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-2">
          <div className="mb-1.5 text-xs font-medium text-red-400">{title}</div>
          <div className="space-y-1">
            {errors.map((e, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <AlertCircleIcon className="mt-0.5 size-3 shrink-0 text-red-400/70" />
                <span className="flex-1 text-xs text-foreground/80">{e.message}</span>
                {e.location && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{e.location}</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <span className="text-muted-foreground">{prompt}</span>
      </div>
    </div>
  );

  if (lintSingleMatch) {
    const [, location, errorMsg, prompt] = lintSingleMatch;
    return renderErrorBlock(
      `Lint Error`,
      [{ message: errorMsg, location }],
      prompt,
    );
  }

  if (lintMultiMatch) {
    const [, fileName, errorLines, prompt] = lintMultiMatch;
    const errors = errorLines.trim().split("\n").map((line) => {
      const m = line.match(/^- (.+?):(\d+) — (.+)$/);
      return m ? { message: m[3], location: `${m[1]}:${m[2]}` } : { message: line.replace(/^- /, "") };
    });
    return renderErrorBlock(`Lint Errors — ${fileName}`, errors, prompt);
  }

  if (compileErrorMatch) {
    const [, errorLines, prompt] = compileErrorMatch;
    const errors = errorLines.trim().split("\n").map((line) => ({
      message: line.replace(/^- /, ""),
    }));
    return renderErrorBlock(
      `Compilation ${errors.length === 1 ? "Error" : "Errors"}`,
      errors,
      prompt,
    );
  }

  return (
    <div className="flex w-full flex-col items-end py-1.5">
      <div className="max-w-[85%] rounded-xl bg-muted px-3 py-1.5 text-foreground text-sm">
        {contextLabel && (
          <span className="mb-1 inline-flex items-center rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {contextLabel}
          </span>
        )}
        {contextLabel && bodyText && <br />}
        {bodyText}
      </div>
    </div>
  );
};

// ─── Assistant Message ───

const AssistantMessage: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
}> = ({ message, toolResultMap }) => {
  const content = message.message?.content;
  if (!content || content.length === 0) return null;

  // Check if any content block would actually render
  const hasRenderableContent = content.some(
    (block) =>
      (block.type === "text" && block.text) ||
      (block.type === "tool_use" && block.id)
  );

  if (!hasRenderableContent) {
    console.log("[chat-msg] AssistantMessage skipped — no renderable content:",
      content.map((b) => ({ type: b.type, hasText: !!b.text, hasId: !!b.id }))
    );
    return null;
  }

  return (
    <div className="w-full py-1.5">
      <div className="px-1 text-foreground text-sm leading-relaxed">
        {content.map((block, idx) => {
          if (block.type === "text" && block.text) {
            return (
              <MarkdownRenderer
                key={idx}
                content={block.text}
                className="prose prose-sm dark:prose-invert max-w-none"
              />
            );
          }
          if (block.type === "tool_use" && block.id) {
            const result = toolResultMap.get(block.id);
            return (
              <ToolWidget
                key={idx}
                toolUse={block}
                toolResult={result}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
};

// ─── Result Message ───

const ResultMessage: FC<{ message: ClaudeStreamMessage }> = ({ message }) => {
  const isError = message.is_error || message.subtype === "error";
  const resultText = message.result;

  if (!resultText) return null;

  return (
    <div className="w-full py-1.5">
      <div className="px-1 text-foreground text-sm leading-relaxed">
        {isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {resultText}
          </div>
        ) : (
          <MarkdownRenderer
            content={resultText}
            className="prose prose-sm dark:prose-invert max-w-none"
          />
        )}
      </div>
      {message.cost_usd != null && (
        <div className="mt-1 px-1 text-right text-muted-foreground text-xs">
          Cost: ${message.cost_usd.toFixed(4)}
        </div>
      )}
    </div>
  );
};
