import { EditorSelection, EditorState } from "@codemirror/state";
import { collectSamples, measured, notMeasured } from "./stats";

/** Document sizes the per-keystroke cost is measured against. */
const SIZES = [4096, 32768, 131072, 524288];

/**
 * One CodeMirror transaction that inserts a character, then materializes the
 * document with `doc.toString()`. This is the editor's per-keystroke document
 * cost. It is not keystroke-to-preview latency, and it does not time
 * `schedule()` from the debounced content push.
 */
function keystrokeMs(base: EditorState): number {
  const at = base.doc.length;
  const started = performance.now();
  const transaction = base.update({
    changes: { from: at, insert: "x" },
    selection: EditorSelection.cursor(at + 1),
    userEvent: "input.type",
  });
  const text = transaction.state.doc.toString();
  const ms = performance.now() - started;
  if (!transaction.isUserEvent("input.type")) {
    throw new Error("transaction was not input.type");
  }
  if (text.length !== at + 1 || transaction.state.doc.length !== at + 1) {
    throw new Error("document did not grow by one character");
  }
  return ms;
}

export async function measureKeystroke() {
  try {
    const bySize = [];
    for (const size of SIZES) {
      const base = EditorState.create({ doc: "a".repeat(size) });
      if (base.doc.length !== size) {
        throw new Error(`fixture document length ${base.doc.length}`);
      }
      const { summary, warmup, smoke } = await collectSamples(() =>
        keystrokeMs(base),
      );
      bySize.push(
        measured(summary, warmup, {
          smoke,
          document_chars: size,
          unit: "ms",
          what: "EditorState.update insert plus doc.toString, same base state each sample",
          environment: "node/bun, no EditorView, no webview",
          not_preview_latency: true,
        }),
      );
    }
    return {
      status: "measured" as const,
      replaces: "apps/desktop/scripts/bench-typing.ts",
      note: "bench-typing timed createDebouncedContentPush.schedule and described that as snapshot stringification. This times a real CodeMirror input transaction and doc.toString().",
      by_document_chars: bySize,
    };
  } catch (error) {
    return notMeasured(error instanceof Error ? error.message : String(error));
  }
}
