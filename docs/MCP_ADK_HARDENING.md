# MCP + agent-runtime hardening

An audit of the two harness surfaces — the MCP server (`src-tauri/src/mcp/`) and
the in-app agent runtime (`src-tauri/src/native_agent/`) — and what was changed.

Findings were produced by four independent read-only audits run in parallel, one
per surface, each required to falsify its own findings before reporting. Two of
them independently identified the same critical defect, which is noted below.
Every fix carries a regression test that fails against the pre-fix code.

## Threat model

`main.rs --mcp` and `--mcp-http` expose the career knowledgebase — the user's
employment history, contact details, and every ingested document — to any MCP
client, with no authentication and no per-call authorization. Tool arguments are
arbitrary JSON from that client. The client is frequently an LLM agent, so any
untrusted text that reaches the model (a pasted job description, a file read, a
KB chunk) is an indirect-prompt-injection path to a tool call.

The design assumption is therefore: **arguments are hostile, and the caller is
not necessarily acting on the user's behalf.**

## Critical

### The delete confirmation was decorative

`career_delete_block` gates permanent deletion of an experience block and all of
its embeddings behind an MRTR (SEP-2322) confirmation. That gate treated the
mere *presence* of a decodable `request_state` as proof the user had answered:

```json
{"name": "career_delete_block",
 "arguments": {"block_id": "exp_1",
               "request_state": "e30=",
               "input_responses": {"confirm": true}}}
```

`e30=` is base64 for `{}`. Six characters deleted the block, with no prompt ever
shown. Block ids are enumerable first via the unauthenticated `career_get_profile`,
so the whole knowledgebase could be walked and destroyed in a loop. The existing
test only walked the happy path, so it encoded the bypass as correct.

*Found independently by two of the four audits.*

**Fix.** `requestState` is now bound to a server-issued nonce
(`mcp/elicitation.rs`) that is single-use, expiring, and bound to the issuing
tool *and* subject. The wire format is unchanged — the nonce travels inside the
existing base64 envelope — so clients need no changes.

A signed token was the alternative and was rejected: HMAC keeps the token
literally self-contained, but a signed token stays valid until it expires, so
one confirmed delete yields a token that authorises that same delete again.
A consumed nonce cannot be replayed. It also needs no new dependency.

### Any website could read and write the knowledgebase

The HTTP transport answered every request with `Access-Control-Allow-Origin: *`
and `Access-Control-Allow-Headers: *`. That is precisely the configuration that
lets a page on any origin read the response body, and `POST` is a CORS-safelisted
method, so the preflight succeeded. Any site the user visited while
`--mcp-http` was running could read their entire career database and issue tool
calls against it — including, before the fix above, the delete bypass.

**Fix.** No `Access-Control-Allow-*` headers are emitted at all; requests
carrying a foreign `Origin` or a browser-set `Sec-Fetch-Site` are refused; `Host`
must be a literal loopback authority (DNS-rebinding defense, since a rebound name
would otherwise be same-origin). The app's own webview origins are allow-listed
by exact match — a page cannot forge `Origin`. Optional bearer auth is available
via `DEVPRISM_MCP_HTTP_TOKEN`; it is opt-in so existing local clients keep working.

**Security impact:** this narrows access only. No path that previously required
credentials now works without them.

## High

