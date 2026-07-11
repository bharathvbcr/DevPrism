# Cursor CLI integration

DevPrism can use the [Cursor CLI](https://cursor.com/docs/cli/headless) as a chat backend (`agentBackend: "cursor-cli"`).

## Setup

1. Install the Cursor CLI:
   ```bash
   curl https://cursor.com/install -fsS | bash
   ```
2. Authenticate with one of:
   - `agent login` (browser flow)
   - `CURSOR_API_KEY` environment variable
   - Service account key (enterprise)
3. In DevPrism: **Settings → Provider → Agent backend → Cursor CLI**.

## Runtime paths

| Path | When used |
|------|-----------|
| **ACP** (primary) | Spawns `agent acp` with JSON-RPC over stdio. Handles `session/new`, `session/prompt`, permission auto-allow. |
| **stream-json** (fallback) | When ACP fails or ACP is disabled: `agent -p --output-format stream-json`. Events are adapted to Claude-shaped NDJSON for the existing chat UI. |

Toggle **Prefer ACP protocol** in Settings when the Cursor backend is selected.

## Session resume

- ACP: `session/load` with stored session id
- stream-json: `--resume SESSION_ID`

Session history appears in the chat UI like Claude Code sessions.

## Notes

- Cursor stream format differs from Claude for tools; DevPrism uses `stream_adapter.rs` to map events.
- Blocking extension requests (`cursor/ask_question`, `cursor/create_plan`) should surface in the UI via the existing AskUser pattern.
- The Cursor CLI is **not** the same as the Cursor desktop editor — only the headless `agent` binary is used.
