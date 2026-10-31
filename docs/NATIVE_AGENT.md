# Native local agent (no Claude CLI)

English · [한국어](NATIVE_AGENT.ko.md) · [日本語](NATIVE_AGENT.ja.md) · [简体中文](NATIVE_AGENT.zh-CN.md)

Chat turns are a `manvi run` process. That covers a local
[Ollama](https://ollama.com) model, an OpenAI-compatible API (Groq, OpenRouter,
Gemini, …), and Claude chat through Manvi's Anthropic harness. The chat UI
still receives the same `claude-output` and `claude-complete` events.

One-shot completion, embeddings, captions, and Ollama model admin stay in
DevPrism. Cursor CLI chat is unchanged. On the Claude backend, a selected
OpenAI-compatible credential still uses that provider. A missing `manvi`
binary fails the turn.

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

When a native backend is active, the Claude Code CLI is not used for chat.
Embeddings prefer Gemini/OpenAI `/embeddings` when such a credential is
selected; otherwise they use local Ollama.

## Claude models

The picker offers Opus, Sonnet, Haiku, and Opus Plan. Opus, Sonnet, and Haiku
map to `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. Opus
Plan is not a catalogue id: the session model is Opus and the heavy tier is
Sonnet, so Opus plans the turn and Sonnet writes. The advisor tier stays on
Opus, and the cache key stays the picker string `opusplan`. The host pins a
Manvi tier only when that tier's shipped input price is higher than the model
you picked, so a Sonnet chat cannot start an Opus or Fable side call. Effort
is `low`, `medium`, or `high`. The Anthropic key is the one stored in
Settings. When that store has no key, the turn uses `ANTHROPIC_API_KEY` from
the app's own environment. `bun run dev:desktop` rebuilds the Manvi sidecar
when the sibling checkout's Go sources are newer than the binary on disk.

## What it does

- Spawns `manvi run --json` and translates Manvi events into the chat stream.
  The same chat UI, diffs, and Keep/Undo flow still apply.
- **Tools** come from Manvi's harness plus DevPrism's MCP server, including
  `latex_compile` for the open project. See [PLUGINS.md](PLUGINS.md).
- **Host prefix:** the open file, the selection (text and 1-based lines), the
  last compile status, and the on-device personalization profile when that
  profile has something to say. Manvi keeps its own system prompt. The profile
  is added once, in the user prefix.
- **Approvals** answer on a pipe. There is no
  `--dangerously-skip-permissions` flag.
- **Sessions** are Manvi ids prefixed `manvi:`. They are remembered for the
  running app, and after a restart when this project still has the session
  file and the chat UI sends the stored `manvi:` id. New Chat drops that id.
  They are not Claude Code session files.
- **Vision:** up to four pasted images, 8 MiB each, png/jpeg/gif/webp.
- **Streaming:** text and thinking deltas are coalesced before they cross IPC.
  A heartbeat every 30 seconds keeps a quiet tool call from looking stalled.

Chat-only mode passes `--chat-only`. The composer sets it for an Ollama model
that cannot call tools, and the host also sets it when Ollama's `/api/show`
lists capabilities and omits `tools`. That case emits the same assistant
notice as the previous engine. `keep_alive` is sent only to Ollama, and an
unset value is `10m`. Temperature and context window are sent only for the
local provider, and only when the caller set them. A cloud OpenAI-compatible
host with an empty key fails the turn. A Vertex OpenAI-compatible base mints
a bearer through the existing Google auth path and sends it as `LOCAL_API_KEY`.

## Tuning (Settings → Provider, when a local model is on)

- **Context window (`num_ctx`)** and **temperature** are forwarded to the local
  provider when you set them. They are not sent to Anthropic, and the host does
  not invent the old defaults of 8192 and 0.4.
- **`keep_alive`** is forwarded to Ollama. Unset means `10m`. It is not sent
  to Anthropic or to another OpenAI-compatible host.

## Notes & limitations

- Tool-calling quality depends on the model.
- A Manvi session id survives an app restart when the project still has the
  session file and the chat UI sends the stored id. New Chat omits `--resume`.
- A paper whose `.devcouncil/config.yaml` sets `llm.tier` is refused. The host
  does not let `manvi run` scaffold `.devcouncil` in the project.
