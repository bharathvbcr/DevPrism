# Native local agent (no Claude CLI)

English · [한국어](NATIVE_AGENT.ko.md) · [日本語](NATIVE_AGENT.ja.md) · [简体中文](NATIVE_AGENT.zh-CN.md)

DevPrism includes a built-in agent runtime that talks **directly to a local
[Ollama](https://ollama.com) model** or any **OpenAI-compatible API** (Groq,
OpenRouter, Gemini, …) — no Claude Code CLI and no translation proxy for the
native path.

## Enabling Ollama

1. Install and start Ollama, and pull a **tool-capable** model:
   ```bash
   ollama pull llama3.1      # or qwen2.5, mistral-nemo, …
   ```
   (Small models without tool-calling support can chat but won't use tools.)
2. In DevPrism: **Settings → Provider → Agent backend → Native Ollama**.
3. (Optional) Configure the Ollama endpoint/model as an OpenAI-compatible
   provider in the same panel. If you don't, the runtime defaults to
   `http://localhost:11434` and the first installed model.

## Native API (Groq / OpenRouter / Gemini / …)

For cloud OpenAI-compatible providers without the Claude CLI:

1. Add a credential in **Settings → Provider** (Groq, OpenRouter, Gemini, or
   custom base URL). Presets already exist for common hosts.
2. Select **Agent backend → Native API**, then pick that credential in the chat
   composer.
3. **Native Groq** remains available as a convenience alias that prefers a Groq
   credential and defaults to `llama-3.3-70b-versatile`.

The optional [groq-code-cli](https://github.com/build-with-groq/groq-code-cli)
can be installed for terminal use — it is **not** spawned for in-app chat.

When a native backend is active, Claude Code and other cloud CLI providers are
not used for chat. Embeddings prefer Gemini/OpenAI `/embeddings` when such a
credential is selected; otherwise they use local Ollama.

## What it does

- Runs an agentic loop in Rust: it reads/edits your files with built-in tools and
  keeps going until the task is done — same chat UI, diffs, and "Keep/Undo" flow.
- **Tools:** `Read`, `Write`, `Edit` (with `replace_all`), `MultiEdit` (several
  edits to one file applied atomically — handy for multi-spot `.tex`/`.bib` edits),
  `LS`, `Grep` (with `glob`/`case_sensitive` scoping), `Glob`, `Bash` (runs in the
  project, activates `.venv`). All file access is confined to the project directory.
  On top of these built-ins the agent advertises a curated subset of the plugin
  registry — knowledge-base search, resume synthesis / gap analysis / compile,
  and guarded resume document editing (`resume_doc_*`, `resume_variant_*`);
  packs opt in per tool, see [PLUGINS.md](PLUGINS.md).
- **Project context:** auto-discovers your master/instruction files, a project
  map, and installed skills (see [CONTEXT_FILES.md](CONTEXT_FILES.md)).
- **Memory:** remembers the conversation per chat tab.
- **Vision:** pasted images are sent to vision-capable models (e.g. `llava`,
  `llama3.2-vision`).
- **Streaming:** text/thinking deltas are coalesced in Rust (~40 ms or 1 KiB
  windows) before crossing IPC, so chatty local models don't flood the chat UI.

## Tuning (Settings → Provider, when native is on)

- **Context window (`num_ctx`)** — how much the model can "see" (default 8192).
  Larger = more memory/VRAM. Lower it on small machines; raise it for long
  documents/conversations.
- **Temperature** — default 0.4 (low = more deterministic edits).
- **`keep_alive`** — how long Ollama keeps the model resident between turns
  (default `10m`); the runtime accepts an override so a warm model isn't reloaded
  each round.

## Notes & limitations

- Tool-calling quality depends on the model; prefer `llama3.1` / `qwen2.5` /
  `mistral-nemo` over tiny non-tool models.
- Conversation memory is in-process (cleared on "new chat"/closing a tab; not yet
  persisted across app restarts).
- Assistant text is streamed token-by-token to the chat as it is generated; tool
  calls are reconciled per round.
