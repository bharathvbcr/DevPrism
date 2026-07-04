import { type ButtonHTMLAttributes, type FC, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircleIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  FileEditIcon,
  FileIcon,
  FileOutputIcon,
  ListTodoIcon,
  LoaderIcon,
  MessageCircleQuestionIcon,
  SendIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useClaudeChatStore,
  type ContentBlock,
} from "@/stores/claude-chat-store";

interface ToolWidgetProps {
  toolUse: ContentBlock;
  toolResult?: ContentBlock;
}

export const ToolWidget: FC<ToolWidgetProps> = ({ toolUse, toolResult }) => {
  const name = toolUse.name?.toLowerCase() || "";

  if (name === "write")
    return <WriteWidget input={toolUse.input} result={toolResult} />;
  if (name === "edit" || name === "multiedit")
    return <EditWidget input={toolUse.input} result={toolResult} />;
  if (name === "read")
    return <ReadWidget input={toolUse.input} result={toolResult} />;
  if (name === "bash")
    return <BashWidget input={toolUse.input} result={toolResult} />;
  if (name === "powershell" || name === "pwsh")
    return (
      <BashWidget input={toolUse.input} result={toolResult} prefix="PS>" />
    );
  if (name === "glob")
    return <GlobWidget input={toolUse.input} result={toolResult} />;
  if (name === "grep")
    return <GrepWidget input={toolUse.input} result={toolResult} />;
  if (name === "compile")
    return <CompileWidget input={toolUse.input} result={toolResult} />;
  if (name === "askuserquestion")
    return <AskUserQuestionWidget input={toolUse.input} result={toolResult} />;
  if (name === "askuser")
    return <NativeAskUserWidget toolUse={toolUse} result={toolResult} />;
  if (name === "exitplanmode")
    return <ExitPlanModeWidget input={toolUse.input} result={toolResult} />;
  if (name === "todowrite")
    return <TodoWriteWidget input={toolUse.input} result={toolResult} />;

  return (
    <GenericWidget
      name={toolUse.name || "unknown"}
      input={toolUse.input}
      result={toolResult}
    />
  );
};

// ─── Status Icon ───

const StatusIcon: FC<{ result?: ContentBlock }> = ({ result }) => {
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  if (!result) {
    if (!isStreaming) {
      // Tool was cancelled (stop pressed) — show stopped state
      return (
        <CircleIcon
          className="size-3.5 text-muted-foreground"
          role="img"
          aria-label="Cancelled"
        />
      );
    }
    return (
      <LoaderIcon
        className="size-3.5 animate-spin text-muted-foreground"
        role="img"
        aria-label="Running"
      />
    );
  }
  if (result.is_error) {
    return (
      <AlertCircleIcon
        className="size-3.5 text-destructive"
        role="img"
        aria-label="Failed"
      />
    );
  }
  return (
    <CheckIcon
      className="size-3.5 text-success"
      role="img"
      aria-label="Completed"
    />
  );
};

// ─── Disclosure Chevron ───

const DisclosureChevron: FC<{ expanded: boolean }> = ({ expanded }) =>
  expanded ? (
    <ChevronDownIcon className="ml-auto size-3.5 text-muted-foreground" />
  ) : (
    <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
  );

// ─── Tool Row Button ───
//
// Shared trigger for expandable tool-widget rows: consistent hover/focus-visible
// affordance and rounded corners. `rounded` lets callers switch to `rounded-t-lg`
// when an expanded panel/border follows below to avoid corner bleed.

const ToolRowButton: FC<
  ButtonHTMLAttributes<HTMLButtonElement> & { rounded?: string }
> = ({ rounded = "rounded-lg", className, children, ...props }) => (
  <button
    type="button"
    className={`flex w-full items-center gap-2 px-3 py-2 transition-colors ${rounded} hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset${
      className ? ` ${className}` : ""
    }`}
    {...props}
  >
    {children}
  </button>
);

