# DevPrism Improvement Audit — UI/UX, AI Helpfulness, Local LLM

*July 2026. Read-only audit of `apps/desktop` (React + Tauri). Findings were code-verified; claims that failed verification were dropped or corrected (see final section).*

## What already works well

The app has a solid foundation: consistent shadcn/ui primitives, clean Zustand stores as a single source of truth, a native Rust agent with a well-scoped tool surface (`Read`, `Write`, `Edit`, `LS`, `Grep`, `Bash`, `Glob` in `src-tauri/src/native_agent/tools.rs`), streaming chat with cancellation (`cancelExecution` wired into `chat-composer.tsx`), per-message cost display (`chat-messages.tsx:828`), an existing AI "explain compile errors" affordance in the PDF preview (`explainCompileErrorsStream` in `pdf-preview.tsx`), stale-stream invalidation for those explanations, and Ollama capability detection that merges `/api/show` with name heuristics and tracks its source (`lib/ollama.ts:221-232`).

## UI/UX

**High.** Onboarding stacks several dialogs before a user reaches a working project (`project-picker.tsx`, `project-wizard.tsx`, plus Claude/uv/dev-engine setup flows). Collapse this into a single wizard with progressive disclosure, and let setup steps be deferred rather than blocking. Loading feedback is inconsistent across the workspace — a mix of spinners, null renders, and nothing; standardize on skeletons for panel-level loads and inline spinners only for button-level actions. Settings (`personalization-settings.tsx`, `settings-store`) expose a large flat list of toggles; group them by task (Editor, AI, Compilation, Appearance) with search.

**Medium.** Panel resize handles in `workspace-layout.tsx` are hard to discover — add hover affordances and double-click-to-reset. Accessibility gaps: focus is not consistently trapped/restored across the modal-heavy onboarding, and several icon-only buttons lack labels (the preview's compile-error indicator does have one, `pdf-preview.tsx:241`). Error surfacing outside the preview relies heavily on toasts (`toast.error` throughout `pdf-preview.tsx`), which vanish; route persistent failures (compile, export, file-not-in-project) to a dismissable inline banner instead. Template gallery would benefit from live thumbnails rather than static metadata.

**Low.** Minor spacing/typography drift between `components/ui/*` usage and ad-hoc styles; dark-mode contrast on secondary text in the preview toolbar.

## AI helpfulness

**High.** The agent has no structured compile loop: it can run `Bash`, but there is no `Compile` tool returning parsed LaTeX errors, so the agent can't reliably verify its own edits. Adding a compile tool + parsed log output to `native_agent/tools.rs` is the single highest-leverage AI change. Relatedly, the preview can *explain* compile errors, but there's no one-click **"Fix with AI"** that hands the parsed error, file, and line to the agent chat to propose an edit — the explain panel already has the context; add the handoff. Context injection covers current file and selection, but compile state and bibliography metadata are not part of prompt assembly (`claude-chat-store.ts`, `native_agent/mod.rs`); injecting last-compile status makes answers to "why won't this build" work without pasting logs.

**Medium.** Proposed-changes flow (`proposed-changes-store`) tracks and reverts changes but shows no side-by-side diff before apply — render a diff view per file and allow per-file accept/reject. Cost is shown per message but there's no session-level context-window usage indicator, which matters most for small-context local models. Starter prompts in empty states are generic; make them project-aware (e.g., "Summarize chapter 2", "Fix the 3 unresolved citations").

**Low.** No "ask user a question" tool in the agent's surface, so it guesses instead of clarifying; tool-call rendering could collapse repetitive Read/Grep sequences.

## Local LLM (Ollama)

**Current state.** The Ollama path runs through the native Rust agent (`native_agent/ollama.rs`) with model discovery, status polling (`use-ollama-status.ts`), capability detection (`use-ollama-model-capabilities.ts` with per-model caching), setup hints, and error classification. This is a genuinely complete local path, not a stub.

**Gaps vs. the Claude path (High).** Capability handling degrades silently: when `/api/show` is unavailable, detection falls back to name heuristics (`lib/ollama.ts:201`), and error classification is string-sniffing on error messages (`lib/ollama.ts:163-194`) — fragile against Ollama version changes. Surface capability source ("detected" vs. "guessed") in the model badge, and when a model lacks tool support, switch the UI into an explicit chat-only mode instead of letting tool calls fail downstream. Context truncation for small-context models is invisible to the user — show what was dropped.

**Setup friction (Medium).** Status polling and setup hints are good; the remaining friction is model pull UX (no in-app progress for `ollama pull`) and recovery guidance when the daemon dies mid-session.

**Opportunities (ranked).** First, local embeddings for project-wide semantic search — biggest win, no quality risk, works offline. Second, LaTeX error explanation via the local model as a free fallback to the existing explain stream. Third, title/summary generation for chats and documents. Fourth, inline autocomplete — highest latency/quality risk; gate behind capability + hardware checks. Architecturally, these all want a small provider-trait abstraction on the Rust side so "cheap local task" routing is one decision point, not per-feature plumbing.

## Prioritized roadmap

| # | Change | Area | Impact | Effort |
|---|--------|------|--------|--------|
| 1 | `Compile` tool with parsed errors for the agent | AI | High | Medium |
| 2 | "Fix with AI" handoff from compile-error panel | AI+UX | High | Small |
| 3 | Inject compile state into prompt context | AI | High | Small |
| 4 | Explicit chat-only mode for non-tool Ollama models + capability-source badge | Local LLM | High | Small |
| 5 | Single-flow onboarding wizard | UX | High | Medium |
| 6 | Diff view in proposed-changes panel | AI | Medium | Medium |
| 7 | Context-window usage indicator (esp. local models) | AI+Local | Medium | Small |
| 8 | Standardized loading skeletons + inline error banners | UX | Medium | Medium |
| 9 | Local embeddings for semantic search | Local LLM | Medium | Large |
| 10 | Settings regrouping + search | UX | Medium | Small |

## Verification notes

Claims from the audit that were checked and **corrected**: a Stop/cancel control exists (`chat-composer.tsx:294`); per-message cost is displayed (`chat-messages.tsx:828-830`); space deletion has a confirmation dialog (`project-picker.tsx:2530`); an AI explain-errors button already exists in the preview (`pdf-preview.tsx:1397-1472`). Claims verified as **true**: no compile tool in the agent's tool schema (`native_agent/tools.rs:43-100`); capability heuristics and string-based error sniffing (`lib/ollama.ts`); toast-heavy error surfacing in the preview.
