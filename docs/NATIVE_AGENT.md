# Native local agent (no Claude CLI)

DevPrism includes a built-in agent runtime that talks **directly to a local
[Ollama](https://ollama.com) model** — no Claude Code CLI and no translation
proxy. It's fully offline and self-contained.

## Enabling it

1. Install and start Ollama, and pull a **tool-capable** model:
   ```bash
   ollama pull llama3.1      # or qwen2.5, mistral-nemo, …
   ```
   (Small models without tool-calling support can chat but won't use tools.)
2. In DevPrism: **Settings → Provider → "Native local agent (no Claude CLI)"**.
3. (Optional) Configure the Ollama endpoint/model as an OpenAI-compatible
   provider in the same panel. If you don't, the runtime defaults to
   `http://localhost:11434` and the first installed model.

When the toggle is on, the chat uses the native runtime; the cloud providers are
used only when it's off.

## What it does

- Runs an agentic loop in Rust: it reads/edits your files with built-in tools and
  keeps going until the task is done — same chat UI, diffs, and "Keep/Undo" flow.
- **Tools:** `Read`, `Write`, `Edit` (with `replace_all`), `LS`, `Grep` (with
  `glob`/`case_sensitive` scoping), `Glob`, `Bash` (runs in the project, activates
  `.venv`). All file access is confined to the project directory.
- **Project context:** auto-discovers your master/instruction files, a project
  map, and installed skills (see [CONTEXT_FILES.md](CONTEXT_FILES.md)).
- **Memory:** remembers the conversation per chat tab.
- **Vision:** pasted images are sent to vision-capable models (e.g. `llava`,
  `llama3.2-vision`).

## Tuning (Settings → Provider, when native is on)

- **Context window (`num_ctx`)** — how much the model can "see" (default 8192).
  Larger = more memory/VRAM. Lower it on small machines; raise it for long
  documents/conversations.
- **Temperature** — default 0.4 (low = more deterministic edits).

## Notes & limitations

- Tool-calling quality depends on the model; prefer `llama3.1` / `qwen2.5` /
  `mistral-nemo` over tiny non-tool models.
- Conversation memory is in-process (cleared on "new chat"/closing a tab; not yet
  persisted across app restarts).
- Output is per-response (not token-by-token streaming), matching the chat UI's
  message model.
