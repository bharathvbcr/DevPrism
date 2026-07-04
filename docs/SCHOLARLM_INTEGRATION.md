# ScholarLM / WisDev ARC Integration

DevPrism embeds the **ScholarLM** research capability through its open-source
runtime, **WisDev ARC** (Agent Research Core). This adds autonomous,
evidence-grounded research and grounded manuscript drafting directly inside the
LaTeX workspace, rendered with DevPrism's existing KaTeX math pipeline and
compilable through the built-in Tectonic + PDF preview.

## What you get

- **ScholarLM Research panel** — a new sidebar section (flask icon, "ScholarLM").
  - **Research** mode: runs the WisDev YOLO loop
    (`Query → Plan → Search → Analyze → Synthesize → Report`) and renders the
    evidence-grounded report as Markdown with full LaTeX math support. Metadata
    chips show iterations, papers found, synthesis mode, and convergence. It also
    surfaces the **ranked hypotheses** (with confidence bars and status) the agent
    explored and the **coverage gaps** it still sees. One click inserts the report
    at the editor cursor.
  - **ScholarDoc** mode (manuscript generation): generates a structured,
    compilable LaTeX manuscript (`docgen -f latex`) and saves it as a new `.tex`
    file in the project, opened in the editor and ready for the PDF preview.
    ScholarDoc is the single manuscript-generation path in DevPrism; manuscripts
    can be edited either as LaTeX source or in the rich (Word-like) editor view.
- **Live progress** — research runs stream real-time loop stages (planning,
  searching, admitting papers, sufficiency checks, synthesis) into the panel via
  the runtime's `--stages` output; degraded steps are flagged. The full trace is
  kept as a collapsible "Research trace" after the run.
- **Offline toggle** (panel header). Offline keeps the entire loop local — no
  cloud, no search providers, no API keys — so the feature works out of the box.
- **One-click runtime build** when only the Go source is present.
- **Runtime settings** (gear icon): configure the WisDev ARC repo path, an
  optional explicit binary path, and the max research iterations — persisted in
  the `devprism.scholarlm` store. A "Re-check runtime" button re-detects
  availability.
- **Command palette**: "ScholarLM: Research a question" / "ScholarDoc: Generate
  a manuscript" open the panel from anywhere (⌘K), via an
  `devprism:open-sidebar-section` event the sidebar listens for.

## Architecture

```
React panel  ──invoke──▶  Tauri (Rust) wisdev.rs  ──spawn──▶  wisdev CLI (Go)
  scholarlm-research-panel     wisdev_check / _build              yolo --json
  scholarlm-store              wisdev_research / _docgen          docgen -f latex
        │                                                              │
        └── MarkdownRenderer (remark-math + rehype-katex) ◀── report / manuscript
```

- Frontend: `apps/desktop/src/components/scholarlm/scholarlm-research-panel.tsx`,
  store `apps/desktop/src/stores/scholarlm-store.ts`.
- Host: `apps/desktop/src-tauri/src/wisdev.rs` (registered in `lib.rs`).
- Runtime: the `wisdev` Go CLI shipped in the ScholarLM repo under `wisdev-arc/`.

## Runtime resolution

`wisdev.rs` locates a runner in this order:

1. An explicit binary path (`binaryPath` setting), if set and it exists.
2. `<repo>/dist/wisdev` — the prebuilt binary (produced by **Build runtime**).
3. `go run ./cmd/wisdev` from `<repo>/orchestrator` — needs the Go toolchain.

The default repo path is `/Users/bharath/Code/scholarlm/wisdev-arc`; change it in
the `devprism.scholarlm` persisted store (`repoPath`). PATH is augmented for
GUI-launched apps so Homebrew / `go` are found.

## Tauri commands

| Command | CLI it drives | Returns |
|---|---|---|
| `wisdev_check` | filesystem + `go version` | runtime status (mode, availability) |
| `wisdev_build` | `go build -o dist/wisdev ./cmd/wisdev` | built binary path |
| `wisdev_research` | `wisdev yolo --json [--offline] [--max-iterations N]` | structured report |
| `wisdev_docgen` | `wisdev docgen -f latex\|markdown\|json [--offline]` | manuscript text |

The runtime writes structured logs to stdout before its payload;
`wisdev.rs` strips those and parses the trailing JSON (research) or the manuscript
body (docgen).

`wisdev_research` also passes `--stages`, reads the runtime's stderr line-by-line,
parses each `✓/⚠ [stage] message — …` line into a `{stage, message, degraded}`
event, and emits it on the `wisdev-stage` Tauri channel. The panel subscribes to
that channel for the duration of a run to show live progress.

## Verifying

Offline smoke test (no keys required):

```bash
cd /Users/bharath/Code/scholarlm/wisdev-arc/orchestrator
go build -o ../dist/wisdev ./cmd/wisdev
../dist/wisdev yolo --json --offline "What evidence supports RAG for scientific literature?"
../dist/wisdev docgen -f latex --offline "Retrieval-augmented generation"
```

Online research uses whatever WisDev is configured for (Gemini/Vertex, an
OpenAI-compatible endpoint, or Ollama) via `wisdev-arc/.env`; without it the loop
degrades gracefully to a heuristic synthesis.

## Notes

- The desktop Rust build requires the project's Tectonic native toolchain
  (`pnpm build:macos` with the vcpkg backend). The ScholarLM commands themselves
  depend only on std/tokio/serde, already in `Cargo.toml`.
- Parsing logic is covered by an offline harness run against real CLI output.
