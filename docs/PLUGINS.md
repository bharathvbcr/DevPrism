# Plugins 1.0

DevPrism's capability packs: one registration point that serves tools,
resources and prompts to **both** consumers of the engine — the MCP 2.0 server
(stdio, HTTP and the in-app Tauri commands) and the built-in native agent.

## Why

Before this layer there were two routing authorities that could drift:

1. `mcp/server.rs` dispatched `tools/call` by string prefix (`career_*` /
   `resume_*`) against a hardcoded module list;
2. `native_agent/tools.rs` hand-copied four tool schemas and re-implemented
   their dispatch.

Plugins 1.0 replaces both with a single registry. Registering two packs that
claim the same tool name is now a boot failure instead of a silent shadow.

## The contract

A pack implements `CapabilityPlugin` (`src-tauri/src/plugins/mod.rs`):

| Method | Serves |
| --- | --- |
| `id` / `version` / `description` | provenance — every definition carries `_meta.pluginId`, and `tools/list` returns `_meta.plugins` with a summary |
| `tools` | MCP tool definitions |
| `resources` | static resources (URI-unique across packs) |
| `prompts` | prompt templates |
| `call_tool` / `read_resource` / `get_prompt` | execution; state arrives per call via `PluginContext` (career DB handle, task manager, elicitation store) |
| `native_agent_tools` | the curated subset advertised to the built-in agent's model context |

Packs hold no state. Everything they touch flows through `PluginContext`, so
confirmations issued by any pack are redeemable across calls exactly as the
pre-plugin server behaved.

### Shipped packs

| Pack | Tools | Notes |
| --- | --- | --- |
| `career-knowledgebase` | `career_*` (9) + 3 resources | unchanged behaviour, now routed through the registry |
| `resume-synthesis` | `resume_*` analysis/synthesis/compile (7) + 4 prompts | `resume_compile` now honours `include_pdf` (default **false**, reports `pdfOmitted` honestly) |
| `resume-documents` | `resume_doc_*` / `resume_variant_*` (10) + `resume_compile_file`, `resume_save_synthesis`, `resume-docs://projects`, `edit-resume-with-engine` prompt (12 tools total) | new; see below |

Adding a pack: implement the trait, register it in `plugins::default_registry`,
and the compiler plus the registry tests do the rest (duplicate names,
schema-shape and advertisement consistency are all asserted at boot/test time).

## Resume document editing (`resume-documents`)

This is the capability that lets an external agent **edit or modify your
actual resume documents** — master project files and tailored variants under
`<project>/.prism/variants/<slug>/` — using DevPrism's engine, rather than only
generating fresh synthesis output in-band.

| Tool | What it does |
| --- | --- |
| `resume_doc_list_projects` | lists registered projects — the only roots these tools may touch |
| `resume_doc_list_files` | source files of a project (dot-dirs excluded) |
| `resume_doc_read` | UTF-8 file + its sha1 (chain into writes) |
| `resume_doc_write` | create or overwrite; overwrites need `expected_sha1`; backs up first |
| `resume_doc_edit` | MultiEdit-style atomic exact-string edits, all-or-nothing, needs `expected_sha1` |
| `resume_variant_list/create/update/delete/diff` | tailored-version lifecycle; delete is human-gated |
| `resume_compile_file` | in-process Typst compile of a project source; optional PDF persist to `.prism/build/` |
| `resume_save_synthesis` | persists generated Typst as a NEW variant (snapshot → write source → compile verification PDF → record JD); never touches the master |

### Safety model

* **Known-project gate** — every path argument must resolve to a folder the
  desktop app has registered in the `known_projects` table of `career.db`
  (written when a project is opened; see `project-store.ts`). Unknown roots
  are refused with guidance; `/etc/passwd` is not a resume.
* **Confinement** (`plugins/path_guard.rs`) — no `..`, no absolute paths
  outside the root, leading `-` rejected, symlink escapes resolved on the
  longest existing ancestor and refused.
* **Read-before-write** — overwrites require the sha1 from a prior read
  (optimistic concurrency). A stale writer is refused *with the current sha*
  so it can recover honestly. Two interleaved editors cannot clobber each
  other silently.
* **Major-reduction guard** — removing more than half of a non-trivial file
  requires `allow_major_reduction: true`.
* **Backups** — every destructive overwrite copies prior content to
  `.prism/mcp-backups/<timestamp>/<relative path>`; backup failure aborts the
  operation rather than skipping it quietly.
* **Human confirmation** — `resume_variant_delete` uses the same single-use,
  tool+subject-bound MRTR elicitation as `career_delete_block`. Forged or
  replayed tokens are burned, never honoured.
* **Text-only writes** — `.typ .tex .md .txt .json .yaml .yml .bib .cls .sty
  .csv`; binaries stay out of agent reach.
* **Atomicity** — temp-file + rename; readers never observe half-writes, and
  hostile fuzzing asserts no temp files leak.

## Built-in agent integration

`native_agent/tools.rs` no longer maintains its own copy of career/resume
schemas: it appends `shared_registry().native_agent_schemas()` and routes any
advertised name through the registry. Packs opt in per tool via
`native_agent_tools()` because local-model context windows are small. The
agent bridge still forces `async:false` (it has no `tasks/get` surface) and
suppresses PDF bytes.

## Verifying

```bash
cd apps/desktop/src-tauri && cargo test --lib plugins
cd apps/desktop/src-tauri && cargo test --lib mcp::stress   # filesystem properties
cd apps/desktop && pnpm test src/__tests__/lib/mcp-client.test.ts
```

Live smoke test through the real stdio transport:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | ./target/debug/claude-prism-desktop --mcp
```

Expect 29 tools across the three packs and `_meta.plugins` naming them.
