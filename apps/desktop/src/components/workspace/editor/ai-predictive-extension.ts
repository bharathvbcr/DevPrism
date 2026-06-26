import {
  Compartment,
  StateEffect,
  StateField,
  Prec,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { keymap } from "@codemirror/view";
import {
  canUseAiAssist,
  extractProseContext,
  fetchPredictiveContinuation,
} from "@/lib/ai-assist";
import { recordPersonalizationEvent } from "@/lib/personalization";
import { useSettingsStore } from "@/stores/settings-store";

export const setGhostText = StateEffect.define<string | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ai-ghost-text";
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

interface GhostState {
  text: string | null;
  pos: number;
}

const ghostField = StateField.define<GhostState>({
  create() {
    return { text: null, pos: 0 };
  },
  update(value, tr) {
    let { text, pos } = value;
    for (const effect of tr.effects) {
      if (effect.is(setGhostText)) {
        text = effect.value;
        pos = tr.state.selection.main.head;
      }
    }
    if (tr.docChanged) {
      text = null;
    }
    return { text, pos };
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const { text, pos } = state.field(field);
      if (!text) return Decoration.none;
      const head = state.selection.main.head;
      if (head !== pos) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new GhostWidget(text),
          side: 1,
        }).range(pos),
      ]);
    }),
});

function acceptGhostText(view: EditorView): boolean {
  const { text, pos } = view.state.field(ghostField);
  if (!text || view.state.selection.main.head !== pos) return false;
  recordPersonalizationEvent("predictive_accepted", { surface: "editor" });
  view.dispatch({
    changes: { from: pos, insert: text },
    effects: setGhostText.of(null),
    selection: { anchor: pos + text.length },
  });
  return true;
}

function dismissGhostText(view: EditorView): boolean {
  const { text } = view.state.field(ghostField);
  if (!text) return false;
  view.dispatch({ effects: setGhostText.of(null) });
  return true;
}

const predictivePlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private requestId = 0;
    private lastPos = -1;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (!useSettingsStore.getState().aiPredictiveText || !canUseAiAssist()) {
        return;
      }
      if (!update.docChanged && !update.selectionSet) return;

      const head = update.state.selection.main.head;
      if (this.timer) clearTimeout(this.timer);

      this.timer = setTimeout(() => {
        void this.fetchSuggestion(head);
      }, 1600);
    }

    private async fetchSuggestion(cursor: number) {
      const doc = this.view.state.doc.toString();
      const { prefix, inProse } = extractProseContext(doc, cursor);
      if (!inProse || !prefix) {
        this.view.dispatch({ effects: setGhostText.of(null) });
        return;
      }
      if (cursor === this.lastPos) return;
      this.lastPos = cursor;

      const id = ++this.requestId;
      try {
        const suggestion = await fetchPredictiveContinuation(prefix);
        if (id !== this.requestId) return;
        if (!suggestion || this.view.state.selection.main.head !== cursor)
          return;
        this.view.dispatch({ effects: setGhostText.of(suggestion) });
      } catch {
        if (id === this.requestId) {
          this.view.dispatch({ effects: setGhostText.of(null) });
        }
      }
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

export const aiPredictiveCompartment = new Compartment();

export function aiPredictiveExtension(enabled: boolean): Extension {
  if (!enabled) return [];
  return [
    ghostField,
    predictivePlugin,
    EditorView.baseTheme({
      ".cm-ai-ghost-text": {
        opacity: "0.45",
        pointerEvents: "none",
      },
    }),
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: acceptGhostText,
        },
        {
          key: "Escape",
          run: dismissGhostText,
        },
      ]),
    ),
  ];
}