| Defect | Effect | Fix |
| --- | --- | --- |
| `career_upsert_block` had no gate at all | Caller supplies the id; the write is a whole-document replace. Overwriting a block with an empty one was a delete that bypassed the delete confirmation. | Losing bullets or facts now requires the same nonce-bound confirmation. Pure additions and edits still apply in one call. |
| Ingest `uri` collision | `uri` is the dedup key: naming an existing source deletes its chunks and embeddings and rewrites its title, unconfirmed. Source uris are readable from `career://kb/sources`. | MCP-ingested sources are namespaced under `mcp://ingest/{uuid}`; a tool call cannot address a source ingested through the app. |
| `career_search_kb` filters were built and dropped | `owner_kinds`, `persona_id`, `domain` were collected into a `SearchFilter` bound to `_filter` and never read. A persona-scoped search silently returned the whole KB. Chunk scores were a hardcoded `0.85`; block scores saturated at exactly `1.0` after any two matches. The description claimed "semantic vector search" for what is substring matching. | Filters applied; scores computed and strictly ordered; description corrected; response now states `searchMode` and `appliedFilters`. |
| HTTP transport read once into a 64 KiB buffer | TCP does not deliver a request in one read. Split requests were silently truncated and rejected as parse errors; anything over 64 KiB could never succeed. | Reads headers to the terminator, then exactly `Content-Length` bytes, with size caps and a whole-request deadline. |
| stdio `while let Ok(n) = read_line(...)` | One byte of invalid UTF-8 made `read_line` return `Err`, the pattern fail, and the server exit — reporting `Ok(())` and status 0, indistinguishable from a clean shutdown. | Lines are read as bytes and validated individually; a bad line costs one error response. Lines are length-bounded; read errors are reported rather than exiting 0. |
| `Working` tasks were never reaped | The reaper skipped them, so any task whose owner panicked or was dropped stayed in the map for the life of the process, reporting "working, 0%" forever. No count cap either. | Abandoned tasks are failed with an explicit timeout past a grace period; `MAX_TASKS` evicts oldest terminal records. Live tasks are never evicted. |
| Poisoned locks failed silently | `if let Ok(guard) = lock()` turned one poisoned lock into permanent silent failure: tasks created but never recorded, results discarded, `get_task` reporting "not found" — each indistinguishable from normal operation. Same shape in the agent's cancel registry, where it produced an *unstoppable* turn. | Both recover the guard via `into_inner()`. |
| Provider `index` drove an unbounded allocation | `"index": 18446744073709551615` in a streaming tool-call delta grows a `Vec` until allocation fails — and Rust *aborts* on allocation failure, killing the app rather than raising a catchable error. | Bounded by `MAX_TOOL_CALLS_PER_TURN`. |
| Any non-`data:` SSE line killed the turn | Comment heartbeats (`: ping`), `event:`/`id:`/`retry:` fields, and `data:[DONE]` without a space are all ordinary and all aborted a healthy turn. The resulting message matched nothing in `is_retryable_chat_error`, so it was not even retried. | Non-`data:` lines skipped; `[DONE]` matched after prefix-stripping; unparseable payloads skipped, matching what the Ollama adapter already did. |
| Truncated tool arguments were fabricated | A partial argument buffer became `{"raw": "<partial text>"}` and was dispatched as if real — an `Edit` whose `file_path` had simply vanished, surfacing as the model misbehaving. `openai_compat` also had no tail flush, which is how the last fragment went missing. | Tail flush added; a non-parsing buffer now fails the turn as retryable `[E_BAD_TOOL_ARGS]`. |
| Agent tool results bypassed the output cap | `resume_compile` defaults `include_pdf` to true, so a routine call pushed a base64 PDF — hundreds of KB — into a context whose byte budget at the default `num_ctx` is ~15 KB. | All four MCP arms route through one helper that caps output and forces `include_pdf: false` and `async: false`. |
| Cancel-registry entry leaked | Removal happened only on the normal fall-through. A panic or a dropped future left the entry forever: the UI looked idle while every later turn in that tab failed `[E_ALREADY_RUNNING]`, unclearable short of restart. | RAII `TurnRegistration`, matching the completion event's existing pattern. |
| TS elicitation types shared no field with the wire | `InputRequiredResult`/`InputRequest` declared `requiredInputs`/`id`/`label`/`action` against an actual shape of `inputRequests`/`type`/`message`/`schema`, with disjoint `type` unions. A confirm dialog would render blank — for a permanent delete — and could never be answered. The test mock hand-wrote the wrong shape, so it passed against a fiction. | Types corrected against the serde source, `isInputRequired` guard added, mock rewritten to the real shape. Correcting the type immediately failed the mock. |

## Medium

- No length or count cap on anything written to the DB. A 200 MB `text` became
  millions of one-character chunk rows, each its own fsync, all while holding the
  process-wide DB mutex — freezing the desktop UI along with every other tool.
  Caps now enforced at the tool boundary; the JSON Schemas in tool definitions are
  advisory and a hostile client will not honour them.
