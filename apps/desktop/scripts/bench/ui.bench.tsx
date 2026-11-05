import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bench, vi } from "vitest";
import { collectSamples, measured, notMeasured, summarize } from "./stats";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("bench"),
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath =
  process.env.DEVPRISM_BENCH_UI_JSON ??
  path.resolve(here, "../../../../bench-results/ui-partial.json");

const REPLY_BYTES = 50_000;
const CHUNK_BYTES = 1024;

function write(body: unknown) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(body, null, 2)}\n`);
}

async function measureStore() {
  const { useSettingsStore } = await import("@/stores/settings-store");
  const { useClaudeChatStore } = await import("@/stores/claude-chat-store");
  useSettingsStore.setState({
    aiAutoTitles: false,
    aiAssistEnabled: false,
  });
  const rows: { ms: number; updates: number; msPerDelta: number }[] = [];
  const deltas = Math.ceil(REPLY_BYTES / CHUNK_BYTES);
  const collected = await collectSamples(() => {
    const tabId = useClaudeChatStore.getState().createTab();
    let updates = 0;
    const unsubscribe = useClaudeChatStore.subscribe(() => {
      updates += 1;
    });
    const started = performance.now();
    let sent = 0;
    let chunks = 0;
    while (sent < REPLY_BYTES) {
      const n = Math.min(CHUNK_BYTES, REPLY_BYTES - sent);
      useClaudeChatStore.getState()._appendMessage(tabId, {
        type: "assistant",
        subtype: "streaming_delta",
        message: { content: [{ type: "text", text: "a".repeat(n) }] },
      });
      sent += n;
      chunks += 1;
    }
    const ms = performance.now() - started;
    unsubscribe();
    const tab = useClaudeChatStore
      .getState()
      .tabs.find((item) => item.id === tabId);
    const text =
      tab?.messages
        .at(-1)
        ?.message?.content?.find((block) => block.type === "text")?.text ?? "";
    if (text.length !== REPLY_BYTES || chunks !== deltas) {
      throw new Error(
        `reply length ${text.length} chunks ${chunks}, expected ${REPLY_BYTES} / ${deltas}`,
      );
    }
    rows.push({ ms, updates, msPerDelta: ms / deltas });
    return ms;
  });
  const kept = rows.slice(collected.warmup.length);
  const updateSummary = summarize(kept.map((row) => row.updates));
  const perDelta = summarize(kept.map((row) => row.msPerDelta));
  return {
    status: "measured" as const,
    reply_bytes: REPLY_BYTES,
    chunk_bytes: CHUNK_BYTES,
    deltas,
    chunk_source:
      "Rust coalescer FLUSH_BYTES is 1024. 50 KB here is 50000 bytes.",
    ai_auto_titles: false,
    what: "zustand notifications and milliseconds while _appendMessage merges streaming_delta chunks",
    wall_ms: measured(collected.summary, collected.warmup, {
      smoke: collected.smoke,
      unit: "ms",
    }),
    store_updates: measured(
      updateSummary,
      rows.slice(0, collected.warmup.length).map((row) => row.updates),
      { smoke: collected.smoke, unit: "updates_per_reply" },
    ),
    ms_per_delta: measured(
      perDelta,
      rows.slice(0, collected.warmup.length).map((row) => row.msPerDelta),
      { smoke: collected.smoke, unit: "ms" },
    ),
  };
}

async function measureRenders() {
  const { invoke } = await import("@tauri-apps/api/core");
  const mockedInvoke = vi.mocked(invoke);
  const previous = mockedInvoke.getMockImplementation();
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "detect_editors") return [];
    if (previous) return previous(cmd, args as never);
    return undefined;
  });
  const { act, cleanup, render } = await import("@testing-library/react");
  const { ThemeProvider } = await import("next-themes");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { EditorView } = await import("@codemirror/view");
  const { Profiler, createElement } = await import("react");
  const { useDocumentStore } = await import("@/stores/document-store");
  const { useSettingsStore } = await import("@/stores/settings-store");
  const { LatexEditor } = await import(
    "@/components/workspace/editor/latex-editor"
  );
  const { Sidebar } = await import("@/components/workspace/sidebar");

  useSettingsStore.setState({
    aiAssistEnabled: false,
    aiGrammarHints: false,
    aiPredictiveText: false,
    aiLintFix: false,
    aiSummarize: false,
    aiAutoTitles: false,
    vimMode: false,
    spellCheck: false,
  });
  useDocumentStore.setState({
    projectRoot: "/tmp/devprism-bench-project",
    initialized: true,
    activeFileId: "main.typ",
    files: [
      {
        id: "main.typ",
        name: "main.typ",
        relativePath: "main.typ",
        absolutePath: "/tmp/devprism-bench-project/main.typ",
        type: "typst",
        content: "Hello bench.\n",
        isDirty: false,
      },
    ],
    compiledPageCounts: new Map(),
    cursorPosition: 0,
  });

  const counts = {
    sidebar: 0,
    editor: 0,
    armed: false,
    mountSidebar: 0,
    mountEditor: 0,
    storeNotes: 0,
  };
  await act(async () => {
    render(
      createElement(
        ThemeProvider,
        { attribute: "class", defaultTheme: "light" },
        createElement(
          TooltipProvider,
          {},
          createElement(
            Profiler,
            {
              id: "sidebar",
              onRender: () => {
                if (counts.armed) counts.sidebar += 1;
                else counts.mountSidebar += 1;
              },
            },
            createElement(Sidebar, {}),
          ),
          createElement(
            Profiler,
            {
              id: "editor",
              onRender: () => {
                if (counts.armed) counts.editor += 1;
                else counts.mountEditor += 1;
              },
            },
            createElement(LatexEditor, {}),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const content = document.querySelector(".cm-content");
  if (!content) throw new Error("CodeMirror did not mount in the editor");
  const view = EditorView.findFromDOM(content);
  const before = view.state.doc.length;

  const unsubscribe = useDocumentStore.subscribe(() => {
    if (counts.armed) counts.storeNotes += 1;
  });
  async function oneKeystroke(): Promise<{ sidebar: number; editor: number }> {
    counts.sidebar = 0;
    counts.editor = 0;
    counts.storeNotes = 0;
    counts.armed = true;
    const at = view.state.selection.main.head;
    await act(async () => {
      view.dispatch({
        changes: { from: at, insert: "x" },
        selection: { anchor: at + 1 },
        userEvent: "input.type",
      });
    });
    counts.armed = false;
    return { sidebar: counts.sidebar, editor: counts.editor };
  }

  const rows: { sidebar: number; editor: number }[] = [];
  const collected = await collectSamples(async () => {
    const row = await oneKeystroke();
    rows.push(row);
    return row.sidebar + row.editor;
  });
  if (view.state.doc.length !== before + rows.length) {
    throw new Error(
      `editor grew by ${view.state.doc.length - before}, expected ${rows.length}`,
    );
  }
  const kept = rows.slice(collected.warmup.length);
  const cursorAfter = useDocumentStore.getState().cursorPosition;
  unsubscribe();
  cleanup();
  return {
    status: "measured" as const,
    mount_sidebar_commits: counts.mountSidebar,
    mount_editor_commits: counts.mountEditor,
    cursor_after: cursorAfter,
    last_sample_document_store_notifications: counts.storeNotes,
    environment:
      "vitest jsdom, real Sidebar and LatexEditor, one EditorView.dispatch per sample",
    not_preview_latency: true,
    debounced_content_push_included: false,
    sidebar_commits: measured(
      summarize(kept.map((row) => row.sidebar)),
      rows.slice(0, collected.warmup.length).map((row) => row.sidebar),
      {
        smoke: collected.smoke,
        unit: "react_profiler_commits",
      },
    ),
    editor_commits: measured(
      summarize(kept.map((row) => row.editor)),
      rows.slice(0, collected.warmup.length).map((row) => row.editor),
      {
        smoke: collected.smoke,
        unit: "react_profiler_commits",
      },
    ),
  };
}

let wrote = false;

try {
  let store:
    | ReturnType<typeof notMeasured>
    | Awaited<ReturnType<typeof measureStore>>;
  try {
    store = await measureStore();
  } catch (error) {
    store = notMeasured(error instanceof Error ? error.message : String(error));
  }
  let renders:
    | ReturnType<typeof notMeasured>
    | Awaited<ReturnType<typeof measureRenders>>;
  try {
    renders = await measureRenders();
  } catch (error) {
    renders = notMeasured(
      error instanceof Error ? error.stack || error.message : String(error),
    );
  }
  write({ store, renders });
  wrote = true;
} catch (error) {
  write({
    store: notMeasured(error instanceof Error ? error.message : String(error)),
    renders: notMeasured("ui bench failed before the render measurement"),
  });
  wrote = true;
}

bench(
  "ui partial json was written",
  () => {
    if (!wrote) throw new Error("ui partial json was not written");
  },
  { iterations: 1, time: 0, warmupIterations: 0, warmupTime: 0 },
);