// ─── Write Widget ───

const WriteWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileOutputIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Wrote" : "Writing"}{" "}
        <code className="rounded bg-muted px-1 text-xs">
          {input?.file_path}
        </code>
      </span>
    </div>
  );
};

// ─── Edit Widget ───

const EditWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <ToolRowButton
        rounded={expanded && input?.old_string ? "rounded-t-lg" : "rounded-lg"}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <FileEditIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-muted-foreground">
          {result ? "Edited" : "Editing"}{" "}
          <code className="rounded bg-muted px-1 text-xs">
            {input?.file_path}
          </code>
        </span>
        {(input?.old_string || input?.edits) && (
          <DisclosureChevron expanded={expanded} />
        )}
      </ToolRowButton>
      {expanded && input?.old_string && (
        <div className="border-border border-t px-3 py-2 font-mono text-xs">
          <div className="mb-1 text-destructive">
            - {truncate(input.old_string, 200)}
          </div>
          <div className="text-success">
            + {truncate(input.new_string, 200)}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Read Widget ───

const ReadWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Read" : "Reading"}{" "}
        <code className="rounded bg-muted px-1 text-xs">
          {input?.file_path}
        </code>
      </span>
    </div>
  );
};

// ─── Bash Widget ───

const BashWidget: FC<{
  input: any;
  result?: ContentBlock;
  prefix?: string;
}> = ({ input, result, prefix = "$" }) => {
  const [expanded, setExpanded] = useState(false);
  const command = input?.command || input?.description || "";
  const resultContent =
    typeof result?.content === "string" ? result.content : "";

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/70 text-sm dark:bg-neutral-900">
      <ToolRowButton
        rounded={expanded && resultContent ? "rounded-t-lg" : "rounded-lg"}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <TerminalIcon className="size-3.5 shrink-0 text-success" />
        <code className="min-w-0 truncate text-success text-xs">
          {prefix} {truncate(command, 80)}
        </code>
        {result && <DisclosureChevron expanded={expanded} />}
      </ToolRowButton>
      {expanded && resultContent && (
        <div className="max-h-40 overflow-auto border-border/50 border-t px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-muted-foreground text-xs">
            {truncate(resultContent, 2000)}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Glob Widget ───

const GlobWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Searched" : "Searching"}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.pattern}</code>
      </span>
    </div>
  );
};

// ─── Grep Widget ───

const GrepWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <StatusIcon result={result} />
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">
        {result ? "Grepped" : "Grepping"}{" "}
        <code className="rounded bg-muted px-1 text-xs">{input?.pattern}</code>
      </span>
    </div>
  );
};

// ─── Compile Widget ───

const CompileWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const [expanded, setExpanded] = useState(false);
  const mainFile = input?.main_file ?? "main.tex";
  const resultContent =
    typeof result?.content === "string" ? result.content : "";
  const failed = result?.is_error || /failed|error/i.test(resultContent);

  return (
    <div
      className={`my-1.5 rounded-lg border text-sm ${
        failed
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-muted/50"
      }`}
    >
      <ToolRowButton
        rounded={expanded && resultContent ? "rounded-t-lg" : "rounded-lg"}
        aria-expanded={expanded}
        onClick={() => resultContent && setExpanded(!expanded)}
        disabled={!resultContent}
      >
        <StatusIcon result={result} />
        <FileOutputIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-muted-foreground">
          {result ? (failed ? "Compile failed" : "Compiled") : "Compiling"}{" "}
          <code className="rounded bg-muted px-1 text-xs">{mainFile}</code>
        </span>
        {resultContent && <DisclosureChevron expanded={expanded} />}
      </ToolRowButton>
      {expanded && resultContent && (
        <div className="max-h-48 overflow-auto border-border/50 border-t px-3 py-2">
          <pre
            className={`whitespace-pre-wrap font-mono text-xs ${
              failed ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {truncate(resultContent, 3000)}
          </pre>
        </div>
      )}
    </div>
  );
};

const COLLAPSIBLE_TOOL_NAMES = new Set(["read", "grep", "glob", "ls"]);
const TOOL_GROUP_MIN = 3;

/** Collapse long runs of the same lightweight tool into one expandable row. */
export const ToolGroupWidget: FC<{
  name: string;
  tools: ContentBlock[];
  toolResultMap: Map<string, ContentBlock>;
}> = ({ name, tools, toolResultMap }) => {
  const [expanded, setExpanded] = useState(false);
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  const allDone = tools.every((t) => t.id && toolResultMap.has(t.id));

  const summary = (() => {
    if (name === "read") {
      const paths = tools
        .map((t) => t.input?.file_path)
        .filter(Boolean)
        .slice(0, 2);
      const extra = tools.length - paths.length;
      return paths.join(", ") + (extra > 0 ? ` +${extra} more` : "");
    }
    if (name === "grep" || name === "glob") {
      return tools[0]?.input?.pattern ?? `${tools.length} searches`;
    }
    return `${tools.length} calls`;
  })();

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/40 text-sm">
      <ToolRowButton
        rounded={expanded ? "rounded-t-lg" : "rounded-lg"}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {allDone ? (
          <CheckIcon className="size-3.5 shrink-0 text-success" />
        ) : (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-muted-foreground">
          {allDone ? label : `${label}ing`}{" "}
          <span className="text-foreground/80">{tools.length}×</span>
          <span className="text-muted-foreground/70"> — {summary}</span>
        </span>
        <DisclosureChevron expanded={expanded} />
      </ToolRowButton>
      {expanded && (
        <div className="space-y-1 border-border/50 border-t px-2 py-2">
          {tools.map((tool, i) => (
            <ToolWidget
              key={tool.id ?? i}
              toolUse={tool}
              toolResult={tool.id ? toolResultMap.get(tool.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export function groupAssistantToolBlocks(
  blocks: ContentBlock[],
): Array<
  | { kind: "block"; block: ContentBlock; index: number }
  | { kind: "group"; name: string; tools: ContentBlock[]; index: number }
> {
  const result: Array<
    | { kind: "block"; block: ContentBlock; index: number }
    | { kind: "group"; name: string; tools: ContentBlock[]; index: number }
  > = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    const name =
      block.type === "tool_use" ? block.name?.toLowerCase() : undefined;
    if (name && COLLAPSIBLE_TOOL_NAMES.has(name)) {
      const group: ContentBlock[] = [block];
      let j = i + 1;
      while (j < blocks.length) {
        const next = blocks[j];
        if (next.type !== "tool_use") break;
        if (next.name?.toLowerCase() !== name) break;
        group.push(next);
        j++;
      }
      if (group.length >= TOOL_GROUP_MIN) {
        result.push({ kind: "group", name, tools: group, index: i });
        i = j;
        continue;
      }
    }
    result.push({ kind: "block", block, index: i });
    i++;
  }
  return result;
}

// ─── AskUserQuestion Widget ───

const AskUserQuestionWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const questions: any[] = input?.questions || [];
  const [answered, setAnswered] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<Record<number, string>>(
    {},
  );

  // In -p mode, AskUserQuestion always errors because CLI can't prompt interactively.
  // The process is killed when AskUserQuestion is detected, so result may be undefined.
  // Options are clickable when there's no result or an error result.
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const needsUserAnswer =
    !answered && !isStreaming && (!result || result.is_error);

  const handleOptionClick = (qIdx: number, label: string) => {
    const { sendPrompt, isStreaming } = useClaudeChatStore.getState();
    if (isStreaming) return;
    setSelectedLabel((prev) => ({ ...prev, [qIdx]: label }));
    setAnswered(true);
    sendPrompt(`${label}`);
  };

  if (questions.length === 0) {
    return (
      <div className="my-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
        <StatusIcon result={result} />
        <MessageCircleQuestionIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {result ? "Asked question" : "Asking question..."}
        </span>
      </div>
    );
  }

  // Determine header state
  const headerLabel = isStreaming
    ? "Waiting for answer..."
    : needsUserAnswer
      ? "Choose an option"
      : answered
        ? "Answer sent"
        : "Question answered";

  return (
    <div
      className={`my-1.5 rounded-lg border text-sm ${
        needsUserAnswer
          ? "border-blue-500/40 bg-blue-500/10"
          : "border-blue-500/20 bg-blue-500/5"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {needsUserAnswer ? (
          <MessageCircleQuestionIcon className="size-3.5 text-blue-500" />
        ) : (
          <>
            <StatusIcon result={result} />
            <MessageCircleQuestionIcon className="size-3.5 text-blue-500" />
          </>
        )}
        <span className="font-medium text-blue-600 dark:text-blue-400">
          {headerLabel}
        </span>
      </div>
      <div className="space-y-3 border-blue-500/20 border-t px-3 py-2.5">
        {questions.map((q: any, qIdx: number) => {
          const questionId = `askuser-q-${qIdx}`;
          return (
            <div key={qIdx} className="space-y-1.5">
              {q.header && (
                <span className="inline-block rounded-full bg-blue-500/15 px-2 py-0.5 font-medium text-blue-600 text-xs dark:text-blue-400">
                  {q.header}
                </span>
              )}
              <p
                id={questionId}
                className="font-medium text-foreground text-sm"
              >
                {q.question}
              </p>
              <div
                className="space-y-1 pl-1"
                role="radiogroup"
                aria-labelledby={questionId}
              >
                {q.options?.map((opt: any, oIdx: number) => {
                  const selected = selectedLabel[qIdx] === opt.label;
                  return (
                    <button
                      type="button"
                      key={oIdx}
                      role="radio"
                      aria-checked={selected}
                      disabled={!needsUserAnswer}
                      onClick={() =>
                        needsUserAnswer && handleOptionClick(qIdx, opt.label)
                      }
                      className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                        needsUserAnswer
                          ? "cursor-pointer hover:bg-blue-500/15"
                          : "cursor-default"
                      }`}
                    >
                      <div className="mt-0.5">
                        {selected ? (
                          <CheckIcon className="size-3.5 text-blue-500" />
                        ) : (
                          <CircleIcon
                            className={`size-3.5 ${
                              needsUserAnswer
                                ? "text-blue-500/50"
                                : "text-muted-foreground/40"
                            }`}
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span
                          className={`text-sm ${selected ? "font-medium" : ""}${
                            needsUserAnswer
                              ? "text-foreground"
                              : "text-muted-foreground"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.description && (
                          <p className="mt-0.5 text-muted-foreground/70 text-xs">
                            {opt.description}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Native AskUser Widget (native Ollama agent) ───
//
// The native agent's AskUser tool parks the Rust tool loop until the user
// replies via the `answer_native_agent_question` command, keyed by this
// tool_use block's id. Unlike the CLI AskUserQuestion widget above (which
// kills the process and restarts with a new prompt), answering here resumes
// the SAME run: the backend pushes the reply as this call's tool_result and
// the loop continues. The result arriving (answer echoed back, timeout, or a
// cancel) is what flips the widget into its settled state.

const NativeAskUserWidget: FC<{
  toolUse: ContentBlock;
  result?: ContentBlock;
}> = ({ toolUse, result }) => {
  const [answered, setAnswered] = useState(false);
  const [text, setText] = useState("");
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);

  const question: string =
    typeof toolUse.input?.question === "string" ? toolUse.input.question : "";
  const options: string[] = Array.isArray(toolUse.input?.options)
    ? toolUse.input.options
        .filter(
          (opt: unknown): opt is string =>
            typeof opt === "string" && !!opt.trim(),
        )
        .slice(0, 4)
    : [];
  const requestId = toolUse.id;
  // Interactive only while the run is parked on this question: no result yet,
  // the stream is still live, and we haven't already sent an answer.
  const canAnswer = !answered && !result && isStreaming && !!requestId;

  const submit = async (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed || !canAnswer || !requestId) return;
    setSelectedOption(trimmed);
    setAnswered(true);
    try {
      await invoke("answer_native_agent_question", {
        requestId,
        answer: trimmed,
      });
    } catch {
      // The question is no longer pending (timed out / run stopped) — don't
      // pretend the answer was delivered.
      setAnswered(false);
      setSelectedOption(null);
    }
  };

  const headerLabel = canAnswer
    ? "Waiting for your answer"
    : answered && !result
      ? "Answer sent"
      : result?.is_error
        ? "Question cancelled"
        : result
          ? "Question answered"
          : "Question";

  const resultText =
    typeof result?.content === "string" ? result.content : undefined;

  return (
    <div
      className={`my-1.5 rounded-lg border text-sm ${
        canAnswer
          ? "border-blue-500/40 bg-blue-500/10"
          : "border-blue-500/20 bg-blue-500/5"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {!canAnswer && <StatusIcon result={result} />}
        <MessageCircleQuestionIcon className="size-3.5 text-blue-500" />
        <span className="font-medium text-blue-600 dark:text-blue-400">
          {headerLabel}
        </span>
      </div>
      <div className="space-y-2 border-blue-500/20 border-t px-3 py-2.5">
        <p
          id={`native-askuser-q-${requestId ?? "x"}`}
          className="font-medium text-foreground text-sm"
        >
          {question}
        </p>
        {options.length > 0 && (
          <div
            className="space-y-1"
            role="radiogroup"
            aria-labelledby={`native-askuser-q-${requestId ?? "x"}`}
          >
            {options.map((opt, oIdx) => {
              const selected = selectedOption === opt;
              return (
                <button
                  type="button"
                  key={oIdx}
                  role="radio"
                  aria-checked={selected}
                  disabled={!canAnswer}
                  onClick={() => void submit(opt)}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    canAnswer
                      ? "cursor-pointer hover:bg-blue-500/15"
                      : "cursor-default"
                  }`}
                >
                  {selected ? (
                    <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-blue-500" />
                  ) : (
                    <CircleIcon
                      className={`mt-0.5 size-3.5 shrink-0 ${
                        canAnswer
                          ? "text-blue-500/50"
                          : "text-muted-foreground/40"
                      }`}
                    />
                  )}
                  <span
                    className={`min-w-0 text-sm ${
                      selected ? "font-medium" : ""
                    }${
                      canAnswer ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {opt}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {canAnswer && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(text);
            }}
          >
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type your answer…"
              className="h-8 min-w-0 flex-1 rounded-md border border-blue-500/30 bg-background px-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-blue-500/60"
            />
            <Button
              type="submit"
              size="icon-sm"
              disabled={!text.trim()}
              aria-label="Send answer"
              className="bg-blue-500 text-white hover:bg-blue-500/90"
            >
              <SendIcon className="size-3.5" />
            </Button>
          </form>
        )}
        {!canAnswer && resultText && (
          <p className="text-muted-foreground text-xs">
            {truncate(resultText, 300)}
          </p>
        )}
      </div>
    </div>
  );
};

// ExitPlanMode Widget

const ExitPlanModeWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const [answered, setAnswered] = useState(false);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const needsApproval =
    !answered && !isStreaming && (!result || result.is_error);
  const plan = input?.plan || input?.content || "";

  const sendPlanResponse = (text: string) => {
    const { sendPrompt, isStreaming } = useClaudeChatStore.getState();
    if (isStreaming) return;
    setAnswered(true);
    sendPrompt(text);
  };

  return (
    <div
      className={`my-1.5 rounded-lg border text-sm ${
        needsApproval
          ? "border-warning/40 bg-warning/15"
          : "border-warning/20 bg-warning/5"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <SparklesIcon className="size-3.5 text-warning" />
        <span className="font-medium text-warning">
          {needsApproval
            ? "Plan needs approval"
            : answered
              ? "Plan response sent"
              : "Plan handled"}
        </span>
      </div>
      {plan && (
        <div className="border-warning/20 border-t px-3 py-2">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-foreground text-xs leading-relaxed">
            {plan}
          </pre>
        </div>
      )}
      {needsApproval && (
        <div className="flex flex-wrap gap-2 border-warning/20 border-t px-3 py-2">
          <Button
            size="sm"
            onClick={() =>
              sendPlanResponse("Approved. Continue implementing the plan.")
            }
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              sendPlanResponse(
                "Revise the plan before implementing. Keep it concise and address any missing risks.",
              )
            }
          >
            Revise
          </Button>
        </div>
      )}
    </div>
  );
};

// ─── TodoWrite Widget ───

const TodoWriteWidget: FC<{ input: any; result?: ContentBlock }> = ({
  input,
  result,
}) => {
  const [expanded, setExpanded] = useState(true);
  const todos: any[] = Array.isArray(input?.todos) ? input.todos : [];

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckIcon className="size-3.5 text-success" />;
      case "in_progress":
        return <ClockIcon className="size-3.5 animate-pulse text-blue-500" />;
      default:
        return <CircleIcon className="size-3.5 text-muted-foreground/40" />;
    }
  };

  const completedCount = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <ToolRowButton
        rounded={expanded && todos.length > 0 ? "rounded-t-lg" : "rounded-lg"}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <ListTodoIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          Todos ({completedCount}/{todos.length})
        </span>
        <DisclosureChevron expanded={expanded} />
      </ToolRowButton>
      {expanded && todos.length > 0 && (
        <div className="space-y-0.5 border-border border-t px-3 py-2">
          {todos.map((todo, idx) => (
            <div
              key={idx}
              className={`flex items-center gap-2 rounded px-1.5 py-1 ${
                todo.status === "completed" ? "opacity-50" : ""
              }`}
            >
              {statusIcon(todo.status)}
              <span
                className={`text-xs ${
                  todo.status === "completed"
                    ? "text-muted-foreground line-through"
                    : todo.status === "in_progress"
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                }`}
              >
                {todo.status === "in_progress"
                  ? todo.activeForm || todo.content
                  : todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Generic Widget ───

const GenericWidget: FC<{
  name: string;
  input: any;
  result?: ContentBlock;
}> = ({ name, input, result }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1.5 rounded-lg border border-border bg-muted/50 text-sm">
      <ToolRowButton
        rounded={expanded && input ? "rounded-t-lg" : "rounded-lg"}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon result={result} />
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {result ? "Ran" : "Running"} <code className="text-xs">{name}</code>
        </span>
        <DisclosureChevron expanded={expanded} />
      </ToolRowButton>
      {expanded && input && (
        <div className="max-h-32 overflow-auto border-border border-t px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-muted-foreground text-xs">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Thinking Widget ───

export const ThinkingWidget: FC<{ thinking: string; signature?: string }> = ({
  thinking,
}) => {
  const [expanded, setExpanded] = useState(false);
  const trimmed = thinking.trim();

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-muted-foreground/20 bg-muted-foreground/5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-muted-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="flex items-center gap-2">
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/10">
            <BrainIcon className="size-3.5 text-muted-foreground" />
          </div>
          <span className="font-medium text-muted-foreground text-sm italic">
            Thinking...
          </span>
        </div>
        <DisclosureChevron expanded={expanded} />
      </button>
      {expanded && (
        <div className="border-muted-foreground/20 border-t px-3 pt-2 pb-3">
          <pre className="whitespace-pre-wrap rounded-lg bg-muted-foreground/5 p-3 font-mono text-muted-foreground text-xs italic">
            {trimmed}
          </pre>
        </div>
      )}
    </div>
  );
};

// ─── Helpers ───

function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max)}...` : str;
}