- Wrong-typed arguments silently became defaults. `{"persona_id": 123}` read as
  *no filter* and returned the entire unscoped profile. `optional_str` now
  distinguishes absent from wrong-typed.
- `Mcp-Protocol-Version` was parsed and never validated, despite the module
  advertising SEP-2243 validation.
- Notifications were answered, violating JSON-RPC 2.0 §4.1, and answered with
  "method not found" — which strict clients treat as fatal. `notifications/*` is
  now accepted and transports stay silent.
- Unbounded stream buffers in both providers: the framing loop drains only on
  `\n`, so a server streaming without newlines grew memory without limit. The
  idle timeout does not fire (data *is* arriving) and the request deadline is a
  time bound, not a size bound. Error bodies were fully buffered before being
  truncated to a 300-character snippet.
- Ollama sent no `num_predict`, so a looping model generated into memory and into
  the UI for the full 600s budget. The OpenAI path always sent `max_tokens`.
- A top-level `message` field was read as a fatal API error even on a valid
  chunk, aborting healthy streams from gateways that attach status notes.
- The TS client had no timeout on either transport, a 120s task poll against a
  600s server budget, and no `cancelTask` on timeout — so abandoning a poll left
  the model generating and the compile running for another eight minutes.
- Built-in personas could be redefined over MCP even though `career_delete_persona`
  refuses to remove them. Refused at the MCP boundary; the user's own UI path is
  deliberately unaffected.

## Round two: auditing the fixes, and the surfaces round one skipped

The first round left three gaps: `latex.rs` was unaudited, `career_db` was only
seen through its callers, and — the one that mattered most — **the round-one
changes had themselves never been reviewed.** New code that gates deletes and
terminates TCP connections deserves the same adversarial pass as the code it
replaced. Three more audits ran: one on `latex.rs`, one on `career_db/`, and one
whose only job was to find defects the round-one diff introduced.

It found seven. Two were serious.

### The overwrite gate counted items instead of comparing them

`career_upsert_block`'s new confirmation fired on a *count decrease*
(`prior.bullets.len() - next.bullets.len()`). But the write is a whole-document
replace, so a payload with the **same number** of bullets silently discarded
every original `canonical`, `metrics`, `evidenceRefs` — and, because
`Bullet::locked` is `#[serde(default)]`, every `locked` flag, simply by omitting
the key. The gate reported no loss at all. The code comment claimed it covered
exactly those fields; it checked none of them.

Now `overwrite_loss` compares bullet and fact *identities* and treats any change
to a locked bullet — including silently clearing the flag — as a loss.

### The confirmation approved a block id, not a change

The nonce was bound to `block_id`. A token issued for "drop 1 of 20 bullets" —
which is what the human saw and approved — could be redeemed on a second call
carrying an empty block of the same id, gutting all 20. The subject is now a
digest of the exact payload, so the approved write is the only write the token
authorises. (`career_delete_block` was never exposed to this: there the subject
*is* the whole action.)

### The rest

