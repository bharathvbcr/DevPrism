import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { latexCompletionSource as packageCompletionSource } from "codemirror-lang-latex";
import { parseBibFile } from "@/lib/bibtex";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { suggestCitations, canUseAiAssist } from "@/lib/ai-assist";
import { useSettingsStore } from "@/stores/settings-store";

// LaTeX autocompletion: offers context-aware suggestions for
//   • \cite{…}        → BibTeX keys gathered from the project's .bib files
//   • \ref{…} etc.    → \label{…} targets gathered from the project's .tex files
//   • \begin{…}/\end  → common environment names (auto-closes \begin)
//   • \command        → a curated list of frequently used LaTeX commands
//
// All project data is read on demand from the document store so completions
// always reflect the latest in-memory file contents (including unsaved edits).

/** Collect BibTeX keys from every .bib file plus inline \bibitem{…} keys. */
function collectBibEntries(files: ProjectFile[]) {
  const entries: ReturnType<typeof parseBibFile> = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.type === "bib" && f.content) {
      for (const e of parseBibFile(f.content)) {
        if (!seen.has(e.key)) {
          seen.add(e.key);
          entries.push(e);
        }
      }
    }
  }
  // Inline \bibitem{key} entries inside .tex files (thebibliography environment).
  const bibitemRe = /\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  for (const f of files) {
    if (f.type !== "tex" || !f.content) continue;
    let m: RegExpExecArray | null;
    while ((m = bibitemRe.exec(f.content)) !== null) {
      const key = m[1].trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        entries.push({
          key,
          type: "bibitem",
          raw: m[0],
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    }
  }
  return entries;
}

interface LabelEntry {
  label: string;
  file: string;
}

/** Collect \label{…} targets from every .tex file in the project. */
function collectLabels(files: ProjectFile[]): LabelEntry[] {
  const labels: LabelEntry[] = [];
  const seen = new Set<string>();
  const labelRe = /\\label\s*\{([^}]+)\}/g;
  for (const f of files) {
    if (f.type !== "tex" || !f.content) continue;
    let m: RegExpExecArray | null;
    while ((m = labelRe.exec(f.content)) !== null) {
      const label = m[1].trim();
      if (label && !seen.has(label)) {
        seen.add(label);
        labels.push({ label, file: f.name });
      }
    }
  }
  return labels;
}

// Commands whose braces hold a citation key (complete from BibTeX keys).
const CITE_RE =
  /\\(?:cite|citep|citet|citeauthor|citeyear|citeyearpar|Cite|Citep|Citet|parencite|Parencite|textcite|Textcite|autocite|Autocite|smartcite|footcite|footcitetext|fullcite|nocite|supercite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{[^}]*$/;

// Commands whose braces hold a cross-reference label.
const REF_RE =
  /\\(?:ref|eqref|autoref|cref|Cref|crefrange|pageref|nameref|vref|Vref|labelcref|fref|Fref)\*?\s*\{[^}]*$/;

/** Build the lexical \cite{…} completion options from BibTeX entries. */
function buildCiteOptions(
  entries: ReturnType<typeof collectBibEntries>,
): Completion[] {
  return entries.map((e) => ({
    label: e.key,
    type: "constant",
    detail: e.year,
    info: [e.author, e.title].filter(Boolean).join(" — ") || undefined,
  }));
}

function latexCompletionSource(
  context: CompletionContext,
): CompletionResult | Promise<CompletionResult | null> | null {
  const files = useDocumentStore.getState().files;

  // ── Citation keys ──────────────────────────────────────────────────────
  if (context.matchBefore(CITE_RE)) {
    const token = context.matchBefore(/[\w:.-]*$/);
    const from = token ? token.from : context.pos;
    const entries = collectBibEntries(files);
    if (entries.length === 0 && !context.explicit) return null;
    const options = buildCiteOptions(entries);
    const lexical: CompletionResult = { from, options, validFor: /^[\w:.-]*$/ };

    // AI-ranked keys: prepend the model's top picks ahead of the lexical list.
    // Gated on the bib-assist toggle + provider availability. Always falls back
    // to the lexical completions if the AI call is slow, fails, or is disabled.
    if (
      entries.length > 0 &&
      useSettingsStore.getState().aiBibAssist &&
      canUseAiAssist()
    ) {
      const before = context.state.sliceDoc(
        Math.max(0, context.pos - 600),
        context.pos,
      );
      return suggestCitations(
        before,
        entries.map((e) => ({
          key: e.key,
          title: e.title,
          author: e.author,
          year: e.year,
        })),
      )
        .then((ranked): CompletionResult => {
          if (!ranked || ranked.length === 0) return lexical;
          const byKey = new Map(options.map((o) => [o.label, o]));
          const boosted: Completion[] = [];
          const seen = new Set<string>();
          for (const key of ranked) {
            const base = byKey.get(key);
            if (!base || seen.has(key)) continue;
            seen.add(key);
            boosted.push({
              ...base,
              detail: base.detail ? `★ AI · ${base.detail}` : "★ AI",
              boost: 99,
            });
          }
          if (boosted.length === 0) return lexical;
          const rest = options.filter((o) => !seen.has(o.label));
          return { from, options: [...boosted, ...rest], validFor: /^[\w:.-]*$/ };
        })
        .catch(() => lexical);
    }

    return lexical;
  }

  // ── Cross-reference labels ─────────────────────────────────────────────
  if (context.matchBefore(REF_RE)) {
    const token = context.matchBefore(/[\w:.-]*$/);
    const from = token ? token.from : context.pos;
    const labels = collectLabels(files);
    if (labels.length === 0 && !context.explicit) return null;
    const options: Completion[] = labels.map((l) => ({
      label: l.label,
      type: "variable",
      detail: l.file,
    }));
    return { from, options, validFor: /^[\w:.-]*$/ };
  }

  // Environments, commands, and snippets are handled by the package's built-in
  // completion source, which runs alongside this one.
  return null;
}

/**
 * CodeMirror extension providing LaTeX-aware autocompletion.
 *
 * The host must construct the language with `enableAutocomplete: false` so this
 * is the only `autocompletion()` in the configuration — two of them collide on
 * the non-mergeable `override` facet field. We layer our project-aware source
 * (bib keys, labels) on top of the package's built-in command/snippet source so
 * neither set of completions is lost.
 */
export function latexAutocomplete() {
  return autocompletion({
    override: [latexCompletionSource, packageCompletionSource(true)],
    activateOnTyping: true,
    icons: true,
  });
}