| Defect (introduced in round one) | Effect | Fix |
| --- | --- | --- |
| The 30s deadline wrapped dispatch, not just reading | A `resume_synthesize` past 30s had its future dropped mid-`await`: no response, socket closed, while the `spawn_blocking` work already dispatched ran on and still committed. | Split into `READ_TIMEOUT` (30s, receiving) and `DISPATCH_TIMEOUT` (600s, matching the server's own budgets), and answer the timeout instead of dropping the connection. |
| stdio off-by-one | A line of exactly `MAX+1` bytes *ending in a newline* is already framed, but the oversize branch drained anyway — eating the client's next valid request, which then never got a response. | Drain only when the line is genuinely unterminated. |
| `:1420` allow-listed in release builds | 1420 is Vite's *default* port. Any other project's dev server — or any page opened on it — could issue writes. Exactly the CSRF the origin check exists to refuse. | `#[cfg(debug_assertions)]`. |
| Caps applied at one call site, not at the class | `career_add_facts` bounded the entry *count* but not bytes (500 × 10 MB is a ~5 GB row); `career_upsert_persona` had no size check at all. | Both bounded on the serialized payload. |
| Semaphore acquired in the accept loop | 64 stalled peers stopped `accept()` being called at all — the backlog filled and legitimate clients were refused rather than queued. | Spawn first, acquire inside the task. |
| Bearer scheme case-sensitive; secret compared with `!=` | RFC 7235 makes the scheme case-insensitive, so `bearer <tok>` read as a wrong secret; an env var's trailing newline could never match. | Case-insensitive scheme, both sides trimmed, constant-time compare. |

### `latex.rs` — a model-reachable path escape

`agent_compile_project` normalized separators with `main_file.replace('\\', "/")`
and joined the result — *after* its caller had validated the raw string. On Unix
a backslash is an ordinary filename character, so `a\..\..\..\etc\x.tex` is a
single `Component::Normal` that passes every traversal check; the rewrite then
turned it into real traversal. Since `Compile`'s `main_file` comes from the
model, that was a model-reachable arbitrary-file **write**
(`prepend_xetex_compat_input` rewrites the file it compiles) and **read** (TeX
echoes source lines into the log, which is returned to the agent).

The rewrite now happens *before* validation, validation lives inside
`agent_compile_project` rather than in its caller, and every `join` uses the path
that was actually checked. That also closes the missing leading-`-` rejection.

Also fixed there: `extract_error_lines` byte-sliced the log at `len - 500` with
no char-boundary check (a panic on any non-ASCII log — and on the UI path, outside
`spawn_blocking`, that hung the compile promise for the session); logs were read
unbounded and `read_to_string`'s UTF-8 failure silently became an empty log,
discarding every real error; and `success: true` was decided by the PDF existing
while the compile result said `Err`, so a timed-out second TeX pass was reported
as a clean build.

### `career_db` — the crash you flagged, and its blast radius

`ingest.rs:134` byte-sliced at `len - OVERLAP_CHARS` while the two slices below
it in the same function used `floor_char_boundary`. Confirmed, fixed, and swept:
an exhaustive search found these were the only three `str` range-slices in the
directory, and the other two were already guarded.

The blast radius was worse than the panic. `with_conn` **propagated** lock
poisoning, so one panic disabled every career operation — UI and MCP — for the
life of the process. And `ingest_source`'s delete → update-hash → insert ran in
autocommit, so a failure between them left the source recorded as ingested with
the new hash and zero chunks; re-ingesting the same file then short-circuits as
`skipped`, so it could never self-heal. Poisoning is now recovered, and the
sequence is one transaction.

Two more: the brute-force vector sort used `partial_cmp(...).unwrap_or(Equal)`,
an intransitive comparator that since Rust 1.81 can panic outright — now
`total_cmp`, with non-finite components rejected at the write boundary. And
`career.db` genuinely has three writers (UI, MCP, and a separate `--mcp-stdio`
process) with a per-state mutex that serializes none of them, on the default
rollback journal with no busy handler; it now opens WAL with a 5s busy timeout.

## Stress testing

`mcp/stress.rs` asserts the properties the fixes exist to protect, against
seeded pseudorandom traffic — so a future change that reopens a hole by a route
nobody enumerated still fails. Determinism is deliberate: failures reproduce from
the seed printed in the assertion, and no new dependency was added for it.

The central property is that **no sequence of tool calls destroys a seeded block
without a genuine confirmation round trip** — 400 randomized calls biased hard
toward the destructive shapes (real block ids, forged `requestState` values,
`confirm: true`, emptied blocks). Alongside it: 600 randomized tool calls and 400
randomized JSON-RPC envelopes asserting the dispatcher never panics and never
returns a malformed response; 3,000 randomized elicitation interleavings; 3,000
randomized task lifecycles; 3,000 generated HTTP head blocks asserting that an
*allow* decision always implies POST + loopback `Host` + non-foreign `Origin` +
the `/mcp` route; and 2,000 asserting a configured bearer token is never bypassed.

**The harness was verified to have teeth.** Reopening the delete bypass in
`tools_career.rs` made four tests fail, including the stress property, which
named a reproducible seed:

```
seed 202: tool 'career_delete_block' destroyed block 'block-a'
          without a genuine confirmation; survivors: ["block-b", "block-c"]
```

The file was then restored byte-for-byte (md5-verified) and the suite re-run.

## Verifying

```bash
cd apps/desktop/src-tauri && cargo test --lib
```

630 pass, 2 ignored (live Ollama). Frontend: `npx vitest run` — 863 pass;
`npx tsc -b` — clean. `cargo clippy --lib` exits 0: the three pre-existing
`unwrap`/`expect` deny violations are fixed too, and this change introduces no
new clippy warning on any line it adds.

Notable tests: `a_forged_request_state_cannot_delete_a_block`,
`a_confirmation_token_cannot_be_replayed`,
`a_confirmation_for_one_block_cannot_delete_another`,
`a_request_from_a_web_page_is_refused`, `a_rebound_dns_name_is_refused`,
`search_filters_are_applied_rather_than_silently_dropped`,
`a_poisoned_lock_does_not_silently_disable_the_manager`,
`a_hostile_tool_call_cannot_panic_the_dispatcher` (every advertised tool ×
nine hostile argument shapes), `every_advertised_tool_is_dispatchable`.

## Known, not fixed

Everything below is a real finding from the audits that was deliberately left,
with the reason. None of it is unexamined.

- **`Bash` is arbitrary model-controlled execution.** `tools.rs` is explicit that
  this is intentional and "NOT a sandbox". It sets the severity ceiling for
  everything else: any injection that reaches the model is one step from code
  execution as the user. Note that `is_secret_env_key` strips credential-shaped
  *environment variables* and reads like containment — the same shell can still
  `cat ~/.ssh/id_rsa`. A real but partial mitigation; not an exfiltration boundary.
- **`compile_latex` (the Tauri IPC command) still joins `project_dir` and
  `main_file` unvalidated**, so an absolute `main_file` escapes via `Path::join`.
  Same primitive as the model-reachable escape fixed in `agent_compile_project`,
  but reachable only from the webview, i.e. from the user's own UI. Fixing it is
  a one-line call to the same `validated_main_rel`; it is left out because it
  changes a UI path whose callers were not surveyed here.
- **`agent_compile_project` takes neither the compile semaphore nor the
  per-project lock**, so a UI compile racing the agent's `Compile` share one build
  directory and can prune each other's files mid-run. Needs a signature change to
  thread the lock through.
- **Unbounded result sets.** `career_get_profile`, `career://profile`,
  `list_kb_chunks(None)`, brute-force vector search, and `synthesis_runs` (which
  nothing ever deletes) all materialize whole tables. Memory is bounded only by
  KB size — which the new input caps at least stop a caller from inflating first.
  Proper pagination is an API change across Rust and TS.
- **Storage-layer correctness issues found but not addressed:** duplicate-content
  chunks lose embeddings on re-upsert (the reuse map is keyed by content hash and
  last-writer-wins); `vec_embeddings` is dropped and fully rebuilt whenever the
  embedding dimension alternates, *from the search path*, non-transactionally;
  child embedding owner ids are not namespaced per block, so two blocks sharing a
  bullet id can delete each other's vectors; `stable_rowid` uses `DefaultHasher`,
  whose output is explicitly not stable across Rust releases, for **persisted**
  rowids; `kb_sources.uri` has no UNIQUE index; and several write loops run one
  autocommit transaction per row. Each is a genuine defect; together they are a
  storage-layer workstream, not a hardening pass.
- **Two latent-but-not-exploitable shapes**, both verified unreachable today and
  worth closing when touched: `find_texlive_binary` interpolates a name into a
  `zsh -c` string (every caller passes a literal), and `resolve_child_hit`
  interpolates a JSON path into SQL (both callers pass constants).
- **Elicitation and task TTLs use wall-clock time**, so an NTP step shifts them.
- **`.synctex.gz` is decompressed unbounded** (engine-generated, UI-only).
